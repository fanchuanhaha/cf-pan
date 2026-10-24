// 彩虹外链网盘 - 在线预览路由 (对应原 view.php / file_output inline)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf } from '../middleware';
import { getFileByHash } from '../db';
import { fileOutput } from '../services/upload';
import { getViewType } from '../utils/mime';
import { getStorageBackends, findStorageBackend } from '../storage/backends';

const view = new Hono<AppEnv>();

// /view.php/embed/:hash.:ext 预览播放器（后台 iframe 用）
// 只输出媒体元素本身，不带页面框架；媒体由 <video>/<audio>/<img> 加载，
// 与首页播放器完全同一条链路，不受 Content-Disposition 影响。
view.get('/embed/*', async (c) => {
  let path = c.req.path.replace(/^\/view\.php\/embed\//, '').replace(/\/+$/, '');
  let hash = path;
  let ext = (c.req.query('ext') || '').toLowerCase();

  // 兼容 /embed/<hash>.<ext> 与 /embed/<hash>?ext=xxx 两种写法
  const dotPos = path.lastIndexOf('.');
  if (dotPos !== -1) {
    hash = path.substring(0, dotPos);
    if (!ext) ext = path.substring(dotPos + 1).toLowerCase();
  }

  if (!/^[0-9a-f]{32}$/i.test(hash)) {
    return new Response('Invalid hash', { status: 400 });
  }

  const src = `/view.php/${hash}${ext ? '.' + ext : ''}`;
  const viewType = getViewType(ext);
  let media: string;
  if (viewType === 'video') {
    media = `<video src="${src}" controls playsinline preload="metadata"></video>`;
  } else if (viewType === 'audio') {
    media = `<audio src="${src}" controls preload="metadata"></audio>`;
  } else if (viewType === 'image') {
    media = `<img src="${src}" alt="preview">`;
  } else {
    media = `<div class="other"><a href="${src}" target="_blank" rel="noopener">打开 / 下载文件</a></div>`;
  }

  return c.html(`<!DOCTYPE html>
<html lang="zh-cn"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}
video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
img{display:block;max-width:100%;max-height:100%;margin:auto;object-fit:contain}
body.audio{display:flex;align-items:center;justify-content:center}
audio{width:90%}
.other{display:flex;align-items:center;justify-content:center;height:100%;color:#fff;font:16px/1.5 sans-serif}
.other a{color:#4da3ff}
</style></head>
<body${viewType === 'audio' ? ' class="audio"' : ''}>${media}</body></html>`);
});

// /view.php/:hash.:ext 直接流式输出文件 (用于 img/audio/video src)
view.get('/*', async (c) => {
  const db = getDB(c);
  const config = getConf(c);

  const path = c.req.path.replace(/^\/view\.php\//, '');
  let hash: string;
  const dotPos = path.indexOf('.');
  if (dotPos !== -1) {
    hash = path.substring(0, dotPos);
  } else {
    hash = path;
  }

  if (!/^[0-9a-f]{32}$/i.test(hash)) {
    return new Response('Invalid hash', { status: 400 });
  }

  const row = await getFileByHash(db, hash);
  if (!row) return new Response('404 Not Found', { status: 404 });
  if (row.block >= 1) return new Response('File is blocked!', { status: 403 });

  const backends = getStorageBackends(config, c.env);
  const found = await findStorageBackend(backends, hash);
  if (!found.backend) return new Response('File Not Found', { status: 404 });

  return fileOutput(c, found.backend.stor, hash, row.type, row.size, row.name);
});

export default view;
