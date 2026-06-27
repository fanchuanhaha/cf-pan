// 彩虹外链网盘 - 管理后台 API（存储迁移、数据恢复）

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf, getStorOrThrow } from '../middleware';
import { jsonError, jsonResult } from '../utils/response';
import { getAllFiles, getFileTotal } from '../db';
import { createStorage } from '../storage/factory';
import { migrateFiles, getMigrationStatus, cancelMigration, createMigrationTask, type MigrationMode } from '../services/migrate';
import { 
  createRestoreTask, 
  getRestoreStatus, 
  cancelRestore, 
  downloadFromUrl, 
  extractZip, 
  restoreDatabaseFromSql, 
  restoreFilesFromZip,
  restoreFilesFromSource
} from '../services/restore';
import type { AppConfig } from '../config';

const adminApi = new Hono<AppEnv>();

// ===================== 存储迁移 =====================

/** 开始迁移任务 */
adminApi.post('/migrate/start', async (c) => {
  const db = getDB(c);
  const currentConfig = getConf(c);
  const body = await c.req.parseBody() as Record<string, string>;
  
  const mode = (body['mode'] || 'new') as MigrationMode;
  const targetType = body['target_type'] as 'r2' | 's3' | 'github' | 'webdav' | 'upyun' | 'qiniu';
  
  if (!['copy', 'new', 'switch'].includes(mode)) {
    return jsonError(c, '无效的迁移模式');
  }
  
  if (!targetType) {
    return jsonError(c, '请选择目标存储类型');
  }
  
  // 构建目标存储配置
  const targetConfig: AppConfig = { ...currentConfig, storage: targetType };
  
  if (targetType === 'r2') {
    targetConfig.storage = 'r2';
  } else if (targetType === 's3') {
    targetConfig.s3_endpoint = body['s3_endpoint'] || currentConfig.s3_endpoint;
    targetConfig.s3_region = body['s3_region'] || currentConfig.s3_region;
    targetConfig.s3_bucket = body['s3_bucket'] || currentConfig.s3_bucket;
    targetConfig.s3_ak = body['s3_ak'] || currentConfig.s3_ak;
    targetConfig.s3_sk = body['s3_sk'] || currentConfig.s3_sk;
  } else if (targetType === 'github') {
    targetConfig.gh_owner = body['gh_owner'] || currentConfig.gh_owner;
    targetConfig.gh_repo = body['gh_repo'] || currentConfig.gh_repo;
    targetConfig.gh_token = body['gh_token'] || currentConfig.gh_token;
    targetConfig.gh_ref = body['gh_ref'] || currentConfig.gh_ref;
    targetConfig.gh_api_base = body['gh_api_base'] || currentConfig.gh_api_base;
  } else if (targetType === 'webdav') {
    targetConfig.webdav_endpoint = body['webdav_endpoint'] || currentConfig.webdav_endpoint;
    targetConfig.webdav_user = body['webdav_user'] || currentConfig.webdav_user;
    targetConfig.webdav_pass = body['webdav_pass'] || currentConfig.webdav_pass;
    targetConfig.webdav_folder = body['webdav_folder'] || currentConfig.webdav_folder;
  } else if (targetType === 'upyun') {
    targetConfig.upyun_bucket = body['upyun_bucket'] || currentConfig.upyun_bucket;
    targetConfig.upyun_operator = body['upyun_operator'] || currentConfig.upyun_operator;
    targetConfig.upyun_password = body['upyun_password'] || currentConfig.upyun_password;
    targetConfig.upyun_endpoint = body['upyun_endpoint'] || currentConfig.upyun_endpoint;
    targetConfig.upyun_domain = body['upyun_domain'] || currentConfig.upyun_domain;
    targetConfig.upyun_folder = body['upyun_folder'] || currentConfig.upyun_folder;
  } else if (targetType === 'qiniu') {
    targetConfig.qiniu_ak = body['qiniu_ak'] || currentConfig.qiniu_ak;
    targetConfig.qiniu_sk = body['qiniu_sk'] || currentConfig.qiniu_sk;
    targetConfig.qiniu_bucket = body['qiniu_bucket'] || currentConfig.qiniu_bucket;
    targetConfig.qiniu_region = body['qiniu_region'] || currentConfig.qiniu_region;
    targetConfig.qiniu_domain = body['qiniu_domain'] || currentConfig.qiniu_domain;
    targetConfig.qiniu_folder = body['qiniu_folder'] || currentConfig.qiniu_folder;
  }
  
  const targetStor = createStorage(targetConfig, { FILE_R2: c.env.FILE_R2 });
  if (!targetStor) {
    return jsonError(c, '目标存储配置无效');
  }
  
  // 检查源存储
  const sourceStor = c.var.stor;
  if (!sourceStor) {
    return jsonError(c, '源存储未配置');
  }
  
  const taskId = 'mig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  createMigrationTask(taskId);
  
  // 异步执行迁移
  c.executionCtx.waitUntil((async () => {
    try {
      let files: Array<{ hash: string; name: string }> = [];
      if (mode === 'copy') {
        // 复制模式：获取所有文件
        const allFiles = await getAllFiles(db);
        files = allFiles.map(f => ({ hash: f.hash, name: f.name }));
      }
      
      const progress = await migrateFiles(sourceStor, targetStor, files, mode, taskId);
      
      // 迁移完成后，根据模式更新配置
      if (mode === 'copy' || mode === 'switch') {
        // 完全切换：更新 storage 配置
        for (const [k, v] of Object.entries(targetConfig)) {
          if (k !== 'storage') {
            await db.prepare('INSERT OR REPLACE INTO pre_config (k, v) VALUES (?, ?)').bind(k, String(v)).run();
          }
        }
        await db.prepare('INSERT OR REPLACE INTO pre_config (k, v) VALUES (?, ?)').bind('storage', targetType).run();
      } else if (mode === 'new') {
        // 新文件用新存储：保存新配置但不删除旧文件
        // 这里只保存 storage 类型，新上传会使用新存储
        await db.prepare('INSERT OR REPLACE INTO pre_config (k, v) VALUES (?, ?)').bind('storage', targetType).run();
      }
    } catch (e: any) {
      console.error('Migration error:', e);
    }
  })());
  
  return jsonResult(c, { code: 0, msg: '迁移任务已启动', taskId });
});

