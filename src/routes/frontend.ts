// 彩虹外链网盘 - 页面渲染完成 (SSR 模板直出，保持原 jQuery+Bootstrap 界面)
// 仿照原 PHP 项目结构:
//   /                -> index.php 文件列表
//   /upload.php      -> upload.php 上传页面//   /file.php?hash=  -> file.php 文件查看
//   /admin           -> admin/index.php 后台首页
//   /admin/file      -> admin/file.php 文件管理
//   /admin/login     -> admin/login.php

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf, getStor, getStorOrThrow } from '../middleware';
import { updateConfig, clearConfigCache } from '../config';
import { getFileByHash, getFileById, setFileBlock, deleteFile, updateFile, touchFile, getFileCountByDateRange } from '../db';
import { getStorageBackends, deleteObjectFromBackends } from '../storage/backends';
import { verifyAdminToken, signAdminToken } from '../auth/admin';
import { getViewType, sizeFormat, typeToIcon, isView } from '../utils/mime';
import { htmlspecialchars, generateCsrfToken, jsonResult, jsonError } from '../utils/response';
import { purgeHomeCache } from '../utils/cache';

const frontend = new Hono<AppEnv>();

// CDN 资源（与原项的header.php/footer.php 完全一致）
const CDN = {
  jquery: 'https://s4.zstatic.net/ajax/libs/jquery/1.12.4/jquery.min.js',
  bootstrapCss: 'https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css',
  bootstrapJs: 'https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/js/bootstrap.min.js',
  fontAwesome: 'https://s4.zstatic.net/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css',
materialCss: 'https://cdnjs.cloudflare.com/ajax/libs/bootstrap-material-design/0.5.10/css/bootstrap-material-design.min.css',
  ripplesCss: 'https://cdnjs.cloudflare.com/ajax/libs/bootstrap-material-design/0.5.10/css/ripples.min.css',
  materialJs: 'https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/js/material.min.js',
  ripplesJs: 'https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/js/ripples.min.js',
  aplayerCss: 'https://s4.zstatic.net/ajax/libs/aplayer/1.10.1/APlayer.min.css',
  aplayerJs: 'https://s4.zstatic.net/ajax/libs/aplayer/1.10.1/APlayer.min.js',
  clipboard: 'https://s4.zstatic.net/ajax/libs/clipboard.js/2.0.4/clipboard.min.js',
  layer: 'https://s4.zstatic.net/ajax/libs/layer/3.1.1/layer.min.js',
  vue: 'https://s4.zstatic.net/ajax/libs/vue/2.6.14/vue.min.js',
  qrcode: 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=10&data=',
  // admin
  jquery2: 'https://s4.zstatic.net/ajax/libs/jquery/2.1.4/jquery.min.js',
  bootstrapTableCss: 'https://s4.zstatic.net/ajax/libs/bootstrap-table/1.21.4/bootstrap-table.min.css',
  bootstrapTableJs: 'https://s4.zstatic.net/ajax/libs/bootstrap-table/1.21.4/bootstrap-table.min.js',
  bootstrapTablePageJump: 'https://s4.zstatic.net/ajax/libs/bootstrap-table/1.21.4/extensions/page-jump-to/bootstrap-table-page-jump-to.min.js',
};

// ===================== 通用 layout（仿照原 header.php + footer.php） =====================
function siteUrl(c: any): string {
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}`;
}

/** 顶部导航栏（仿原 header.php）*/
function publicNavBar(active: 'index' | 'upload' | 'file' | 'mine', siteUrlStr: string, siteTitle: string): string {
  const cls = (key: string) => active === key ? 'active' : '';
  return `<div class="navbar navbar-default">
<div class="container">
  <div class="navbar-header">
    <button type="button" class="navbar-toggle" data-toggle="collapse" data-target=".navbar-responsive-collapse">
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
    </button>
    <a class="navbar-brand" href="./">${htmlspecialchars(siteTitle)}</a>
  </div>
  <div class="navbar-collapse collapse navbar-responsive-collapse">
    <ul class="nav navbar-nav">
      <li class="${cls('index')}"><a href="./"><i class="fa fa-list" aria-hidden="true"></i> 文件列表</a></li>
      <li class="${cls('upload')}"><a href="./upload.php"><i class="fa fa-upload" aria-hidden="true"></i> 上传文件</a></li>
      ${active === 'file' ? `<li class="active"><a href=""><i class="fa fa-file" aria-hidden="true"></i> 文件查看</a></li>` : ''}
    </ul>
    <ul class="nav navbar-nav navbar-right">
      <li class="${cls('mine')}"><a href="./?m=mine"><i class="fa fa-folder-open" aria-hidden="true"></i> 我的文件</a></li>
    </ul>
  </div>
</div>
</div>`;
}

function publicFooter(siteTitle: string, tongji: string = ''): string {
  return `<footer class="footer text-center">
<div class="container">
<p class="text-muted">Copyright &copy; ${new Date().getFullYear()} <a href="/">${htmlspecialchars(siteTitle)}</a> ${tongji}</p>
</div>
</footer>`;
}

/** 前台页面通用 layout（与原 header.php/footer.php 完全一致） */
function publicLayout(title: string, body: string, siteUrlStr: string, active: 'index' | 'upload' | 'file' | 'mine' = 'index', isFile: boolean = false, siteTitle: string = '彩虹外链网盘', tongji: string = ''): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="renderer" content="webkit">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${htmlspecialchars(title)}</title>
<meta name="viewport" content="width=device-width,height=device-height,inital-scale=1.0,maximum-scale=1.0,user-scalable=no;">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="format-detection" content="telephone=no">
<link href="${CDN.fontAwesome}" rel="stylesheet">
<link href="${CDN.bootstrapCss}" rel="stylesheet">
<link href="${CDN.materialCss}" rel="stylesheet">
<link href="${CDN.ripplesCss}" rel="stylesheet">
${isFile ? `<link rel="stylesheet" href="${CDN.aplayerCss}"><link href="assets/css/ckplayer.css" rel="stylesheet">` : ''}
<link href="assets/css/style.css" rel="stylesheet">
<link href="assets/css/dark.css" rel="stylesheet">
<link rel="icon" href="favicon.ico" type="image/x-icon">
<!--[if lt IE 9]>
<script src="https://s4.zstatic.net/ajax/libs/html5shiv/3.7.3/html5shiv.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/respond.js/1.4.2/respond.min.js"></script>
<![endif]-->
<script src="${CDN.jquery}"></script>
</head>
<body>
${publicNavBar(active, siteUrlStr, siteTitle)}
${body}
${publicFooter(siteTitle, tongji)}
<script src="${CDN.bootstrapJs}"></script>
<script src="${CDN.materialJs}"></script>
<script src="${CDN.ripplesJs}"></script>
<script>if (typeof $.material !== 'undefined') $.material.init();</script>
</body>
</html>`;
}

/** 管理后台 layout（仿原 admin/head.php
*/
function adminLayout(title: string, body: string, siteUrlStr: string, active: 'index' | 'file' | 'user' | 'set' = 'index', showNav: boolean = true, siteTitle: string = '彩虹外链网盘'): string {
  const cls = (key: string) => active === key ? 'active' : '';
  const nav = showNav ? `<nav class="navbar navbar-fixed-top navbar-default">
<div class="container">
  <div class="navbar-header">
    <button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#navbar" aria-expanded="false" aria-controls="navbar">
      <span class="sr-only">导航按钮</span>
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
    </button>
    <a class="navbar-brand" href="/admin">${htmlspecialchars(siteTitle)}管理中心</a>
  </div>
  <div id="navbar" class="collapse navbar-collapse">
    <ul class="nav navbar-nav navbar-right">
      <li class="${cls('index')}"><a href="/admin"><i class="fa fa-home"></i> 后台首页</a></li>
       <li class="${cls('file')}"><a href="/admin/file"><i class="fa fa-folder-open"></i> 文件管理</a></li>
       <li class="${cls('user')}"><a href="/admin/user"><i class="fa fa-users"></i> 用户管理</a></li>
    <li class="dropdown ${cls('set')}" id="admin-settings-menu">
        <a href="#" class="dropdown-toggle" data-toggle="dropdown" role="button" aria-haspopup="true" aria-expanded="false"><i class="fa fa-cog"></i> 系统设置 <span class="caret"></span></a>
        <ul class="dropdown-menu">
          <li><a href="/admin/set?mod=site"><i class="fa fa-info-circle"></i> 网站信息设置</a></li>
          <li><a href="/admin/set?mod=user"><i class="fa fa-users"></i> 用户登录设置</a></li>
          <li><a href="/admin/set?mod=stor"><i class="fa fa-database"></i> 存储类型设置</a></li>
          <li><a href="/admin/set?mod=file"><i class="fa fa-upload"></i> 文件上传设置</a></li>
           <li><a href="/admin/set?mod=green"><i class="fa fa-image"></i> 图片检测设置</a></li>
          <li><a href="/admin/set?mod=api"><i class="fa fa-code"></i> 上传API设置</a></li>
           <li><a href="/admin/set?mod=account"><i class="fa fa-user-secret"></i> 管理员账号设置</a></li>
        </ul>
      </li>
       <li><a href="/admin/login?logout=1" onclick="return confirm('确定退出登录吗？')"><i class="fa fa-sign-out"></i> 退出登录</a></li>
    </ul>
  </div>
</div>
</nav>` : '';
  return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="utf-8"/>
<meta name="renderer" content="webkit">
<meta name="viewport" content="width=device-width,height=device-height,inital-scale=1.0,maximum-scale=1.0,user-scalable=no;">
<title>${htmlspecialchars(title)}</title>
<link href="${CDN.bootstrapCss}" rel="stylesheet"/>
<link href="${CDN.fontAwesome}" rel="stylesheet"/>
<link href="${CDN.bootstrapTableCss}" rel="stylesheet"/>
<link href="/assets/css/admin.css" rel="stylesheet"/>
<link href="/assets/css/dark.css" rel="stylesheet"/>
<script src="${CDN.jquery2}"></script>
<script src="${CDN.bootstrapJs}"></script>
<script src="https://s4.zstatic.net/ajax/libs/layer/2.3/layer.js"></script>
<!--[if lt IE 9]>
<script src="https://s4.zstatic.net/ajax/libs/html5shiv/3.7.3/html5shiv.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/respond.js/1.4.2/respond.min.js"></script>
<![endif]-->
</head>
<body>
${nav}
${body}
</body>
</html>`;
}

/**
 * 原版 admin/head.php 的 1:1 复刻（只把 PHP 链接换成 Worker 路由）。
 * 文件管理页必须用这个 layout：原版没有 admin.css / layer 2.3，
 * 并且 bootstrap-table 用的是本地 assets/css/bootstrap-table.css?v=1。
 * dark.css 仅在系统深色模式（prefers-color-scheme: dark）下生效，
 * 浅色模式仍保持原版外观。
 */
function adminOriginalLayout(title: string, body: string, active: 'index' | 'file' | 'user' | 'set' = 'index'): string {
  const cls = (key: string) => active === key ? 'active' : '';
  return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
  <meta charset="utf-8"/>
  <meta name="renderer" content="webkit">
  <meta name="viewport" content="width=device-width,height=device-height,inital-scale=1.0,maximum-scale=1.0,user-scalable=no;">
  <title>${htmlspecialchars(title)}</title>
  <link href="${CDN.bootstrapCss}" rel="stylesheet"/>
  <link href="${CDN.fontAwesome}" rel="stylesheet"/>
  <link href="/assets/css/bootstrap-table.css?v=1" rel="stylesheet"/>
  <link href="/assets/css/dark.css" rel="stylesheet"/>
  <script src="${CDN.jquery2}"></script>
  <script src="${CDN.bootstrapJs}"></script>
  <!--[if lt IE 9]>
    <script src="https://s4.zstatic.net/ajax/libs/html5shiv/3.7.3/html5shiv.min.js"></script>
    <script src="https://s4.zstatic.net/ajax/libs/respond.js/1.4.2/respond.min.js"></script>
  <![endif]-->
</head>
<body>
  <nav class="navbar navbar-fixed-top navbar-default">
    <div class="container">
      <div class="navbar-header">
        <button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#navbar" aria-expanded="false" aria-controls="navbar">
          <span class="sr-only">导航按钮</span>
          <span class="icon-bar"></span>
          <span class="icon-bar"></span>
          <span class="icon-bar"></span>
        </button>
        <a class="navbar-brand" href="/admin">彩虹外链网盘管理中心</a>
      </div><!-- /.navbar-header -->
      <div id="navbar" class="collapse navbar-collapse">
        <ul class="nav navbar-nav navbar-right">
          <li class="${cls('index')}">
            <a href="/admin"><i class="fa fa-home"></i> 后台首页</a>
          </li>
          <li class="${cls('file')}">
            <a href="/admin/file"><i class="fa fa-folder-open"></i> 文件管理</a>
          </li>
          <li class="${cls('user')}">
            <a href="/admin/user"><i class="fa fa-users"></i> 用户管理</a>
          </li>
          <li class="${cls('set')}">
            <a href="#" class="dropdown-toggle" data-toggle="dropdown"><i class="fa fa-cog"></i> 系统设置<b class="caret"></b></a>
            <ul class="dropdown-menu">
              <li><a href="/admin/set?mod=site">网站信息设置</a></li>
              <li><a href="/admin/set?mod=user">用户登录设置</a></li>
              <li><a href="/admin/set?mod=stor">存储类型设置</a></li>
              <li><a href="/admin/set?mod=file">文件上传设置</a></li>
              <li><a href="/admin/set?mod=green">图片检测设置</a></li>
              <li><a href="/admin/set?mod=api">上传API设置</a></li>
              <li><a href="/admin/set?mod=iptype">用户IP地址设置</a></li>
              <li><a href="/admin/set?mod=account">管理账号设置</a></li>
            </ul>
          </li>
          <li><a href="/admin/login?logout=1" onclick="return confirm('是否确定退出登录？')"><i class="fa fa-sign-out"></i> 退出登录</a></li>
        </ul>
      </div><!-- /.navbar-collapse -->
    </div><!-- /.container -->
  </nav><!-- /.navbar -->
${body}
</body>
</html>`;
}

