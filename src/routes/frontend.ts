// 彩虹外链网盘 - 页面渲染路由 (SSR 模板直出，保持原 jQuery+Bootstrap 界面)
// 仿照原 PHP 项目结构：
//   /                -> index.php 文件列表
//   /upload.php      -> upload.php 上传页
//   /file.php?hash=  -> file.php 文件查看
//   /admin           -> admin/index.php 后台首页
//   /admin/file      -> admin/file.php 文件管理
//   /admin/login     -> admin/login.php

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf, getStor, getStorOrThrow } from '../middleware';
import { updateConfig, clearConfigCache } from '../config';
import { getFileByHash, getFileById, setFileBlock, deleteFile, updateFile, touchFile, getFileTotal, getFileCountByDateRange } from '../db';
import { verifyAdminToken, signAdminToken } from '../auth/admin';
import { getViewType, sizeFormat, typeToIcon } from '../utils/mime';
import { htmlspecialchars, generateCsrfToken } from '../utils/response';

const frontend = new Hono<AppEnv>();

// CDN 资源（与原项目 header.php/footer.php 完全一致）
const CDN = {
  jquery: 'https://s4.zstatic.net/ajax/libs/jquery/1.12.4/jquery.min.js',
  bootstrapCss: 'https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css',
  bootstrapJs: 'https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/js/bootstrap.min.js',
  fontAwesome: 'https://s4.zstatic.net/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css',
  materialCss: 'https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/css/bootstrap-material-design.min.css',
  ripplesCss: 'https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/css/ripples.min.css',
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

/** 顶部导航栏（仿原 header.php） */
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

function publicFooter(siteTitle: string): string {
  return `<footer class="footer text-center">
<div class="container">
<p class="text-muted">Copyright &copy; ${new Date().getFullYear()} <a href="/">${htmlspecialchars(siteTitle)}</a></p>
</div>
</footer>`;
}

/** 前台页面通用 layout（与原 header.php/footer.php 完全一致） */
function publicLayout(title: string, body: string, siteUrlStr: string, active: 'index' | 'upload' | 'file' | 'mine' = 'index', isFile: boolean = false, siteTitle: string = '彩虹外链网盘'): string {
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
${publicFooter(siteTitle)}
<script src="${CDN.bootstrapJs}"></script>
<script src="${CDN.materialJs}"></script>
<script src="${CDN.ripplesJs}"></script>
<script>$.material.init();</script>
</body>
</html>`;
}

/** 管理后台 layout（仿原 admin/head.php） */
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
      <li class="dropdown ${cls('set')}">
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
      <li><a href="/admin/login?logout=1" onclick="return confirm('是否确定退出登录？')"><i class="fa fa-sign-out"></i> 退出登录</a></li>
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
<link href="assets/css/admin.css" rel="stylesheet"/>
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

// ===================== 文件列表页 / =====================
frontend.get('/', async (c) => {
  const config = getConf(c);
  const db = getDB(c);
  const siteUrlStr = siteUrl(c);

  const isMine = c.req.query('m') === 'mine';
  const kw = (c.req.query('kw') || '').trim();
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const pageSize = 15;
  const offset = (page - 1) * pageSize;

  // 构建 where 条件
  const where: string[] = [];
  const params: any[] = [];
  if (isMine) {
    // 我的文件 - 基于 cookie 中的 file_ids 缓存
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
      // 限制最多 60 个，倒序
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
  const link = (page: number) => {
    const params = new URLSearchParams();
    if (isMine) params.set('m', 'mine');
    if (kw) params.set('kw', kw);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return './' + (qs ? '?' + qs : '');
  };

  const title = isMine
    ? '我的文件 - ' + config.title
    : config.title;
  const htext = isMine
    ? '我上传的文件'
    : '文件列表';

  const tableRows = rawRows.map((res: any, i: number) => {
    const fileurl = `down.php/${res.hash}.${res.type || 'file'}`;
    const viewurl = `file.php?hash=${res.hash}`;
    const icon = typeToIcon(res.type);
    return `<tr>
<td><b>${offset + i + 1}</b></td>
<td><a href="${fileurl}">下载</a>｜<a href="${viewurl}">查看</a></td>
<td><i class="fa ${icon} fa-fw"></i>${htmlspecialchars(res.name)}</td>
<td>${sizeFormat(res.size)}</td>
<td><font color="blue">${res.type || '未知'}</font></td>
<td>${res.addtime}</td>
<td>${(res.ip || '').replace(/\d+$/, '*')}</td>
</tr>`;
  }).join('');

  const empty = rawRows.length === 0
    ? '<tr><td colspan="7" align="center">还没上传过任何文件</td></tr>'
    : '';

  // 分页
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

  const body = `<div class="container">
<div class="well bs-component">
  <h2>${htext}
    <span class="searchbox" style="float:right">
      <form class="form-inline" action="./" method="GET">
        ${isMine ? '<input name="m" type="hidden" value="mine">' : ''}
        <input name="kw" class="form-control" type="search" placeholder="请输入搜索关键字" value="${htmlspecialchars(kw)}">
        <button class="btn btn-default btn-raised btn-sm" type="submit"><i class="fa fa-search" aria-hidden="true"></i> 搜索</button>
      </form>
    </span>
  </h2>
  <div class="table-responsive">
    <table class="table table-striped table-hover filelist">
      <thead>
        <tr><th>#</th><th>操作</th><th>文件名</th><th>文件大小</th><th>文件格式</th><th>上传时间</th><th>上传者IP</th></tr>
      </thead>
      <tbody>
        ${tableRows}
        ${empty}
      </tbody>
    </table>
  </div>
  <div class="row">
    <div class="col-md-6"><br>共有 ${totalCount} 个文件&nbsp;&nbsp;当前第 ${page} 页，共 ${totalPages} 页</div>
    <div class="col-md-6"><nav>${pagination}</nav></div>
  </div>
</div>
</div>`;

  return c.html(publicLayout(title, body, siteUrlStr, isMine ? 'mine' : 'index', false, config.title));
});

// ===================== 上传页 /upload.php =====================
frontend.get('/upload.php', (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  const csrf = generateCsrfToken();

  // 保存 csrf 到一个临时 cookie，ajax 端会比对
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
<input type="checkbox" id="show" v-model="input.show"> 在首页文件列表显示
</label>
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
**您的IP是${clientip}，请不要上传违规文件！
</div>
${config.upload_size > 0 ? `<div class="list-group-item">**上传无格式限制，当前服务器单个文件上传最大支持<b>${config.upload_size}MB</b>！
</div>` : `<div class="list-group-item">**上传无格式限制，无大小限制！
</div>`}
${config.videoreview == 1 ? `<div class="list-group-item">**当前网站已开启视频文件审核，如果上传的是视频文件，需要等待审核通过后才能下载和播放。
</div>` : ''}
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
<script src="assets/js/uploadnew.js"></script>`;

  return c.html(publicLayout('上传文件 - ' + config.title, body, siteUrlStr, 'upload', false, config.title));
});

