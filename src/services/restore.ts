// 彩虹外链网盘 - 数据恢复服务
// 从原 PHP 项目恢复数据：SQL 文件 + 站点目录压缩包

import type { IStorage } from '../storage/IStorage';
import { extractPreFileRecords, type PreFileRecord } from './restorePreExtract';
import { QiniuStorage } from '../storage/QiniuStorage';

function buildSourceFileUrl(sourceBaseUrl: string, hash: string, type: string): string {
  const input = new URL(sourceBaseUrl);
  const path = input.pathname.replace(/\/+$/, '');
  const extension = type ? `.${type.replace(/^\./, '')}` : '.file';

  // The original PHP site serves files through down.php, while some sites
  // expose the physical file/ directory directly.
  if (/\/down\.php$/i.test(path)) {
    input.pathname = `${path}/${hash}${extension}`;
  } else if (/\/file$/i.test(path)) {
    input.pathname = `${path}/${hash}`;
  } else {
    input.pathname = `${path}/file/${hash}`;
  }
  return input.toString();
}

function normalizeSourceBaseUrl(sourceBaseUrl: string): string {
  const input = new URL(sourceBaseUrl);
  const match = input.pathname.match(/^(.*\/down\.php)(?:\/.*)?$/i);
  if (match) {
    input.pathname = match[1];
    input.search = '';
    input.hash = '';
  }
  return input.toString().replace(/\/+$/, '');
}

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
  skipped: string[];
  startTime: number;
  endTime?: number;
  message?: string;
  /** 当前文件已下载字节（用于二级进度条，仅在单文件下载阶段有值） */
  currentFileReceived?: number;
  /** 当前文件总字节（用于二级进度条，仅在单文件下载阶段有值） */
  currentFileTotal?: number;
  totalBytes: number;
  processedBytes: number;
  currentFileStage?: 'download' | 'upload';
  currentFileSpeed?: number;
  currentFileChunked?: boolean;
  logs: string[];
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
    skipped: [],
    startTime: Date.now(),
    message: '等待开始',
    totalBytes: 0,
    processedBytes: 0,
    logs: [],
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
 * @param skipPreConfig 跳过 pre_config 表（默认 true，避免原 PHP 项目的 storage='local' 污染当前系统配置）
 */