// ===================== 首页（服务端渲染，老浏览器兼容） =====================
frontend.get('/', async (c) => {
  const config = getConf(c);
  const db = getDB(c);
  const siteUrlStr = siteUrl(c);

  const isMine = c.req.query('m') === 'mine';
  // 首页可缓存：m=mine 依赖 cookie，不能进公共缓存
  const cacheable = !isMine && c.req.method === 'GET';
  const edgeCache = (globalThis as any).caches?.default as any;
  const cacheKey = cacheable ? new Request(c.req.url, { method: 'GET' }) : null;
  if (cacheable && edgeCache && cacheKey) {
    try {
      const hit = await edgeCache.match(cacheKey);
      if (hit) {
        const res = new Response(hit.body, hit);
        res.headers.set('X-Cache', 'HIT');
        return res;
      }
    } catch {}
  }
  const searchEnabled = config.filesearch === 1;
  const kw = searchEnabled ? (c.req.query('kw') || '').trim() : '';
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const pageSize = 15;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: any[] = [];
  if (isMine) {
    const cookie = c.req.header('cookie') || '';
    const match = cookie.match(/file_ids=([^;]+)/);
    let ids: number[] = [];
    if (match) {
      try {
        const decoded = atob(decodeURIComponent(match[1]));
        ids = decoded.split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
      } catch {}
    }
    if (ids.length > 0) {
      ids = ids.slice(0, 60);
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    } else {
      where.push('1=2');
    }
  } else {
    where.push('hide=0');
    if (kw) {
      where.push('name LIKE ?');
      params.push(`%${kw}%`);
    }
  }

  const { results: rawRows } = await db.prepare(
    `SELECT * FROM pre_file WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all<any>();
  const { results: countRow } = await db.prepare(
    `SELECT count(*) as cnt FROM pre_file WHERE ${where.join(' AND ')}`
  ).bind(...params).all<{ cnt: number }>();
  const totalCount = countRow[0]?.cnt || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const link = (p: number) => {
    const sp = new URLSearchParams();
    if (isMine) sp.set('m', 'mine');
    if (kw) sp.set('kw', kw);
    if (p > 1) sp.set('page', String(p));
    const qs = sp.toString();
    return './' + (qs ? '?' + qs : '');
  };

  const title = isMine ? '我的文件 - ' + config.title : config.title;
  const htext = isMine ? '我上传的文件' : '文件列表';

  const tableRows = rawRows.map((res: any, i: number) => {
    const fileurl = `down.php/${res.hash}.${res.type || 'file'}`;
    const viewurl = `file.php?hash=${res.hash}`;
    const icon = typeToIcon(res.type);
    return `<tr>
<td><b>${offset + i + 1}</b></td>
<td><a href="${fileurl}">下载</a>｜<a href="${viewurl}">查看</a></td>
<td><i class="fa ${icon} fa-fw"></i>${htmlspecialchars(res.name)}</td>
<td>${sizeFormat(res.size)}</td>
<td><font color="blue">${res.type || '未知类型'}</font></td>
<td>${res.addtime}</td>
<td>${(res.ip || '').replace(/\d+$/, '*')}</td>
</tr>`;
  }).join('');

  const empty = rawRows.length === 0
    ? '<tr><td colspan="7" align="center">还没上传过任何文件</td></tr>'
    : '';

  let pagination = '';
  if (totalPages > 1) {
    let items = '';
    if (page > 1) {
      items += `<li><a href="${link(1)}">首页</a></li><li><a href="${link(page - 1)}">&laquo;</a></li>`;
    } else {
      items += '<li class="disabled"><a>首页</a></li><li class="disabled"><a>&laquo;</a></li>';
    }
    const start = Math.max(1, page - 10);
    const end = Math.min(totalPages, page + 10);
    for (let i = start; i < page; i++) {
      items += `<li><a href="${link(i)}">${i}</a></li>`;
    }
    items += `<li class="disabled"><a>${page}</a></li>`;
    for (let i = page + 1; i <= end; i++) {
      items += `<li><a href="${link(i)}">${i}</a></li>`;
    }
    if (page < totalPages) {
      items += `<li><a href="${link(page + 1)}">&raquo;</a></li><li><a href="${link(totalPages)}">尾页</a></li>`;
    } else {
      items += '<li class="disabled"><a>&raquo;</a></li><li class="disabled"><a>尾页</a></li>';
    }
    pagination = `<ul class="pagination pagination-sm" style="float:right;">${items}</ul>`;
  }

  // 公告
  const gonggao = config.gonggao || '';
  const gonggaoHtml = gonggao
    ? `<div class="alert alert-info"><i class="fa fa-bullhorn" aria-hidden="true"></i> ${htmlspecialchars(gonggao)}</div>`
    : '';

  const body = `<div class="container">
<div class="well bs-component">
  <h2>${htext}
    ${searchEnabled ? `<span class="searchbox">
      <form class="form-inline" action="./" method="GET">
        ${isMine ? '<input name="m" type="hidden" value="mine">' : ''}
        <input name="kw" class="form-control" type="search" placeholder="请输入搜索关键词" value="${htmlspecialchars(kw)}">
        <button class="btn btn-default btn-raised btn-sm" type="submit"><i class="fa fa-search" aria-hidden="true"></i> 搜索</button>
      </form>
    </span>` : ''}
  </h2>
  ${gonggaoHtml}
  <div class="table-responsive">
    <table class="table table-striped table-hover filelist">
      <thead>
        <tr><th>#</th><th>操作</th><th>文件</th><th>文件大小</th><th>文件格式</th><th>上传时间</th><th>上传者IP</th></tr>
      </thead>
      <tbody>
        ${tableRows}
        ${empty}
      </tbody>
    </table>
  </div>
  <div class="row">
    <div class="col-md-6"><br>共有 ${totalCount} 个文件，&nbsp;&nbsp;当前第 ${page} 页，共 ${totalPages} 页</div>
    <div class="col-md-6"><nav>${pagination}</nav></div>
  </div>
</div>
</div>`;

  // 首页可被 Cloudflare 缓存（用户上传/删除后等待缓存过期即可刷新）
  const res = c.html(publicLayout(title, body, siteUrlStr, isMine ? 'mine' : 'index', false, config.title, config.tongji));
  res.headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.headers.set('CDN-Cache-Control', 'public, max-age=300');
  res.headers.set('X-Cache', 'MISS');
  if (cacheable && edgeCache && cacheKey) {
    try {
      c.executionCtx.waitUntil(edgeCache.put(cacheKey, res.clone()));
    } catch {}
  }
  return res;
});

// ===================== 上传页面/upload.php =====================
frontend.get('/upload.php', (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  const csrf = generateCsrfToken();

  // 保存 csrf 到一个临时?cookie，ajax 头会对比c
  c.header('Set-Cookie', `upload_csrf=${csrf}; Path=/; Max-Age=3600; SameSite=Lax`);

  // 获取客户端IP
  const clientip = c.req.header('CF-Connecting-IP') || c.req.header('X-Real-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || '0.0.0.0';

  const body = `<div class="container" id="app" style="padding-top:30px">
    <div class="row">
      <div class="col-sm-9">
        <div class="well infobox" align="center" id="fileInput" :style="{background: background}">
        <div style="min-height:50px;">
            <div id="progressBar" v-if="showtype==1">
                <div class="progress progress-striped active"><div class="progress-bar" style="width: 0%" :style="{ width: progress + '%' }">{{progress_tip}}</div></div><div class="row"><div class="col-xs-3" style="text-align:left;" id="percentage"><span v-if="progress>0">{{progress}}%</span></div><div class="col-xs-6 filename">{{filename}}</div><div class="col-xs-3" style="text-align:right;" id="uploadspeed">{{uploadspeed}}</div></div>
            </div>
            <div class="alert alert-dismissible" :class="'alert-'+alert.type" v-if="showtype==2">
                <button type="button" class="close" data-dismiss="alert">×</button>
                <strong>{{alert.msg}}</strong>
            </div>
        </div>

         <br><br>
         <h1 style="color:#8d8b8b;" id="uploadTitle">{{uploadTitle}}</h1>

         <input type="hidden" id="csrf_token" name="csrf_token" value="${csrf}">
         <input type="file" id="file" name="myfile" @change="selectFile" style="display:none"/>

         <div id="upload_frame">
         <button id="uploadFile" class="btn btn-raised btn-primary" style="height:50px;font-size:20px;" @click="clickUpload"><i class="fa fa-upload"></i> 选择文件<div class="ripple-container"></div></button>
<div class="form-group">
<div class="checkbox">
<label>
<input type="checkbox" id="show" v-model="input.show"> 在首页文件列表显示</label>
</div>
</div>
<div class="form-group">
<div class="checkbox">
<label>
<input type="checkbox" id="ispwd" v-model="input.ispwd"> 设定密码
</label>
</div>
</div>
<div class="form-group" style="max-width:220px;" id="pwd_frame" v-if="input.ispwd">
<input type="text" class="form-control" id="pwd" placeholder="请输入密码" autocomplete="off" v-model="input.pwd">
<p class="help-block">密码只能为字母或数字</p>
</div>
         </div>

        <br><br><br><br>
        </div>
      </div>
      <div class="col-sm-3">
      <div class="panel panel-primary">
<div class="panel-heading">
<h3 class="panel-title"><i class="fa fa-exclamation-circle"></i> 上传提示</h3>
</div>
<div class="list-group-item">
**您的IP是 ${clientip}，请不要要上传违规文件</div>
${config.upload_size > 0 ? `<div class="list-group-item">**上传无格式限制，当前服务器单个文件上传最大支持 <b>${config.upload_size}MB</b></div>` : `<div class="list-group-item">**上传无格式限制，无大小限制！
</div>`}
${config.videoreview == 1 ? `<div class="list-group-item">**当前网站已开启视频文件审核，如果上传的是视频文件，需要等待审核通过后才能下载和播放</div>` : ''}
</div>
      </div>
    </div>
  </div>
<div class="colorful_loading_frame">
  <div class="colorful_loading"><i class="rect1"></i><i class="rect2"></i><i class="rect3"></i><i class="rect4"></i><i class="rect5"></i></div>
</div>
<script src="${CDN.vue}"></script>
<script src="https://s4.zstatic.net/ajax/libs/spark-md5/3.0.2/spark-md5.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/layer/3.1.1/layer.js"></script>
<script>var upload_max_filesize = '${config.upload_size}';</script>
<script src="assets/js/uploadnew.js?v=20261024"></script>`;

  return c.html(publicLayout('上传文件 - ' + config.title, body, siteUrlStr, 'upload', false, config.title, config.tongji));
});

// ===================== 文件查看</file.php?hash=xxx =====================
frontend.get('/file.php', async (c) => {
  const db = getDB(c);
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  const csrf = generateCsrfToken();
  c.header('Set-Cookie', `upload_csrf=${csrf}; Path=/; Max-Age=3600; SameSite=Lax`);

  const hash = c.req.query('hash') || '';
  const pwd = c.req.query('pwd') || null;

  if (!hash || !/^[0-9a-f]{32}$/i.test(hash)) {
    return c.html('<script>window.location.href="./";</script>', 302);
  }

  const row = await getFileByHash(db, hash);
  if (!row) {
    return c.html('<script>alert("文件不存在);window.location.href="./";</script>');
  }

  // 密码保护
  if (row.pwd && row.pwd !== '' && row.pwd !== pwd) {
    return c.html(`<meta charset="utf-8"/>
<title>请输入密码下载文件</title>
<script>
var pwd=prompt("请输入密码",")
if (pwd!=null && pwd!="")
{
    window.location.href="./file.php?hash=${hash}&pwd="+pwd
}
</script>
请刷新页面或[ <a href="javascript:history.back();">返回上一页</a> ]`);
  }

  // 增加下载计数
  await touchFile(db, row.id);
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/file_ids=([^;]+)/);
  let ids: number[] = [];
  if (match) {
    try {
      ids = atob(decodeURIComponent(match[1])).split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
    } catch {}
  }
  const isMine = ids.includes(row.id);

  const downurl = `down.php/${row.hash}.${row.type || 'file'}`;
  const viewurl = `view.php/${row.hash}.${row.type || 'file'}`;
  const downurlAll = `${siteUrlStr}/${downurl}`;
  const viewurlAll = `${siteUrlStr}/${viewurl}`;
  const thisurl = `${siteUrlStr}/file.php?hash=${row.hash}${pwd ? '&pwd=' + pwd : ''}`;

  // 直连模式：进入页面时先获取带签名的直链，下载按钮/链接直接跳转，无需经过 down.php
  let downReal = downurlAll;
  if (config.downfile_type === 1) {
    try {
      const stor = getStorOrThrow(c);
      if (stor.getDownUrl) {
        const directUrl = await stor.getDownUrl(row.hash, row.name);
        if (directUrl) downReal = directUrl;
      }
    } catch {}
  }

  const viewType = getViewType(row.type);
  const extLower = (row.type || '').toLowerCase();
  const videoPlug = extLower === 'm3u8' ? 'hls.js' : (extLower === 'flv' || extLower === 'f4v' ? 'flv.js' : '');
  const embedUrl = `${siteUrlStr}/view.php/embed/${row.hash}?ext=${encodeURIComponent(row.type || 'file')}`;
  let fileTitle = '';
  let htmlcode = '';
  let htmlcode2 = '';
  let ubbcode = '';
  let linktitle = '文件链接';
  let filetype = 0;

  if (viewType === 'image') {
    filetype = 1;
    fileTitle = '<i class="fa fa-picture-o"></i> 图片查看器';
    htmlcode = htmlspecialchars(`<img src="${viewurlAll}"/>`);
    ubbcode = `[img]${viewurlAll}[/img]`;
    linktitle = '图片链接';
  } else if (viewType === 'audio') {
    filetype = 2;
    fileTitle = '<i class="fa fa-music"></i> 音乐播放器'
    htmlcode = htmlspecialchars(`<audio id="bgmMusic" src="${viewurlAll}" autoplay="autoplay" loop="loop" preload="auto"></audio>`);
    htmlcode2 = htmlspecialchars(`<iframe src="${embedUrl}" width="407" height="70" scrolling="no" frameborder="0"></iframe>`);
    ubbcode = `[audio=X]${viewurlAll}[/audio]`;
    linktitle = '音乐链接';
  } else if (viewType === 'video') {
    filetype = 3;
    fileTitle = '<i class="fa fa-video-camera"></i> 视频播放器';
    htmlcode = htmlspecialchars(`<video id="movies" src="${viewurlAll}" autobuffer="true" controls="" width="100%"></video>`);
    htmlcode2 = htmlspecialchars(`<iframe src="${embedUrl}" width="800" height="500" scrolling="no" frameborder="0"></iframe>`);
    ubbcode = `[movie=320*180]${viewurlAll}[/movie]`;
    linktitle = '视频链接';
  } else {
    filetype = 0;
    fileTitle = '<i class="fa fa-file"></i> 文件查看';
    htmlcode = htmlspecialchars(`<a href="${downurlAll}" target="_blank">${row.name}</a>`);
    ubbcode = `[url=${downurlAll}]${row.name}[/url]`;
  }

  let fileContent = '';
  if (filetype === 1) {
    fileContent = `<div class="image_view"><a href="${viewurl}" title="点击查看原图"><img alt="loading" src="${viewurl}" class="image"/></a></div>`;
  } else if (filetype === 2) {
    fileContent = `<div class="view"><div id="aplayer"></div></div>`;
  } else if (filetype === 3 && row.block === 0) {
    fileContent = `<div class="videoplayer"></div>`;
  } else if (filetype === 3) {
    const icon = typeToIcon(row.type);
    fileContent = `<div class="view"><div class="elseview"><div class="tubiao"><i class="fa ${icon}"></i></div></div>
<div class="elsetext"><p>${htmlspecialchars(row.name)}</p><p>视频文件审核通过后才能在线播放和下载，请等待审核通过</p></div></div>`;
  } else {
    const icon = typeToIcon(row.type);
    fileContent = `<div class="view"><div class="elseview"><div class="tubiao"><i class="fa ${icon}"></i></div></div>
<div class="elsetext"><p>${htmlspecialchars(row.name)}（${sizeFormat(row.size)}）</p>
<a href="${downReal}" class="btn btn-raised btn-primary btn-lg"${config.downfile_type === 1 ? ' target="_blank"' : ''}><i class="fa fa-download" aria-hidden="true"></i> 下载文件<div class="ripple-container"></div></a>
</div></div>`;
  }

  const body = `<div class="container">
<div class="row">
<div class="col-sm-9">
  <div class="panel panel-primary">
    <div class="panel-heading"><h3 class="panel-title">${fileTitle}</h3></div>
    <div class="panel-body" align="center">${fileContent}</div>
  </div>
  <div class="panel panel-default">
    <div class="panel-body" style="padding:0">
      <ul class="nav nav-tabs" style="margin-bottom:15px">
        <li class="active"><a href="#link" data-toggle="tab"><i class="fa fa-link"></i> 文件外链</a></li>
        <li><a href="#code" data-toggle="tab"><i class="fa fa-code"></i> 代码调用</a></li>
        <li><a href="#info" data-toggle="tab"><i class="fa fa-info-circle"></i> 文件详情</a></li>
        ${isMine ? '<li><a href="#manager" data-toggle="tab"><i class="fa fa-cog"></i> 管理</a></li>' : ''}
      </ul>
      <div id="myTabContent" class="tab-content" style="padding:19px">
        <div class="tab-pane fade active in" id="link">
          ${filetype > 0 ? `<div class="form-group row">
            <label class="col-md-2 control-label">${linktitle}</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="link1" readonly value="${viewurlAll}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${viewurlAll}">复制</button></span>
              </div>
            </div>
          </div>` : ''}
          <div class="form-group row">
            <label class="col-md-2 control-label">下载链接</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="link2" readonly value="${downReal}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${downReal}">复制</button></span>
              </div>
            </div>
          </div>
        </div>
        <div class="tab-pane fade" id="code">
          ${filetype >= 2 ? `<div class="form-group row">
            <label class="col-md-2 control-label">播放器代码</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="code1" readonly value='${htmlcode2}'>
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text='${htmlcode2}'>复制</button></span>
              </div>
            </div>
          </div>
          <div class="form-group row">
            <label class="col-md-2 control-label">HTML代码</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="code2" readonly value='${htmlcode}'>
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text='${htmlcode}'>复制</button></span>
              </div>
            </div>
          </div>` : ''}
          <div class="form-group row">
            <label class="col-md-2 control-label">UBB代码</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="code3" readonly value="${ubbcode}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${ubbcode}">复制</button></span>
              </div>
            </div>
          </div>
        </div>
        <div class="tab-pane fade" id="info">
          <div class="row" align="center">
            <table class="table table-bordered fileinfo-table">
              <tr>
                <th width="97">上传者IP</th><td width="100">${(row.ip || '').replace(/\d+$/, '*')}</td>
                <th width="100">上传时间</th><td width="168">${row.addtime}</td>
              </tr>
              <tr>
                <th>下载次数</th><td>${row.count}</td>
                <th>文件大小</th><td>${sizeFormat(row.size)} (${row.size} 字节)</td>
              </tr>
            </table>
          </div>
        </div>
        ${isMine ? `<div class="tab-pane fade" id="manager">
          <div class="row" align="center">
            <div class="col-md-12">
              <input type="hidden" id="hash" value="${hash}">
              <input type="hidden" id="csrf_token" value="${csrf}">
              <button onclick="delete_confirm()" class="btn btn-raised btn-danger"><i class="fa fa-close"></i> 删除文件</button>
            </div>
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>
</div>
<div class="col-sm-3">
  <div class="panel panel-info">
    <div class="panel-heading"><h3 class="panel-title"><i class="fa fa-exclamation-circle"></i> 提示</h3></div>
    <div class="panel-body">
      ${config.gg_file}
    </div>
  </div>
  <div class="panel panel-default hidden-xs">
    <div class="panel-heading"><h3 class="panel-title"><i class="fa fa-qrcode"></i> 手机扫码下载</h3></div>
    <div class="panel-body text-center">
      <img alt="二维码" src="${CDN.qrcode}${encodeURIComponent(thisurl)}">
    </div>
  </div>
</div>
</div>
</div>
<script src="${CDN.clipboard}"></script>
<script src="${CDN.layer}"></script>
${filetype === 2 ? `<script src="${CDN.aplayerJs}"></script>` : ''}
${filetype === 3 && row.block === 0 ? `<script src="assets/js/ckplayer.min.js"></script>` : ''}
${filetype === 3 && row.block === 0 && videoPlug === 'hls.js' ? `<script src="https://s4.zstatic.net/ajax/libs/hls.js/1.2.4/hls.min.js"></script>` : ''}
${filetype === 3 && row.block === 0 && videoPlug === 'flv.js' ? `<script src="https://s4.zstatic.net/ajax/libs/flv.js/1.6.2/flv.min.js"></script>` : ''}
<script>
function delete_confirm(){
  var hash = $("#hash").val();
  var csrf_token = $("#csrf_token").val();
  layer.confirm('删除文件后不可恢复，您确定删除吗？', { btn: ['您确定要','取消'], icon: 0 }, function(){
    var ii = layer.load(2);
    $.ajax({
      type : 'POST',
      url : 'ajax.php?act=deleteFile',
      data : {hash:hash, csrf_token:csrf_token},
      dataType : 'json',
      success : function(data) {
        layer.close(ii);
        if(data.code == 0){ layer.alert('删除成功', {icon:1}, function(){window.location.href="./";}); }
        else { layer.alert(data.msg, {icon:2}); }
      },
      error:function(){ layer.close(ii); layer.msg('服务器错误'); }
    });
  });
}
$(function(){
  var clipboard = new ClipboardJS('.copy-btn');
  clipboard.on('success', function(){ layer.msg('复制成功', {icon: 1}); });
  clipboard.on('error', function(){ layer.msg('复制失败，请长按链接后手动复制', {icon: 2}); });
});
${filetype === 2 ? `
$(function(){
  new APlayer({
    container: document.getElementById('aplayer'),
    loop: 'none',
    theme: '#b2dae6',
    audio: [{ title: ${JSON.stringify(row.name)}, author: 'none', url: ${JSON.stringify(viewurlAll)}, cover: 'assets/img/music.png' }]
  });
});` : ''}
${filetype === 3 && row.block === 0 ? `
$(function(){
  var videoObject = {
    container: '.videoplayer',
    plug: ${JSON.stringify(videoPlug)},
    video: ${JSON.stringify(viewurlAll)},
    webFull: true
  };
  var player = new ckplayer(videoObject);
});` : ''}
</script>`;

  return c.html(publicLayout('文件查看 - ' + config.title, body, siteUrlStr, 'file', filetype > 0, config.title, config.tongji));
});

// ===================== 管理后台登录 </h2> ====
// /admin/login =====================
frontend.get('/admin/login', async (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);

  // 登出（必须在已登录状态查之前，否则已登录用户无法退出）
  if (c.req.query('logout') === '1') {
    c.header('Set-Cookie', 'admin_token=; Path=/; Max-Age=0');
    return c.html('<script>window.location.href="/admin/login";</script>');
  }

  // 已登录则跳到后台
  const cookie = c.req.header('cookie') || '';
  const token = cookie.match(/admin_token=([^;]+)/)?.[1];
  if (token) {
    const valid = await verifyAdminToken(decodeURIComponent(token), config.admin_user, config.admin_pwd, config.syskey);
    if (valid) {
      return c.html('<script>window.location.href="/admin";</script>');
    }
  }

  const body = `<style>
body{background:linear-gradient(to right,#49bdad,#6a67c7) fixed}
.admin-login-form{background:#fff;text-align:center;padding:50px 30px 30px;box-shadow:12px 12px 0 rgba(0,0,0,.3);margin-top:50%}
.admin-login-form .heading{color:#555;font-size:30px;font-weight:600;letter-spacing:1px;margin:0 0 50px}
.admin-login-form .form-group{margin:0 auto 30px;position:relative}
.admin-login-form .form-group>i{color:#999;position:absolute;left:5px;top:12px}
.admin-login-form .form-control{color:#7ab6b6;font-size:17px;letter-spacing:1px;height:40px;padding:5px 10px 2px 25px;border:0;border-bottom:1px solid rgba(0,0,0,.1);border-radius:0}
.admin-login-form .form-control:focus{border-bottom:1px solid #7ab6b6;box-shadow:none}
.admin-login-form .btn{color:#7ab6b6;background:#edf6f5;font-size:18px;font-weight:700;letter-spacing:1px;border-radius:5px;width:50%;height:45px;margin:0 auto 25px;border:0;display:block}
.admin-login-form .btn:hover{color:#fff;background:#7ab6b6}
</style><div class="container">
<div class="col-md-4 col-md-offset-4">
<form id="loginForm" class="admin-login-form">
  <div class="heading">管理员登录</div>
      <div class="form-group"><i class="fa fa-user"></i><input class="form-control" id="username" placeholder="用户名" required autofocus></div>
      <div class="form-group"><i class="fa fa-lock"></i><input type="password" class="form-control" id="password" placeholder="密码" required></div>
      <button type="submit" class="btn"><i class="fa fa-arrow-right"></i></button>
    </form>
</div>
</div>
<script>
document.getElementById('loginForm').onsubmit = function(e){
  e.preventDefault();
  var user = document.getElementById('username').value;
  var pwd = document.getElementById('password').value;
  var button = document.querySelector('#loginForm button[type="submit"]');
  button.disabled = true;
  button.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 登录中...';
  $.ajax({
    url: '/admin/ajax/login',
    type: 'POST',
    contentType: 'application/json',
    data: JSON.stringify({username: user, password: pwd}),
    dataType: 'json',
    success: function(res){
      if (res.code === 0) { window.location.href = '/admin'; }
      else { alert(res.msg || '登录失败'); }
    },
    error: function(){ alert('登录请求失败，请检查服务是否正常运行'); },
    complete: function(){
      button.disabled = false;
      button.innerHTML = '<i class="fa fa-sign-in"></i> 登录';
    }
  });
};
</script>`;

  return c.html(adminLayout('管理员登录', body, siteUrlStr, 'index', false, config.title));
});

// 管理员登录接口必须位于需要 admin_token 的后台 AJAX 鉴权之外。
frontend.post('/admin/ajax/login', async (c) => {
  try {
    const config = getConf(c);
    let body: { username?: string; password?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      const form = await c.req.parseBody<Record<string, string>>();
      body = { username: form.username, password: form.password };
    }
    const username = String(body.username || '');
    const password = String(body.password || '');
    if (!username || !password) return jsonError(c, '请输入用户名和密码');
    if (username !== config.admin_user || password !== config.admin_pwd) {
      return jsonError(c, '用户名或密码错误');
    }
    const token = await signAdminToken(config.admin_user, config.admin_pwd, config.syskey, 7);
    c.header('Set-Cookie', `admin_token=${encodeURIComponent(token)}; Path=/; Max-Age=${7 * 86400}; HttpOnly; SameSite=Lax`);
    return jsonResult(c, { code: 0, msg: '登录成功' });
  } catch (e: any) {
    console.error('[admin/login] error:', e);
    return jsonError(c, '登录失败: ' + (e.message || e));
  }
});

// ===================== 管理后台首页 /admin =====================
async function checkAdmin(c: any): Promise<boolean> {
  const config = getConf(c);
  const cookie = c.req.header('cookie') || '';
  const token = cookie.match(/admin_token=([^;]+)/)?.[1];
  if (!token) return false;
  return await verifyAdminToken(decodeURIComponent(token), config.admin_user, config.admin_pwd, config.syskey);
}

frontend.get('/admin', async (c) => {
  const siteUrlStr = siteUrl(c);
  const config = getConf(c);
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='/admin/login';</script>`);
  }

  const body = `<div class="container" style="padding-top:70px">
<div class="col-md-12 col-lg-10 center-block" style="float:none">
<div class="row">
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-primary">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-cloud fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count1">0</div><div>文件总数</div></div>
      </div></div>
      <a href="/admin/file"><div class="panel-footer" style="font-size:12px;line-height:20px"><span class="pull-left">总大小：<span id="totalSize">0 B</span></span><span class="pull-right">查看详情 <i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-green">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-cloud-upload fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count2">0</div><div>今日上传文件</div></div>
      </div></div>
      <a href="/admin/file"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-yellow">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-inbox fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count3">0</div><div>昨日上传文件</div></div>
      </div></div>
      <a href="/admin/file"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-red">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-hdd-o fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count4" style="font-size:22px;line-height:1.5;word-break:break-word">0</div><div>存储类型</div></div>
      </div></div>
       <a href="/admin/set?mod=stor"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
</div>
<div class="row">
  <div class="col-md-8 col-sm-12">
    <div class="panel panel-info">
      <div class="panel-heading"><h3 class="panel-title">系统信息</h3></div>
      <ul class="list-group">
        <li class="list-group-item"><b>运行环境：</b>Cloudflare Workers (Node.js Compat)</li>
        <li class="list-group-item"><b>数据库：</b>Cloudflare D1 (SQLite)</li>
        <li class="list-group-item"><b>对象存储：</b>${getConf(c).storage.toUpperCase()}</li>
        <li class="list-group-item"><b>服务器时间：</b>${new Date().toISOString().replace('T', ' ').substring(0, 19)}</li>
        <li class="list-group-item"><b>站点名称：</b>${htmlspecialchars(getConf(c).title)}</li>
      </ul>
    </div>
  </div>
  <div class="col-md-4 col-sm-12">
    <div class="panel panel-success">
      <div class="panel-heading"><h3 class="panel-title">版本信息</h3></div>
      <ul class="list-group text-dark">
        <li class="list-group-item"><b>彩虹外链网盘</b></li>
        <li class="list-group-item">Workers 迁移到 v1.0</li>
        <li class="list-group-item">${new Date().getFullYear()} © CAIHONG</li>
      </ul>
    </div>
  </div>
</div>
</div>
</div>
<script>
$.ajax({
  type: 'GET',
  url: '/admin/ajax/getcount',
  dataType: 'json',
  success: function(data) {
    if (data && data.code === 0) {
      $('#count1').html(data.count1);
      $('#count2').html(data.count2);
      $('#count3').html(data.count3);
      $('#count4').html(data.count4);
      $('#totalSize').text(data.totalSizeText || '0 B');
      console.log('[getcount]', data);
    } else {
      console.warn('[getcount] unexpected response', data);
    }
  },
  error: function(xhr, status, err) {
    console.error('[getcount] request failed', status, err, xhr && xhr.responseText);
  }
});
</script>`;

  return c.html(adminLayout('后台首页', body, siteUrlStr, 'index', true, config.title));
});

// ===================== 管理后台文件管理 /admin/file =====================
frontend.get('/admin/file', async (c) => {
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='/admin/login';</script>`);
  }

  const body = `<style>
.table>tbody>tr>td{vertical-align:middle;max-width:360px;word-break:break-all}
@media (prefers-color-scheme: dark) {
  /* 编辑文件弹窗：Bootstrap 默认是白底，dark.css 只覆盖了通用表格/表单 */
  #modal-store .modal-content { background:#252525; border-color:#3a3a3a; color:#ccc; }
  #modal-store .modal-header,
  #modal-store .modal-footer { border-color:#3a3a3a; }
  #modal-store .modal-title { color:#ddd; }
  #modal-store .btn-white { background:#333; border-color:#444; color:#ccc; }
  #modal-store .btn-white:hover,
  #modal-store .btn-white:focus { background:#444; color:#fff; }
  /* bootstrap-table 的加载遮罩默认固定白底 */
  .bootstrap-table .fixed-table-container .fixed-table-body .fixed-table-loading { background:#252525; }
  .bootstrap-table .fixed-table-container .fixed-table-body .fixed-table-loading .loading-wrap .animation-dot,
  .bootstrap-table .fixed-table-container .fixed-table-body .fixed-table-loading .loading-wrap .animation-wrap::before,
  .bootstrap-table .fixed-table-container .fixed-table-body .fixed-table-loading .loading-wrap .animation-wrap::after { background:#ccc; }
  .bootstrap-table .fixed-table-container .table tbody tr.selected td { background-color:rgba(90,138,180,.25) !important; }
  .bootstrap-table .fixed-table-pagination .page-jump-to input { background:#2a2a2a; border-color:#3a3a3a; color:#eee; }
  .bootstrap-table.fullscreen { background:#1a1a1a !important; }
}
</style>
<div class="modal" id="modal-store" role="dialog" aria-labelledby="myModalLabel" aria-hidden="true">
  <div class="modal-dialog">
    <div class="modal-content animated flipInX">
      <div class="modal-header">
        <button type="button" class="close" data-dismiss="modal"><span aria-hidden="true">&times;</span><span class="sr-only">Close</span></button>
        <h4 class="modal-title" id="modal-title">文件信息修改</h4>
      </div>
      <div class="modal-body">
        <form class="form-horizontal" id="form-store">
          <input type="hidden" name="action" id="action"/>
          <input type="hidden" name="id" id="id"/>
          <div class="form-group">
            <label class="col-sm-2 control-label no-padding-right">文件名称</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="name" id="name"></div>
          </div>
          <div class="form-group">
            <label class="col-sm-2 control-label no-padding-right">文件类型</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="type" id="type"></div>
          </div>
          <div class="form-group">
            <label class="col-sm-2 control-label no-padding-right">文件大小</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="size" id="size" disabled></div>
          </div>
          <div class="form-group">
            <label class="col-sm-2 control-label no-padding-right">文件MD5</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="hash" id="hash" disabled></div>
          </div>
          <div class="form-group">
            <label class="col-sm-2 control-label no-padding-right">是否隐藏</label>
            <div class="col-sm-10"><select id="hide" name="hide" class="form-control"><option value="0">0_否</option><option value="1">1_是</option></select></div>
          </div>
          <div class="form-group">
            <label class="col-sm-2 control-label no-padding-right">开启密码</label>
            <div class="col-sm-10"><select id="ispwd" name="ispwd" class="form-control" onchange="change_ispwd(this)"><option value="0">0_否</option><option value="1">1_是</option></select></div>
          </div>
          <div class="form-group" id="pwd_frame">
            <label class="col-sm-2 control-label no-padding-right">下载密码</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="pwd" id="pwd"></div>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-white" data-dismiss="modal">关闭</button>
        <button type="button" class="btn btn-primary" id="store" onclick="save()">保存</button>
      </div>
    </div>
  </div>
</div>
<div class="container" style="padding-top:70px;">
  <div class="col-xs-12 center-block" style="float: none;">
    <form onsubmit="return searchSubmit()" method="GET" class="form-inline" id="searchToolbar">
      <div class="form-group">
        <label>搜索</label>
        <select name="type" class="form-control"><option value="1">文件名</option><option value="2">文件Hash</option><option value="3">文件格式</option><option value="4">上传者IP</option></select>
      </div>
      <div class="form-group"><input type="text" class="form-control" name="kw" placeholder="搜索内容"></div>
      <div class="form-group"><input type="text" class="form-control" name="uid" style="width: 100px;" placeholder="UID"></div>
      <div class="form-group">
        <select id="dstatus" name="dstatus" class="form-control"><option value="-1">全部状态</option><option value="0">正常文件</option><option value="1">已屏蔽文件</option><option value="2">待审核文件</option></select>
      </div>
      <div class="form-group">
        <select id="orderby" name="orderby" class="form-control" style="width:150px"><option value="0">默认排序</option><option value="1">按下载量排序</option><option value="2">按大小降序</option><option value="3">按大小升序</option></select>
      </div>
      <div class="form-group">
        <button class="btn btn-primary" type="submit"><i class="fa fa-search"></i> 搜索</button>
        <a href="javascript:resetSearch()" class="btn btn-default"><i class="fa fa-repeat"></i> 重置</a>
      </div>
      <div class="btn-group" role="group">
        <button type="button" class="btn btn-default dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">批量操作 <span class="caret"></span></button>
        <ul class="dropdown-menu"><li><a href="javascript:operation(0)"><i class="fa fa-trash"></i> 删除</a></li><li><a href="javascript:operation(1)"><i class="fa fa-times-circle"></i> 封禁</a></li><li><a href="javascript:operation(2)"><i class="fa fa-check-circle"></i> 解封</a></li></ul>
      </div>
    </form>
    <table id="listTable"></table>
  </div>
</div>
<script src="${CDN.layer}"></script>
<script src="${CDN.bootstrapTableJs}"></script>
<script src="${CDN.bootstrapTablePageJump}"></script>
<script src="/assets/js/custom.js"></script>
<script>
$(document).ready(function(){
  updateToolbar();
  var defaultPageSize = 15;
  var pageNumber = typeof window.$_GET['pageNumber'] != 'undefined' ? parseInt(window.$_GET['pageNumber']) : 1;
  var pageSize = typeof window.$_GET['pageSize'] != 'undefined' ? parseInt(window.$_GET['pageSize']) : defaultPageSize;
  $('#listTable').bootstrapTable({
    url: '/admin/ajax/fileList',
    pageNumber: pageNumber,
    pageSize: pageSize,
    classes: 'table table-striped table-hover table-bordered',
    columns: [
      { field: '', checkbox: true },
      { field: 'id', title: 'ID', formatter: function(value, row, index){ return '<b>'+value+'</b>'; } },
      { field: 'uid', title: '用户', formatter: function(value, row, index){ return value>0?'<a href="/admin/user?type=1&kw='+value+'" target="_blank">'+value+'</a>':'游客'; } },
      { field: 'name', title: '文件名', formatter: function(value, row, index){
          var html = '<a href="'+escHtml(row.fileurl)+'" title="点击下载"><i class="fa '+row.icon+' fa-fw"></i>'+escHtml(value)+'</a>';
          if(row.view){
            var previewUrl = row.view_type == 'image' ? row.viewurl : row.embedurl;
            html += ' [<a href="javascript:;" class="preview-link" data-url="'+escHtml(previewUrl)+'" data-type="'+escHtml(row.view_type)+'">预览</a>]';
          }
          return html;
        } },
      { field: 'size', title: '文件大小', sortable: true },
      { field: 'type', title: '文件格式', formatter: function(value, row, index){ return value ? escHtml(value) : '未知'; } },
      { field: 'addtime', title: '上传日期/上次下载', formatter: function(value, row, index){ return escHtml(value) + '<br/>' + escHtml(row.lasttime||''); } },
      { field: 'ip', title: '上传IP/下载量', formatter: function(value, row, index){ return '<a href="https://m.ip138.com/iplookup.asp?ip='+encodeURIComponent(value||'')+'" target="_blank" rel="noreferrer">'+escHtml(value)+'</a><br/><b>'+row.count+'</b>'; } },
      { field: 'block', title: '状态', formatter: function(value, row, index){
          if(value == '2') return '<a href="javascript:setBlock('+row.id+',0)" class="btn btn-xs btn-warning">待审</a>';
          else if(value == '1') return '<a href="javascript:setBlock('+row.id+',0)" class="btn btn-xs btn-danger">封禁</a>';
          else return '<a href="javascript:setBlock('+row.id+',1)" class="btn btn-xs btn-success">正常</a>';
        } },
      { field: 'status', title: '操作', formatter: function(value, row, index){
          return '<a href="javascript:editframe('+row.id+')" class="btn btn-xs btn-info">编辑</a>&nbsp;<a href="'+escHtml(row.pageurl)+'" class="btn btn-xs btn-warning" target="_blank">查看</a>&nbsp;<a href="javascript:delFile('+row.id+')" class="btn btn-xs btn-danger">删除</a>';
        } }
    ]
  });

  // 点击表头排序时同步“排序方式”下拉框，保证服务端和界面一致
  $('#listTable').on('sort.bs.table', function(e, name, order){
    if(name === 'size') $('#orderby').val(order === 'asc' ? '3' : '2');
    else if(name) $('#orderby').val('0');
  });
  // 下拉框选择排序方式时同步表头排序状态
  $('#orderby').on('change', function(){
    var v = $(this).val();
    var sortName = (v === '2' || v === '3') ? 'size' : '';
    var sortOrder = v === '3' ? 'asc' : 'desc';
    $('#listTable').bootstrapTable('refreshOptions', { pageNumber: 1, sortName: sortName, sortOrder: sortOrder });
  });

  $(document).on('click', '.preview-link', function(){
    var url = $(this).attr('data-url');
    var type = $(this).attr('data-type');
    if(type == 'image') showimage(url);
    else showfile(url, type);
    return false;
  });
});

function escHtml(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function change_ispwd(obj){
  if($(obj).val()==1) $('#pwd_frame').show();
  else $('#pwd_frame').hide();
}
function setBlock(id, status){
  $.ajax({ type:'GET', url:'/admin/ajax/setBlock?id='+id+'&status='+status, dataType:'json',
    success:function(data){ searchSubmit(); },
    error:function(){ layer.msg('服务器错误'); }
  });
}
function editframe(id){
  var ii = layer.load(2, {shade:[0.1,'#fff']});
  $.ajax({ type:'GET', url:'/admin/ajax/getFileInfo?id='+id, dataType:'json',
    success:function(data){
      layer.close(ii);
      if(data.code == 0){
        $('#modal-store').modal('show');
        $('#action').val('edit');
        $('#form-store #id').val(data.id);
        $('#form-store #name').val(data.name);
        $('#form-store #type').val(data.type);
        $('#form-store #size').val(data.size2+' ('+data.size+' 字节)');
        $('#form-store #hash').val(data.hash);
        $('#form-store #hide').val(data.hide);
        if(data.pwd==null || data.pwd==''){
          $('#form-store #ispwd').val(0);
          $('#form-store #pwd').val('');
          $('#pwd_frame').hide();
        }else{
          $('#form-store #ispwd').val(1);
          $('#form-store #pwd').val(data.pwd);
          $('#pwd_frame').show();
        }
      }else{
        layer.alert(data.msg, {icon:2});
      }
    },
    error:function(){ layer.msg('服务器错误'); }
  });
}
function save(){
  if($('#name').val()==''){
    layer.alert('请确保各项不能为空！');
    return false;
  }
  var ii = layer.load(2, {shade:[0.1,'#fff']});
  $.ajax({ type:'POST', url:'/admin/ajax/saveFileInfo', data:$('#form-store').serialize(), dataType:'json',
    success:function(data){
      layer.close(ii);
      if(data.code == 0){
        layer.alert(data.msg, {icon:1, closeBtn:false}, function(){
          $('#modal-store').modal('hide');
          searchSubmit();
          layer.closeAll();
        });
      }else{
        layer.alert(data.msg, {icon:2});
      }
    },
    error:function(){ layer.msg('服务器错误'); }
  });
}
function delFile(id){
  var confirmobj = layer.confirm('你确定要删除此文件吗？', { btn:['确定','取消'], icon:0 }, function(){
    $.ajax({ type:'GET', url:'/admin/ajax/delFile?id='+id, dataType:'json',
      success:function(data){
        if(data.code == 0){ searchSubmit(); layer.alert('删除成功', {icon:1}); }
        else layer.alert(data.msg, {icon:2});
      },
      error:function(){ layer.msg('服务器错误'); }
    });
  }, function(){ layer.close(confirmobj); });
}
function operation(status){
  var selected = $('#listTable').bootstrapTable('getSelections');
  if(selected.length == 0){ layer.msg('未选中文件', {time:1500}); return; }
  if(status == 0 && !confirm('确定要删除已选中的'+selected.length+'个文件吗？')) return;
  var checkbox = [];
  $.each(selected, function(key, item){ checkbox.push(item.id); });
  var ii = layer.load(2, {shade:[0.1,'#fff']});
  $.ajax({ type:'POST', url:'/admin/ajax/operation', data:{ checkbox: checkbox, status: status }, dataType:'json',
    success:function(data){
      layer.close(ii);
      if(data.code == 0){ searchSubmit(); layer.alert(data.msg, {icon:1}); }
      else layer.alert(data.msg, {icon:2});
    },
    error:function(){ layer.msg('请求超时'); searchSubmit(); }
  });
}
function resetSearch(){
  $('#searchToolbar').find('input[name]').each(function(){ $(this).val(''); });
  $('#searchToolbar').find('select[name]').each(function(){ $(this).find('option:first').prop('selected','selected'); });
  $('#listTable').bootstrapTable('refreshOptions', { pageNumber: 1, sortName: '', sortOrder: 'desc' });
}
function showfile(url, type){
  var area;
  if(type == 'audio'){
    if($(window).width() >= 1200) area = ['50%','120px'];
    else if($(window).width() >= 992) area = ['75%','120px'];
    else if($(window).width() >= 768) area = ['95%','120px'];
    else area = ['100%','120px'];
  }else if(type == 'video'){
    if($(window).width() >= 1200) area = ['50%','60%'];
    else if($(window).width() >= 992) area = ['75%','70%'];
    else if($(window).width() >= 768) area = ['95%','75%'];
    else area = ['100%','55%'];
  }else{
    area = ['90%','90%'];
  }
  layer.open({ type:2, title:'文件预览', shadeClose:true, area:area, content:url });
}
function showimage(resourcesUrl){
  var ii = layer.load(2, {shade:[0.1,'#fff']});
  var img = new Image();
  img.onload = function(){
    var max_height = $(window).height() - 200;
    var max_width = $(window).width();
    var rate1 = max_height / img.height;
    var rate2 = max_width / img.width;
    var rate3 = 1;
    var rate = Math.min(rate1, rate2, rate3);
    var imgHeight = img.height * rate;
    var imgWidth = img.width * rate;
    var imgHtml = '<div id="showimg" style="width:'+imgWidth+'px; height:'+imgHeight+'px;"></div>';
    img.style.width = '100%';
    layer.close(ii);
    layer.open({ type:1, shade:0.6, title:false, area:['auto','auto'], shadeClose:true, content:imgHtml,
      success:function(){ $('#showimg').append(img); }
    });
  };
  img.onerror = function(){ layer.close(ii); layer.msg('图片加载错误'); };
  img.src = resourcesUrl;
}
</script>`;

  c.header('Cache-Control', 'no-store');
  return c.html(adminOriginalLayout('文件管理', body, 'file'));
});