// ===================== 文件查看页 /file.php?hash=xxx =====================
frontend.get('/file.php', async (c) => {
  const db = getDB(c);
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);

  const hash = c.req.query('hash') || '';
  const pwd = c.req.query('pwd') || null;

  if (!hash || !/^[0-9a-f]{32}$/i.test(hash)) {
    return c.html('<script>window.location.href="./";</script>', 302);
  }

  const row = await getFileByHash(db, hash);
  if (!row) {
    return c.html('<script>alert("文件不存在");window.location.href="./";</script>');
  }

  // 密码保护
  if (row.pwd && row.pwd !== '' && row.pwd !== pwd) {
    return c.html(`<meta charset="utf-8"/>
<title>请输入密码下载文件</title>
<script>
var pwd=prompt("请输入密码","")
if (pwd!=null && pwd!="")
{
    window.location.href="./file.php?hash=${hash}&pwd="+pwd
}
</script>
请刷新页面，或[ <a href="javascript:history.back();">返回上一页</a> ]`);
  }

  // 增加下载计数 + 设置 file_ids cookie（用于"我的文件"）
  await touchFile(db, row.id);
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/file_ids=([^;]+)/);
  let ids: number[] = [];
  if (match) {
    try {
      ids = atob(decodeURIComponent(match[1])).split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
    } catch {}
  }
  if (!ids.includes(row.id)) {
    ids.unshift(row.id);
    if (ids.length > 60) ids = ids.slice(0, 60);
  }
  c.header('Set-Cookie', `file_ids=${encodeURIComponent(btoa(ids.join(',')))}; Path=/; Max-Age=604800; SameSite=Lax`);

  const downurl = `down.php/${row.hash}.${row.type || 'file'}`;
  const viewurl = `view.php/${row.hash}.${row.type || 'file'}`;
  const downurlAll = `${siteUrlStr}/${downurl}`;
  const viewurlAll = `${siteUrlStr}/${viewurl}`;
  const thisurl = `${siteUrlStr}/file.php?hash=${row.hash}${pwd ? '&pwd=' + pwd : ''}`;

  const viewType = getViewType(row.type);
  let fileTitle = '';
  let htmlcode = '';
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
    fileTitle = '<i class="fa fa-music"></i> 音乐播放器';
    htmlcode = htmlspecialchars(`<audio src="${viewurlAll}" autoplay="autoplay" loop="loop" preload="auto"></audio>`);
    ubbcode = `[audio]${viewurlAll}[/audio]`;
    linktitle = '音乐链接';
  } else if (viewType === 'video') {
    filetype = 3;
    fileTitle = '<i class="fa fa-video-camera"></i> 视频播放器';
    htmlcode = htmlspecialchars(`<video src="${viewurlAll}" controls="" width="100%"></video>`);
    ubbcode = `[movie]${viewurlAll}[/movie]`;
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
<div class="elsetext"><p>${htmlspecialchars(row.name)}</p><p>视频文件需审核通过后才能在线播放和下载，请等待审核通过！</p></div></div>`;
  } else {
    const icon = typeToIcon(row.type);
    fileContent = `<div class="view"><div class="elseview"><div class="tubiao"><i class="fa ${icon}"></i></div></div>
<div class="elsetext"><p>${htmlspecialchars(row.name)}（${sizeFormat(row.size)}）</p>
<a href="${downurl}" class="btn btn-raised btn-primary btn-lg"><i class="fa fa-download" aria-hidden="true"></i> 下载文件<div class="ripple-container"></div></a>
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
        <li><a href="#manager" data-toggle="tab"><i class="fa fa-cog"></i> 管理</a></li>
      </ul>
      <div id="myTabContent" class="tab-content" style="padding:19px">
        <div class="tab-pane fade active in" id="link">
          ${filetype > 0 ? `<div class="form-group row">
            <label class="col-md-2 control-label">${linktitle}：</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="link1" readonly value="${viewurlAll}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${viewurlAll}">复制</button></span>
              </div>
            </div>
          </div>` : ''}
          <div class="form-group row">
            <label class="col-md-2 control-label">下载链接：</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="link2" readonly value="${downurlAll}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${downurlAll}">复制</button></span>
              </div>
            </div>
          </div>
        </div>
        <div class="tab-pane fade" id="code">
          ${filetype >= 2 ? `<div class="form-group row">
            <label class="col-md-2 control-label">HTML代码：</label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="code2" readonly value='${htmlcode}'>
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text='${htmlcode}'>复制</button></span>
              </div>
            </div>
          </div>` : ''}
          <div class="form-group row">
            <label class="col-md-2 control-label">UBB代码：</label>
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
                <th width="97">上传者IP：</th><td width="100">${(row.ip || '').replace(/\d+$/, '*')}</td>
                <th width="100">上传时间：</th><td width="168">${row.addtime}</td>
              </tr>
              <tr>
                <th>下载次数：</th><td>${row.count}</td>
                <th>文件大小：</th><td>${sizeFormat(row.size)} (${row.size} 字节)</td>
              </tr>
            </table>
          </div>
        </div>
        <div class="tab-pane fade" id="manager">
          <div class="row" align="center">
            <div class="col-md-12">
              <input type="hidden" id="hash" value="${hash}">
              <input type="hidden" id="csrf_token" value="${generateCsrfToken()}">
              <button onclick="delete_confirm()" class="btn btn-raised btn-danger"><i class="fa fa-close"></i> 删除文件</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="col-sm-3">
  <div class="panel panel-info">
    <div class="panel-heading"><h3 class="panel-title"><i class="fa fa-exclamation-circle"></i> 提示</h3></div>
    <div class="panel-body">
      <p>直链可用于 img 标签、视频播放等场景。</p>
      <p>下载链接点击即可直接下载文件。</p>
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
<script>
function delete_confirm(){
  var hash = $("#hash").val();
  var csrf_token = $("#csrf_token").val();
  layer.confirm('删除文件后不可恢复，确定删除吗？', { btn: ['确定','取消'], icon: 0 }, function(){
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
  clipboard.on('success', function(){ layer.msg('复制成功！', {icon: 1}); });
  clipboard.on('error', function(){ layer.msg('复制失败，请长按链接后手动复制', {icon: 2}); });
});
${filetype === 2 ? `
$(function(){
  new APlayer({
    container: document.getElementById('aplayer'),
    loop: 'none',
    theme: '#b2dae6',
    audio: [{ title: '${htmlspecialchars(row.name).replace(/'/g, "\\'")}', author: 'none', url: '${viewurlAll}', cover: 'assets/img/music.png' }]
  });
});` : ''}
${filetype === 3 && row.block === 0 ? `
$(function(){
  var videoObject = { container: '.videoplayer', video: '${viewurlAll}', autoplay: false };
  // 简化版视频播放 - 实际项目里用 ckplayer
  $('.videoplayer').html('<video src="${viewurlAll}" controls style="max-width:100%"></video>');
});` : ''}
</script>`;

  return c.html(publicLayout('文件查看 - ' + config.title, body, siteUrlStr, 'file', filetype > 0, config.title));
});

// ===================== 管理后台登录页 /admin/login =====================
frontend.get('/admin/login', async (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);

  // 登出（必须在已登录检查之前，否则已登录用户无法退出）
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

  const body = `<div class="container" style="padding-top:100px">
<div class="col-md-4 col-md-offset-4">
<div class="panel panel-primary">
  <div class="panel-heading"><h3 class="panel-title">管理员登录</h3></div>
  <div class="panel-body">
    <form id="loginForm">
      <div class="form-group"><input class="form-control" id="username" placeholder="用户名" autofocus></div>
      <div class="form-group"><input type="password" class="form-control" id="password" placeholder="密码"></div>
      <button type="submit" class="btn btn-primary btn-block">登 录</button>
    </form>
  </div>
</div>
</div>
</div>
<script>
document.getElementById('loginForm').onsubmit = async function(e){
  e.preventDefault();
  var user = document.getElementById('username').value;
  var pwd = document.getElementById('password').value;
  var res = await fetch('ajax/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: user, password: pwd})
  }).then(r => r.json());
  if (res.code === 0) { window.location.href = './'; }
  else { alert(res.msg || '登录失败'); }
};
</script>`;

  return c.html(adminLayout('管理员登录', body, siteUrlStr, 'index', false, config.title));
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
      <a href="/admin/file"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
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
        <div class="col-xs-9 text-right"><div class="huge" id="count4">0</div><div>存储类型</div></div>
      </div></div>
      <a href="./setting"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
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
        <li class="list-group-item">Workers 移植版 v1.0</li>
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
  url: 'ajax/getcount',
  dataType: 'json',
  success: function(data) {
    $('#count1').html(data.count1);
    $('#count2').html(data.count2);
    $('#count3').html(data.count3);
    $('#count4').html(data.count4);
  }
});
</script>`;

  return c.html(adminLayout('后台首页', body, siteUrlStr, 'index', true, config.title));
});

