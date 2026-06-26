// 彩虹外链网盘 - 页面渲染路由 (SSR 模板直出，保持原 jQuery+Bootstrap 界面)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf } from '../middleware';
import { getFileByHash } from '../db';
import { verifyAdminToken } from '../auth/admin';
import { getViewType, sizeFormat, getFileExt } from '../utils/mime';
import { htmlspecialchars } from '../utils/response';

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
  clipboard: 'https://s4.zstatic.net/ajax/libs/clipboard.js/2.0.4/clipboard.min.js',
};

// 共用布局（匹配原项目 header.php + footer.php）
function layout(title: string, body: string, siteUrl: string = '', isFile: boolean = false): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,height=device-height,inital-scale=1.0,maximum-scale=1.0,user-scalable=no;">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="format-detection" content="telephone=no">
<title>${title}</title>
<link rel="stylesheet" href="${CDN.fontAwesome}">
<link rel="stylesheet" href="${CDN.bootstrapCss}">
<link rel="stylesheet" href="${CDN.materialCss}">
<link rel="stylesheet" href="${CDN.ripplesCss}">
${isFile ? `<link rel="stylesheet" href="${CDN.aplayerCss}"><link href="${siteUrl}assets/css/ckplayer.css" rel="stylesheet">` : ''}
<link rel="stylesheet" href="${siteUrl}assets/css/style.css">
<link rel="icon" href="${siteUrl}favicon.ico" type="image/x-icon">
<!--[if lt IE 9]>
<script src="https://s4.zstatic.net/ajax/libs/html5shiv/3.7.3/html5shiv.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/respond.js/1.4.2/respond.min.js"></script>
<![endif]-->
<script src="${CDN.jquery}"></script>
</head>
<body>
${body}
<footer class="footer text-center">
<div class="container">
<p class="text-muted">Copyright &copy; ${new Date().getFullYear()} <a href="${siteUrl}">彩虹外链网盘</a></p>
</div>
</footer>
<script src="${CDN.bootstrapJs}"></script>
<script src="${CDN.materialJs}"></script>
<script src="${CDN.ripplesJs}"></script>
${isFile ? `<script src="${siteUrl}assets/js/ckplayer.min.js"></script><script src="${siteUrl}assets/js/custom.js"></script>` : ''}
<script>if(window.\\$)\\$().material.init();</script>
</body>
</html>`;
}

function navBar(siteUrl: string): string {
  return `<nav class="navbar navbar-default navbar-fixed-top">
<div class="container">
<div class="navbar-header">
<a class="navbar-brand" href="${siteUrl}">🌈 彩虹外链网盘</a>
</div>
<ul class="nav navbar-nav navbar-right">
<li><a href="${siteUrl}admin">管理后台</a></li>
</ul>
</div>
</nav>`;
}

function filePageLayout(title: string, body: string, siteUrl: string, isFile: boolean = false): string {
  return layout(title, navBar(siteUrl) + body, siteUrl, isFile);
}

// 首页 / 上传页
frontend.get('/', async (c) => {
  const config = getConf(c);
  const siteUrl = (c.req.url || '').replace(/\/$/, '') + '/';

  const html = filePageLayout('彩虹外链网盘', `
<div class="container" style="padding-top:80px;">
<div id="app" class="row">
<div class="col-md-6 col-md-offset-3">
<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">📤 文件上传</h3></div>
<div class="panel-body" id="fileInput" style="text-align:center;padding:40px;cursor:pointer">
  <i class="fa fa-cloud-upload fa-3x"></i>
  <p style="margin-top:15px;">拖拽文件到此处 或 点击选择文件</p>
  <input type="file" id="file" style="display:none" onchange="handleSelect(event)"/>
  <div v-if="showtype==1" class="progress" style="margin-top:15px">
    <div class="progress-bar" :style="'width:'+progress+'%'">
      {{ progress }}%
    </div>
  </div>
  <div v-if="showtype==2" class="alert" :class="'alert-'+alert.type">
    {{ alert.msg }}
  </div>
