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
function publicNavBar(active: 'index' | 'upload' | 'file' | 'mine', siteUrlStr: string): string {
  const cls = (key: string) => active === key ? 'active' : '';
  return `<div class="navbar navbar-default">
<div class="container">
  <div class="navbar-header">
    <button type="button" class="navbar-toggle" data-toggle="collapse" data-target=".navbar-responsive-collapse">
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
    </button>
    <a class="navbar-brand" href="./">彩虹外链网盘</a>
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

function publicFooter(): string {
  return `<footer class="footer text-center">
<div class="container">
<p class="text-muted">Copyright &copy; ${new Date().getFullYear()} <a href="/">彩虹外链网盘</a></p>
</div>
</footer>`;
}

/** 前台页面通用 layout（与原 header.php/footer.php 完全一致） */
function publicLayout(title: string, body: string, siteUrlStr: string, active: 'index' | 'upload' | 'file' | 'mine' = 'index', isFile: boolean = false): string {
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
${publicNavBar(active, siteUrlStr)}
${body}
${publicFooter()}
<script src="${CDN.bootstrapJs}"></script>
<script src="${CDN.materialJs}"></script>
<script src="${CDN.ripplesJs}"></script>
<script>if(window.\\$)\\$().material.init();</script>
</body>
</html>`;
}

/** 管理后台 layout（仿原 admin/head.php） */
function adminLayout(title: string, body: string, siteUrlStr: string, active: 'index' | 'file' | 'user' | 'set' = 'index', showNav: boolean = true): string {
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
    <a class="navbar-brand" href="./">彩虹外链网盘管理中心</a>
  </div>
  <div id="navbar" class="collapse navbar-collapse">
    <ul class="nav navbar-nav navbar-right">
      <li class="${cls('index')}"><a href="./"><i class="fa fa-home"></i> 后台首页</a></li>
      <li class="${cls('file')}"><a href="./file"><i class="fa fa-folder-open"></i> 文件管理</a></li>
      <li><a href="./login?logout=1" onclick="return confirm('是否确定退出登录？')"><i class="fa fa-sign-out"></i> 退出登录</a></li>
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

  return c.html(publicLayout(title, body, siteUrlStr, isMine ? 'mine' : 'index'));
});

// ===================== 上传页 /upload.php =====================
frontend.get('/upload.php', (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  const csrf = generateCsrfToken();

  // 保存 csrf 到一个临时 cookie，ajax 端会比对
  c.header('Set-Cookie', `upload_csrf=${csrf}; Path=/; Max-Age=3600; SameSite=Lax`);

  const body = `<div class="container" style="padding-top:30px">
<div class="well bs-component">
  <div id="app">
    <div class="panel panel-primary">
      <div class="panel-heading">
        <h3 class="panel-title"><i class="fa fa-cloud-upload"></i> 上传文件</h3>
      </div>
      <div class="panel-body">
        <input type="file" id="file" style="display:none" @change="selectFile($event)">
        <div id="fileInput" @click="clickUpload()" :style="'background:'+background" style="border:2px dashed #ccc;padding:60px 20px;text-align:center;cursor:pointer;border-radius:8px;transition:background 0.2s">
          <i class="fa fa-cloud-upload" style="font-size:48px;color:#999"></i>
          <p style="margin-top:15px;font-size:18px">{{ uploadTitle }}</p>
          <input type="hidden" id="csrf_token" value="${csrf}">
        </div>

        <div v-if="filename" class="alert alert-info" style="margin-top:15px">
          <i class="fa fa-file"></i> {{ filename }}
        </div>

        <div v-if="showtype==1" style="margin-top:15px">
          <div class="progress" style="height:20px;">
            <div class="progress-bar progress-bar-striped active" :style="'width:'+progress+'%'">{{ progress }}%</div>
          </div>
          <p style="margin-top:8px;color:#666">{{ progress_tip }} <span class="pull-right" v-if="uploadspeed">{{ uploadspeed }}</span></p>
        </div>

        <div v-if="showtype==2" class="alert" :class="'alert-'+alert.type" style="margin-top:15px">
          <i class="fa fa-info-circle"></i> {{ alert.msg }}
        </div>

        <div v-if="isBlock" style="margin-top:15px">
          <button class="btn btn-primary" @click="clickUpload()"><i class="fa fa-upload"></i> 重新选择文件</button>
        </div>

        <div style="margin-top:15px">
          <label style="margin-right:20px"><input type="checkbox" v-model="input.show" checked> 显示在主页</label>
          <label><input type="checkbox" v-model="input.ispwd"> 启用下载密码</label>
          <input v-if="input.ispwd" type="text" class="form-control" style="margin-top:8px" v-model="input.pwd" placeholder="下载密码（仅字母+数字）">
        </div>
      </div>
    </div>
  </div>
</div>
</div>
<script src="${CDN.vue}"></script>
<script src="https://s4.zstatic.net/ajax/libs/spark-md5/3.0.2/spark-md5.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/layer/3.1.1/layer.min.js"></script>
<script src="assets/js/uploadnew.js"></script>`;

  return c.html(publicLayout('上传文件 - ' + config.title, body, siteUrlStr, 'upload'));
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

  return c.html(publicLayout('文件查看 - ' + config.title, body, siteUrlStr, 'file', filetype > 0));
});

// ===================== 管理后台登录页 /admin/login =====================
frontend.get('/admin/login', async (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);

  // 已登录则跳到后台
  const cookie = c.req.header('cookie') || '';
  const token = cookie.match(/admin_token=([^;]+)/)?.[1];
  if (token) {
    const valid = await verifyAdminToken(decodeURIComponent(token), config.admin_user, config.admin_pwd, config.syskey);
    if (valid) {
      return c.html('<script>window.location.href="./";</script>');
    }
  }

  // 登出
  if (c.req.query('logout') === '1') {
    c.header('Set-Cookie', 'admin_token=; Path=/; Max-Age=0');
    return c.html('<script>window.location.href="./login";</script>');
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

  return c.html(adminLayout('管理员登录', body, siteUrlStr, 'index', false));
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
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='./login';</script>`);
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
      <a href="./file"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-green">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-cloud-upload fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count2">0</div><div>今日上传文件</div></div>
      </div></div>
      <a href="./file"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-yellow">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-inbox fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count3">0</div><div>昨日上传文件</div></div>
      </div></div>
      <a href="./file"><div class="panel-footer"><span class="pull-left">查看详情</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
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

  return c.html(adminLayout('后台首页', body, siteUrlStr, 'index'));
});

// ===================== 管理后台文件管理 /admin/file =====================
frontend.get('/admin/file', async (c) => {
  const siteUrlStr = siteUrl(c);
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='../login';</script>`);
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

  return c.html(adminLayout('文件管理', body, siteUrlStr, 'file'));
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
