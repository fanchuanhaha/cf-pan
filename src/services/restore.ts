// 彩虹外链网盘 - 数据恢复服务
// 从原 PHP 项目恢复数据：SQL 文件 + 站点目录压缩包

import type { IStorage } from '../storage/IStorage';

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
export async function restoreDatabaseFromSql(db: D1Database, sqlContent: string, taskId: string): Promise<{ success: number; failed: number; errors: string[] }> {
  const task = restoreTasks.get(taskId);
  if (task) {
    task.stage = 'database';
    task.message = '正在恢复数据库...';
  }
  
  const result: { success: number; failed: number; errors: string[] } = { success: 0, failed: 0, errors: [] };
  
  // 分割 SQL 语句（按分号分割，但忽略引号内的分号）
  const statements = splitSqlStatements(sqlContent);
  
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (!stmt) continue;
    
    if (task) {
      task.processed = i;
      task.message = `正在执行 SQL 语句 ${i + 1}/${statements.length}`;
    }
    
    try {
      // 只处理 INSERT 语句，跳过 CREATE/DROP（结构由 D1 初始化管理）
      if (/^INSERT\s+INTO\s+/i.test(stmt)) {
        // 转换表名
        const converted = convertTableName(stmt);
        try {
          // @ts-ignore - D1 动态类型
          const stmt_obj = db.prepare(converted);
          // @ts-ignore - D1 动态类型
          await stmt_obj.run();
        } catch (e: any) {
          // 失败则跳过
          result.failed++;
          result.errors.push(`INSERT 失败: ${e.message || e}`);
        }
        result.success++;
      } else if (/^CREATE\s+TABLE/i.test(stmt)) {
        // 跳过 CREATE TABLE（D1 已有结构）
        result.success++;
      } else if (/^DROP/i.test(stmt) || /^DELETE/i.test(stmt)) {
        // 跳过 DROP 和 DELETE
        result.success++;
      } else {
        // 其他语句：尝试 prepare + run
        try {
          const statement = stmt.trim();
          if (statement) {
            // @ts-ignore - D1 动态类型
            const stmt_obj = db.prepare(statement);
            // @ts-ignore - D1 动态类型
            await stmt_obj.run();
          }
          result.success++;
        } catch (e: any) {
          result.failed++;
          result.errors.push(`语句 ${i + 1}: ${e.message || e}`);
        }
      }
    } catch (e: any) {
      result.failed++;
      result.errors.push(`语句 ${i + 1}: ${(e.message || e).substring(0, 200)}`);
    }
  }
  
  return result;
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