// ===================== 管理后台用户管理 /admin/user =====================
frontend.get('/admin/user', async (c) => {
  const config = getConf(c);
  if (!await checkAdmin(c)) return c.html(`<script>window.location.href='/admin/login';</script>`);
  const body = `<style>.user-table td{vertical-align:middle;word-break:break-all}.user-avatar{width:40px;height:40px;border-radius:50%;margin-right:7px}</style>
<div class="container" style="padding-top:70px"><div class="col-xs-12 center-block" style="float:none">
<form id="userSearch" class="form-inline" onsubmit="return loadUsers(1)">
  <div class="form-group"><label>搜索 </label><select id="userType" class="form-control"><option value="1">UID</option><option value="2">第三方账号UID</option><option value="3">昵称</option><option value="4">登录IP</option></select></div>
  <div class="form-group"><input id="userKw" class="form-control" placeholder="搜索内容"></div>
  <div class="form-group"><select id="userStatus" class="form-control"><option value="-1">全部状态</option><option value="1">正常状态</option><option value="0">封禁状态</option></select></div>
  <button class="btn btn-primary" type="submit"><i class="fa fa-search"></i> 搜索</button>
  <button class="btn btn-default" type="button" onclick="document.getElementById('userKw').value='';loadUsers(1)"><i class="fa fa-repeat"></i> 重置</button>
</form>
<table class="table table-striped table-hover table-bordered user-table" style="margin-top:15px"><thead><tr><th>UID</th><th>头像/昵称</th><th>登录方式/账号</th><th>注册IP/登录IP</th><th>注册时间/最后登录</th><th>权限</th><th>状态</th><th>操作</th></tr></thead><tbody id="userRows"><tr><td colspan="8" class="text-center">加载中...</td></tr></tbody></table>
<div class="text-center"><button id="userPrev" class="btn btn-default btn-sm" onclick="loadUsers(userPage-1)">上一页</button> <span id="userPageText">第 1 页</span> <button id="userNext" class="btn btn-default btn-sm" onclick="loadUsers(userPage+1)">下一页</button></div>
</div></div>
<script>
var userPage=1;
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
async function loadUsers(page){if(page<1)return false;var rowsEl=document.getElementById('userRows');rowsEl.innerHTML='<tr><td colspan="8" class="text-center">加载中...</td></tr>';var fd=new FormData();fd.set('type',document.getElementById('userType').value);fd.set('kw',document.getElementById('userKw').value);fd.set('dstatus',document.getElementById('userStatus').value);fd.set('offset',String((page-1)*15));fd.set('limit','15');try{var response=await fetch('/admin/ajax/userList',{method:'POST',body:fd,credentials:'same-origin'});var r=await response.json();if(!response.ok||r.code<0)throw new Error(r.msg||'加载失败');userPage=page;var rows=Array.isArray(r.rows)?r.rows:[];rowsEl.innerHTML=rows.length?rows.map(function(u){return '<tr><td><b>'+u.uid+'</b></td><td>'+(u.faceimg?'<img class="user-avatar" src="'+esc(u.faceimg)+'">':'')+esc(u.nickname)+'</td><td><b>'+esc(u.type)+'</b><br>'+esc(u.openid)+'</td><td>'+esc(u.regip)+'<br>'+esc(u.loginip)+'</td><td>'+esc(u.addtime)+'<br>'+esc(u.lasttime)+'</td><td><button class="btn btn-xs btn-link" onclick="setLevel('+u.uid+','+(u.level?0:1)+')">'+(u.level?'高级':'普通')+'</button></td><td><button class="btn btn-xs '+(u.enable?'btn-success':'btn-danger')+'" onclick="setEnable('+u.uid+','+(u.enable?0:1)+')">'+(u.enable?'正常':'封禁')+'</button></td><td><a class="btn btn-xs btn-info" href="/admin/file?uid='+u.uid+'">文件</a> <button class="btn btn-xs btn-danger" onclick="delUser('+u.uid+')">删除</button></td></tr>';}).join(''):'<tr><td colspan="8" class="text-center text-muted">没有找到匹配的记录</td></tr>';document.getElementById('userPageText').innerText='第 '+page+' 页，共 '+(r.total||0)+' 个用户';document.getElementById('userPrev').disabled=page<=1;document.getElementById('userNext').disabled=page*15>=(r.total||0);}catch(e){rowsEl.innerHTML='<tr><td colspan="8" class="text-center text-danger">加载失败：'+esc(e.message||e)+'</td></tr>';}return false;}
async function setEnable(uid,enable){var fd=new FormData();fd.set('uid',uid);fd.set('enable',enable);await fetch('/admin/ajax/setUserEnable',{method:'POST',body:fd,credentials:'same-origin'});loadUsers(userPage);}
async function setLevel(uid,level){var fd=new FormData();fd.set('uid',uid);fd.set('level',level);await fetch('/admin/ajax/saveUserInfo',{method:'POST',body:fd,credentials:'same-origin'});loadUsers(userPage);}
async function delUser(uid){if(!confirm('确定删除此用户吗？'))return;var fd=new FormData();fd.set('uid',uid);await fetch('/admin/ajax/delUser',{method:'POST',body:fd,credentials:'same-origin'});loadUsers(userPage);}
(function(){
  var q = new URLSearchParams(window.location.search);
  if(q.get('type')) document.getElementById('userType').value = q.get('type');
  if(q.get('kw')) document.getElementById('userKw').value = q.get('kw');
})();
loadUsers(1);
</script>`;
  return c.html(adminLayout('用户管理', body, siteUrl(c), 'user', true, config.title));
});