// ===================== 管理后台文件管理 /admin/file =====================
frontend.get('/admin/file', async (c) => {
  const siteUrlStr = siteUrl(c);
  const config = getConf(c);
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='/admin/login';</script>`);
  }

  const body = `<style>
.table>tbody>tr>td{vertical-align:middle;max-width:360px;word-break:break-all}
</style>
<div class="modal" id="modal-store" role="dialog">
  <div class="modal-dialog">
    <div class="modal-content animated flipInX">
      <div class="modal-header">
        <button type="button" class="close" data-dismiss="modal"><span aria-hidden="true">&times;</span></button>
        <h4 class="modal-title">文件信息修改</h4>
      </div>
      <div class="modal-body">
        <form class="form-horizontal" id="form-store">
          <input type="hidden" name="id" id="store_id">
          <div class="form-group"><label class="col-sm-2 control-label">文件名称</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="name" id="store_name"></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">文件类型</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="type" id="store_type"></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">文件大小</label>
            <div class="col-sm-10"><input type="text" class="form-control" id="store_size" disabled></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">文件Hash</label>
            <div class="col-sm-10"><input type="text" class="form-control" id="store_hash" disabled></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">是否隐藏</label>
            <div class="col-sm-10"><select id="store_hide" name="hide" class="form-control"><option value="0">0_否</option><option value="1">1_是</option></select></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">启用密码</label>
            <div class="col-sm-10"><select id="store_ispwd" name="ispwd" class="form-control" onchange="change_ispwd(this)"><option value="0">0_否</option><option value="1">1_是</option></select></div></div>
          <div class="form-group" id="pwd_frame" style="display:none"><label class="col-sm-2 control-label">下载密码</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="pwd" id="store_pwd"></div></div>
        </form>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-white" data-dismiss="modal">关闭</button>
        <button type="button" class="btn btn-primary" onclick="saveFile()">保存</button>
      </div>
    </div>
  </div>
</div>
<div class="container" style="padding-top:70px">
<div class="col-xs-12 center-block" style="float:none">
  <form onsubmit="return searchSubmit()" method="GET" class="form-inline" id="searchToolbar">
    <div class="form-group">
      <label>搜索</label>
      <select name="type" class="form-control"><option value="1">文件名</option><option value="2">文件Hash</option></select>
    </div>
    <div class="form-group"><input type="text" class="form-control" name="kw" placeholder="搜索内容"></div>
    <div class="form-group">
      <select id="dstatus" name="dstatus" class="form-control"><option value="-1">全部状态</option><option value="0">正常文件</option><option value="1">已屏蔽文件</option><option value="2">待审核文件</option></select>
    </div>
    <div class="form-group">
      <select id="orderby" name="orderby" class="form-control"><option value="0">默认排序</option><option value="1">按下载量排序</option></select>
    </div>
    <div class="form-group">
      <button class="btn btn-primary" type="submit"><i class="fa fa-search"></i> 搜索</button>
      <a href="javascript:searchClear()" class="btn btn-default"><i class="fa fa-repeat"></i> 重置</a>
    </div>
    <div class="btn-group" role="group">
      <button type="button" class="btn btn-default dropdown-toggle" data-toggle="dropdown">批量操作 <span class="caret"></span></button>
      <ul class="dropdown-menu">
        <li><a href="javascript:operation(0)"><i class="fa fa-trash"></i> 删除</a></li>
        <li><a href="javascript:operation(1)"><i class="fa fa-times-circle"></i> 封禁</a></li>
        <li><a href="javascript:operation(2)"><i class="fa fa-check-circle"></i> 解封</a></li>
      </ul>
    </div>
  </form>
  <table id="listTable"></table>
</div>
</div>
<script src="${CDN.layer}"></script>
<script src="${CDN.bootstrapTableJs}"></script>
<script src="${CDN.bootstrapTablePageJump}"></script>
<script>
function change_ispwd(obj){ if($(obj).val()==1) $('#pwd_frame').show(); else $('#pwd_frame').hide(); }

var \$_GET = {};
document.location.search.replace(/\\??(?:(\\w+)=(\\w*)(?:&|$))*/g, function(_, k, v){ \$_GET[k] = v; });

$(function(){
  var pageNumber = \$_GET['pageNumber'] ? parseInt(\$_GET['pageNumber']) : 1;
  var pageSize = \$_GET['pageSize'] ? parseInt(\$_GET['pageSize']) : 15;
  $('#listTable').bootstrapTable({
    url: 'ajax/fileList',
    method: 'post',
    pageNumber: pageNumber,
    pageSize: pageSize,
    classes: 'table table-striped table-hover table-bordered',
    columns: [
      { field: '', checkbox: true },
      { field: 'id', title: 'ID', formatter: function(v){ return '<b>'+v+'</b>'; } },
      { field: 'name', title: '文件名', formatter: function(v, row){
          var html = '<a href="'+row.fileurl+'" title="点击下载"><i class="fa '+row.icon+' fa-fw"></i>'+v+'</a>';
          return html;
      } },
      { field: 'size', title: '文件大小' },
      { field: 'type', title: '文件格式', formatter: function(v){ return v ? v : '未知'; } },
      { field: 'addtime', title: '上传日期', formatter: function(v, row){ return v + '<br/>' + (row.lasttime||''); } },
      { field: 'ip', title: '上传IP/下载量', formatter: function(v, row){ return v + '<br/><b>'+row.count+'</b>'; } },
      { field: 'block', title: '状态', formatter: function(v, row){
          if(v==2) return '<a href="javascript:setBlock('+row.id+',0)" class="btn btn-xs btn-warning">待审</a>';
          else if(v==1) return '<a href="javascript:setBlock('+row.id+',0)" class="btn btn-xs btn-danger">封禁</a>';
          else return '<a href="javascript:setBlock('+row.id+',1)" class="btn btn-xs btn-success">正常</a>';
      } },
      { field: 'status', title: '操作', formatter: function(v, row){
          return '<a href="javascript:editframe('+row.id+')" class="btn btn-xs btn-info">编辑</a>&nbsp;<a href="'+row.pageurl+'" class="btn btn-xs btn-warning" target="_blank">查看</a>&nbsp;<a href="javascript:delFile('+row.id+')" class="btn btn-xs btn-danger">删除</a>';
      } }
    ]
  });
});

function setBlock(id, status) {
  $.ajax({ type:'GET', url:'ajax/setBlock?id='+id+'&status='+status, dataType:'json',
    success: function(){ searchSubmit(); }, error: function(){ layer.msg('服务器错误'); } });
}
function editframe(id){
  var ii = layer.load(2, {shade:[0.1,'#fff']});
  $.ajax({ type:'GET', url:'ajax/getFileInfo?id='+id, dataType:'json',
    success: function(data){
      layer.close(ii);
      if(data.code == 0){
        $('#modal-store').modal('show');
        $('#store_id').val(data.id);
        $('#store_name').val(data.name);
        $('#store_type').val(data.type);
        $('#store_size').val(data.size2+' ('+data.size+' 字节)');
        $('#store_hash').val(data.hash);
        $('#store_hide').val(data.hide);
        if(data.pwd==null||data.pwd==''){
          $('#store_ispwd').val(0); $('#store_pwd').val(''); $('#pwd_frame').hide();
        } else { $('#store_ispwd').val(1); $('#store_pwd').val(data.pwd); $('#pwd_frame').show(); }
      } else layer.alert(data.msg, {icon:2});
    }, error: function(){ layer.msg('服务器错误'); }
  });
}
function saveFile(){
  if($('#store_name').val()==''){ layer.alert('请确保各项不能为空！'); return; }
  var ii = layer.load(2);
  $.ajax({ type:'POST', url:'ajax/saveFileInfo', data: $('#form-store').serialize(), dataType:'json',
    success: function(data){
      layer.close(ii);
      if(data.code==0){ layer.alert(data.msg,{icon:1,closeBtn:false}, function(){ $('#modal-store').modal('hide'); searchSubmit(); }); }
      else layer.alert(data.msg, {icon:2});
    }, error: function(){ layer.msg('服务器错误'); }
  });
}
function delFile(id){
  layer.confirm('你确定要删除此文件吗？', { btn:['确定','取消'], icon:0 }, function(){
    $.ajax({ type:'GET', url:'ajax/delFile?id='+id, dataType:'json',
      success: function(d){ if(d.code==0){ layer.msg('删除成功',{icon:1}); searchSubmit(); } else layer.alert(d.msg,{icon:2}); }
    });
  });
}
function operation(status){
  var sel = $('#listTable').bootstrapTable('getSelections');
  if(sel.length==0){ layer.msg('请先选择文件'); return; }
  var ids = sel.map(function(r){ return r.id; });
  layer.confirm('确认对选中的 '+ids.length+' 个文件执行此操作？', { btn:['确定','取消'], icon:0 }, function(){
    $.ajax({ type:'POST', url:'ajax/operation', data: { status: status, ids: ids.join(',') }, dataType:'json',
      success: function(d){ if(d.code==0){ layer.msg(d.msg,{icon:1}); searchSubmit(); } else layer.alert(d.msg,{icon:2}); }
    });
  });
}
function searchSubmit(){ window.location.href = './file?' + $('#searchToolbar').serialize(); }
function searchClear(){ window.location.href = './file'; }
</script>`;

  return c.html(adminLayout('文件管理', body, siteUrlStr, 'file', true, config.title));
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
    url : '/admin/ajax/set',
    data : $(obj).serialize(),
    dataType : 'json',
    success : function(data) {
      layer.close(ii);
      if(data.code == 0){
        layer.alert('设置保存成功！', { icon: 1, closeBtn: false }, function(){ window.location.reload(); });
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
    <label class="col-sm-2 control-label">关键字</label>
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
    <div class="col-sm-10"><textarea class="form-control" name="gonggao" rows="3" placeholder="不填写则不显示首页公告">${config.gonggao}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">文件查看页公告</label>
    <div class="col-sm-10"><textarea class="form-control" name="gg_file" rows="3" placeholder="不填写则不显示">${config.gg_file}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">统计代码</label>
    <div class="col-sm-10"><textarea class="form-control" name="tongji" rows="3" placeholder="不填写则不显示统计代码">${config.tongji}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">文件搜索功能</label>
    <div class="col-sm-10"><select class="form-control" name="filesearch" default="${config.filesearch}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-2 col-sm-10"><input type="submit" name="submit" value="修改" class="btn btn-primary form-control"/><br/>
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
    <label class="col-sm-3 control-label">用户登录开关</label>
    <div class="col-sm-9"><select class="form-control" name="userlogin" default="${config.userlogin}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">聚合登录接口地址</label>
    <div class="col-sm-9"><input type="text" name="login_apiurl" value="${config.login_apiurl}" class="form-control" placeholder="接口地址要以http://或https://开头，以/结尾"/></div>
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
    <label class="col-sm-3 control-label">开启的登录方式</label>
    <div class="col-sm-9">
    <input type="hidden" name="login_qq" value="0"/>
    <input type="hidden" name="login_wx" value="0"/>
    <label class="checkbox-inline"><input type="checkbox" name="login_qq" value="1" ${config.login_qq ? 'checked' : ''}> QQ</label>
    <label class="checkbox-inline"><input type="checkbox" name="login_wx" value="1" ${config.login_wx ? 'checked' : ''}> 微信</label>
    </div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
<div class="panel-footer">
<span class="glyphicon glyphicon-info-sign"></span>
聚合登录接口是使用彩虹聚合登录系统搭建的站点。<br/>
开启后请勿随意更换登录接口站点，否则会导致之前注册的用户全部无法登录。
</div>
</div>`;
  } else if (mod === 'stor') {
    pageTitle = '存储类型设置';
    const storOptions = (val: string) => {
      const types = [
        { v: 'r2', n: 'Cloudflare R2' },
        { v: 's3', n: 'S3兼容存储' },
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
    <div id="cloud_stor" style="${config.storage === 'r2' ? '' : 'display:none;'}">
    <div class="form-group">
      <label class="col-sm-3 control-label">文件上传方式</label>
      <div class="col-sm-9"><select class="form-control" name="uploadfile_type" default="${config.uploadfile_type}"><option value="0">网站中转</option><option value="1">直接链接</option></select></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">文件下载方式</label>
      <div class="col-sm-9"><select class="form-control" name="downfile_type" default="${config.downfile_type}"><option value="0">网站中转</option><option value="1">直接链接</option></select></div>
    </div><br/>
    <div class="form-group" id="downfile_type_form" style="${config.downfile_type !== 1 ? 'display:none;' : ''}">
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
        <font color="green">填写Bucket绑定的域名，也可使用CDN域名</font>
      </div>
    </div><br/>
    </div>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">Cloudflare R2 配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">R2 公开访问URL</label>
      <div class="col-sm-9"><input type="text" name="r2_public_url" value="${config.r2_public_url}" class="form-control" placeholder="如 https://files.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">S3 兼容存储配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 Endpoint</label>
      <div class="col-sm-9"><input type="text" name="s3_endpoint" value="${config.s3_endpoint}" class="form-control" placeholder="如 https://s3.amazonaws.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 Region</label>
      <div class="col-sm-9"><input type="text" name="s3_region" value="${config.s3_region}" class="form-control" placeholder="如 us-east-1"/></div>
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
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
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
      <div class="col-sm-9"><input type="text" name="gh_ref" value="${config.gh_ref}" class="form-control" placeholder="如 main"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储目录</label>
      <div class="col-sm-9"><input type="text" name="gh_folder" value="${config.gh_folder}" class="form-control" placeholder="如 file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">WebDAV 配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">WebDAV 地址</label>
      <div class="col-sm-9"><input type="text" name="webdav_endpoint" value="${config.webdav_endpoint}" class="form-control" placeholder="如 https://dav.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">用户名</label>
      <div class="col-sm-9"><input type="text" name="webdav_user" value="${config.webdav_user}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">密码</label>
      <div class="col-sm-9"><input type="text" name="webdav_pass" value="${config.webdav_pass}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储目录</label>
      <div class="col-sm-9"><input type="text" name="webdav_folder" value="${config.webdav_folder}" class="form-control" placeholder="如 file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">又拍云配置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">服务名 (Bucket)</label>
      <div class="col-sm-9"><input type="text" name="upyun_bucket" value="${config.upyun_bucket}" class="form-control" placeholder="如 my-pan-storage"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">操作员</label>
      <div class="col-sm-9"><input type="text" name="upyun_operator" value="${config.upyun_operator}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">密码</label>
      <div class="col-sm-9"><input type="password" name="upyun_password" value="${config.upyun_password}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">API 端点</label>
      <div class="col-sm-9"><input type="text" name="upyun_endpoint" value="${config.upyun_endpoint}" class="form-control" placeholder="如 https://v0.api.upyun.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">加速域名</label>
      <div class="col-sm-9"><input type="text" name="upyun_domain" value="${config.upyun_domain}" class="form-control" placeholder="如 https://xxx.b0.upaiyun.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储目录</label>
      <div class="col-sm-9"><input type="text" name="upyun_folder" value="${config.upyun_folder}" class="form-control" placeholder="如 file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
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
      <div class="col-sm-9"><input type="text" name="qiniu_domain" value="${config.qiniu_domain}" class="form-control" placeholder="如 https://cdn.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">存储目录</label>
      <div class="col-sm-9"><input type="text" name="qiniu_folder" value="${config.qiniu_folder}" class="form-control" placeholder="如 file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<script>
$("select[name='storage']").change(function(){
  if($(this).val() == 'r2'){
    $("#cloud_stor").show();
  }else{
    $("#cloud_stor").hide();
  }
});
$("select[name='downfile_type']").change(function(){
  if($(this).val() == '1'){ $("#downfile_type_form").show(); }
  else{ $("#downfile_type_form").hide(); }
});

function startMigrate(){
  var targetType = $("select[name='storage']").val();
  var currentStorage = '${config.storage}';
  if(targetType === currentStorage){
    layer.alert('目标存储类型与当前相同', {icon: 2});
    return;
  }
  var dialogContent = ''
    + '<div style="padding:20px">'
    + '<p><strong>当前存储：</strong>' + currentStorage.toUpperCase() + '</p>'
    + '<p><strong>目标存储：</strong>' + targetType.toUpperCase() + '</p>'
    + '<hr/>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="copy" checked> 迁移数据：将所有现有文件复制到新存储（耗时较长）</label></div>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="new"> 新文件用新存储：只对新上传的文件使用新存储，旧文件保留在旧存储</label></div>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="switch"> 直接切换：完全切换到新存储，旧文件不可访问（最快）</label></div>'
    + '<hr/>'
    + '<p style="color:#999">是否在迁移完成后删除旧存储的文件？</p>'
    + '<div class="radio"><label><input type="radio" name="delete_old" value="0" checked> 保留旧存储文件</label></div>'
    + '<div class="radio"><label><input type="radio" name="delete_old" value="1"> 删除旧存储文件（仅迁移模式有效）</label></div>'
    + '</div>';
  layer.open({
    type: 1,
    title: '存储迁移选项',
    area: ['500px', 'auto'],
    content: dialogContent,
    btn: ['开始迁移', '取消'],
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
          layer.alert('迁移完成！成功: ' + res.data.success + ', 失败: ' + res.data.failed, {icon: 1}, function(){
            window.location.reload();
          });
        } else if(res.data && res.data.status === 'failed'){
          clearInterval(timer);
          layer.close(ii);
          layer.alert('迁移完成但有错误。成功: ' + res.data.success + ', 失败: ' + res.data.failed, {icon: 2});
        }
      }
    });
  }, 2000);
}
</script>