</div>
</div>
<div class="panel panel-default">
<div class="panel-heading">
<div class="row">
<div class="col-xs-6"><label><input type="checkbox" checked> 显示在主页</label></div>
<div class="col-xs-6 text-right"><label><input type="checkbox" id="chkPwd"> 设置密码</label></div>
</div>
</div>
<div class="panel-body" id="pwdBox" style="display:none">
<input type="text" class="form-control" id="filePwd" placeholder="设置下载密码（字母+数字）"/>
</div>
</div>
</div>
</div>
</div>
<script>
var csrfToken = '';
fetch('/ajax.php/csrf').then(r => r.json()).then(d => { csrfToken = d.token; });

function handleSelect(e) {
  var file = e.target.files[0];
  if (!file) return;
  upload(file);
}

var fileInput = document.getElementById('fileInput');
fileInput.onclick = function() { document.getElementById('file').click(); };

fileInput.ondragenter = function() { this.style.background = '#f0f0f0'; };
fileInput.ondragleave = function() { this.style.background = ''; };
fileInput.ondragover = function(e) { e.preventDefault(); };
fileInput.ondrop = function(e) {
  e.preventDefault();
  this.style.background = '';
  var file = e.dataTransfer.files[0];
  if (file) upload(file);
};

document.addEventListener('paste', function(e) {
  var items = (e.clipboardData || window.clipboardData).items;
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      upload(items[i].getAsFile());
      break;
    }
  }
});

document.getElementById('chkPwd').onchange = function() {
  document.getElementById('pwdBox').style.display = this.checked ? 'block' : 'none';
};

async function upload(file) {
  var progressBar = document.querySelector('.progress-bar');
  if (!csrfToken) { alert('请刷新页面再试'); return; }

  // 计算 hash
  var reader = new FileReader();
  reader.readAsArrayBuffer(file);
  reader.onload = async function() {
    var hashBytes = await crypto.subtle.digest('MD5', reader.result);
    var hash = Array.from(new Uint8Array(hashBytes)).map(b => b.toString(16).padStart(2,'0')).join('');

    var form = new FormData();
    form.append('csrf_token', csrfToken);
    form.append('name', file.name);
    form.append('hash', hash);
    form.append('size', file.size);
    form.append('show', '1');
    form.append('ispwd', document.getElementById('chkPwd').checked ? '1' : '0');
    form.append('pwd', document.getElementById('filePwd').value);

    // 预上传
    var preRes = await fetch('/ajax.php/pre_upload', { method: 'POST', body: form }).then(r => r.json());
    if (preRes.code === 1) {
      showMsg('文件已存在，秒传成功！', 'success');
      return;
    }
    if (preRes.code === -1) { showMsg(preRes.msg, 'danger'); return; }

    // 分片上传
    var chunkSize = preRes.chunksize || 8*1024*1024;
    var chunks = preRes.chunks || 1;
    for (var i = 1; i <= chunks; i++) {
      var start = (i-1)*chunkSize;
      var end = Math.min(i*chunkSize, file.size);
      var blob = file.slice(start, end);
      var partForm = new FormData();
      partForm.append('csrf_token', csrfToken);
      partForm.append('hash', hash);
      partForm.append('chunk', i);
      partForm.append('file', blob, file.name);

      var partRes = await fetch('/ajax.php/upload_part', { method: 'POST', body: partForm }).then(r => r.json());
      if (partRes.code === -1) { showMsg(partRes.msg, 'danger'); return; }
      
      var pct = Math.round(end / file.size * 100);
      if (progressBar) { progressBar.style.width = pct + '%'; progressBar.textContent = pct + '%'; }
    }
    showMsg('文件上传成功！', 'success');
  };
}