// ===================== 管理后台设置 /admin/set =====================
frontend.get('/admin/set', async (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='/admin/login';</script>`);
  }

  const mod = c.req.query('mod') || 'site';
  let panelBody = '';
  let pageTitle = '系统设置';

  // 通用 saveSetting 脚本
  const saveScript = `<script>
var items = $("select[default]");
for (i = 0; i < items.length; i++) {
  $(items[i]).val($(items[i]).attr("default")||0);
}
function saveSetting(obj){
  var ii = layer.load(2, {shade:[0.1,'#fff']});
  $.ajax({
    type : 'POST',
     url : '/admin/ajax/saveSetting',
    data : $(obj).serialize(),
    dataType : 'json',
    success : function(data) {
      layer.close(ii);
      if(data.code == 0){
        layer.alert('设置保存成功', { icon: 1, closeBtn: false }, function(){ window.location.reload(); });
      }else{
        layer.alert(data.msg, {icon: 2});
      }
    },
    error:function(){ layer.msg('服务器错误'); }
  });
  return false;
}
</script>`;

  if (mod === 'site') {
    pageTitle = '网站信息设置';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">网站信息设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-2 control-label">网站标题</label>
    <div class="col-sm-10"><input type="text" name="title" value="${config.title}" class="form-control" required/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">关键词</label>
    <div class="col-sm-10"><input type="text" name="keywords" value="${config.keywords}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">网站描述</label>
    <div class="col-sm-10"><input type="text" name="description" value="${config.description}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">禁止访问IP</label>
    <div class="col-sm-10"><textarea class="form-control" name="blackip" rows="2" placeholder="多个IP用|隔开">${config.blackip}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">首页公告</label>
    <div class="col-sm-10"><textarea class="form-control" name="gonggao" rows="3" placeholder="不填写则不显示首页公告">${htmlspecialchars(config.gonggao)}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">文件查看页公告</label>
    <div class="col-sm-10"><textarea class="form-control" name="gg_file" rows="3" placeholder="不填写则不显示">${htmlspecialchars(config.gg_file)}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">统计代码</label>
    <div class="col-sm-10"><textarea class="form-control" name="tongji" rows="3" placeholder="不填写则不显示统计代码">${htmlspecialchars(config.tongji)}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">文件搜索功能</label>
    <div class="col-sm-10"><select class="form-control" name="filesearch" default="${config.filesearch}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-2 col-sm-10"><input type="submit" name="submit" value="提交" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>`;
  } else if (mod === 'user') {
    pageTitle = '用户登录设置';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">用户登录设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
    <label class="col-sm-3 control-label">用户登录</label>
    <div class="col-sm-9"><select class="form-control" name="userlogin" default="${config.userlogin}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">聚合登录接口地址</label>
    <div class="col-sm-9"><input type="text" name="login_apiurl" value="${config.login_apiurl}" class="form-control" placeholder="接口地址要以http://或https://开头，?结尾"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">应用APPID</label>
    <div class="col-sm-9"><input type="text" name="login_appid" value="${config.login_appid}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">应用APPKEY</label>
    <div class="col-sm-9"><input type="text" name="login_appkey" value="${config.login_appkey}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">三网盘登录方式</label>
    <div class="col-sm-9">
    <input type="hidden" name="login_qq" value="0"/>
    <input type="hidden" name="login_wx" value="0"/>
    <label class="checkbox-inline"><input type="checkbox" name="login_qq" value="1" ${config.login_qq ? 'checked' : ''}> QQ</label>
    <label class="checkbox-inline"><input type="checkbox" name="login_wx" value="1" ${config.login_wx ? 'checked' : ''}> 微信</label>
    </div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
<div class="panel-footer">
<span class="glyphicon glyphicon-info-sign"></span>
聚合登录接口昻὿用彩虹聚合登录系统搭建的站点</br/>
开启后请勿随意更换登录接口站点，否则会导致之前注册的用户全部无法登录</div>
</div>`;
  } else if (mod === 'stor') {
    pageTitle = '存储类型设置';
    const storOptions = (val: string) => {
      const types = [
        { v: 'r2', n: 'Cloudflare R2' },
        { v: 's3', n: 'S3兼容的存储' },
        { v: 'github', n: 'GitHub API' },
        { v: 'webdav', n: 'WebDAV' },
        { v: 'upyun', n: '又拍云' },
        { v: 'qiniu', n: '七牛云' },
      ];
      return types.map(t => `<option value="${t.v}"${config.storage === t.v ? ' selected' : ''}>${t.n}</option>`).join('');
    };
    panelBody = `<div class="panel panel-success">
<div class="panel-heading"><h3 class="panel-title">存储类型设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">切换存储类型</label>
      <div class="col-sm-9"><select class="form-control" name="storage" default="${config.storage}">${storOptions(config.storage)}</select><font color="green">已有文件的情况下请勿随意变更，否则之前上传的文件全部无法下载</font></div>
    </div><br/>
    <div id="cloud_stor">
    <div class="form-group" id="uploadfile_type_form">
      <label class="col-sm-3 control-label">文件上传方式</label>
       <div class="col-sm-9"><select class="form-control" name="uploadfile_type" default="${config.uploadfile_type}"><option value="0">网站中转</option><option value="1">直接链接</option></select><font color="green">直传需存储商允许跨域(CORS)，否则请使用中转</font></div>
    </div><br/>
    <div class="form-group" id="downfile_type_mode_form">
      <label class="col-sm-3 control-label">文件下载方式</label>
       <div class="col-sm-9"><select class="form-control" name="downfile_type" default="${config.downfile_type}"><option value="0">网站中转</option><option value="1">直接链接</option></select></div>
    </div><br/>
    <div class="form-group" id="downfile_domain_form" style="${config.downfile_type !== 1 ? 'display:none;' : ''}">
      <label class="col-sm-3 control-label">文件下载域名</label>
      <div class="col-sm-9">
        <div class="row">
        <div class="col-xs-4 col-md-3" style="padding-right: 0px;">
          <select class="form-control" name="downfile_protocol" default="${config.downfile_protocol}"><option value="0">http://</option><option value="1">https://</option></select>
        </div>
        <div class="col-xs-8 col-md-9" style="padding-left: 0px;">
          <input type="text" class="form-control" name="downfile_domain" value="${config.downfile_domain}" placeholder="留空则使用云存储默认域名">
        </div>
        </div>
        <font color="green">不设Bucket绑定的域名，也可使用CDN域名</font>
      </div>
    </div><br/>
    <div class="form-group" id="gh_proxy_form" style="display:none">
      <label class="col-sm-3 control-label">下载代理地址</label>
      <div class="col-sm-9"><input type="text" class="form-control" name="gh_download_proxy" value="${config.gh_download_proxy}" placeholder="https://ghfast.top/"/><font color="green">GitHub 直连下载走代理前缀，留空则直连原始地址</font></div>
    </div><br/>
    </div>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info stor-panel" data-stor="r2">
<div class="panel-heading"><h3 class="panel-title">Cloudflare R2 配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">R2 公开访问URL</label>
      <div class="col-sm-9"><input type="text" name="r2_public_url" value="${config.r2_public_url}" class="form-control" placeholder="https://files.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">Account ID</label>
      <div class="col-sm-9"><input type="text" name="r2_account_id" value="${config.r2_account_id}" class="form-control" placeholder="Cloudflare Account ID"/><font color="green">未配置 FILE_R2 绑定时，使用 Account ID + AK/SK 通过 S3 API 访问 R2</font></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">Bucket</label>
      <div class="col-sm-9"><input type="text" name="r2_bucket" value="${config.r2_bucket}" class="form-control" placeholder="R2 存储桶名称"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">AccessKey</label>
      <div class="col-sm-9"><input type="text" name="r2_access_key_id" value="${config.r2_access_key_id}" class="form-control" placeholder="R2 Access Key ID"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">SecretKey</label>
      <div class="col-sm-9"><input type="text" name="r2_secret_access_key" value="${config.r2_secret_access_key}" class="form-control" placeholder="R2 Secret Access Key"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 API Endpoint（可选）</label>
      <div class="col-sm-9"><input type="text" name="r2_endpoint" value="${config.r2_endpoint}" class="form-control" placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info stor-panel" data-stor="s3">
<div class="panel-heading"><h3 class="panel-title">S3 兼容的存储配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 Endpoint</label>
      <div class="col-sm-9"><input type="text" name="s3_endpoint" value="${config.s3_endpoint}" class="form-control" placeholder="https://s3.amazonaws.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 Region</label>
      <div class="col-sm-9"><input type="text" name="s3_region" value="${config.s3_region}" class="form-control" placeholder="us-east-1"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 Bucket</label>
      <div class="col-sm-9"><input type="text" name="s3_bucket" value="${config.s3_bucket}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">AccessKey</label>
      <div class="col-sm-9"><input type="text" name="s3_ak" value="${config.s3_ak}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">SecretKey</label>
      <div class="col-sm-9"><input type="text" name="s3_sk" value="${config.s3_sk}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info stor-panel" data-stor="github">
<div class="panel-heading"><h3 class="panel-title">GitHub API 配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">GitHub 用户名</label>
      <div class="col-sm-9"><input type="text" name="gh_owner" value="${config.gh_owner}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">仓库名称</label>
      <div class="col-sm-9"><input type="text" name="gh_repo" value="${config.gh_repo}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">Token</label>
      <div class="col-sm-9"><input type="text" name="gh_token" value="${config.gh_token}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">分支</label>
      <div class="col-sm-9"><input type="text" name="gh_ref" value="${config.gh_ref}" class="form-control" placeholder="main"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储类型与</label>
      <div class="col-sm-9"><input type="text" name="gh_folder" value="${config.gh_folder}" class="form-control" placeholder="file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info stor-panel" data-stor="webdav">
<div class="panel-heading"><h3 class="panel-title">WebDAV 配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">WebDAV 地址</label>
      <div class="col-sm-9"><input type="text" name="webdav_endpoint" value="${config.webdav_endpoint}" class="form-control" placeholder="https://dav.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">用户</label>
      <div class="col-sm-9"><input type="text" name="webdav_user" value="${config.webdav_user}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">密码</label>
      <div class="col-sm-9"><input type="text" name="webdav_pass" value="${config.webdav_pass}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储类型与</label>
      <div class="col-sm-9"><input type="text" name="webdav_folder" value="${config.webdav_folder}" class="form-control" placeholder="file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info stor-panel" data-stor="upyun">
<div class="panel-heading"><h3 class="panel-title">又拍云配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">服务名 (Bucket)</label>
      <div class="col-sm-9"><input type="text" name="upyun_bucket" value="${config.upyun_bucket}" class="form-control" placeholder="my-pan-storage"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">操作</label>
      <div class="col-sm-9"><input type="text" name="upyun_operator" value="${config.upyun_operator}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">密码</label>
      <div class="col-sm-9"><input type="password" name="upyun_password" value="${config.upyun_password}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">API 请求数</label>
      <div class="col-sm-9"><input type="text" name="upyun_endpoint" value="${config.upyun_endpoint}" class="form-control" placeholder="https://v0.api.upyun.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">加速域名</label>
      <div class="col-sm-9"><input type="text" name="upyun_domain" value="${config.upyun_domain}" class="form-control" placeholder="https://xxx.b0.upaiyun.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储类型与</label>
      <div class="col-sm-9"><input type="text" name="upyun_folder" value="${config.upyun_folder}" class="form-control" placeholder="file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info stor-panel" data-stor="qiniu">
<div class="panel-heading"><h3 class="panel-title">七牛云配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">AccessKey (AK)</label>
      <div class="col-sm-9"><input type="text" name="qiniu_ak" value="${config.qiniu_ak}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">SecretKey (SK)</label>
      <div class="col-sm-9"><input type="password" name="qiniu_sk" value="${config.qiniu_sk}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储空间名称 (Bucket)</label>
      <div class="col-sm-9"><input type="text" name="qiniu_bucket" value="${config.qiniu_bucket}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">空间绑定域名</label>
      <div class="col-sm-9"><input type="text" name="qiniu_domain" value="${config.qiniu_domain}" class="form-control" placeholder="https://cdn.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储类型与</label>
      <div class="col-sm-9"><input type="text" name="qiniu_folder" value="${config.qiniu_folder}" class="form-control" placeholder="file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<script>
function applyStorView(){
  var t = $("select[name='storage']").val();
  // 上传方式：支持浏览器直传的存储（七牛/又拍/云/S3/R2）
  $("#uploadfile_type_form").toggle(t === 'qiniu' || t === 'upyun' || t === 's3' || t === 'r2');
  // 下载方式：有直链能力的存储（七牛/又拍/GitHub/S3/R2）
  $("#downfile_type_mode_form").toggle(t === 'qiniu' || t === 'upyun' || t === 'github' || t === 's3' || t === 'r2');
  // 只显示与当前存储类型匹配的配置面板
  $(".stor-panel").each(function(){
    $(this).css('display', $(this).data('stor') === t ? '' : 'none');
  });
  applyDownfileView();
}
function applyDownfileView(){
  var t = $("select[name='storage']").val();
  var isDirect = $("select[name='downfile_type']").val() == '1';
  // 下载域名：仅七牛云在直连时显示
  $("#downfile_domain_form").toggle(t === 'qiniu' && isDirect);
  // GitHub 代理地址：GitHub 直连时显示
  $("#gh_proxy_form").toggle(t === 'github' && isDirect);
}
$("select[name='storage']").change(applyStorView);
$(function(){ applyStorView(); });
$("select[name='downfile_type']").change(applyDownfileView);

function startMigrate(){
  var targetType = $("select[name='storage']").val();
  var currentStorage = '${config.storage}';
  if(targetType === currentStorage){
    layer.alert('您选择的存储类型与当前相同', {icon: 2});
    return;
  }
  var dialogContent = ''
    + '<div style="padding:20px">'
    + '<p><strong>当前存储：</strong>' + currentStorage.toUpperCase() + '</p>'
    + '<p><strong>请选择存储：</strong>' + targetType.toUpperCase() + '</p>'
    + '<hr/>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="copy" checked> 迁移数据：将所有现有文件复制到新存储桶，耗时较长</label></div>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="new"> 新文件用新存储桶，仅对新上传的文件使用新存储桶，旧文件保留在旧存储</label></div>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="switch"> 直接切换：完全切换到新存储桶，旧文件不再迁移，此迁移</label></div>'
    + '<hr/>'
    + '<p style="color:#999">您在迁移完成后删除旧存储的文件</p>'
    + '<div class="radio"><label><input type="radio" name="delete_old" value="0" checked> 保留旧存储文件</label></div>'
    + '<div class="radio"><label><input type="radio" name="delete_old" value="1"> 删除旧存储文件（仅迁移模式有效）</label></div>'
    + '</div>';
  layer.open({
    type: 1,
    title: '存储迁移选项',
    area: ['500px', 'auto'],
    content: dialogContent,
    btn: ['您开始迁移？', '取消'],
    yes: function(){
      var mode = $('input[name="migrate_mode"]:checked').val();
      var deleteOld = $('input[name="delete_old"]:checked').val();
      layer.closeAll();
      var ii = layer.load(2, {shade:[0.1,'#fff']});
      $.ajax({
        type: 'POST',
        url: '/admin/api/migrate/start',
        data: { mode: mode, target_type: targetType, delete_old: deleteOld },
        dataType: 'json',
        success: function(res){
          layer.close(ii);
          if(res.code === 0){
            pollMigrateProgress(res.taskId);
          } else {
            layer.alert(res.msg, {icon: 2});
          }
        },
        error: function(){
          layer.close(ii);
          layer.alert('服务器错误', {icon: 2});
        }
      });
    }
  });
}

function pollMigrateProgress(taskId){
  var ii = layer.load(2, {shade:[0.1,'#fff']});
  var timer = setInterval(function(){
    $.ajax({
      type: 'GET',
      url: '/admin/api/migrate/status?taskId=' + taskId,
      dataType: 'json',
      success: function(res){
        if(res.data && res.data.status === 'running'){
          var msg = '迁移进度: ' + res.data.processed + '/' + res.data.total + '\\n当前: ' + res.data.currentFile;
          layer.msg(msg, {time: 2000});
        } else if(res.data && res.data.status === 'completed'){
          clearInterval(timer);
          layer.close(ii);
          layer.alert('迁移完成！成功 ' + res.data.success + ', 失败: ' + res.data.failed, {icon: 1}, function(){
            window.location.reload();
          });
        } else if(res.data && res.data.status === 'failed'){
          clearInterval(timer);
          layer.close(ii);
          layer.alert('迁移完成但有错误。成功 ' + res.data.success + ', 失败: ' + res.data.failed, {icon: 2});
        }
      }
    });
  }, 2000);
}
</script>

<div class="panel panel-warning">
<div class="panel-heading"><h3 class="panel-title">存储迁移</h3></div>
<div class="panel-body">
  <p>请提交存储类型后点击下方按钮进行迁移，可选择迁移全部数据、新文件用新存储或直接切换</p>
  <button type="button" class="btn btn-warning" onclick="startMigrate()"><i class="fa fa-exchange"></i> 开始迁移到新存储</button>
</div>
</div>
`;
  } else if (mod === 'file') {
    pageTitle = '文件上传设置';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">文件上传设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-3 control-label">图片文件类型</label>
    <div class="col-sm-9"><input type="text" name="type_image" value="${config.type_image}" class="form-control" placeholder="多个文件类型用|隔开"/><font color="green">在文件预览页面，以上文件类型将以图片的形式展示</font></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">音频文件类型</label>
    <div class="col-sm-9"><input type="text" name="type_audio" value="${config.type_audio}" class="form-control" placeholder="多个文件类型用|隔开"/><font color="green">在文件预览页面，以上文件类型将以音频的形式展示</font></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">视频文件类型</label>
    <div class="col-sm-9"><input type="text" name="type_video" value="${config.type_video}" class="form-control" placeholder="多个文件类型用|隔开"/><font color="green">在文件预览页面，以上文件类型将以视频的形式展示</font></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">禁止上传的文件类型</label>
    <div class="col-sm-9"><input type="text" name="type_block" value="${config.type_block}" class="form-control" placeholder="多个文件类型用|隔开"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">文件名屏蔽关键词</label>
    <div class="col-sm-9"><input type="text" name="name_block" value="${config.name_block}" class="form-control" placeholder="多个关键词用|隔开"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">每IP每天限制上传数量</label>
    <div class="col-sm-9"><input type="text" name="upload_limit" value="${config.upload_limit}" class="form-control" placeholder="0或留空为不限制"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">视频文件需要审核</label>
    <div class="col-sm-9"><select class="form-control" name="videoreview" default="${config.videoreview}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">上传大小限制</label>
    <div class="col-sm-9"><div class="input-group"><input type="text" name="upload_size" value="${config.upload_size}" class="form-control" placeholder="不填写则不限制大小"/><span class="input-group-addon">MB</span></div></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">仅限登录用户上传</label>
    <div class="col-sm-9"><select class="form-control" name="forcelogin" default="${config.forcelogin}"><option value="0">否</option><option value="1">是</option></select></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>`;
  } else if (mod === 'green') {
    pageTitle = '图片检测设置';
    const greenLabelPorn = config.green_label_porn ? config.green_label_porn.split(',') : [];
    const greenLabelTerrorism = config.green_label_terrorism ? config.green_label_terrorism.split(',') : [];
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">图片检测设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
    <label class="col-sm-3 control-label">图片违规类型</label>
    <div class="col-sm-9"><select class="form-control" name="green_check" default="${config.green_check}"><option value="0">关闭</option><option value="1">阿里云内容安全接口</option><option value="2">腾讯云内容安全接口</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">AccessKey Id</label>
    <div class="col-sm-9"><input type="text" name="green_ak" value="${config.green_ak}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">AccessKey Secret</label>
    <div class="col-sm-9"><input type="text" name="green_sk" value="${config.green_sk}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">图片检测接入区域</label>
    <div class="col-sm-9"><select class="form-control" name="green_region" default="${config.green_region}"><option value="cn-beijing">华北2（北京）</option><option value="cn-shanghai">华东2（上海）</option><option value="cn-shenzhen">华南1（深圳）</option><option value="ap-southeast-1">新加坡</option><option value="us-west-1">美西</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">图片智能鉴黄</label>
    <div class="col-sm-9"><select class="form-control" name="green_check_porn" default="${config.green_check_porn}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">图片智能鉴黄屏蔽类型</label>
    <div class="col-sm-9">
    <label class="checkbox-inline"><input type="checkbox" name="green_label_porn" value="porn" ${greenLabelPorn.includes('porn') ? 'checked' : ''}/> 色情图片（porn）</label>
    <label class="checkbox-inline"><input type="checkbox" name="green_label_porn" value="sexy" ${greenLabelPorn.includes('sexy') ? 'checked' : ''}/> 性感图片（sexy）</label>
    </div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">图片暴恐涉政识别</label>
    <div class="col-sm-9"><select class="form-control" name="green_check_terrorism" default="${config.green_check_terrorism}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">图片暴恐涉政识别屏蔽类型</label>
    <div class="col-sm-9">
    <label class="checkbox-inline"><input type="checkbox" name="green_label_terrorism" value="bloody" ${greenLabelTerrorism.includes('bloody') ? 'checked' : ''}/> 血腥（bloody）</label>
    <label class="checkbox-inline"><input type="checkbox" name="green_label_terrorism" value="terrorism" ${greenLabelTerrorism.includes('terrorism') ? 'checked' : ''}/> 暴恐（terrorism）</label>
    </div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>`;
  } else if (mod === 'api') {
    pageTitle = '上传API设置';
    const siteUrlStr2 = siteUrl(c);
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">上传API设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-3 control-label">上传API</label>
    <div class="col-sm-9"><select class="form-control" name="api_open" default="${config.api_open}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">来源域名白名单</label>
    <div class="col-sm-9"><input type="text" name="api_referer" value="${config.api_referer}" class="form-control" placeholder="多个域名用|隔开"/><font color="green">多个域名用|隔开，不设置则不限制来源域名</font></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="提交" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>
<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">上传API文档</h3></div>
<div class="panel-body">
<pre>
API接口地址：${siteUrlStr2}api.php

当前API支持JSON、JSONP、FORM 3种返回方式，支持Web跨域调用，也支持程序直接调用。
请求方式：POST  multipart/form-data

请求参数说明： file - 文件（必填）
show - 首页显示（默认1）ispwd - 设置密码（默认空）pwd - 下载密码
format - 返回格式（json/jsonp/form，默认json
返回参数说明： code - 0为成功 msg - 提示信息
hash - 文件MD5
name - 文件名称
size - 文件大小
type - 文件格式
downurl - 下载地址
</pre>
</div>
</div>`;
  } else if (mod === 'iptype') {
    pageTitle = '用户IP地址获取设置';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">用户IP地址获取设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-2 control-label">用户IP地址获取方式</label>
      <div class="col-sm-10"><select class="form-control" name="ip_type" default="${config.ip_type}"><option value="0">0_X_FORWARDED_FOR</option><option value="1">1_X_REAL_IP</option><option value="2">2_REMOTE_ADDR</option></select></div>
    </div>
    <div class="form-group">
      <div class="col-sm-offset-2 col-sm-10"><input type="submit" name="submit" value="修改" class="btn btn-primary form-control"/><br/></div>
    </div>
  </form>
</div>
<div class="panel-footer">
<span class="glyphicon glyphicon-info-sign"></span>
此功能设置用于防止用户伪造IP请求。<br/>
X_FORWARDED_FOR：之前的获取真实IP方式，极易被伪造IP<br/>
X_REAL_IP：在网站使用CDN的情况下选择此项，在不使用CDN的情况下也会被伪造<br/>
REMOTE_ADDR：直接获取真实请求IP，无法被伪造，但可能获取到的是CDN节点IP<br/>
<b>你可以从中选择一个能显示你真实地址的IP，优先选下方的选项。</b>
</div>
</div>`;
  } else if (mod === 'account') {
    pageTitle = '管理员账号设置';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">管理员账号设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-2 control-label">用户</label>
    <div class="col-sm-10"><input type="text" name="admin_user" value="${config.admin_user}" class="form-control" required/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">旧密码</label>
    <div class="col-sm-10"><input type="password" name="oldpwd" value="" class="form-control" placeholder="请输入当前的管理员密码"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">新密码</label>
    <div class="col-sm-10"><input type="password" name="newpwd" value="" class="form-control" placeholder="不修改请留空"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">重输密码</label>
    <div class="col-sm-10"><input type="password" name="newpwd2" value="" class="form-control" placeholder="不修改请留空"/></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-2 col-sm-10"><input type="submit" name="submit" value="提交" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>`;
  }

  const body = `<div class="container" style="padding-top:70px">
<div class="col-xs-12 col-sm-10 col-lg-8 center-block" style="float: none;">
${panelBody}
</div>
</div>
${saveScript}`;

  return c.html(adminLayout(pageTitle, body, siteUrlStr, 'set', true, config.title));
});