/** 查询迁移状态 */
adminApi.get('/migrate/status', async (c) => {
  const taskId = c.req.query('taskId');
  if (!taskId) return jsonError(c, '缺少 taskId');
  
  const status = getMigrationStatus(taskId);
  if (!status) return jsonError(c, '任务不存在');
  
  return jsonResult(c, { code: 0, data: status });
});

/** 取消迁移 */
adminApi.post('/migrate/cancel', async (c) => {
  const body = await c.req.parseBody() as Record<string, string>;
  const taskId = body['taskId'];
  if (!taskId) return jsonError(c, '缺少 taskId');
  cancelMigration(taskId);
  return jsonResult(c, { code: 0, msg: '已取消' });
});

// ===================== 数据恢复 =====================

/** 步骤1：上传或下载 SQL 文件并恢复数据库 */
adminApi.post('/restore/sql', async (c) => {
  const db = getDB(c);
  const taskId = 'rst_sql_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  createRestoreTask(taskId);
  
  try {
    let sqlContent = '';
    
    // 支持文件上传或 URL 下载
    const body = await c.req.parseBody() as Record<string, string | File>;
    const sqlFile = body['sql_file'] as File | undefined;
    const sqlUrl = body['sql_url'] as string | undefined;
    
    if (sqlFile && sqlFile.size > 0) {
      // Cloudflare Workers 请求体限制 100MB
      if (sqlFile.size > 90 * 1024 * 1024) {
        return jsonError(c, 'SQL 文件太大（' + (sqlFile.size / 1024 / 1024).toFixed(2) + 'MB），请使用 URL 方式或拆分后上传（最大 90MB）');
      }
      try {
        const text = await sqlFile.text();
        sqlContent = text;
      } catch (e: any) {
        return jsonError(c, '读取文件失败: ' + (e.message || e));
      }
    } else if (sqlUrl) {
      // 从 URL 下载 - 立即返回 taskId，异步执行
      c.executionCtx.waitUntil((async () => {
        try {
          const data = await downloadFromUrl(sqlUrl, taskId);
          const sqlText = new TextDecoder().decode(data);
          const result = await restoreDatabaseFromSql(db, sqlText, taskId);
          const task = getRestoreStatus(taskId);
          if (task) {
            task.status = 'completed';
            task.stage = 'done';
            task.message = '数据库恢复完成';
          }
        } catch (e: any) {
          const task = getRestoreStatus(taskId);
          if (task) {
            task.status = 'failed';
            task.errors.push('下载/恢复失败: ' + (e.message || e));
          }
        }
      })());
      return jsonResult(c, {
        code: 0,
        msg: '任务已启动，请轮询 /admin/api/restore/status?taskId=' + taskId,
        data: { taskId }
      });
    } else {
      return jsonError(c, '请提供 SQL 文件或 URL');
    }
    
    if (!sqlContent || sqlContent.trim().length === 0) {
      return jsonError(c, 'SQL 文件内容为空');
    }
    
    // 执行恢复
    const result = await restoreDatabaseFromSql(db, sqlContent, taskId);
    
    return jsonResult(c, {
      code: 0,
      msg: '数据库恢复完成',
      data: { taskId, ...result },
    });
  } catch (e: any) {
    console.error('SQL restore error:', e);
    return jsonError(c, '恢复失败: ' + (e.message || e));
  }
});

