// 彩虹外链网盘 - 数据恢复服务
// 从原 PHP 项目恢复数据：SQL 文件 + 站点目录压缩包

import type { IStorage } from '../storage/IStorage';
import type { D1Like } from '../middleware';

export type RestoreStage = 'download' | 'extract' | 'database' | 'files' | 'done';

export interface RestoreProgress {
  stage: RestoreStage;
  total: number;
  processed: number;
  success: number;
  failed: number;
  currentItem: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  errors: string[];
  startTime: number;
  endTime?: number;
  message?: string;
}

const restoreTasks: Map<string, RestoreProgress> = new Map();

export function getRestoreStatus(taskId: string): RestoreProgress | null {
  return restoreTasks.get(taskId) || null;
}

export function cancelRestore(taskId: string): void {
  const task = restoreTasks.get(taskId);
  if (task && task.status === 'running') {
    task.status = 'cancelled';
  }
}

export function createRestoreTask(taskId: string): RestoreProgress {
  const task: RestoreProgress = {
    stage: 'download',
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    currentItem: '',
    status: 'waiting',
    errors: [],
    startTime: Date.now(),
    message: '等待开始',
  };
  restoreTasks.set(taskId, task);
  return task;
}

/**
 * 从 URL 下载文件
 */
export async function downloadFromUrl(url: string, taskId: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const task = restoreTasks.get(taskId);
  if (task) {
    task.stage = 'download';
    task.currentItem = url;
    task.status = 'running';
    task.message = '正在下载文件...';
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status}`);
  }

  const contentLength = parseInt(res.headers.get('Content-Length') || '0');
  const reader = res.body?.getReader();
  
  if (!reader) {
    // 没有 reader，直接获取全部
    const buf = await res.arrayBuffer();
    if (onProgress) onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }

  // 流式读取以便显示进度
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) onProgress(received, contentLength);
    if (task) {
      task.processed = received;
      task.total = contentLength || received;
      task.message = `已下载 ${formatSize(received)}${contentLength ? ` / ${formatSize(contentLength)}` : ''}`;
    }
  }

  // 合并 chunks
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

/**
 * 解压 ZIP 文件
 * 简单的 ZIP 解压实现，支持存储模式（不压缩）
 */
export async function extractZip(data: ArrayBuffer, taskId: string): Promise<Array<{ name: string; data: ArrayBuffer; size: number }>> {
  const task = restoreTasks.get(taskId);
  if (task) {
    task.stage = 'extract';
    task.message = '正在解压文件...';
  }

  const view = new DataView(data);
  const files: Array<{ name: string; data: ArrayBuffer; size: number }> = [];

  // 验证 ZIP 签名
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('不是有效的 ZIP 文件');
  }

  let offset = 0;
  let fileCount = 0;

  while (offset < data.byteLength - 4) {
    // 查找本地文件头
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    
    const nameBytes = new Uint8Array(data, offset + 30, nameLen);
    const name = new TextDecoder().decode(nameBytes);
    
    const dataStart = offset + 30 + nameLen + extraLen;
    
    let fileData: ArrayBuffer;
    if (method === 0) {
      // 存储
      fileData = data.slice(dataStart, dataStart + compressedSize);
    } else if (method === 8) {
      // DEFLATE - 使用 DecompressionStream
      const compressedData = data.slice(dataStart, dataStart + compressedSize);
      const stream = new Response(compressedData).body!
        .pipeThrough(new DecompressionStream('deflate'));
      const decompressed = await new Response(stream).arrayBuffer();
      fileData = decompressed;
    } else {
      throw new Error(`不支持的压缩方法: ${method}`);
    }
    
    if (!name.endsWith('/')) {
      files.push({ name, data: fileData, size: uncompressedSize || fileData.byteLength });
      fileCount++;
      if (task) {
        task.processed = fileCount;
        task.message = `已解压 ${fileCount} 个文件: ${name}`;
      }
    }
    
    offset = dataStart + compressedSize;
  }
  
  if (task) task.total = fileCount;
  return files;
}

/**
 * 从原 PHP 项目的 SQL 文件恢复数据库
 */
export async function restoreDatabaseFromSql(db: D1Like, sqlContent: string, taskId: string): Promise<{ success: number; failed: number; errors: string[] }> {
  const task = restoreTasks.get(taskId);
  if (task) {
    task.stage = 'database';
    task.message = '正在恢复数据库...';
  }
  
  const result: { success: number; failed: number; errors: string[] } = { success: 0, failed: 0, errors: [] };
  
  // 分割 SQL 语句（按分号分割，但忽略引号内的分号）
  const rawStatements = splitSqlStatements(sqlContent);
  // 预处理：移除每条语句开头的 MySQL 注释（-- 和 /* */），使 startsWith 检查能正确匹配
  const statements = rawStatements.map(s => stripLeadingComments(s.trim())).filter(s => s.length > 0);
  
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (!stmt) continue;
    
    if (task) {
      task.processed = i;
      task.message = `正在执行 SQL 语句 ${i + 1}/${statements.length}`;
    }
    
    const upperStmt = stmt.toUpperCase();
    
    // 跳过 MySQL 专有且 D1 不支持的语句
    if (
      upperStmt.startsWith('SET ') ||
      upperStmt.startsWith('START TRANSACTION') ||
      upperStmt.startsWith('BEGIN') ||
      upperStmt.startsWith('COMMIT') ||
      upperStmt.startsWith('ROLLBACK') ||
      upperStmt.startsWith('LOCK ') ||
      upperStmt.startsWith('UNLOCK ') ||
      upperStmt.startsWith('USE ') ||
      upperStmt.startsWith('DROP DATABASE') ||
      upperStmt.startsWith('CREATE DATABASE') ||
      upperStmt.startsWith('/*!') ||  // MySQL 条件注释
      upperStmt.startsWith('DELIMITER') ||
      /^!\d+/.test(upperStmt)  // MySQL 版本特定语句
    ) {
      result.success++;
      continue;
    }
    
    // CREATE TABLE - 跳过（D1 已有结构）
    if (upperStmt.startsWith('CREATE TABLE') || upperStmt.startsWith('CREATE INDEX') || upperStmt.startsWith('CREATE UNIQUE INDEX')) {
      result.success++;
      continue;
    }
    
    // DROP TABLE - 跳过（D1 已有结构）
    if (upperStmt.startsWith('DROP TABLE') || upperStmt.startsWith('DROP INDEX')) {
      result.success++;
      continue;
    }
    
    // ALTER TABLE - 跳过（D1 schema 已固定）
    if (upperStmt.startsWith('ALTER TABLE')) {
      result.success++;
      continue;
    }
    
    // DELETE - 跳过（避免误删现有数据）
    if (upperStmt.startsWith('DELETE ')) {
      result.success++;
      continue;
    }
    
    try {
      // INSERT 语句：用 INSERT OR REPLACE 避免唯一冲突
      if (upperStmt.startsWith('INSERT INTO')) {
        const converted = convertTableName(stmt).replace(/^INSERT\s+INTO/i, 'INSERT OR REPLACE INTO');
        // @ts-ignore - D1 动态类型
        const stmt_obj = db.prepare(converted);
        // @ts-ignore - D1 动态类型
        await stmt_obj.run();
        result.success++;
      } else {
        // 其他 MySQL 专有语句（不支持的）跳过，不报错
        if (
          upperStmt.startsWith('OPTIMIZE ') ||
          upperStmt.startsWith('REPAIR ') ||
          upperStmt.startsWith('CHECK ') ||
          upperStmt.startsWith('FLUSH ') ||
          upperStmt.startsWith('GRANT ') ||
          upperStmt.startsWith('REVOKE ') ||
          upperStmt.startsWith('SHOW ') ||
          upperStmt.startsWith('DESCRIBE ') ||
          upperStmt.startsWith('TRUNCATE ') ||
          upperStmt.startsWith('RENAME ') ||
          upperStmt.startsWith('LOAD ') ||
          upperStmt.startsWith('CREATE TRIGGER') ||
          upperStmt.startsWith('CREATE PROCEDURE') ||
          upperStmt.startsWith('CREATE FUNCTION') ||
          upperStmt.startsWith('CREATE EVENT') ||
          upperStmt.startsWith('CREATE VIEW')
        ) {
          result.success++;
          continue;
        }
        // 其他语句：尝试 prepare + run
        // @ts-ignore - D1 动态类型
        const stmt_obj = db.prepare(stmt);
        // @ts-ignore - D1 动态类型
        await stmt_obj.run();
        result.success++;
      }
    } catch (e: any) {
      // 单条失败不影响整体
      result.failed++;
      const errMsg = (e.message || String(e)).substring(0, 150);
      result.errors.push(`语句 ${i + 1}: ${errMsg}`);
    }
  }
  
  return result;
}

/**
 * 从原站点批量下载文件
 * @param db D1 数据库
 * @param stor 目标存储
 * @param sourceBaseUrl 原站点 URL（如 http://dl.802213.xyz/）
 * @param taskId 任务 ID
 * @param folder 原站点的存储目录（默认 'file'，对应原 PHP 项目的 file/ 目录）
 */
export async function restoreFilesFromSource(
  db: any,
  stor: IStorage,
  sourceBaseUrl: string,
  taskId: string,
  folder: string = 'file'
): Promise<{ fileCount: number; success: number; failed: number; errors: string[]; totalSize: number }> {
  const task = restoreTasks.get(taskId);
  
  // 标准化 URL
  let baseUrl = sourceBaseUrl.trim();
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = 'http://' + baseUrl;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  
  // 标准化 folder（去掉首尾斜杠和 file/ 前缀，确保最终拼接路径干净）
  const cleanFolder = (folder || 'file').replace(/^\/+|\/+$/g, '');
  
  // 查询所有文件
  const { results: files } = await db.prepare('SELECT id, name, hash, size FROM pre_file').all();
  const fileList = (files as any[]) || [];

  console.log(`[restoreFilesFromSource] taskId=${taskId} baseUrl=${baseUrl} folder=${cleanFolder} fileCount=${fileList.length}`);
  
  if (task) {
    task.stage = 'files';
    task.total = fileList.length;
    task.status = 'running';
    task.message = `开始从 ${baseUrl} 下载 ${fileList.length} 个文件`;
  }
  
  const result: { fileCount: number; success: number; failed: number; errors: string[]; totalSize: number } = {
    fileCount: fileList.length,
    success: 0,
    failed: 0,
    errors: [],
    totalSize: 0,
  };
  
  for (let i = 0; i < fileList.length; i++) {
    if (task && task.status === 'cancelled') break;
    
    const file = fileList[i];
    // 从原站点下载的 URL：{原站点}/{folder}/{hash}
    const downloadUrl = `${baseUrl}/${cleanFolder}/${file.hash}`;
    
    if (task) {
      task.processed = i;
      task.currentItem = file.name;
      task.message = `正在下载 (${i + 1}/${fileList.length}): ${file.name}`;
    }
    
    const startTime = Date.now();
    try {
      // 下载文件
      const res = await fetch(downloadUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 RestoreBot' }
      });
      
      if (!res.ok) {
        result.failed++;
        result.errors.push(`${file.name}: HTTP ${res.status}`);
        if (task) {
          task.processed = i + 1;
          task.failed = result.failed;
        }
        continue;
      }
      
      // 流式读取以便实时更新下载进度
      const contentLength = parseInt(res.headers.get('Content-Length') || '0');
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastUpdate = 0;
      
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          // 每 200ms 更新一次进度
          const now = Date.now();
          if (now - lastUpdate > 200 && task) {
            lastUpdate = now;
            const speed = received / Math.max(1, (now - startTime) / 1000);
            task.processed = i + received / Math.max(1, contentLength);
            task.message = `正在下载 (${i + 1}/${fileList.length}): ${file.name} - ${formatSize(received)}${contentLength ? ` / ${formatSize(contentLength)}` : ''} (${formatSize(speed)}/s)`;
          }
        }
        // 合并 chunks
        const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.byteLength;
        }
        var buf = data.buffer;
      } else {
        var buf = await res.arrayBuffer();
      }
      
      const data = buf;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = data.byteLength / elapsed;
      
      // 上传到目标存储（只需传 hash，hashToKey 会加上 file/ 前缀）
      try {
        if (task) {
          task.message = `正在上传到存储 (${i + 1}/${fileList.length}): ${file.name} (${formatSize(data.byteLength)})`;
        }
        // @ts-ignore
        const ok = await stor.upload(file.hash, data);
        if (ok) {
          result.success++;
          result.totalSize += data.byteLength;
          if (task) {
            task.processed = i + 1;
            task.success = result.success;
            task.failed = result.failed;
            task.message = `已完成 ${i + 1}/${fileList.length}: ${file.name} (${formatSize(data.byteLength)} / ${formatSize(speed)}/s)`;
          }
        } else {
          result.failed++;
          result.errors.push(`${file.name}: 上传到存储失败`);
          if (task) task.failed = result.failed;
        }
      } catch (e: any) {
        result.failed++;
        result.errors.push(`${file.name}: 上传失败 ${(e.message || e).substring(0, 100)}`);
        if (task) task.failed = result.failed;
      }
    } catch (e: any) {
      result.failed++;
      result.errors.push(`${file.name}: ${(e.message || e).substring(0, 100)}`);
      if (task) task.failed = result.failed;
    }
  }
  
  if (task) {
    task.processed = fileList.length;
    task.success = result.success;
    task.failed = result.failed;
    task.currentItem = '';
    task.message = `下载完成: 成功 ${result.success}, 失败 ${result.failed}`;
  }
  
  return result;
}

/**
 * 移除 SQL 语句开头的 MySQL 注释（-- 行注释和 /* 块注释），使类型判断能正确匹配
 */
function stripLeadingComments(sql: string): string {
  let result = sql;
  while (true) {
    const trimmed = result.trimStart();
    // 跳过 -- 行注释
    if (trimmed.startsWith('--')) {
      const idx = trimmed.indexOf('\n');
      if (idx === -1) return '';
      result = trimmed.substring(idx + 1);
      continue;
    }
    // 跳过 /* 块注释（含 /*! 条件注释） */
    if (trimmed.startsWith('/*')) {
      const idx = trimmed.indexOf('*/');
      if (idx === -1) return '';
      result = trimmed.substring(idx + 2);
      continue;
    }
    break;
  }
  return result.trimStart();
}

/**
 * 分割 SQL 语句
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    
    if (inString) {
      current += ch;
      if (ch === stringChar && sql[i - 1] !== '\\') {
        inString = false;
      }
    } else {
      if (ch === "'" || ch === '"') {
        inString = true;
        stringChar = ch;
        current += ch;
      } else if (ch === ';') {
        statements.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/**
 * 转换原 PHP 项目表名到 D1 表名
 * 原项目: pre_file, pre_config, pre_user
 */
function convertTableName(sql: string): string {
  return sql
    .replace(/pre_file/gi, 'pre_file')
    .replace(/pre_config/gi, 'pre_config')
    .replace(/pre_user/gi, 'pre_user')
    .replace(/pre_ip/gi, 'pre_ip');
}

/**
 * 从原 PHP 项目目录恢复文件
 * 识别 file/ 目录，config.php 等配置文件
 */
export async function restoreFilesFromZip(
  storage: IStorage,
  files: Array<{ name: string; data: ArrayBuffer; size: number }>,
  taskId: string
): Promise<{ success: number; failed: number; errors: string[]; totalSize: number }> {
  const task = restoreTasks.get(taskId);
  if (task) {
    task.stage = 'files';
    task.message = '正在恢复文件到存储...';
  }
  
  const result: { success: number; failed: number; errors: string[]; totalSize: number } = { success: 0, failed: 0, errors: [], totalSize: 0 };
  
  // 识别 file/ 目录下的文件
  const fileEntries = files.filter(f => {
    const name = f.name.replace(/\\/g, '/');
    // 匹配 file/ 目录下的文件，或者直接的文件
    return /^file\//.test(name) || /\.(txt|jpg|jpeg|png|gif|webp|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|mp4|mp3)$/i.test(name);
  });
  
  if (task) task.total = fileEntries.length;
  
  for (let i = 0; i < fileEntries.length; i++) {
    if (task && task.status === 'cancelled') break;
    
    const file = fileEntries[i];
    const name = file.name.replace(/\\/g, '/');
    
    if (task) {
      task.processed = i;
      task.currentItem = name;
      task.message = `正在恢复文件 ${i + 1}/${fileEntries.length}: ${name}`;
    }
    
    // 提取 hash 作为存储 key
    // 尝试从文件名提取（如果文件名是 hash）
    const baseName = name.split('/').pop() || name;
    const hashMatch = baseName.match(/^([0-9a-f]{32})$/i);
    const key = hashMatch ? hashMatch[1] : baseName;
    
    try {
      // @ts-ignore - 动态类型
      const ok = await storage.upload(key, file.data);
      if (ok) {
        result.success++;
        result.totalSize += file.size;
      } else {
        result.failed++;
        result.errors.push(`${name}: 上传失败`);
      }
    } catch (e: any) {
      result.failed++;
      result.errors.push(`${name}: ${e.message || e}`);
    }
  }
  
  return result;
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