// ===================== /admin/restore
// 自动从迁移部署 /install 流程 =====================
frontend.get('/admin/restore', async (c) => {
  // 已安装后直接签到 302 到 /install
  return c.redirect('/install');
});

// ===================== 初始化数据库连接和监听 =====================
frontend.get('/admin/ajax/checkdb', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1, msg: 'auth failed' });
  const db = getDB(c);
  const config = getConf(c);

  const result = {
    ok: true,
    storage: config.storage,
    storageOk: c.var.storageOk,
    storExists: !!c.var.stor,
    installed: config.installed,
    queries: {} as Record<string, any>,
  };

  // 1. raw COUNT
  try {
    const r = await db.prepare('SELECT COUNT(*) as c FROM pre_file').first<{ c: number }>();
    result.queries['count_raw'] = { ok: true, value: r?.c ?? null, raw: JSON.stringify(r) };
  } catch (e: any) {
    result.queries['count_raw'] = { ok: false, error: e?.message || String(e) };
  }

  // 2. count with WHERE 1=1 (matching fileList)
  try {
    const r = await db.prepare('SELECT COUNT(*) as c FROM pre_file WHERE 1=1').first<{ c: number }>();
    result.queries['count_where'] = { ok: true, value: r?.c ?? null, raw: JSON.stringify(r) };
  } catch (e: any) {
    result.queries['count_where'] = { ok: false, error: e?.message || String(e) };
  }

  // 3. sample 1 row
  try {
    const row = await db.prepare('SELECT id, name, hash, addtime FROM pre_file ORDER BY id DESC LIMIT 1').first();
    result.queries['sample'] = { ok: true, row };
  } catch (e: any) {
    result.queries['sample'] = { ok: false, error: e?.message || String(e) };
  }

  // 4. table list
  try {
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    result.queries['tables'] = { ok: true, names: (tables.results || []).map((r: any) => r.name) };
  } catch (e: any) {
    result.queries['tables'] = { ok: false, error: e?.message || String(e) };
  }

  console.log(`[checkdb]`, JSON.stringify(result));
  return c.json({ code: 0, data: result });
});