<div class="panel panel-warning">
<div class="panel-heading"><h3 class="panel-title">存储迁移</h3></div>
<div class="panel-body">
  <p>修改存储类型后点击下方按钮进行迁移。可选择迁移全部数据、新文件用新存储或直接切换。</p>
  <button type="button" class="btn btn-warning" onclick="startMigrate()"><i class="fa fa-exchange"></i> 开始迁移到新存储</button>
  <a href="/admin/restore" class="btn btn-info" style="margin-left:10px"><i class="fa fa-history"></i> 从原 PHP 项目恢复数据</a>
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
    <label class="col-sm-3 control-label">图片违规检测</label>
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
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary form-control"/><br/>
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
    <label class="col-sm-3 control-label">上传API开关</label>
    <div class="col-sm-9"><select class="form-control" name="api_open" default="${config.api_open}"><option value="0">关闭</option><option value="1">开启</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">来源域名白名单</label>
    <div class="col-sm-9"><input type="text" name="api_referer" value="${config.api_referer}" class="form-control" placeholder="多个域名用|隔开"/><font color="green">多个域名用|隔开，不填写则不限制来源域名</font></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="修改" class="btn btn-primary form-control"/><br/>
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

当前API支持JSON、JSONP、FORM 3种返回方式，支持Web跨域调用，也支持程序中直接调用。

