// 彩虹外链网盘 - 在线预览路由 (对应原 view.php / file_output inline)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf } from '../middleware';
import { getFileByHash } from '../db';
import { fileOutput } from '../services/upload';
import { getViewType } from '../utils/mime';
import { getStorageBackends, findStorageBackend } from '../storage/backends';
import { htmlspecialchars } from '../utils/response';

const view = new Hono<AppEnv>();

const PLAYER_CDN = {
  jquery: 'https://s4.zstatic.net/ajax/libs/jquery/2.1.4/jquery.min.js',
  aplayerCss: 'https://s4.zstatic.net/ajax/libs/aplayer/1.10.1/APlayer.min.css',
  aplayerJs: 'https://s4.zstatic.net/ajax/libs/aplayer/1.10.1/APlayer.min.js',
  ckplayerCss: '/assets/css/ckplayer.css',
  ckplayerJs: '/assets/js/ckplayer.min.js',
  hlsJs: 'https://s4.zstatic.net/ajax/libs/hls.js/1.2.4/hls.min.js',
  flvJs: 'https://s4.zstatic.net/ajax/libs/flv.js/1.6.2/flv.min.js',
  musicCover: '/assets/img/music.png',
};

// /view.php/embed/:hash.:ext 预览播放器（后台 iframe / 前台播放器代码用）
// 与本地原版 player.php / admin/file-view.php 保持一致：
// 音频用 APlayer，视频用 ckplayer（m3u8/flv 自动加载对应插件）。
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

  const db = getDB(c);
  const row = await getFileByHash(db, hash);
  if (!row) return new Response('404 Not Found', { status: 404 });
  if (row.block >= 1) return new Response('File is blocked!', { status: 403 });

  const realExt = (ext || row.type || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const src = `/view.php/${hash}${realExt ? '.' + realExt : ''}`;
  const viewType = getViewType(realExt);
  const name = row.name || '';
  const nameJson = JSON.stringify(name);
  const srcJson = JSON.stringify(src);
  const plug = realExt === 'm3u8' ? 'hls.js' : (realExt === 'flv' || realExt === 'f4v' ? 'flv.js' : '');

  let media = '';
  let scripts = '';
  if (viewType === 'image') {
    media = `<a href="${src}" title="点击查看原图" target="_blank"><img alt="loading" src="${src}" class="image_view" style="max-width:100%;max-height:100vh"></a>`;
  } else if (viewType === 'audio') {
    media = `<div class="view"><div id="aplayer"></div></div>`;
    scripts = `<script src="${PLAYER_CDN.aplayerJs}"></script>
<script>
var ap = new APlayer({
  container: document.getElementById('aplayer'),
  loop: 'none',
  theme: '#b2dae6',
  audio: [{
    title: ${nameJson},
    author: 'none',
    url: ${srcJson},
    cover: ${JSON.stringify(PLAYER_CDN.musicCover)}
  }]
});
</script>`;
  } else if (viewType === 'video') {
    media = `<div class="videoplayer" style="width:100%"></div>`;
    scripts = `<script src="${PLAYER_CDN.ckplayerJs}"></script>
${plug === 'hls.js' ? `<script src="${PLAYER_CDN.hlsJs}"></script>` : ''}
${plug === 'flv.js' ? `<script src="${PLAYER_CDN.flvJs}"></script>` : ''}
<script>
$(".videoplayer").height($(window).height());
var videoObject = {
  container: '.videoplayer',
  plug: ${JSON.stringify(plug)},
  video: ${srcJson},
  webFull: true
};
var player = new ckplayer(videoObject);
</script>`;
  } else {
    media = `<div class="other"><a href="${src}" target="_blank" rel="noopener">打开 / 下载文件</a></div>`;
  }

  return c.html(`<!DOCTYPE html>
<html lang="zh-cn"><head>
<meta charset="utf-8">
<meta name="renderer" content="webkit">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlspecialchars(name || '文件预览')}</title>
<link rel="stylesheet" href="${PLAYER_CDN.aplayerCss}">
<link rel="stylesheet" href="${PLAYER_CDN.ckplayerCss}">
<script src="${PLAYER_CDN.jquery}"></script>
<style>
html,body{margin:0;padding:0;}
body{background:#fff;}
#preview{text-align:center;}
.image_view{display:inline-block;}
.other{padding:24px;font:16px/1.5 sans-serif;color:#333;}
.other a{color:#337ab7;}
</style>
</head>
<body>
<div id="preview" align="center">${media}</div>
${scripts}
</body></html>`);
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