/** 获取前端盘统计 */
frontend.get('/admin/ajax/getcount', async (c) => {
  // 整个处理器包在 try-catch，避免任何异常导致前端停留在 0
  try {
    // auth
    if (!await checkAdmin(c)) {
      console.warn('[getcount] auth failed');
      return c.json({ code: -1, msg: 'auth failed' });
    }
    const db = getDB(c);
    const config = getConf(c);

    // 文件总数：实际记录数，与“总大小”统计口径一致。
    let total = 0;
    try {
      const r = await db.prepare('SELECT COUNT(*) as c FROM pre_file').first<{ c: number }>();
      total = r?.c ?? 0;
    } catch (e: any) {
      console.error('[getcount] getFileTotal failed:', e?.message || e);
    }

    // 当前全部文件总大小（字节）
    let totalSize = 0;
    try {
      const r = await db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM pre_file').first<{ s: number }>();
      totalSize = Number(r?.s) || 0;
    } catch (e: any) {
      console.error('[getcount] totalSize failed:', e?.message || e);
    }

    // 抽样选一条验证。
    let sample: any = null;
    try {
      sample = await db.prepare('SELECT id, name, hash, addtime FROM pre_file ORDER BY id DESC LIMIT 1').first();
    } catch (e: any) {
      console.error('[getcount] sample failed:', e?.message || e);
    }

    // 日期边界全部使用 UTC，因为 Workers 运行在 UTC 时区。
    const isoNow = new Date().toISOString();
    const todayStr = isoNow.substring(0, 10);
    const todayBoundary = todayStr + ' 00:00:00';

    // 明天：加 1 天的 UTC 日期
    const tomorrowDate = new Date(Date.now() + 86400000);
    const tomorrowBoundary = tomorrowDate.toISOString().substring(0, 10) + ' 00:00:00';

    // 昨天：减 1 天的 UTC 日期
    const yesterdayDate = new Date(Date.now() - 86400000);
    const yesterdayBoundary = yesterdayDate.toISOString().substring(0, 10) + ' 00:00:00';

    let todayCount = 0;
    let yCount = 0;

    try {
      const todayR = await db.prepare(
        'SELECT COUNT(*) as c FROM pre_file WHERE addtime >= ? AND addtime < ?'
      ).bind(todayBoundary, tomorrowBoundary).first<{ c: number }>();
      todayCount = todayR?.c ?? 0;
    } catch (e: any) {
      console.error('[getcount] today query failed:', e?.message || e);
    }

    try {
      const yR = await db.prepare(
        'SELECT COUNT(*) as c FROM pre_file WHERE addtime >= ? AND addtime < ?'
      ).bind(yesterdayBoundary, todayBoundary).first<{ c: number }>();
      yCount = yR?.c ?? 0;
    } catch (e: any) {
      console.error('[getcount] yesterday query failed:', e?.message || e);
    }

    const count1 = total;
    const count2 = todayCount;
    const count3 = yCount;
    const storageNames: Record<string, string> = {
      r2: 'Cloudflare R2', s3: 'S3', github: 'GitHub API',
      webdav: 'WebDAV', upyun: '又拍云', qiniu: '七牛云',
    };
    const count4 = storageNames[config.storage] || config.storage || '未配置';

    console.log(`[getcount] total=${count1} totalSize=${totalSize} today=${count2} yesterday=${count3} storage=${count4} sample=${sample ? sample.id + ':' + sample.name : 'none'} todayBoundary=${todayBoundary} tomorrow=${tomorrowBoundary} yesterday=${yesterdayBoundary}`);

    return c.json({
      code: 0,
      count1, count2, count3, count4,
      totalSize,
      totalSizeText: sizeFormat(totalSize),
      debug: {
        today: todayBoundary,
        tomorrow: tomorrowBoundary,
        yesterday: yesterdayBoundary,
        sample: sample ? { id: sample.id, name: sample.name, hash: sample.hash, addtime: sample.addtime } : null,
      },
    });
  } catch (e: any) {
    console.error('[getcount] unhandled exception:', e?.message || e, e?.stack);
    // 兜底：仍然返回 code:0 以保证前端不会停在 0，至少给一个空值
    return c.json({
      code: 0,
      count1: 0,
      count2: 0,
      count3: 0,
      count4: 'UNKNOWN',
      totalSize: 0,
      totalSizeText: '0 B',
      error: e?.message || String(e),
    });
  }
});