请求方式：POST  multipart/form-data

请求参数说明：
file - 文件（必填）
show - 是否首页显示（默认1）
ispwd - 是否设置密码（默认0）
pwd - 下载密码
format - 返回格式（json/jsonp/form，默认json）

返回参数说明：
code - 0为成功
msg - 提示信息
hash - 文件MD5
name - 文件名称
size - 文件大小
type - 文件格式
downurl - 下载地址
</pre>
</div>
</div>`;
  } else if (mod === 'account') {
    pageTitle = '管理员账号设置';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">管理员账号设置</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-2 control-label">用户名</label>
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
    <div class="col-sm-offset-2 col-sm-10"><input type="submit" name="submit" value="修改" class="btn btn-primary form-control"/><br/>
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

// ===================== 数据恢复页面 /admin/restore =====================
frontend.get('/admin/restore', async (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='/admin/login';</script>`);
  }

  const body = `<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">从原 PHP 项目恢复数据</h3></div>
<div class="panel-body">
  <div class="alert alert-warning">
    <p><strong>使用说明：</strong></p>
    <ol>
      <li><strong>第一步：恢复数据库</strong> - 上传原项目的 SQL 备份文件，系统自动跳过 MySQL 专有语法</li>
      <li><strong>第二步：恢复文件</strong> - 输入原站点地址（如 <code>http://dl.802213.xyz/</code>），系统从 <code>pre_file</code> 表读取所有文件，自动到 <code>{原站点}/file/{hash}</code> 批量下载到当前存储</li>
    </ol>
  </div>
</div>
</div>

<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">第一步：恢复数据库 (SQL 文件)</h3></div>
<div class="panel-body">
  <form id="sqlFormUpload" enctype="multipart/form-data">
    <div class="form-group">
      <label>选择 SQL 备份文件</label>
      <input type="file" name="sql_file" class="form-control" accept=".sql" required/>
      <p class="help-block">支持 MySQL 导出的 .sql 文件（自动跳过 SET / CREATE TABLE 等 D1 不支持的语句）</p>
    </div>
    <button type="button" class="btn btn-primary" onclick="restoreSql()"><i class="fa fa-upload"></i> 上传并恢复</button>
  </form>
  <div id="sqlProgress" style="margin-top:15px;display:none;"></div>
</div>
</div>

<div class="panel panel-success">
<div class="panel-heading"><h3 class="panel-title">第二步：从原站点下载文件到当前存储</h3></div>
<div class="panel-body">
  <form id="sourceForm">
    <div class="form-group">
      <label>原站点 URL</label>
      <input type="text" name="source_url" id="sourceUrl" class="form-control" placeholder="http://dl.802213.xyz/" value="http://" required/>
      <p class="help-block">例如 <code>http://dl.802213.xyz/</code>，系统会从 <code>{原站点}/file/{hash}</code> 下载所有文件到存储</p>
    </div>
    <button type="button" class="btn btn-success" onclick="restoreFromSource()"><i class="fa fa-cloud-download"></i> 开始批量下载</button>
    <button type="button" class="btn btn-danger" onclick="cancelCurrentTask()" id="cancelBtn" style="display:none;"><i class="fa fa-stop"></i> 取消下载</button>
  </form>
  <div id="sourceProgress" style="margin-top:15px;display:none;"></div>
</div>
</div>

<script>
var currentTaskId = null;
var pollTimer = null;

function restoreSql(){
  var form = document.getElementById('sqlFormUpload');
  var fd = new FormData(form);
  var progress = document.getElementById('sqlProgress');
  progress.style.display = 'block';
  progress.innerHTML = '<div class="alert alert-info"><i class="fa fa-spinner fa-spin"></i> 正在上传 SQL...</div>';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/admin/api/restore/sql', true);
  xhr.upload.onprogress = function(e){
    if(e.lengthComputable){
      var pct = (e.loaded / e.total * 100).toFixed(1);
      progress.innerHTML = '<div class="alert alert-info"><i class="fa fa-spinner fa-spin"></i> 上传中 ' + pct + '% (' + (e.loaded / 1024 / 1024).toFixed(2) + ' / ' + (e.total / 1024 / 1024).toFixed(2) + ' MB)</div>';
    }
  };
  xhr.onload = function(){
    try {
      var res = JSON.parse(xhr.responseText);
      if(res.code === 0){
        var msg = '<strong>数据库恢复完成</strong><br/>成功: ' + (res.data.success || 0) + ', 失败: ' + (res.data.failed || 0);
        if(res.data.errors && res.data.errors.length > 0){
          msg += '<br/>错误: <pre style="max-height:200px;overflow:auto">' + res.data.errors.join('\\n').substring(0, 1500) + '</pre>';
        }
        progress.innerHTML = '<div class="alert alert-success">' + msg + '</div>';
      } else {
        progress.innerHTML = '<div class="alert alert-danger">错误: ' + (res.msg || '未知错误') + '</div>';
      }
    } catch(e) {
      progress.innerHTML = '<div class="alert alert-danger">解析响应失败: ' + e.message + '<br/>响应: <pre>' + xhr.responseText.substring(0, 500) + '</pre></div>';
    }
  };
  xhr.onerror = function(){
    progress.innerHTML = '<div class="alert alert-danger">网络错误: 请检查文件大小（最大 90MB）</div>';
  };
  xhr.ontimeout = function(){
    progress.innerHTML = '<div class="alert alert-danger">请求超时</div>';
  };
  xhr.timeout = 300000;
  xhr.send(fd);
}

function restoreFromSource(){
  var url = document.getElementById('sourceUrl').value.trim();
  if(!url || url === 'http://' || url === 'https://'){
    layer.alert('请输入原站点 URL', {icon: 2});
    return;
  }

  var progress = document.getElementById('sourceProgress');
  progress.style.display = 'block';
  progress.innerHTML = '<div class="alert alert-info"><i class="fa fa-spinner fa-spin"></i> 正在启动下载任务...</div>';
  document.getElementById('cancelBtn').style.display = 'inline-block';

  var fd = new FormData();
  fd.append('source_url', url);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/admin/api/restore/files-from-source', true);
  xhr.onload = function(){
    try {
      var res = JSON.parse(xhr.responseText);
      if(res.code === 0 && res.data && res.data.taskId){
        currentTaskId = res.data.taskId;
        pollDownloadProgress();
      } else {
        progress.innerHTML = '<div class="alert alert-danger">启动失败: ' + (res.msg || '未知错误') + '</div>';
        document.getElementById('cancelBtn').style.display = 'none';
      }
    } catch(e) {
      progress.innerHTML = '<div class="alert alert-danger">解析响应失败: ' + e.message + '<br/>响应: <pre>' + xhr.responseText.substring(0, 500) + '</pre></div>';
    }
  };
  xhr.onerror = function(){
    progress.innerHTML = '<div class="alert alert-danger">网络错误: 请重试</div>';
  };
  xhr.send(fd);
}

function pollDownloadProgress(){
  if(!currentTaskId) return;
  var progress = document.getElementById('sourceProgress');

  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(function(){
    fetch('/admin/api/restore/status?taskId=' + encodeURIComponent(currentTaskId))
      .then(r => r.json())
      .then(res => {
        if(res.code !== 0){
          progress.innerHTML = '<div class="alert alert-danger">查询失败: ' + (res.msg || '未知') + '</div>';
          return;
        }
        var s = res.data;
        var pct = s.total > 0 ? ((s.processed / s.total) * 100).toFixed(1) : '0';

        var html = '<div class="alert alert-info">'
          + '<h4 style="margin-top:0"><i class="fa fa-cloud-download"></i> 文件下载进度</h4>'
          + '<div class="progress" style="margin-bottom:10px;height:22px;"><div class="progress-bar progress-bar-success progress-bar-striped active" style="width:' + pct + '%;line-height:22px;">' + pct + '%</div></div>'
          + '<table class="table table-condensed" style="margin-bottom:5px;">'
          + '<tr><th style="width:140px">总文件 / 已下载</th><td><strong>' + s.processed + ' / ' + s.total + '</strong></td></tr>'
          + '<tr><th>成功 / 失败</th><td><span class="text-success">' + (s.success || 0) + '</span> / <span class="text-danger">' + (s.failed || 0) + '</span></td></tr>';
        if(s.currentItem){
          html += '<tr><th>当前下载文件</th><td><i class="fa fa-file"></i> ' + s.currentItem + '</td></tr>';
        }
        if(s.message){
          html += '<tr><th>状态</th><td>' + s.message + '</td></tr>';
        }
        html += '</table>';
        if(s.errors && s.errors.length > 0){
          html += '<div><strong>最近错误 (' + s.errors.length + ')：</strong><pre style="max-height:150px;overflow:auto;margin:5px 0 0 0;">' + s.errors.slice(-5).join('\\n') + '</pre></div>';
        }
        html += '</div>';
        progress.innerHTML = html;

        if(s.status === 'completed'){
          clearInterval(pollTimer);
          pollTimer = null;
          currentTaskId = null;
          document.getElementById('cancelBtn').style.display = 'none';
          var done = '<div class="alert alert-success">'
            + '<h4 style="margin-top:0"><i class="fa fa-check-circle"></i> 文件下载完成</h4>'
            + '<table class="table table-condensed">'
            + '<tr><th>总文件</th><td>' + s.total + '</td></tr>'
            + '<tr><th>成功</th><td><span class="text-success">' + s.success + '</span></td></tr>'
            + '<tr><th>失败</th><td><span class="text-danger">' + s.failed + '</span></td></tr>'
            + '</table>';
          if(s.errors && s.errors.length > 0){
            done += '<div><strong>失败的文件：</strong><pre style="max-height:250px;overflow:auto;">' + s.errors.join('\\n').substring(0, 3000) + '</pre></div>';
          }
          done += '</div>';
          progress.innerHTML = done;
        } else if(s.status === 'failed'){
          clearInterval(pollTimer);
          pollTimer = null;
          currentTaskId = null;
          document.getElementById('cancelBtn').style.display = 'none';
          var fail = '<div class="alert alert-danger"><h4 style="margin-top:0"><i class="fa fa-times-circle"></i> 下载失败</h4>';
          if(s.errors && s.errors.length > 0){
            fail += '<pre style="max-height:200px;overflow:auto;">' + s.errors.join('\\n').substring(0, 2000) + '</pre>';
          } else {
            fail += '<p>请检查原站点 URL 是否正确、是否可访问</p>';
          }
          fail += '</div>';
          progress.innerHTML = fail;
        } else if(s.status === 'cancelled'){
          clearInterval(pollTimer);
          pollTimer = null;
          currentTaskId = null;
          document.getElementById('cancelBtn').style.display = 'none';
          progress.innerHTML = '<div class="alert alert-warning">任务已取消</div>';
        }
      })
      .catch(e => {});
  }, 1000);
}

function cancelCurrentTask(){
  if(!currentTaskId) return;
  if(!confirm('确定要取消当前下载任务吗？')) return;
  fetch('/admin/api/restore/cancel', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'taskId=' + encodeURIComponent(currentTaskId)
  }).then(r => r.json()).then(res => {
    layer.msg(res.msg || (res.code === 0 ? '已请求取消' : '取消失败'), {icon: res.code === 0 ? 1 : 2});
  });
}
</script>
`;

  return c.html(adminLayout('数据恢复', body, siteUrlStr, 'set', true, config.title));
});