export async function restoreDatabaseFromSql(
  db: D1Database,
  sqlContent: string,
  taskId: string,
  options: { skipPreConfig?: boolean } = {}
): Promise<{ success: number; failed: number; errors: string[]; skippedPreConfig?: number }> {
  const skipPreConfig = options.skipPreConfig !== false; // 默认 true
  const task = restoreTasks.get(taskId);
  if (task) {
    task.stage = 'database';
    task.message = '正在恢复数据库...';
  }

  const result: { success: number; failed: number; errors: string[]; skippedPreConfig?: number } = { success: 0, failed: 0, errors: [] };
  
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

    // pre_config - 跳过（系统配置，CF Workers 与原 PHP 项目的 key 不同；
    // 原 PHP 项目的 storage='local' 等会污染当前系统的存储配置导致后续文件恢复失败）
    if (skipPreConfig && /^INSERT\s+INTO\s+[`"]?pre_config[`"]?/i.test(stmt)) {
      result.success++;
      result.skippedPreConfig = (result.skippedPreConfig || 0) + 1;
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
  folder: string = 'file',
  sqlText?: string
): Promise<{ fileCount: number; success: number; failed: number; errors: string[]; totalSize: number }> {
  const task = restoreTasks.get(taskId);
  const log = (message: string) => {
    console.log(`[restore:${taskId}] ${message}`);
    if (task) {
      task.logs.push(new Date().toISOString() + ' ' + message);
      if (task.logs.length > 100) task.logs.shift();
    }
  };
  
  // 标准化 URL
  let baseUrl = sourceBaseUrl.trim();
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = 'http://' + baseUrl;
  }
  try {
    baseUrl = normalizeSourceBaseUrl(baseUrl);
  } catch {
    throw new Error(`原站点 URL 无效: ${sourceBaseUrl}`);
  }
  
  // 标准化 folder（去掉首尾斜杠和 file/ 前缀，确保最终拼接路径干净）
  const cleanFolder = (folder || 'file').replace(/^\/+|\/+$/g, '');
  
  // 查询所有文件
  const { results: files } = await db.prepare('SELECT id, name, hash, size FROM pre_file ORDER BY id').all();
  let fileList = (files as PreFileRecord[]) || [];
  if (fileList.length === 0 && sqlText) {
    fileList = extractPreFileRecords(sqlText);
    console.warn(`[restoreFilesFromSource] pre_file is empty in D1, using ${fileList.length} records parsed from SQL`);
    // 不能只在内存中使用解析结果，否则文件虽然能下载，安装完成后 D1 仍没有文件元数据。
    for (const file of fileList) {
      await db.prepare(
        `INSERT OR REPLACE INTO pre_file
          (id, name, type, size, hash, addtime, lasttime, ip, hide, pwd, block, count, uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        file.id, file.name, file.type || '', file.size || 0, file.hash,
        file.addtime, file.lasttime, file.ip, file.hide, file.pwd, file.block, file.count, file.uid,
      ).run();
    }
  }

  log(`开始任务 baseUrl=${baseUrl} folder=${cleanFolder} fileCount=${fileList.length}`);
  
  if (task) {
    task.stage = 'files';
    task.total = fileList.length;
    task.status = 'running';
    task.message = `开始从 ${baseUrl} 下载 ${fileList.length} 个文件`;
    task.totalBytes = fileList.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    task.processedBytes = 0;
  }
  
  const result: { fileCount: number; success: number; failed: number; errors: string[]; skipped: string[]; totalSize: number } = {
    fileCount: fileList.length,
    success: 0,
    failed: 0,
    errors: [],
    skipped: [],
    totalSize: 0,
  };

  if (fileList.length === 0) {
    if (task) {
      task.status = 'failed';
      task.message = 'pre_file 中没有可恢复的文件记录';
      task.errors.push('pre_file 中没有可恢复的文件记录');
      log('失败: pre_file 中没有可恢复的文件记录');
    }
    return result;
  }
  
  for (let i = 0; i < fileList.length; i++) {
    if (task && task.status === 'cancelled') break;
    
    const file = fileList[i];
    // 默认兼容原 PHP 的 file/ 目录，也支持输入原站点的 /down.php。
    const downloadUrl = /\/down\.php\/?$/i.test(baseUrl)
      ? buildSourceFileUrl(baseUrl, file.hash, file.type)
      : `${baseUrl}/${cleanFolder}/${file.hash}`;
    log(`文件 ${i + 1}/${fileList.length} 开始下载: ${file.name} hash=${file.hash} url=${downloadUrl}`);
    
    if (task) {
      task.processed = i;
      task.currentItem = file.name;
      task.message = `正在下载 (${i + 1}/${fileList.length}): ${file.name}`;
    }

    if (!/^[0-9a-f]{32}$/i.test(file.hash)) {
      const error = `${file.name}: SQL 中的 hash 格式错误（应为 32 位 MD5，实际为 ${file.hash.length} 位），无法拼接源站 URL`;
      result.failed++;
      result.errors.push(error);
      task?.errors.push(error);
      log(error);
      if (task) {
        task.failed = result.failed;
        task.processed = result.success + result.skipped.length + result.failed;
      }
      continue;
    }
    
    const startTime = Date.now();
    try {
      // 下载文件
      let res: Response;
      try {
        res = await fetch(downloadUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          cf: { cacheTtl: -1 },
        });
      } catch (fetchErr: any) {
        const errMsg = `源站连接失败: ${fetchErr?.message || fetchErr} (url=${downloadUrl})`;
        result.failed++;
        result.errors.push(errMsg);
        task?.errors.push(errMsg);
        log(errMsg);
        if (task) {
          task.failed = result.failed;
          task.processed = result.success + result.skipped.length + result.failed;
        }
        continue;
      }
      
      if (!res.ok) {
        const error = res.status === 404
          ? `${file.name}: 源站文件不存在 HTTP 404，hash=${file.hash}，URL=${downloadUrl}`
          : `${file.name}: 源站下载失败 HTTP ${res.status}，URL=${downloadUrl}`;
        if (res.status === 404) {
          result.skipped.push(error);
          task?.skipped.push(error);
          log('跳过文件: ' + error);
        } else {
          result.failed++;
          result.errors.push(error);
          task?.errors.push(error);
          log(error + ` content-type=${res.headers.get('content-type') || ''}`);
        }
        if (task) {
          task.processed = result.success + result.skipped.length + result.failed;
          task.failed = result.failed;
        }
        continue;
      }

      
      // 读取长度只用于进度显示；上传必须尽量保持流式，避免 Worker
      // 为 100 MiB 文件同时保留多个 ArrayBuffer 副本。
      const contentLength = parseInt(res.headers.get('Content-Length') || '0');
      const expectedSize = contentLength || Number(file.size) || 0;
      const useChunkedUpload = stor instanceof QiniuStorage;

      // 七牛大文件走分片上传，避免把整个响应读入 ArrayBuffer/Blob。
      if (useChunkedUpload && res.body) {
        if (task) {
          task.currentFileChunked = true;
          task.currentFileStage = 'upload';
          task.currentFileReceived = 0;
          task.currentFileTotal = expectedSize;
          task.currentFileSpeed = 0;
          task.message = `正在分片上传到七牛云 (${i + 1}/${fileList.length}): ${file.name}`;
        }
        log(`文件 ${file.name} 开始七牛分片上传: ${file.hash}`);
        const uploadStart = Date.now();
        await stor.uploadStream(file.hash, res.body, (uploaded, total) => {
          if (!task) return;
          task.currentFileStage = 'upload';
          task.currentFileReceived = uploaded;
          task.currentFileTotal = total;
          task.currentFileSpeed = uploaded / Math.max(1, (Date.now() - uploadStart) / 1000);
          task.processedBytes = fileList.slice(0, i).reduce((sum, item) => sum + (Number(item.size) || 0), 0) + uploaded;
          task.message = `正在分片上传 (${i + 1}/${fileList.length}): ${file.name} - ${formatSize(uploaded)} / ${formatSize(total)}`;
        }, expectedSize, file.type || 'application/octet-stream');
        result.success++;
        result.totalSize += Number(file.size) || expectedSize;
        if (task) {
          task.processed = result.success + result.skipped.length + result.failed;
          task.success = result.success;
          task.failed = result.failed;
          task.processedBytes = fileList.slice(0, i + 1).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
          task.message = `已完成 ${i + 1}/${fileList.length}: ${file.name}`;
        }
        log(`文件 ${file.name} 七牛分片上传成功`);
        continue;
      }

      if (!res.body) throw new Error('源站响应没有响应体');
      if (task) task.currentFileChunked = false;

      const uploadStream = async (stream: ReadableStream): Promise<boolean> => {
        let received = 0;
        let lastUpdate = 0;
        const input = stream.getReader();
        const output = new TransformStream<Uint8Array, Uint8Array>();
        const writer = output.writable.getWriter();
        const pump = (async () => {
          try {
            while (true) {
              const part = await input.read();
              if (part.done) break;
              received += part.value.byteLength;
              const now = Date.now();
              if (task && now - lastUpdate > 200) {
                lastUpdate = now;
                task.processed = i;
                task.currentFileReceived = received;
                task.currentFileTotal = expectedSize || received;
                task.currentFileStage = 'upload';
                task.currentFileSpeed = received / Math.max(1, (now - startTime) / 1000);
                task.processedBytes = fileList.slice(0, i).reduce((sum, item) => sum + (Number(item.size) || 0), 0) + received;
                task.message = `正在上传 (${i + 1}/${fileList.length}): ${file.name} - ${formatSize(received)}${expectedSize ? ` / ${formatSize(expectedSize)}` : ''}`;
              }
              await writer.write(part.value);
            }
            await writer.close();
          } catch (e) {
            await writer.abort(e);
            throw e;
          }
        })();
        const uploaded = await Promise.all([
          // @ts-ignore IStorage accepts a ReadableStream, while some drivers
          // may internally buffer when their provider API requires it.
          stor.upload(file.hash, output.readable, file.type || 'application/octet-stream'),
          pump,
        ]).then(([ok]) => ok as boolean);
        if (task) {
          task.currentFileReceived = received;
          task.currentFileTotal = expectedSize || received;
          task.currentFileStage = 'upload';
          task.currentFileSpeed = received / Math.max(1, (Date.now() - startTime) / 1000);
        }
        return uploaded;
      };

      log(`文件 ${file.name} 开始流式上传 hash=${file.hash}`);

      // 上传到目标存储。R2/S3/WebDAV/又拍云直接消费响应流；七牛使用分片流式上传。
      try {
        if (task) {
          task.currentFileStage = 'upload';
          task.message = `正在上传到存储 (${i + 1}/${fileList.length}): ${file.name}`;
        }
        const ok = useChunkedUpload
          ? await (stor as QiniuStorage).uploadStream(file.hash, res.body, undefined, expectedSize, file.type || 'application/octet-stream')
          : await uploadStream(res.body);
        if (ok) {
          result.success++;
          result.totalSize += expectedSize || Number(file.size) || 0;
          if (task) {
            task.processed = i + 1;
            task.success = result.success;
            task.failed = result.failed;
            task.processedBytes = fileList.slice(0, i + 1).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
            task.message = `已完成 ${i + 1}/${fileList.length}: ${file.name}`;
          }
          log(`文件 ${file.name} 上传成功: ${expectedSize || Number(file.size) || 0} bytes`);
        } else {
          result.failed++;
          const error = `${file.name}: 上传到存储失败 (hash=${file.hash})`;
          result.errors.push(error);
          task?.errors.push(error);
          log(error);
          if (task) {
            task.failed = result.failed;
            task.processed = result.success + result.skipped.length + result.failed;
          }
        }
      } catch (e: any) {
        result.failed++;
        const error = `${file.name}: 上传失败 ${String(e?.message || e || '未知异常').substring(0, 200)}`;
        result.errors.push(error);
        task?.errors.push(error);
        log(error);
        if (task) {
          task.failed = result.failed;
          task.processed = result.success + result.skipped.length + result.failed;
        }
      }
    } catch (e: any) {
      result.failed++;
      const error = `${file.name}: 文件处理异常 ${String(e?.message || e || '未知异常').substring(0, 400)} (url=${downloadUrl})`;
      result.errors.push(error);
      task?.errors.push(error);
      log(error);
      if (task) {
        task.failed = result.failed;
        task.processed = result.success + result.skipped.length + result.failed;
      }
    }
  }
  
  if (task) {
    task.processed = result.success + result.skipped.length + result.failed;
    task.success = result.success;
    task.failed = result.failed;
    task.currentItem = '';
    task.currentFileReceived = 0;
    task.currentFileTotal = 0;
    task.currentFileStage = undefined;
    task.message = result.failed > 0
      ? `处理完成: 上传成功 ${result.success}, 跳过 ${result.skipped.length}, 失败 ${result.failed}`
      : `下载并上传完成: 成功 ${result.success}, 跳过 ${result.skipped.length}`;
    if (result.failed > 0) task.status = 'failed';
    log(`任务结束: success=${result.success} failed=${result.failed} total=${fileList.length}`);
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