/** 文件管理列表 */
frontend.post('/admin/ajax/fileList', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const offset = Math.max(0, parseInt(String(body['offset'] || '0')) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(String(body['limit'] || '15')) || 15));

  const where: string[] = ['1=1'];
  const params: any[] = [];

  // UID 筛选
  const uid = parseInt(String(body['uid'] || '0'));
  if (!isNaN(uid) && uid > 0) {
    where.push('uid = ?');
    params.push(uid);
  }

  // 状态筛选：-1 为全部
  const dstatus = parseInt(String(body['dstatus'] ?? '-1'));
  if (!isNaN(dstatus) && dstatus >= 0) {
    where.push('block = ?');
    params.push(dstatus);
  }

  // 关键词筛选，type 1=文件名 2=Hash 3=格式 4=上传IP
  const kw = String(body['kw'] || body['search'] || '').trim();
  if (kw) {
    const searchType = parseInt(String(body['type'] || '1'));
    if (searchType === 2) {
      where.push('hash = ?');
      params.push(kw);
    } else if (searchType === 3) {
      where.push('type = ?');
      params.push(kw);
    } else if (searchType === 4) {
      where.push('ip = ?');
      params.push(kw);
    } else {
      where.push('name LIKE ?');
      params.push(`%${kw}%`);
    }
  }

  // 排序：orderby 2/3 为按大小排序；0 时允许点击表头排序
  const orderby = String(body['orderby'] || '0');
  const sort = String(body['sort'] || body['sortName'] || '');
  const sortDir = String(body['order'] || body['sortOrder'] || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sortableColumns: Record<string, string> = {
    id: 'id', uid: 'uid', name: 'name', size: 'size', type: 'type',
    addtime: 'addtime', lasttime: 'lasttime', ip: 'ip', count: 'count', block: 'block',
  };
  let order = 'id DESC';
  if (orderby === '1') order = 'count DESC';
  else if (orderby === '2') order = 'size DESC';
  else if (orderby === '3') order = 'size ASC';
  else if (sort && sortableColumns[sort]) order = `${sortableColumns[sort]} ${sortDir}`;

  const total = (await db.prepare(`SELECT count(*) as c FROM pre_file WHERE ${where.join(' AND ')}`).bind(...params).first<{ c: number }>())?.c || 0;
  const { results } = await db.prepare(
    `SELECT * FROM pre_file WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<any>();

  const rows = results.map((r: any) => ({
    ...r,
    size: sizeFormat(r.size),
    icon: typeToIcon(r.type),
    view: isView(r.type),
    view_type: getViewType(r.type),
    fileurl: `../down.php/${r.hash}.${r.type || 'file'}`,
    viewurl: `../view.php/${r.hash}.${r.type || 'file'}`,
    embedurl: `../view.php/embed/${r.hash}?ext=${encodeURIComponent(r.type || 'file')}`,
    pageurl: `../file.php?hash=${r.hash}${r.pwd ? '&pwd=' + r.pwd : ''}`,
  }));

  return c.json({ total, rows });
});

frontend.get('/admin/ajax/getFileInfo', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  const row = await getFileById(db, id);
  if (!row) return c.json({ code: -1, msg: '文件不存在' });
  return c.json({ ...row, code: 0, size2: sizeFormat(row.size) });
});

frontend.post('/admin/ajax/saveFileInfo', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const id = parseInt(body['id'] || '0');
  const name = String(body['name'] || '').trim();
  const type = String(body['type'] || '').trim();
  const hide = parseInt(body['hide'] || '0');
  const ispwd = parseInt(body['ispwd'] || '0');
  const pwd = ispwd === 1 ? String(body['pwd'] || '').trim() : null;

  if (!name) return c.json({ code: -1, msg: '文件名称不能为空' });
  if (ispwd === 1 && pwd && !/^[a-zA-Z0-9]+$/.test(pwd)) {
    return c.json({ code: -1, msg: '下载密码只能为字母和数字' });
  }

  await updateFile(db, { id, name, type, hide, pwd });
  purgeHomeCache(c);
  return c.json({ code: 0, msg: '提交成功' });
});

frontend.get('/admin/ajax/setBlock', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  const status = parseInt(c.req.query('status') || '0');
  await setFileBlock(db, id, status);
  purgeHomeCache(c);
  return c.json({ code: 0, msg: '提交成功' });
});

frontend.get('/admin/ajax/delFile', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  const row = await getFileById(db, id);
  if (!row) return c.json({ code: -1, msg: '文件不存在' });

  const backends = getStorageBackends(getConf(c), c.env);
  const result = await deleteObjectFromBackends(backends, row.hash);
  if (!result.ok) {
    // 存储删除失败时保留数据库记录，避免出现“数据库没了、R2 还在”的孤儿文件
    const detail = [...result.errors];
    if (result.remaining.length) detail.push(`仍存在：${result.remaining.join('、')}`);
    return c.json({ code: -1, msg: '存储删除失败，数据库记录已保留：' + detail.join('；') });
  }

  const ok = await deleteFile(db, id);
  if (!ok) return c.json({ code: -1, msg: '数据库记录删除失败' });
  purgeHomeCache(c);
  return c.json({ code: 0, msg: '删除成功' });
});

frontend.post('/admin/ajax/operation', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const status = parseInt(String(body['status'] || '0'));
  // 原版前端提交的是 checkbox: [id1, id2]，jQuery 序列化后为 checkbox[]=...
  // 同时兼容旧的 ids=1,2 写法。
  const rawIds: any = (body as any)['checkbox'] ?? (body as any)['checkbox[]'] ?? body['ids'];
  let ids: number[] = [];
  if (Array.isArray(rawIds)) {
    ids = rawIds.map((v: any) => parseInt(String(v))).filter((n: number) => !isNaN(n));
  } else if (rawIds != null && String(rawIds) !== '') {
    ids = String(rawIds).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }
  if (ids.length === 0) return c.json({ code: -1, msg: '您未选中文件' });

  let opname = '处理';
  if (status === 0) opname = '删除';
  else if (status === 1) opname = '封禁'; 
  else if (status === 2) opname = '解封';

  let count = 0;
  const failures: string[] = [];
  const backends = status === 0 ? getStorageBackends(getConf(c), c.env) : [];

  for (const id of ids) {
    if (status === 0) {
      const row = await getFileById(db, id);
      if (!row) continue;
      const result = await deleteObjectFromBackends(backends, row.hash);
      if (!result.ok) {
        const detail = [...result.errors];
        if (result.remaining.length) detail.push(`仍存在：${result.remaining.join('、')}`);
        failures.push(`${row.name || row.hash}：${detail.join('；') || '存储删除失败'}`);
        continue;
      }
      if (await deleteFile(db, id)) count++;
    } else if (status === 1) {
      await setFileBlock(db, id, 1);
      count++;
    } else if (status === 2) {
      await setFileBlock(db, id, 0);
      count++;
    }
  }
  purgeHomeCache(c);
  if (failures.length) {
    return c.json({
      code: 0,
      msg: `成功${opname} ${count} 个文件，${failures.length} 个失败：${failures.slice(0, 3).join('；')}${failures.length > 3 ? '……' : ''}`,
    });
  }
  return c.json({ code: 0, msg: `成功${opname} ${count} 个文件` });
});

export default frontend;