// ===================== 后台 AJAX =====================
frontend.post('/admin/ajax/login', async (c) => {
  const config = getConf(c);
  const body = await c.req.json() as { username: string; password: string };

  if (body.username === config.admin_user && body.password === config.admin_pwd) {
    const token = await signAdminToken(config.admin_user, config.admin_pwd, config.syskey, 7);
    c.header('Set-Cookie', `admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return c.json({ code: 0, msg: '登录成功' });
  }
  return c.json({ code: -1, msg: '用户名或密码错误' });
});

/** 保存设置 */
frontend.post('/admin/ajax/set', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1, msg: '未登录' });
  const config = getConf(c);
  const db = getDB(c);
  const formData = await c.req.formData();

  // 处理管理员账号特殊逻辑
  const adminUser = formData.get('admin_user') as string | null;
  const oldpwd = formData.get('oldpwd') as string | null;
  const newpwd = formData.get('newpwd') as string | null;
  const newpwd2 = formData.get('newpwd2') as string | null;

  if (adminUser !== null) {
    // 管理员账号设置
    if (!adminUser) return c.json({ code: -1, msg: '用户名不能为空' });
    await updateConfig(db, 'admin_user', adminUser);
    if (newpwd && newpwd2) {
      if (oldpwd !== config.admin_pwd) return c.json({ code: -1, msg: '旧密码不正确' });
      if (newpwd !== newpwd2) return c.json({ code: -1, msg: '两次输入的密码不一致' });
      await updateConfig(db, 'admin_pwd', newpwd);
    }
    clearConfigCache();
    return c.json({ code: 0, msg: '修改成功！请重新登录' });
  }

  // 处理复选框类型字段（未选中时不会提交，需要设为 0）
  const checkboxFields = ['login_qq', 'login_wx'];
  // 处理多选字段（数组形式）
  const multiFields = ['green_label_porn', 'green_label_terrorism'];

  // 遍历所有提交的字段
  const updates: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === 'submit') continue;
    if (multiFields.includes(key)) {
      if (!updates[key]) updates[key] = '';
      updates[key] = updates[key] ? updates[key] + ',' + value : value;
    } else {
      updates[key] = value as string;
    }
  }

  // 确保复选框字段有值
  for (const field of checkboxFields) {
    if (!(field in updates)) updates[field] = '0';
  }
  // 确保多选字段有值
  for (const field of multiFields) {
    if (!(field in updates)) updates[field] = '';
  }

  // 保存到数据库
  for (const [key, value] of Object.entries(updates)) {
    await updateConfig(db, key, value);
  }

  clearConfigCache();
  return c.json({ code: 0, msg: '设置保存成功' });
});

/** 仪表盘统计 */
frontend.get('/admin/ajax/getcount', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const config = getConf(c);

  const total = await getFileTotal(db);
  const today = new Date().toISOString().substring(0, 10) + ' 00:00:00';
  const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10) + ' 00:00:00';
  const todayCount = await getFileCountByDateRange(db, today);
  const yCount = await getFileCountByDateRange(db, yesterday, today);

  return c.json({
    code: 0,
    count1: total,
    count2: todayCount,
    count3: yCount,
    count4: config.storage.toUpperCase(),
  });
});

/** 文件管理列表 */
frontend.post('/admin/ajax/fileList', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const offset = parseInt(String(body['offset'] || '0'));
  const limit = parseInt(String(body['limit'] || '15'));
  const search = String(body['search'] || '');
  const order = body['sort'] === 'count' ? 'count DESC' : 'id DESC';

  const where: string[] = ['1=1'];
  const params: any[] = [];
  if (body['dstatus'] && parseInt(body['dstatus']) >= 0) {
    where.push('block = ?');
    params.push(parseInt(body['dstatus']));
  }
  if (search) {
    where.push('name LIKE ?');
    params.push(`%${search}%`);
  }

  const total = (await db.prepare(`SELECT count(*) as c FROM pre_file WHERE ${where.join(' AND ')}`).bind(...params).first<{ c: number }>())?.c || 0;
  const { results } = await db.prepare(
    `SELECT * FROM pre_file WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<any>();

  const rows = results.map((r: any) => ({
    ...r,
    size: sizeFormat(r.size),
    icon: typeToIcon(r.type),
    fileurl: `../down.php/${r.hash}.${r.type || 'file'}`,
    viewurl: `../view.php/${r.hash}.${r.type || 'file'}`,
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
  return c.json({ code: 0, msg: '修改成功' });
});

frontend.get('/admin/ajax/setBlock', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  const status = parseInt(c.req.query('status') || '0');
  await setFileBlock(db, id, status);
  return c.json({ code: 0, msg: '修改成功' });
});

frontend.get('/admin/ajax/delFile', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const id = parseInt(c.req.query('id') || '0');
  const row = await getFileById(db, id);
  if (!row) return c.json({ code: -1, msg: '文件不存在' });
  try {
    await stor.delete(row.hash);
  } catch {}
  await deleteFile(db, id);
  return c.json({ code: 0, msg: '删除成功' });
});

frontend.post('/admin/ajax/operation', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const status = parseInt(String(body['status'] || '0'));
  const idsStr = String(body['ids'] || '');
  const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  if (ids.length === 0) return c.json({ code: -1, msg: '未选中文件' });

  let opname = '处理';
  if (status === 0) opname = '删除';
  else if (status === 1) opname = '封禁';
  else if (status === 2) opname = '解封';

  let count = 0;
  for (const id of ids) {
    if (status === 0) {
      const row = await getFileById(db, id);
      if (row) {
        try { await stor.delete(row.hash); } catch {}
        await deleteFile(db, id);
      }
    } else if (status === 1) {
      await setFileBlock(db, id, 1);
    } else if (status === 2) {
      await setFileBlock(db, id, 0);
    }
    count++;
  }
  return c.json({ code: 0, msg: `成功${opname} ${count} 个文件` });
});

export default frontend;
