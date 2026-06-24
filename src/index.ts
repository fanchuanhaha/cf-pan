// 彩虹外链网盘 - Cloudflare Workers 入口

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { IStorage } from './storage/IStorage';
import type { AppConfig } from './config';
import { loadConfig } from './config';
import { createStorage } from './storage/factory';
import { verifyAdminToken } from './auth/admin';
import { validateUserToken } from './auth/user';
import { getUserById, updateUserLogin } from './db';
import { getClientIP } from './utils/response';

// 导入路由
import ajaxRoutes from './routes/ajax';
import apiRoutes from './routes/api';
import downloadRoutes from './routes/download';
import viewRoutes from './routes/view';
import adminAjaxRoutes from './routes/admin';
import frontendRoutes from './routes/frontend';

// 绑定定义
type Bindings = {
  DB: D1Database;
  FILE_R2: R2Bucket;
  AI?: unknown;
};

const app = new Hono<{ Bindings: Bindings }>();

// 全局 CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type'],
}));

// 注入 db + stor + config 到 context
app.use('*', async (c, next) => {
  const db = c.env.DB;
  const config = await loadConfig(db);
  const stor = createStorage(config, { FILE_R2: c.env.FILE_R2 });

  if (!stor) {
    return c.text('Storage initialization failed', 500);
  }

  // 挂载到 c.env 上供路由使用 (路由层通过 getDB/getStor/getConf 获取)
  // 使用 Hono Context 的 extend 方式
  (c as unknown as Record<string, unknown>)['__db'] = db;
  (c as unknown as Record<string, unknown>)['__stor'] = stor;
  (c as unknown as Record<string, unknown>)['__conf'] = config;

  await next();
});

// =========== 路由挂载 ===========

// 保存上下文到 ctx 的中间件
const withAppCtx: any = async (c: any, next: any) => {
  // 将 __db / __stor / __conf 投射到 c.var 供路由使用
  if (!c.var) c.var = {};
  c.var.db = c['__db'] || c.env.DB;
  c.var.stor = c['__stor'];
  c.var.config = c['__conf'];
  await next();
};

// 前端页面路由 (首页 / 文件查看 / 后台)
app.route('/', frontendRoutes);

// AJAX 上传路由
app.route('/ajax.php', withAppCtx, ajaxRoutes);

// 上传 API
app.route('/api.php', withAppCtx, apiRoutes);

// 下载路由
app.route('/down.php', withAppCtx, downloadRoutes);

// 预览路由
app.route('/view.php', withAppCtx, viewRoutes);

// 后台 AJAX
app.route('/admin/ajax', withAppCtx, adminAjaxRoutes);

// 健康检查
app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

// 404 兜底
app.notFound((c) => {
  const url = new URL(c.req.url);
  if (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/admin/')) {
    return c.text('Not Found', 404);
  }
  return c.text('Not Found', 404);
});

export default app;