/** 步骤2：上传或下载 ZIP 文件并恢复文件 */
adminApi.post('/restore/files', async (c) => {
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const taskId = 'rst_files_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  createRestoreTask(taskId);
  
  try {
    let zipData: ArrayBuffer;
    
    const body = await c.req.parseBody() as Record<string, string | File>;
    const zipFile = body['zip_file'] as File | undefined;
    const zipUrl = body['zip_url'] as string | undefined;
    
    if (zipFile && zipFile.size > 0) {
      // Cloudflare Workers 请求体限制 100MB
      if (zipFile.size > 90 * 1024 * 1024) {
        return jsonError(c, 'ZIP 文件太大（' + (zipFile.size / 1024 / 1024).toFixed(2) + 'MB），请使用 URL 方式（最大 90MB）');
      }
      zipData = await zipFile.arrayBuffer();
    } else if (zipUrl) {
      // URL 异步下载，立即返回 taskId
      c.executionCtx.waitUntil((async () => {
        try {
          const data = await downloadFromUrl(zipUrl, taskId);
          const files = await extractZip(data, taskId);
          const result = await restoreFilesFromZip(stor, files, taskId);
          const task = getRestoreStatus(taskId);
          if (task) {
            task.status = 'completed';
            task.stage = 'done';
            task.message = '文件恢复完成';
          }
        } catch (e: any) {
          const task = getRestoreStatus(taskId);
          if (task) {
            task.status = 'failed';
            task.errors.push('下载/恢复失败: ' + (e.message || e));
          }
        }
      })());
      return jsonResult(c, {
        code: 0,
        msg: '任务已启动，请轮询 /admin/api/restore/status?taskId=' + taskId,
        data: { taskId }
      });
    } else {
      return jsonError(c, '请提供 ZIP 文件或 URL');
    }
    
    // 解压
    const files = await extractZip(zipData, taskId);
    
    // 恢复到存储
    const result = await restoreFilesFromZip(stor, files, taskId);
    
    return jsonResult(c, {
      code: 0,
      msg: '文件恢复完成',
      data: { taskId, fileCount: files.length, ...result },
    });
  } catch (e: any) {
    console.error('Files restore error:', e);
    return jsonError(c, '恢复失败: ' + (e.message || e));
  }
});

/** 步骤2（新版）：输入原站点 URL，从原站点批量下载文件到当前存储 */
adminApi.post('/restore/files-from-source', async (c) => {
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const taskId = 'rst_src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  createRestoreTask(taskId);
  
  try {
    const body = await c.req.parseBody() as Record<string, string>;
    const sourceUrl = (body['source_url'] || '').trim();
    
    if (!sourceUrl) {
      return jsonError(c, '请提供原站点 URL');
    }
    
    // 异步执行批量下载
    c.executionCtx.waitUntil((async () => {
      try {
        const result = await restoreFilesFromSource(db, stor, sourceUrl, taskId);
        const task = getRestoreStatus(taskId);
        if (task) {
          task.status = 'completed';
          task.stage = 'done';
        }
      } catch (e: any) {
        const task = getRestoreStatus(taskId);
        if (task) {
          task.status = 'failed';
          task.errors.push('批量下载失败: ' + (e.message || e));
        }
      }
    })());
    
    return jsonResult(c, {
      code: 0,
      msg: '任务已启动，请轮询 /admin/api/restore/status?taskId=' + taskId,
      data: { taskId }
    });
  } catch (e: any) {
    console.error('Restore from source error:', e);
    return jsonError(c, '启动失败: ' + (e.message || e));
  }
});

/** 查询恢复状态 */
adminApi.get('/restore/status', async (c) => {
  const taskId = c.req.query('taskId');
  if (!taskId) return jsonError(c, '缺少 taskId');
  
  const status = getRestoreStatus(taskId);
  if (!status) return jsonError(c, '任务不存在');
  
  return jsonResult(c, { code: 0, data: status });
});

/** 取消恢复 */
adminApi.post('/restore/cancel', async (c) => {
  const body = await c.req.parseBody() as Record<string, string>;
  const taskId = body['taskId'];
  if (!taskId) return jsonError(c, '缺少 taskId');
  cancelRestore(taskId);
  return jsonResult(c, { code: 0, msg: '已取消' });
});

export default adminApi;
