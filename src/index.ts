// 彩虹外链网盘 - Cloudflare Workers 入口

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initApp } from './middleware';
import type { AppEnv } from './middleware';

// 导入路由
import ajaxRoutes from './routes/ajax';
import apiRoutes from './routes/api';
import downloadRoutes from './routes/download';
import viewRoutes from './routes/view';
import adminAjaxRoutes from './routes/admin';
import frontendRoutes from './routes/frontend';

const app = new Hono<AppEnv>();

// 全局 CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type'],
}));

// 注入 db + stor + config 到 context (统一使用 middleware)
app.use('*', initApp());

// =========== 路由挂载 ===========

// 前端页面路由 (首页 / 文件查看 / 后台)
app.route('/', frontendRoutes);

// AJAX 上传路由
app.route('/ajax.php', ajaxRoutes);

// 上传 API
app.route('/api.php', apiRoutes);

// 下载路由
app.route('/down.php', downloadRoutes);

// 预览路由
app.route('/view.php', viewRoutes);

// 后台 AJAX
app.route('/admin/ajax', adminAjaxRoutes);

// 健康检查
app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

export default app;
