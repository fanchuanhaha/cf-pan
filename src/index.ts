// 彩虹外链网盘 - Cloudflare Workers 入口

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initApp, getStor, isStorageReady } from './middleware';
import type { AppEnv } from './middleware';

// 导入路由
import ajaxRoutes from './routes/ajax';
import apiRoutes from './routes/api';
import downloadRoutes from './routes/download';
import viewRoutes from './routes/view';
import adminAjaxRoutes from './routes/admin';
import frontendRoutes from './routes/frontend';
import installRoutes from './routes/install';

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

// 安装向导（不需要存储，优先级最高）
app.route('/install', installRoutes);

// 存储就绪检查中间件（仅对需要存储的路由生效）
const requireStorage = async (c: any, next: any) => {
  if (!isStorageReady(c)) {
    // 未安装或存储未配置
    const config = c.var.config;
    if (config.installed !== 1) {
      return c.redirect('/install/');
    }
    // 已安装但存储不可用（例如 R2 token 失效）
    return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>存储未配置</title>
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
<style>
body { background: #f5f5f5; padding: 50px 0; }
.box { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
.alert { padding: 15px; border-radius: 4px; margin-bottom: 20px; }
.alert-danger { background: #fee; color: #c33; border: 1px solid #fcc; }
pre { background: #f5f5f5; padding: 10px; border-radius: 4px; }
</style>
</head>
<body>
<div class="box">
  <h2><i class="fa fa-exclamation-triangle" style="color:#c33"></i> 存储后端不可用</h2>
  <div class="alert alert-danger">
    <p><strong>当前配置：</strong>${config.storage}</p>
    <p>存储后端未就绪，无法正常使用网盘功能。请检查：</p>
    <ul>
      ${config.storage === 'r2' ? '<li>Cloudflare R2 存储桶是否已创建</li><li>wrangler.toml 中的 R2 绑定是否正确</li><li>API Token 是否包含 R2 权限</li>' : ''}
      ${config.storage === 's3' ? '<li>S3 Endpoint / Bucket / AccessKey 等配置是否正确</li><li>S3 存储桶是否可访问</li>' : ''}
      ${config.storage === 'github' ? '<li>GitHub owner / repo / token 是否正确</li><li>Token 是否具备 repo 权限</li>' : ''}
    </ul>
  </div>
  <p>如需重新配置存储，请访问 <a href="/install/">/install/</a> 重新填写。</p>
</div>
</body>
</html>`, 503);
  }
  await next();
};

// 前端页面路由 (首页 / 文件查看 / 后台)
app.use('/', requireStorage);
app.use('/view.php', requireStorage);
app.use('/down.php', requireStorage);
app.use('/ajax.php', requireStorage);
app.use('/api.php', requireStorage);
app.use('/admin', requireStorage);

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

// 健康检查（不需要存储）
app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

// 404
app.notFound((c) => c.text('404 Not Found', 404));

export default app;