function showMsg(msg, type) {
  var el = document.querySelector('.alert');
  if (!el) { el = document.createElement('div'); el.className = 'alert'; document.querySelector('.panel-body').appendChild(el); }
  el.className = 'alert alert-' + type;
  el.textContent = msg;
}
</script>
<script src="${CDN.clipboard}"></script>
`, siteUrl);

  return c.html(html);
});

// 文件查看页 /file.php?hash=xxx&pwd=xxx
frontend.get('/file.php', async (c) => {
  const db = getDB(c);
  const stor = getStor(c);
  const config = getConf(c);
  const siteUrl = (c.req.url || '').replace(/\/file\.php.*$/, '') + '/';

  const hash = c.req.query('hash') || '';
  const pwd = c.req.query('pwd') || null;

  if (!hash || !/^[0-9a-f]{32}$/i.test(hash)) {
    return new Response('<script>window.location.href="./";</script>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const row = await getFileByHash(db, hash);
  if (!row) {
    return new Response('<script>alert("文件不存在");window.location.href="./";</script>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // 密码校验
  if (row.pwd !== null && row.pwd !== '' && row.pwd !== pwd) {
    return new Response(`
      <meta http-equiv="content-type" content="text/html;charset=utf-8"/>
      <title>请输入密码下载文件</title>
      <script>
      var pwd=prompt("请输入密码","")
      if (pwd!=null && pwd!="")
      {
          window.location.href="./file.php?hash=${hash}&pwd="+pwd
      }
      </script>
      请刷新页面
    `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const viewType = getViewType(row.type);
  const downurl = `down.php/${row.hash}.${row.type}${row.pwd ? '&' + row.pwd : ''}`;
  const viewurl = `view.php/${row.hash}.${row.type}`;
  const downurlAll = siteUrl + downurl;
  const viewurlAll = siteUrl + viewurl;

  let fileContent = '';
  let title = '文件查看';
  let linkTitle = '文件链接';

  if (viewType === 'image') {
    title = '图片查看';
    linkTitle = '图片链接';
    fileContent = `<div class="image_view"><a href="${viewurl}" title="点击查看原图"><img src="${viewurl}" class="image" alt="loading"/></a></div>`;
  } else if (viewType === 'audio') {
    title = '音乐播放器';
    linkTitle = '音乐链接';
    fileContent = `<div class="view"><div id="aplayer"></div></div>`;
  } else if (viewType === 'video') {
    title = '视频播放器';
    linkTitle = '视频链接';
    if (row.block === 0) {
      fileContent = `<div class="videoplayer"><video id="player" src="${viewurl}" controls width="100%"></video></div>`;
    } else {
      fileContent = `<div class="view"><p>${htmlspecialchars(row.name)}</p><p>视频文件需审核通过后才能在线播放和下载！</p></div>`;
    }
  } else {
    title = '文件查看';
    linkTitle = '文件链接';
    fileContent = `<div class="view"><p>${htmlspecialchars(row.name)}（${sizeFormat(row.size)}）</p>
<a href="${downurl}" class="btn btn-raised btn-primary btn-lg"><i class="fa fa-download"></i> 下载文件</a></div>`;
  }

  const html = filePageLayout(title + ' - ' + config.title, `
<div class="container" style="padding-top:80px;">
<div class="row">
<div class="col-md-9">
<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">${title}</h3></div>
<div class="panel-body" align="center">${fileContent}</div>
</div>
<div class="panel panel-default">
<div class="panel-body">
<ul class="nav nav-tabs">
<li class="active"><a href="#link" data-toggle="tab">${linkTitle}</a></li>
<li><a href="#code" data-toggle="tab">代码调用</a></li>
<li><a href="#info" data-toggle="tab">文件详情</a></li>
</ul>
<div class="tab-content" style="padding:19px;">
<div class="tab-pane active" id="link">
<div class="form-group row">
<label class="col-md-2 control-label">下载链接：</label>
<div class="col-md-10"><input class="form-control" readonly value="${htmlspecialchars(downurlAll)}"/>
<button class="btn btn-primary btn-sm copy-btn" data-clipboard-text="${htmlspecialchars(downurlAll)}">复制</button></div>
</div>
</div>
<div class="tab-pane" id="code">
<div class="form-group row">
<label class="col-md-2">HTML：</label>
<div class="col-md-10"><input class="form-control" readonly value="${htmlspecialchars('<a href="' + downurlAll + '">' + row.name + '</a>')}"/></div>
</div>
</div>
<div class="tab-pane" id="info">
<table class="table table-bordered">
<tr><th>上传IP：</th><td>${(row.ip || '').replace(/\\d+$/, '*')}</td><th>上传时间：</th><td>${row.addtime}</td></tr>
<tr><th>下载次数：</th><td>${row.count}</td><th>文件大小：</th><td>${sizeFormat(row.size)}</td></tr>
</table>
</div>
</div>
</div>
</div>
</div>
<div class="col-md-3">
<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">提示</h3></div>
<div class="panel-body">
<p>直链可用于&nbsp;img&nbsp;标签、视频播放等场景。</p>
<p>下载链接点击即可直接下载文件。</p>
</div>
</div>
</div>
</div>
</div>
<script src="${CDN.clipboard}"></script>
<script>
var clipboard = new ClipboardJS('.copy-btn');
clipboard.on('success', function(e) { alert('已复制到剪贴板'); });
</script>
`, siteUrl, true);

  return c.html(html);
});

// 管理后台登录页
frontend.get('/admin/login', (c) => {
  const siteUrl = (c.req.url || '').replace(/\/admin\/login.*$/, '') + '/';
  const html = layout('管理后台登录', `
