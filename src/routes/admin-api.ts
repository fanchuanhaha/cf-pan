// 彩虹外链网盘 - 管理后台 API（存储迁移）

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf, getStorOrThrow } from '../middleware';
import { jsonError, jsonResult } from '../utils/response';
import { getAllFiles } from '../db';
import { createStorage } from '../storage/factory';
import { migrateFiles, getMigrationStatus, cancelMigration, createMigrationTask, type MigrationMode } from '../services/migrate';
import type { AppConfig } from '../config';

const adminApi = new Hono<AppEnv>();

// 日志中间件：记录所有 admin/api 请求
adminApi.use('*', async (c, next) => {
  const path = c.req.path || c.req.url;
  console.log(`[admin-api] ${c.req.method} ${path} storageOk=${c.var.storageOk} stor=${!!c.var.stor}`);
  await next();
});

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

// 数据恢复相关接口已迁移到 /install/api/*（见 install.ts）

export default adminApi;