<div class="container" style="padding-top:100px;">
<div class="col-md-4 col-md-offset-4">
<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">管理员登录</h3></div>
<div class="panel-body">
<form id="loginForm">
<div class="form-group"><input class="form-control" id="username" placeholder="用户名"/></div>
<div class="form-group"><input type="password" class="form-control" id="password" placeholder="密码"/></div>
<button type="submit" class="btn btn-primary btn-block">登录</button>
</form>
</div>
</div>
</div>
</div>
<script>
document.getElementById('loginForm').onsubmit = async function(e) {
  e.preventDefault();
  var user = document.getElementById('username').value;
  var pwd = document.getElementById('password').value;
  // 使用 Basic Auth 方式提交
  var res = await fetch('${siteUrl}admin/ajax/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: user, password: pwd})
  }).then(r => r.json());
  if (res.code === 0) {
    window.location.href = '${siteUrl}admin';
  } else {
    alert(res.msg);
  }
};
</script>
`, siteUrl);
  return c.html(html);
});

// 管理后台首页
frontend.get('/admin', async (c) => {
  const config = getConf(c);
  const siteUrl = (c.req.url || '').replace(/\/admin\/?$/, '') + '/';

  // 检查登录
  const token = c.req.header('cookie')?.match(/admin_token=([^;]+)/)?.[1];
  if (!token) {
    return new Response(`<script>window.location.href='${siteUrl}admin/login';</script>`, { headers: { 'Content-Type': 'text/html' } });
  }
  const valid = await verifyAdminToken(token, config.admin_user, config.admin_pwd, config.syskey);
  if (!valid) {
    return new Response(`<script>window.location.href='${siteUrl}admin/login';</script>`, { headers: { 'Content-Type': 'text/html' } });
  }

  const html = layout('管理后台', `
<div class="container" style="padding-top:70px;">
<div class="row">
<div class="col-md-12">
<h3>文件管理</h3>
<table class="table table-striped" id="fileTable"></table>
</div>
</div>
</div>
<script>
fetch('${siteUrl}admin/ajax/fileList', { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'offset=0&limit=20' })
  .then(r => r.json()).then(d => {
    var tbody = document.getElementById('fileTable');
    tbody.innerHTML = '<tr><th>ID</th><th>文件名</th><th>大小</th><th>操作</th></tr>';
    (d.rows || []).forEach(r => {
      tbody.innerHTML += '<tr><td>'+r.id+'</td><td>'+r.name+'</td><td>'+r.size2+'</td><td><button onclick="del('+r.id+')">删除</button></td></tr>';
    });
  });
function del(id) { if(confirm('确定删除？')) fetch('${siteUrl}admin/ajax/delFile?id='+id).then(r=>r.json()).then(d=>{alert(d.msg);location.reload();}); }
</script>
`, siteUrl);
  return c.html(html);
});

// 处理后台 AJAX 登录
frontend.post('/admin/ajax/login', async (c) => {
  const config = getConf(c);
  const body = await c.req.json() as { username: string; password: string };
  
  if (body.username === config.admin_user && body.password === config.admin_pwd) {
    const { signAdminToken } = await import('../auth/admin');
    const token = await signAdminToken(config.admin_user, config.admin_pwd, config.syskey, 7);
    c.header('Set-Cookie', `admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
    return c.json({ code: 0, msg: '登录成功' });
  }
  return c.json({ code: -1, msg: '用户名或密码错误' });
});

export default frontend;
