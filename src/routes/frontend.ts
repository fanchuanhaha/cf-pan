// 褰╄櫣澶栭摼缃戠洏 - 椤甸潰娓叉煋璺敱 (SSR 妯℃澘鐩村嚭锛屼繚鎸佸師 jQuery+Bootstrap 鐣岄潰)
// 浠跨収鍘?PHP 椤圭洰缁撴瀯锛?//   /                -> index.php 鏂囦欢鍒楄〃
//   /upload.php      -> upload.php 涓婁紶椤?//   /file.php?hash=  -> file.php 鏂囦欢鏌ョ湅
//   /admin           -> admin/index.php 鍚庡彴棣栭〉
//   /admin/file      -> admin/file.php 鏂囦欢绠＄悊
//   /admin/login     -> admin/login.php

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf, getStor, getStorOrThrow } from '../middleware';
import { updateConfig, clearConfigCache } from '../config';
import { getFileByHash, getFileById, setFileBlock, deleteFile, updateFile, touchFile, getFileCountByDateRange } from '../db';
import { verifyAdminToken, signAdminToken } from '../auth/admin';
import { getViewType, sizeFormat, typeToIcon } from '../utils/mime';
import { htmlspecialchars, generateCsrfToken } from '../utils/response';

const frontend = new Hono<AppEnv>();

// CDN 璧勬簮锛堜笌鍘熼」鐩?header.php/footer.php 瀹屽叏涓€鑷达級
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

// ===================== 閫氱敤 layout锛堜豢鐓у師 header.php + footer.php锛?=====================
function siteUrl(c: any): string {
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}`;
}

/** 椤堕儴瀵艰埅鏍忥紙浠垮師 header.php锛?*/
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
      <li class="${cls('index')}"><a href="./"><i class="fa fa-list" aria-hidden="true"></i> 鏂囦欢鍒楄〃</a></li>
      <li class="${cls('upload')}"><a href="./upload.php"><i class="fa fa-upload" aria-hidden="true"></i> 涓婁紶鏂囦欢</a></li>
      ${active === 'file' ? `<li class="active"><a href=""><i class="fa fa-file" aria-hidden="true"></i> 鏂囦欢鏌ョ湅</a></li>` : ''}
    </ul>
    <ul class="nav navbar-nav navbar-right">
      <li class="${cls('mine')}"><a href="./?m=mine"><i class="fa fa-folder-open" aria-hidden="true"></i> 鎴戠殑鏂囦欢</a></li>
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

/** 鍓嶅彴椤甸潰閫氱敤 layout锛堜笌鍘?header.php/footer.php 瀹屽叏涓€鑷达級 */
function publicLayout(title: string, body: string, siteUrlStr: string, active: 'index' | 'upload' | 'file' | 'mine' = 'index', isFile: boolean = false, siteTitle: string = '褰╄櫣澶栭摼缃戠洏'): string {
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

/** 绠＄悊鍚庡彴 layout锛堜豢鍘?admin/head.php锛?*/
function adminLayout(title: string, body: string, siteUrlStr: string, active: 'index' | 'file' | 'user' | 'set' = 'index', showNav: boolean = true, siteTitle: string = '褰╄櫣澶栭摼缃戠洏'): string {
  const cls = (key: string) => active === key ? 'active' : '';
  const nav = showNav ? `<nav class="navbar navbar-fixed-top navbar-default">
<div class="container">
  <div class="navbar-header">
    <button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#navbar" aria-expanded="false" aria-controls="navbar">
      <span class="sr-only">瀵艰埅鎸夐挳</span>
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
      <span class="icon-bar"></span>
    </button>
    <a class="navbar-brand" href="/admin">${htmlspecialchars(siteTitle)}绠＄悊涓績</a>
  </div>
  <div id="navbar" class="collapse navbar-collapse">
    <ul class="nav navbar-nav navbar-right">
      <li class="${cls('index')}"><a href="/admin"><i class="fa fa-home"></i> 鍚庡彴棣栭〉</a></li>
      <li class="${cls('file')}"><a href="/admin/file"><i class="fa fa-folder-open"></i> 鏂囦欢绠＄悊</a></li>
      <li class="dropdown ${cls('set')}">
        <a href="#" class="dropdown-toggle" data-toggle="dropdown" role="button" aria-haspopup="true" aria-expanded="false"><i class="fa fa-cog"></i> 绯荤粺璁剧疆 <span class="caret"></span></a>
        <ul class="dropdown-menu">
          <li><a href="/admin/set?mod=site"><i class="fa fa-info-circle"></i> 缃戠珯淇℃伅璁剧疆</a></li>
          <li><a href="/admin/set?mod=user"><i class="fa fa-users"></i> 鐢ㄦ埛鐧诲綍璁剧疆</a></li>
          <li><a href="/admin/set?mod=stor"><i class="fa fa-database"></i> 瀛樺偍绫诲瀷璁剧疆</a></li>
          <li><a href="/admin/set?mod=file"><i class="fa fa-upload"></i> 鏂囦欢涓婁紶璁剧疆</a></li>
          <li><a href="/admin/set?mod=green"><i class="fa fa-image"></i> 鍥剧墖妫€娴嬭缃?/a></li>
          <li><a href="/admin/set?mod=api"><i class="fa fa-code"></i> 涓婁紶API璁剧疆</a></li>
          <li><a href="/admin/set?mod=account"><i class="fa fa-user-secret"></i> 绠＄悊鍛樿处鍙疯缃?/a></li>
        </ul>
      </li>
      <li><a href="/admin/login?logout=1" onclick="return confirm('鏄惁纭畾閫€鍑虹櫥褰曪紵')"><i class="fa fa-sign-out"></i> 閫€鍑虹櫥褰?/a></li>
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

// ===================== 鏂囦欢鍒楄〃椤?/ =====================
frontend.get('/', async (c) => {
  const config = getConf(c);
  const db = getDB(c);
  const siteUrlStr = siteUrl(c);

  const isMine = c.req.query('m') === 'mine';
  const kw = (c.req.query('kw') || '').trim();
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const pageSize = 15;
  const offset = (page - 1) * pageSize;

  // 鏋勫缓 where 鏉′欢
  const where: string[] = [];
  const params: any[] = [];
  if (isMine) {
    // 鎴戠殑鏂囦欢 - 鍩轰簬 cookie 涓殑 file_ids 缂撳瓨
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
      // 闄愬埗鏈€澶?60 涓紝鍊掑簭
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
    ? '鎴戠殑鏂囦欢 - ' + config.title
    : config.title;
  const htext = isMine
    ? '鎴戜笂浼犵殑鏂囦欢'
    : '鏂囦欢鍒楄〃';

  const tableRows = rawRows.map((res: any, i: number) => {
    const fileurl = `down.php/${res.hash}.${res.type || 'file'}`;
    const viewurl = `file.php?hash=${res.hash}`;
    const icon = typeToIcon(res.type);
    return `<tr>
<td><b>${offset + i + 1}</b></td>
<td><a href="${fileurl}">涓嬭浇</a>锝?a href="${viewurl}">鏌ョ湅</a></td>
<td><i class="fa ${icon} fa-fw"></i>${htmlspecialchars(res.name)}</td>
<td>${sizeFormat(res.size)}</td>
<td><font color="blue">${res.type || '鏈煡'}</font></td>
<td>${res.addtime}</td>
<td>${(res.ip || '').replace(/\d+$/, '*')}</td>
</tr>`;
  }).join('');

  const empty = rawRows.length === 0
    ? '<tr><td colspan="7" align="center">杩樻病涓婁紶杩囦换浣曟枃浠?/td></tr>'
    : '';

  // 鍒嗛〉
  let pagination = '';
  if (totalPages > 1) {
    let items = '';
    if (page > 1) {
      items += `<li><a href="${link(1)}">棣栭〉</a></li><li><a href="${link(page - 1)}">&laquo;</a></li>`;
    } else {
      items += '<li class="disabled"><a>棣栭〉</a></li><li class="disabled"><a>&laquo;</a></li>';
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
      items += `<li><a href="${link(page + 1)}">&raquo;</a></li><li><a href="${link(totalPages)}">灏鹃〉</a></li>`;
    } else {
      items += '<li class="disabled"><a>&raquo;</a></li><li class="disabled"><a>灏鹃〉</a></li>';
    }
    pagination = `<ul class="pagination pagination-sm" style="float:right;">${items}</ul>`;
  }

  const body = `<div class="container">
<div class="well bs-component">
  <h2>${htext}
    <span class="searchbox" style="float:right">
      <form class="form-inline" action="./" method="GET">
        ${isMine ? '<input name="m" type="hidden" value="mine">' : ''}
        <input name="kw" class="form-control" type="search" placeholder="璇疯緭鍏ユ悳绱㈠叧閿瓧" value="${htmlspecialchars(kw)}">
        <button class="btn btn-default btn-raised btn-sm" type="submit"><i class="fa fa-search" aria-hidden="true"></i> 鎼滅储</button>
      </form>
    </span>
  </h2>
  <div class="table-responsive">
    <table class="table table-striped table-hover filelist">
      <thead>
        <tr><th>#</th><th>鎿嶄綔</th><th>鏂囦欢鍚?/th><th>鏂囦欢澶у皬</th><th>鏂囦欢鏍煎紡</th><th>涓婁紶鏃堕棿</th><th>涓婁紶鑰匢P</th></tr>
      </thead>
      <tbody>
        ${tableRows}
        ${empty}
      </tbody>
    </table>
  </div>
  <div class="row">
    <div class="col-md-6"><br>鍏辨湁 ${totalCount} 涓枃浠?nbsp;&nbsp;褰撳墠绗?${page} 椤碉紝鍏?${totalPages} 椤?/div>
    <div class="col-md-6"><nav>${pagination}</nav></div>
  </div>
</div>
</div>`;

  return c.html(publicLayout(title, body, siteUrlStr, isMine ? 'mine' : 'index', false, config.title));
});

// ===================== 涓婁紶椤?/upload.php =====================
frontend.get('/upload.php', (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  const csrf = generateCsrfToken();

  // 淇濆瓨 csrf 鍒颁竴涓复鏃?cookie锛宎jax 绔細姣斿
  c.header('Set-Cookie', `upload_csrf=${csrf}; Path=/; Max-Age=3600; SameSite=Lax`);

  // 鑾峰彇瀹㈡埛绔疘P
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
                <button type="button" class="close" data-dismiss="alert">脳</button>
                <strong>{{alert.msg}}</strong>
            </div>
        </div>

         <br><br>
         <h1 style="color:#8d8b8b;" id="uploadTitle">{{uploadTitle}}</h1>

         <input type="hidden" id="csrf_token" name="csrf_token" value="${csrf}">
         <input type="file" id="file" name="myfile" @change="selectFile" style="display:none"/>

         <div id="upload_frame">
         <button id="uploadFile" class="btn btn-raised btn-primary" style="height:50px;font-size:20px;" @click="clickUpload"><i class="fa fa-upload"></i> 閫夋嫨鏂囦欢<div class="ripple-container"></div></button>
<div class="form-group">
<div class="checkbox">
<label>
<input type="checkbox" id="show" v-model="input.show"> 鍦ㄩ椤垫枃浠跺垪琛ㄦ樉绀?</label>
</div>
</div>
<div class="form-group">
<div class="checkbox">
<label>
<input type="checkbox" id="ispwd" v-model="input.ispwd"> 璁惧畾瀵嗙爜
</label>
</div>
</div>
<div class="form-group" style="max-width:220px;" id="pwd_frame" v-if="input.ispwd">
<input type="text" class="form-control" id="pwd" placeholder="璇疯緭鍏ュ瘑鐮? autocomplete="off" v-model="input.pwd">
<p class="help-block">瀵嗙爜鍙兘涓哄瓧姣嶆垨鏁板瓧</p>
</div>
         </div>

        <br><br><br><br>
        </div>
      </div>
      <div class="col-sm-3">
      <div class="panel panel-primary">
<div class="panel-heading">
<h3 class="panel-title"><i class="fa fa-exclamation-circle"></i> 涓婁紶鎻愮ず</h3>
</div>
<div class="list-group-item">
**鎮ㄧ殑IP鏄?{clientip}锛岃涓嶈涓婁紶杩濊鏂囦欢锛?</div>
${config.upload_size > 0 ? `<div class="list-group-item">**涓婁紶鏃犳牸寮忛檺鍒讹紝褰撳墠鏈嶅姟鍣ㄥ崟涓枃浠朵笂浼犳渶澶ф敮鎸?b>${config.upload_size}MB</b>锛?</div>` : `<div class="list-group-item">**涓婁紶鏃犳牸寮忛檺鍒讹紝鏃犲ぇ灏忛檺鍒讹紒
</div>`}
${config.videoreview == 1 ? `<div class="list-group-item">**褰撳墠缃戠珯宸插紑鍚棰戞枃浠跺鏍革紝濡傛灉涓婁紶鐨勬槸瑙嗛鏂囦欢锛岄渶瑕佺瓑寰呭鏍搁€氳繃鍚庢墠鑳戒笅杞藉拰鎾斁銆?</div>` : ''}
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

  return c.html(publicLayout('涓婁紶鏂囦欢 - ' + config.title, body, siteUrlStr, 'upload', false, config.title));
});

// ===================== 鏂囦欢鏌ョ湅椤?/file.php?hash=xxx =====================
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
    return c.html('<script>alert("鏂囦欢涓嶅瓨鍦?);window.location.href="./";</script>');
  }

  // 瀵嗙爜淇濇姢
  if (row.pwd && row.pwd !== '' && row.pwd !== pwd) {
    return c.html(`<meta charset="utf-8"/>
<title>璇疯緭鍏ュ瘑鐮佷笅杞芥枃浠?/title>
<script>
var pwd=prompt("璇疯緭鍏ュ瘑鐮?,"")
if (pwd!=null && pwd!="")
{
    window.location.href="./file.php?hash=${hash}&pwd="+pwd
}
</script>
璇峰埛鏂伴〉闈紝鎴朳 <a href="javascript:history.back();">杩斿洖涓婁竴椤?/a> ]`);
  }

  // 澧炲姞涓嬭浇璁℃暟 + 璁剧疆 file_ids cookie锛堢敤浜?鎴戠殑鏂囦欢"锛?  await touchFile(db, row.id);
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
  let linktitle = '鏂囦欢閾炬帴';
  let filetype = 0;

  if (viewType === 'image') {
    filetype = 1;
    fileTitle = '<i class="fa fa-picture-o"></i> 鍥剧墖鏌ョ湅鍣?;
    htmlcode = htmlspecialchars(`<img src="${viewurlAll}"/>`);
    ubbcode = `[img]${viewurlAll}[/img]`;
    linktitle = '鍥剧墖閾炬帴';
  } else if (viewType === 'audio') {
    filetype = 2;
    fileTitle = '<i class="fa fa-music"></i> 闊充箰鎾斁鍣?;
    htmlcode = htmlspecialchars(`<audio src="${viewurlAll}" autoplay="autoplay" loop="loop" preload="auto"></audio>`);
    ubbcode = `[audio]${viewurlAll}[/audio]`;
    linktitle = '闊充箰閾炬帴';
  } else if (viewType === 'video') {
    filetype = 3;
    fileTitle = '<i class="fa fa-video-camera"></i> 瑙嗛鎾斁鍣?;
    htmlcode = htmlspecialchars(`<video src="${viewurlAll}" controls="" width="100%"></video>`);
    ubbcode = `[movie]${viewurlAll}[/movie]`;
    linktitle = '瑙嗛閾炬帴';
  } else {
    filetype = 0;
    fileTitle = '<i class="fa fa-file"></i> 鏂囦欢鏌ョ湅';
    htmlcode = htmlspecialchars(`<a href="${downurlAll}" target="_blank">${row.name}</a>`);
    ubbcode = `[url=${downurlAll}]${row.name}[/url]`;
  }

  let fileContent = '';
  if (filetype === 1) {
    fileContent = `<div class="image_view"><a href="${viewurl}" title="鐐瑰嚮鏌ョ湅鍘熷浘"><img alt="loading" src="${viewurl}" class="image"/></a></div>`;
  } else if (filetype === 2) {
    fileContent = `<div class="view"><div id="aplayer"></div></div>`;
  } else if (filetype === 3 && row.block === 0) {
    fileContent = `<div class="videoplayer"></div>`;
  } else if (filetype === 3) {
    const icon = typeToIcon(row.type);
    fileContent = `<div class="view"><div class="elseview"><div class="tubiao"><i class="fa ${icon}"></i></div></div>
<div class="elsetext"><p>${htmlspecialchars(row.name)}</p><p>瑙嗛鏂囦欢闇€瀹℃牳閫氳繃鍚庢墠鑳藉湪绾挎挱鏀惧拰涓嬭浇锛岃绛夊緟瀹℃牳閫氳繃锛?/p></div></div>`;
  } else {
    const icon = typeToIcon(row.type);
    fileContent = `<div class="view"><div class="elseview"><div class="tubiao"><i class="fa ${icon}"></i></div></div>
<div class="elsetext"><p>${htmlspecialchars(row.name)}锛?{sizeFormat(row.size)}锛?/p>
<a href="${downurl}" class="btn btn-raised btn-primary btn-lg"><i class="fa fa-download" aria-hidden="true"></i> 涓嬭浇鏂囦欢<div class="ripple-container"></div></a>
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
        <li class="active"><a href="#link" data-toggle="tab"><i class="fa fa-link"></i> 鏂囦欢澶栭摼</a></li>
        <li><a href="#code" data-toggle="tab"><i class="fa fa-code"></i> 浠ｇ爜璋冪敤</a></li>
        <li><a href="#info" data-toggle="tab"><i class="fa fa-info-circle"></i> 鏂囦欢璇︽儏</a></li>
        <li><a href="#manager" data-toggle="tab"><i class="fa fa-cog"></i> 绠＄悊</a></li>
      </ul>
      <div id="myTabContent" class="tab-content" style="padding:19px">
        <div class="tab-pane fade active in" id="link">
          ${filetype > 0 ? `<div class="form-group row">
            <label class="col-md-2 control-label">${linktitle}锛?/label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="link1" readonly value="${viewurlAll}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${viewurlAll}">澶嶅埗</button></span>
              </div>
            </div>
          </div>` : ''}
          <div class="form-group row">
            <label class="col-md-2 control-label">涓嬭浇閾炬帴锛?/label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="link2" readonly value="${downurlAll}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${downurlAll}">澶嶅埗</button></span>
              </div>
            </div>
          </div>
        </div>
        <div class="tab-pane fade" id="code">
          ${filetype >= 2 ? `<div class="form-group row">
            <label class="col-md-2 control-label">HTML浠ｇ爜锛?/label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="code2" readonly value='${htmlcode}'>
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text='${htmlcode}'>澶嶅埗</button></span>
              </div>
            </div>
          </div>` : ''}
          <div class="form-group row">
            <label class="col-md-2 control-label">UBB浠ｇ爜锛?/label>
            <div class="col-md-10">
              <div class="input-group">
                <input type="text" class="form-control" id="code3" readonly value="${ubbcode}">
                <span class="input-group-btn"><button class="btn btn-primary btn-raised copy-btn" type="button" data-clipboard-text="${ubbcode}">澶嶅埗</button></span>
              </div>
            </div>
          </div>
        </div>
        <div class="tab-pane fade" id="info">
          <div class="row" align="center">
            <table class="table table-bordered fileinfo-table">
              <tr>
                <th width="97">涓婁紶鑰匢P锛?/th><td width="100">${(row.ip || '').replace(/\d+$/, '*')}</td>
                <th width="100">涓婁紶鏃堕棿锛?/th><td width="168">${row.addtime}</td>
              </tr>
              <tr>
                <th>涓嬭浇娆℃暟锛?/th><td>${row.count}</td>
                <th>鏂囦欢澶у皬锛?/th><td>${sizeFormat(row.size)} (${row.size} 瀛楄妭)</td>
              </tr>
            </table>
          </div>
        </div>
        <div class="tab-pane fade" id="manager">
          <div class="row" align="center">
            <div class="col-md-12">
              <input type="hidden" id="hash" value="${hash}">
              <input type="hidden" id="csrf_token" value="${generateCsrfToken()}">
              <button onclick="delete_confirm()" class="btn btn-raised btn-danger"><i class="fa fa-close"></i> 鍒犻櫎鏂囦欢</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="col-sm-3">
  <div class="panel panel-info">
    <div class="panel-heading"><h3 class="panel-title"><i class="fa fa-exclamation-circle"></i> 鎻愮ず</h3></div>
    <div class="panel-body">
      <p>鐩撮摼鍙敤浜?img 鏍囩銆佽棰戞挱鏀剧瓑鍦烘櫙銆?/p>
      <p>涓嬭浇閾炬帴鐐瑰嚮鍗冲彲鐩存帴涓嬭浇鏂囦欢銆?/p>
    </div>
  </div>
  <div class="panel panel-default hidden-xs">
    <div class="panel-heading"><h3 class="panel-title"><i class="fa fa-qrcode"></i> 鎵嬫満鎵爜涓嬭浇</h3></div>
    <div class="panel-body text-center">
      <img alt="浜岀淮鐮? src="${CDN.qrcode}${encodeURIComponent(thisurl)}">
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
  layer.confirm('鍒犻櫎鏂囦欢鍚庝笉鍙仮澶嶏紝纭畾鍒犻櫎鍚楋紵', { btn: ['纭畾','鍙栨秷'], icon: 0 }, function(){
    var ii = layer.load(2);
    $.ajax({
      type : 'POST',
      url : 'ajax.php?act=deleteFile',
      data : {hash:hash, csrf_token:csrf_token},
      dataType : 'json',
      success : function(data) {
        layer.close(ii);
        if(data.code == 0){ layer.alert('鍒犻櫎鎴愬姛', {icon:1}, function(){window.location.href="./";}); }
        else { layer.alert(data.msg, {icon:2}); }
      },
      error:function(){ layer.close(ii); layer.msg('鏈嶅姟鍣ㄩ敊璇?); }
    });
  });
}
$(function(){
  var clipboard = new ClipboardJS('.copy-btn');
  clipboard.on('success', function(){ layer.msg('澶嶅埗鎴愬姛锛?, {icon: 1}); });
  clipboard.on('error', function(){ layer.msg('澶嶅埗澶辫触锛岃闀挎寜閾炬帴鍚庢墜鍔ㄥ鍒?, {icon: 2}); });
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
  // 绠€鍖栫増瑙嗛鎾斁 - 瀹為檯椤圭洰閲岀敤 ckplayer
  $('.videoplayer').html('<video src="${viewurlAll}" controls style="max-width:100%"></video>');
});` : ''}
</script>`;

  return c.html(publicLayout('鏂囦欢鏌ョ湅 - ' + config.title, body, siteUrlStr, 'file', filetype > 0, config.title));
});

// ===================== 绠＄悊鍚庡彴鐧诲綍椤?/admin/login =====================
frontend.get('/admin/login', async (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);

  // 鐧诲嚭锛堝繀椤诲湪宸茬櫥褰曟鏌ヤ箣鍓嶏紝鍚﹀垯宸茬櫥褰曠敤鎴锋棤娉曢€€鍑猴級
  if (c.req.query('logout') === '1') {
    c.header('Set-Cookie', 'admin_token=; Path=/; Max-Age=0');
    return c.html('<script>window.location.href="/admin/login";</script>');
  }

  // 宸茬櫥褰曞垯璺冲埌鍚庡彴
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
  <div class="panel-heading"><h3 class="panel-title">绠＄悊鍛樼櫥褰?/h3></div>
  <div class="panel-body">
    <form id="loginForm">
      <div class="form-group"><input class="form-control" id="username" placeholder="鐢ㄦ埛鍚? autofocus></div>
      <div class="form-group"><input type="password" class="form-control" id="password" placeholder="瀵嗙爜"></div>
      <button type="submit" class="btn btn-primary btn-block">鐧?褰?/button>
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
  else { alert(res.msg || '鐧诲綍澶辫触'); }
};
</script>`;

  return c.html(adminLayout('绠＄悊鍛樼櫥褰?, body, siteUrlStr, 'index', false, config.title));
});

// ===================== 绠＄悊鍚庡彴棣栭〉 /admin =====================
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
        <div class="col-xs-9 text-right"><div class="huge" id="count1">0</div><div>鏂囦欢鎬绘暟</div></div>
      </div></div>
      <a href="/admin/file"><div class="panel-footer"><span class="pull-left">鏌ョ湅璇︽儏</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-green">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-cloud-upload fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count2">0</div><div>浠婃棩涓婁紶鏂囦欢</div></div>
      </div></div>
      <a href="/admin/file"><div class="panel-footer"><span class="pull-left">鏌ョ湅璇︽儏</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-yellow">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-inbox fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count3">0</div><div>鏄ㄦ棩涓婁紶鏂囦欢</div></div>
      </div></div>
      <a href="/admin/file"><div class="panel-footer"><span class="pull-left">鏌ョ湅璇︽儏</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
  <div class="col-lg-3 col-md-6">
    <div class="panel panel-red">
      <div class="panel-heading"><div class="row">
        <div class="col-xs-3"><i class="fa fa-hdd-o fa-5x"></i></div>
        <div class="col-xs-9 text-right"><div class="huge" id="count4">0</div><div>瀛樺偍绫诲瀷</div></div>
      </div></div>
      <a href="./setting"><div class="panel-footer"><span class="pull-left">鏌ョ湅璇︽儏</span><span class="pull-right"><i class="fa fa-arrow-circle-right"></i></span><div class="clearfix"></div></div></a>
    </div>
  </div>
</div>
<div class="row">
  <div class="col-md-8 col-sm-12">
    <div class="panel panel-info">
      <div class="panel-heading"><h3 class="panel-title">绯荤粺淇℃伅</h3></div>
      <ul class="list-group">
        <li class="list-group-item"><b>杩愯鐜锛?/b>Cloudflare Workers (Node.js Compat)</li>
        <li class="list-group-item"><b>鏁版嵁搴擄細</b>Cloudflare D1 (SQLite)</li>
        <li class="list-group-item"><b>瀵硅薄瀛樺偍锛?/b>${getConf(c).storage.toUpperCase()}</li>
        <li class="list-group-item"><b>鏈嶅姟鍣ㄦ椂闂达細</b>${new Date().toISOString().replace('T', ' ').substring(0, 19)}</li>
        <li class="list-group-item"><b>绔欑偣鍚嶇О锛?/b>${htmlspecialchars(getConf(c).title)}</li>
      </ul>
    </div>
  </div>
  <div class="col-md-4 col-sm-12">
    <div class="panel panel-success">
      <div class="panel-heading"><h3 class="panel-title">鐗堟湰淇℃伅</h3></div>
      <ul class="list-group text-dark">
        <li class="list-group-item"><b>褰╄櫣澶栭摼缃戠洏</b></li>
        <li class="list-group-item">Workers 绉绘鐗?v1.0</li>
        <li class="list-group-item">${new Date().getFullYear()} 漏 CAIHONG</li>
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

  return c.html(adminLayout('鍚庡彴棣栭〉', body, siteUrlStr, 'index', true, config.title));
});

// ===================== 绠＄悊鍚庡彴鏂囦欢绠＄悊 /admin/file =====================
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
        <h4 class="modal-title">鏂囦欢淇℃伅淇敼</h4>
      </div>
      <div class="modal-body">
        <form class="form-horizontal" id="form-store">
          <input type="hidden" name="id" id="store_id">
          <div class="form-group"><label class="col-sm-2 control-label">鏂囦欢鍚嶇О</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="name" id="store_name"></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">鏂囦欢绫诲瀷</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="type" id="store_type"></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">鏂囦欢澶у皬</label>
            <div class="col-sm-10"><input type="text" class="form-control" id="store_size" disabled></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">鏂囦欢Hash</label>
            <div class="col-sm-10"><input type="text" class="form-control" id="store_hash" disabled></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">鏄惁闅愯棌</label>
            <div class="col-sm-10"><select id="store_hide" name="hide" class="form-control"><option value="0">0_鍚?/option><option value="1">1_鏄?/option></select></div></div>
          <div class="form-group"><label class="col-sm-2 control-label">鍚敤瀵嗙爜</label>
            <div class="col-sm-10"><select id="store_ispwd" name="ispwd" class="form-control" onchange="change_ispwd(this)"><option value="0">0_鍚?/option><option value="1">1_鏄?/option></select></div></div>
          <div class="form-group" id="pwd_frame" style="display:none"><label class="col-sm-2 control-label">涓嬭浇瀵嗙爜</label>
            <div class="col-sm-10"><input type="text" class="form-control" name="pwd" id="store_pwd"></div></div>
        </form>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-white" data-dismiss="modal">鍏抽棴</button>
        <button type="button" class="btn btn-primary" onclick="saveFile()">淇濆瓨</button>
      </div>
    </div>
  </div>
</div>
<div class="container" style="padding-top:70px">
<div class="col-xs-12 center-block" style="float:none">
  <form onsubmit="return searchSubmit()" method="GET" class="form-inline" id="searchToolbar">
    <div class="form-group">
      <label>鎼滅储</label>
      <select name="type" class="form-control"><option value="1">鏂囦欢鍚?/option><option value="2">鏂囦欢Hash</option></select>
    </div>
    <div class="form-group"><input type="text" class="form-control" name="kw" placeholder="鎼滅储鍐呭"></div>
    <div class="form-group">
      <select id="dstatus" name="dstatus" class="form-control"><option value="-1">鍏ㄩ儴鐘舵€?/option><option value="0">姝ｅ父鏂囦欢</option><option value="1">宸插睆钄芥枃浠?/option><option value="2">寰呭鏍告枃浠?/option></select>
    </div>
    <div class="form-group">
      <select id="orderby" name="orderby" class="form-control"><option value="0">榛樿鎺掑簭</option><option value="1">鎸変笅杞介噺鎺掑簭</option></select>
    </div>
    <div class="form-group">
      <button class="btn btn-primary" type="submit"><i class="fa fa-search"></i> 鎼滅储</button>
      <a href="javascript:searchClear()" class="btn btn-default"><i class="fa fa-repeat"></i> 閲嶇疆</a>
    </div>
    <div class="btn-group" role="group">
      <button type="button" class="btn btn-default dropdown-toggle" data-toggle="dropdown">鎵归噺鎿嶄綔 <span class="caret"></span></button>
      <ul class="dropdown-menu">
        <li><a href="javascript:operation(0)"><i class="fa fa-trash"></i> 鍒犻櫎</a></li>
        <li><a href="javascript:operation(1)"><i class="fa fa-times-circle"></i> 灏佺</a></li>
        <li><a href="javascript:operation(2)"><i class="fa fa-check-circle"></i> 瑙ｅ皝</a></li>
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
    url: '/admin/ajax/fileList',
    method: 'post',
    pageNumber: pageNumber,
    pageSize: pageSize,
    classes: 'table table-striped table-hover table-bordered',
    columns: [
      { field: '', checkbox: true },
      { field: 'id', title: 'ID', formatter: function(v){ return '<b>'+v+'</b>'; } },
      { field: 'name', title: '鏂囦欢鍚?, formatter: function(v, row){
          var html = '<a href="'+row.fileurl+'" title="鐐瑰嚮涓嬭浇"><i class="fa '+row.icon+' fa-fw"></i>'+v+'</a>';
          return html;
      } },
      { field: 'size', title: '鏂囦欢澶у皬' },
      { field: 'type', title: '鏂囦欢鏍煎紡', formatter: function(v){ return v ? v : '鏈煡'; } },
      { field: 'addtime', title: '涓婁紶鏃ユ湡', formatter: function(v, row){ return v + '<br/>' + (row.lasttime||''); } },
      { field: 'ip', title: '涓婁紶IP/涓嬭浇閲?, formatter: function(v, row){ return v + '<br/><b>'+row.count+'</b>'; } },
      { field: 'block', title: '鐘舵€?, formatter: function(v, row){
          if(v==2) return '<a href="javascript:setBlock('+row.id+',0)" class="btn btn-xs btn-warning">寰呭</a>';
          else if(v==1) return '<a href="javascript:setBlock('+row.id+',0)" class="btn btn-xs btn-danger">灏佺</a>';
          else return '<a href="javascript:setBlock('+row.id+',1)" class="btn btn-xs btn-success">姝ｅ父</a>';
      } },
      { field: 'status', title: '鎿嶄綔', formatter: function(v, row){
          return '<a href="javascript:editframe('+row.id+')" class="btn btn-xs btn-info">缂栬緫</a>&nbsp;<a href="'+row.pageurl+'" class="btn btn-xs btn-warning" target="_blank">鏌ョ湅</a>&nbsp;<a href="javascript:delFile('+row.id+')" class="btn btn-xs btn-danger">鍒犻櫎</a>';
      } }
    ]
  });
});

function setBlock(id, status) {
  $.ajax({ type:'GET', url:'ajax/setBlock?id='+id+'&status='+status, dataType:'json',
    success: function(){ searchSubmit(); }, error: function(){ layer.msg('鏈嶅姟鍣ㄩ敊璇?); } });
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
        $('#store_size').val(data.size2+' ('+data.size+' 瀛楄妭)');
        $('#store_hash').val(data.hash);
        $('#store_hide').val(data.hide);
        if(data.pwd==null||data.pwd==''){
          $('#store_ispwd').val(0); $('#store_pwd').val(''); $('#pwd_frame').hide();
        } else { $('#store_ispwd').val(1); $('#store_pwd').val(data.pwd); $('#pwd_frame').show(); }
      } else layer.alert(data.msg, {icon:2});
    }, error: function(){ layer.msg('鏈嶅姟鍣ㄩ敊璇?); }
  });
}
function saveFile(){
  if($('#store_name').val()==''){ layer.alert('璇风‘淇濆悇椤逛笉鑳戒负绌猴紒'); return; }
  var ii = layer.load(2);
  $.ajax({ type:'POST', url:'ajax/saveFileInfo', data: $('#form-store').serialize(), dataType:'json',
    success: function(data){
      layer.close(ii);
      if(data.code==0){ layer.alert(data.msg,{icon:1,closeBtn:false}, function(){ $('#modal-store').modal('hide'); searchSubmit(); }); }
      else layer.alert(data.msg, {icon:2});
    }, error: function(){ layer.msg('鏈嶅姟鍣ㄩ敊璇?); }
  });
}
function delFile(id){
  layer.confirm('浣犵‘瀹氳鍒犻櫎姝ゆ枃浠跺悧锛?, { btn:['纭畾','鍙栨秷'], icon:0 }, function(){
    $.ajax({ type:'GET', url:'ajax/delFile?id='+id, dataType:'json',
      success: function(d){ if(d.code==0){ layer.msg('鍒犻櫎鎴愬姛',{icon:1}); searchSubmit(); } else layer.alert(d.msg,{icon:2}); }
    });
  });
}
function operation(status){
  var sel = $('#listTable').bootstrapTable('getSelections');
  if(sel.length==0){ layer.msg('璇峰厛閫夋嫨鏂囦欢'); return; }
  var ids = sel.map(function(r){ return r.id; });
  layer.confirm('纭瀵归€変腑鐨?'+ids.length+' 涓枃浠舵墽琛屾鎿嶄綔锛?, { btn:['纭畾','鍙栨秷'], icon:0 }, function(){
    $.ajax({ type:'POST', url:'ajax/operation', data: { status: status, ids: ids.join(',') }, dataType:'json',
      success: function(d){ if(d.code==0){ layer.msg(d.msg,{icon:1}); searchSubmit(); } else layer.alert(d.msg,{icon:2}); }
    });
  });
}
function searchSubmit(){ window.location.href = './file?' + $('#searchToolbar').serialize(); }
function searchClear(){ window.location.href = './file'; }
</script>`;

  return c.html(adminLayout('鏂囦欢绠＄悊', body, siteUrlStr, 'file', true, config.title));
});

// ===================== 绠＄悊鍚庡彴璁剧疆 /admin/set =====================
frontend.get('/admin/set', async (c) => {
  const config = getConf(c);
  const siteUrlStr = siteUrl(c);
  if (!await checkAdmin(c)) {
    return c.html(`<script>window.location.href='/admin/login';</script>`);
  }

  const mod = c.req.query('mod') || 'site';
  let panelBody = '';
  let pageTitle = '绯荤粺璁剧疆';

  // 閫氱敤 saveSetting 鑴氭湰
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
        layer.alert('璁剧疆淇濆瓨鎴愬姛锛?, { icon: 1, closeBtn: false }, function(){ window.location.reload(); });
      }else{
        layer.alert(data.msg, {icon: 2});
      }
    },
    error:function(){ layer.msg('鏈嶅姟鍣ㄩ敊璇?); }
  });
  return false;
}
</script>`;

  if (mod === 'site') {
    pageTitle = '缃戠珯淇℃伅璁剧疆';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">缃戠珯淇℃伅璁剧疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-2 control-label">缃戠珯鏍囬</label>
    <div class="col-sm-10"><input type="text" name="title" value="${config.title}" class="form-control" required/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">鍏抽敭瀛?/label>
    <div class="col-sm-10"><input type="text" name="keywords" value="${config.keywords}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">缃戠珯鎻忚堪</label>
    <div class="col-sm-10"><input type="text" name="description" value="${config.description}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">绂佹璁块棶IP</label>
    <div class="col-sm-10"><textarea class="form-control" name="blackip" rows="2" placeholder="澶氫釜IP鐢▅闅斿紑">${config.blackip}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">棣栭〉鍏憡</label>
    <div class="col-sm-10"><textarea class="form-control" name="gonggao" rows="3" placeholder="涓嶅～鍐欏垯涓嶆樉绀洪椤靛叕鍛?>${config.gonggao}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">鏂囦欢鏌ョ湅椤靛叕鍛?/label>
    <div class="col-sm-10"><textarea class="form-control" name="gg_file" rows="3" placeholder="涓嶅～鍐欏垯涓嶆樉绀?>${config.gg_file}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">缁熻浠ｇ爜</label>
    <div class="col-sm-10"><textarea class="form-control" name="tongji" rows="3" placeholder="涓嶅～鍐欏垯涓嶆樉绀虹粺璁′唬鐮?>${config.tongji}</textarea></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">鏂囦欢鎼滅储鍔熻兘</label>
    <div class="col-sm-10"><select class="form-control" name="filesearch" default="${config.filesearch}"><option value="0">鍏抽棴</option><option value="1">寮€鍚?/option></select></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-2 col-sm-10"><input type="submit" name="submit" value="淇敼" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>`;
  } else if (mod === 'user') {
    pageTitle = '鐢ㄦ埛鐧诲綍璁剧疆';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">鐢ㄦ埛鐧诲綍璁剧疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
    <label class="col-sm-3 control-label">鐢ㄦ埛鐧诲綍寮€鍏?/label>
    <div class="col-sm-9"><select class="form-control" name="userlogin" default="${config.userlogin}"><option value="0">鍏抽棴</option><option value="1">寮€鍚?/option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">鑱氬悎鐧诲綍鎺ュ彛鍦板潃</label>
    <div class="col-sm-9"><input type="text" name="login_apiurl" value="${config.login_apiurl}" class="form-control" placeholder="鎺ュ彛鍦板潃瑕佷互http://鎴杊ttps://寮€澶达紝浠?缁撳熬"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">搴旂敤APPID</label>
    <div class="col-sm-9"><input type="text" name="login_appid" value="${config.login_appid}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">搴旂敤APPKEY</label>
    <div class="col-sm-9"><input type="text" name="login_appkey" value="${config.login_appkey}" class="form-control"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">寮€鍚殑鐧诲綍鏂瑰紡</label>
    <div class="col-sm-9">
    <input type="hidden" name="login_qq" value="0"/>
    <input type="hidden" name="login_wx" value="0"/>
    <label class="checkbox-inline"><input type="checkbox" name="login_qq" value="1" ${config.login_qq ? 'checked' : ''}> QQ</label>
    <label class="checkbox-inline"><input type="checkbox" name="login_wx" value="1" ${config.login_wx ? 'checked' : ''}> 寰俊</label>
    </div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
<div class="panel-footer">
<span class="glyphicon glyphicon-info-sign"></span>
鑱氬悎鐧诲綍鎺ュ彛鏄娇鐢ㄥ僵铏硅仛鍚堢櫥褰曠郴缁熸惌寤虹殑绔欑偣銆?br/>
寮€鍚悗璇峰嬁闅忔剰鏇存崲鐧诲綍鎺ュ彛绔欑偣锛屽惁鍒欎細瀵艰嚧涔嬪墠娉ㄥ唽鐨勭敤鎴峰叏閮ㄦ棤娉曠櫥褰曘€?</div>
</div>`;
  } else if (mod === 'stor') {
    pageTitle = '瀛樺偍绫诲瀷璁剧疆';
    const storOptions = (val: string) => {
      const types = [
        { v: 'r2', n: 'Cloudflare R2' },
        { v: 's3', n: 'S3鍏煎瀛樺偍' },
        { v: 'github', n: 'GitHub API' },
        { v: 'webdav', n: 'WebDAV' },
        { v: 'upyun', n: '鍙堟媿浜? },
        { v: 'qiniu', n: '涓冪墰浜? },
      ];
      return types.map(t => `<option value="${t.v}"${config.storage === t.v ? ' selected' : ''}>${t.n}</option>`).join('');
    };
    panelBody = `<div class="panel panel-success">
<div class="panel-heading"><h3 class="panel-title">瀛樺偍绫诲瀷璁剧疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">鍒囨崲瀛樺偍绫诲瀷</label>
      <div class="col-sm-9"><select class="form-control" name="storage" default="${config.storage}">${storOptions(config.storage)}</select><font color="green">宸叉湁鏂囦欢鐨勬儏鍐典笅璇峰嬁闅忔剰鍙樻洿锛屽惁鍒欎箣鍓嶄笂浼犵殑鏂囦欢鍏ㄩ儴鏃犳硶涓嬭浇</font></div>
    </div><br/>
    <div id="cloud_stor" style="${config.storage === 'r2' ? '' : 'display:none;'}">
    <div class="form-group">
      <label class="col-sm-3 control-label">鏂囦欢涓婁紶鏂瑰紡</label>
      <div class="col-sm-9"><select class="form-control" name="uploadfile_type" default="${config.uploadfile_type}"><option value="0">缃戠珯涓浆</option><option value="1">鐩存帴閾炬帴</option></select></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">鏂囦欢涓嬭浇鏂瑰紡</label>
      <div class="col-sm-9"><select class="form-control" name="downfile_type" default="${config.downfile_type}"><option value="0">缃戠珯涓浆</option><option value="1">鐩存帴閾炬帴</option></select></div>
    </div><br/>
    <div class="form-group" id="downfile_type_form" style="${config.downfile_type !== 1 ? 'display:none;' : ''}">
      <label class="col-sm-3 control-label">鏂囦欢涓嬭浇鍩熷悕</label>
      <div class="col-sm-9">
        <div class="row">
        <div class="col-xs-4 col-md-3" style="padding-right: 0px;">
          <select class="form-control" name="downfile_protocol" default="${config.downfile_protocol}"><option value="0">http://</option><option value="1">https://</option></select>
        </div>
        <div class="col-xs-8 col-md-9" style="padding-left: 0px;">
          <input type="text" class="form-control" name="downfile_domain" value="${config.downfile_domain}" placeholder="鐣欑┖鍒欎娇鐢ㄤ簯瀛樺偍榛樿鍩熷悕">
        </div>
        </div>
        <font color="green">濉啓Bucket缁戝畾鐨勫煙鍚嶏紝涔熷彲浣跨敤CDN鍩熷悕</font>
      </div>
    </div><br/>
    </div>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">Cloudflare R2 閰嶇疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">R2 鍏紑璁块棶URL</label>
      <div class="col-sm-9"><input type="text" name="r2_public_url" value="${config.r2_public_url}" class="form-control" placeholder="濡?https://files.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">S3 鍏煎瀛樺偍閰嶇疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 Endpoint</label>
      <div class="col-sm-9"><input type="text" name="s3_endpoint" value="${config.s3_endpoint}" class="form-control" placeholder="濡?https://s3.amazonaws.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">S3 Region</label>
      <div class="col-sm-9"><input type="text" name="s3_region" value="${config.s3_region}" class="form-control" placeholder="濡?us-east-1"/></div>
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
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">GitHub API 閰嶇疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">GitHub 鐢ㄦ埛鍚?/label>
      <div class="col-sm-9"><input type="text" name="gh_owner" value="${config.gh_owner}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">浠撳簱鍚嶇О</label>
      <div class="col-sm-9"><input type="text" name="gh_repo" value="${config.gh_repo}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">Token</label>
      <div class="col-sm-9"><input type="text" name="gh_token" value="${config.gh_token}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">鍒嗘敮</label>
      <div class="col-sm-9"><input type="text" name="gh_ref" value="${config.gh_ref}" class="form-control" placeholder="濡?main"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">瀛樺偍鐩綍</label>
      <div class="col-sm-9"><input type="text" name="gh_folder" value="${config.gh_folder}" class="form-control" placeholder="濡?file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">WebDAV 閰嶇疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">WebDAV 鍦板潃</label>
      <div class="col-sm-9"><input type="text" name="webdav_endpoint" value="${config.webdav_endpoint}" class="form-control" placeholder="濡?https://dav.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">鐢ㄦ埛鍚?/label>
      <div class="col-sm-9"><input type="text" name="webdav_user" value="${config.webdav_user}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">瀵嗙爜</label>
      <div class="col-sm-9"><input type="text" name="webdav_pass" value="${config.webdav_pass}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">瀛樺偍鐩綍</label>
      <div class="col-sm-9"><input type="text" name="webdav_folder" value="${config.webdav_folder}" class="form-control" placeholder="濡?file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">鍙堟媿浜戦厤缃?/h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
      <label class="col-sm-3 control-label">鏈嶅姟鍚?(Bucket)</label>
      <div class="col-sm-9"><input type="text" name="upyun_bucket" value="${config.upyun_bucket}" class="form-control" placeholder="濡?my-pan-storage"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">鎿嶄綔鍛?/label>
      <div class="col-sm-9"><input type="text" name="upyun_operator" value="${config.upyun_operator}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">瀵嗙爜</label>
      <div class="col-sm-9"><input type="password" name="upyun_password" value="${config.upyun_password}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">API 绔偣</label>
      <div class="col-sm-9"><input type="text" name="upyun_endpoint" value="${config.upyun_endpoint}" class="form-control" placeholder="濡?https://v0.api.upyun.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">鍔犻€熷煙鍚?/label>
      <div class="col-sm-9"><input type="text" name="upyun_domain" value="${config.upyun_domain}" class="form-control" placeholder="濡?https://xxx.b0.upaiyun.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">瀛樺偍鐩綍</label>
      <div class="col-sm-9"><input type="text" name="upyun_folder" value="${config.upyun_folder}" class="form-control" placeholder="濡?file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary btn-block"/>
      </div>
    </div>
  </form>
</div>
</div>

<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">涓冪墰浜戦厤缃?/h3></div>
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
      <label class="col-sm-3 control-label">瀛樺偍绌洪棿鍚嶇О (Bucket)</label>
      <div class="col-sm-9"><input type="text" name="qiniu_bucket" value="${config.qiniu_bucket}" class="form-control"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">绌洪棿缁戝畾鍩熷悕</label>
      <div class="col-sm-9"><input type="text" name="qiniu_domain" value="${config.qiniu_domain}" class="form-control" placeholder="濡?https://cdn.example.com"/></div>
    </div><br/>
    <div class="form-group">
      <label class="col-sm-3 control-label">瀛樺偍鐩綍</label>
      <div class="col-sm-9"><input type="text" name="qiniu_folder" value="${config.qiniu_folder}" class="form-control" placeholder="濡?file"/></div>
    </div><br/>
    <div class="form-group">
      <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary btn-block"/>
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
    layer.alert('鐩爣瀛樺偍绫诲瀷涓庡綋鍓嶇浉鍚?, {icon: 2});
    return;
  }
  var dialogContent = ''
    + '<div style="padding:20px">'
    + '<p><strong>褰撳墠瀛樺偍锛?/strong>' + currentStorage.toUpperCase() + '</p>'
    + '<p><strong>鐩爣瀛樺偍锛?/strong>' + targetType.toUpperCase() + '</p>'
    + '<hr/>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="copy" checked> 杩佺Щ鏁版嵁锛氬皢鎵€鏈夌幇鏈夋枃浠跺鍒跺埌鏂板瓨鍌紙鑰楁椂杈冮暱锛?/label></div>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="new"> 鏂版枃浠剁敤鏂板瓨鍌細鍙鏂颁笂浼犵殑鏂囦欢浣跨敤鏂板瓨鍌紝鏃ф枃浠朵繚鐣欏湪鏃у瓨鍌?/label></div>'
    + '<div class="radio"><label><input type="radio" name="migrate_mode" value="switch"> 鐩存帴鍒囨崲锛氬畬鍏ㄥ垏鎹㈠埌鏂板瓨鍌紝鏃ф枃浠朵笉鍙闂紙鏈€蹇級</label></div>'
    + '<hr/>'
    + '<p style="color:#999">鏄惁鍦ㄨ縼绉诲畬鎴愬悗鍒犻櫎鏃у瓨鍌ㄧ殑鏂囦欢锛?/p>'
    + '<div class="radio"><label><input type="radio" name="delete_old" value="0" checked> 淇濈暀鏃у瓨鍌ㄦ枃浠?/label></div>'
    + '<div class="radio"><label><input type="radio" name="delete_old" value="1"> 鍒犻櫎鏃у瓨鍌ㄦ枃浠讹紙浠呰縼绉绘ā寮忔湁鏁堬級</label></div>'
    + '</div>';
  layer.open({
    type: 1,
    title: '瀛樺偍杩佺Щ閫夐」',
    area: ['500px', 'auto'],
    content: dialogContent,
    btn: ['寮€濮嬭縼绉?, '鍙栨秷'],
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
          layer.alert('鏈嶅姟鍣ㄩ敊璇?, {icon: 2});
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
          var msg = '杩佺Щ杩涘害: ' + res.data.processed + '/' + res.data.total + '\\n褰撳墠: ' + res.data.currentFile;
          layer.msg(msg, {time: 2000});
        } else if(res.data && res.data.status === 'completed'){
          clearInterval(timer);
          layer.close(ii);
          layer.alert('杩佺Щ瀹屾垚锛佹垚鍔? ' + res.data.success + ', 澶辫触: ' + res.data.failed, {icon: 1}, function(){
            window.location.reload();
          });
        } else if(res.data && res.data.status === 'failed'){
          clearInterval(timer);
          layer.close(ii);
          layer.alert('杩佺Щ瀹屾垚浣嗘湁閿欒銆傛垚鍔? ' + res.data.success + ', 澶辫触: ' + res.data.failed, {icon: 2});
        }
      }
    });
  }, 2000);
}
</script>

<div class="panel panel-warning">
<div class="panel-heading"><h3 class="panel-title">瀛樺偍杩佺Щ</h3></div>
<div class="panel-body">
  <p>淇敼瀛樺偍绫诲瀷鍚庣偣鍑讳笅鏂规寜閽繘琛岃縼绉汇€傚彲閫夋嫨杩佺Щ鍏ㄩ儴鏁版嵁銆佹柊鏂囦欢鐢ㄦ柊瀛樺偍鎴栫洿鎺ュ垏鎹€?/p>
  <button type="button" class="btn btn-warning" onclick="startMigrate()"><i class="fa fa-exchange"></i> 寮€濮嬭縼绉诲埌鏂板瓨鍌?/button>
</div>
</div>
`;
  } else if (mod === 'file') {
    pageTitle = '鏂囦欢涓婁紶璁剧疆';
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">鏂囦欢涓婁紶璁剧疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-3 control-label">鍥剧墖鏂囦欢绫诲瀷</label>
    <div class="col-sm-9"><input type="text" name="type_image" value="${config.type_image}" class="form-control" placeholder="澶氫釜鏂囦欢绫诲瀷鐢▅闅斿紑"/><font color="green">鍦ㄦ枃浠堕瑙堥〉闈紝浠ヤ笂鏂囦欢绫诲瀷灏嗕互鍥剧墖鐨勫舰寮忓睍绀?/font></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">闊抽鏂囦欢绫诲瀷</label>
    <div class="col-sm-9"><input type="text" name="type_audio" value="${config.type_audio}" class="form-control" placeholder="澶氫釜鏂囦欢绫诲瀷鐢▅闅斿紑"/><font color="green">鍦ㄦ枃浠堕瑙堥〉闈紝浠ヤ笂鏂囦欢绫诲瀷灏嗕互闊抽鐨勫舰寮忓睍绀?/font></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">瑙嗛鏂囦欢绫诲瀷</label>
    <div class="col-sm-9"><input type="text" name="type_video" value="${config.type_video}" class="form-control" placeholder="澶氫釜鏂囦欢绫诲瀷鐢▅闅斿紑"/><font color="green">鍦ㄦ枃浠堕瑙堥〉闈紝浠ヤ笂鏂囦欢绫诲瀷灏嗕互瑙嗛鐨勫舰寮忓睍绀?/font></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">绂佹涓婁紶鐨勬枃浠剁被鍨?/label>
    <div class="col-sm-9"><input type="text" name="type_block" value="${config.type_block}" class="form-control" placeholder="澶氫釜鏂囦欢绫诲瀷鐢▅闅斿紑"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">鏂囦欢鍚嶅睆钄藉叧閿瘝</label>
    <div class="col-sm-9"><input type="text" name="name_block" value="${config.name_block}" class="form-control" placeholder="澶氫釜鍏抽敭璇嶇敤|闅斿紑"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">姣廔P姣忓ぉ闄愬埗涓婁紶鏁伴噺</label>
    <div class="col-sm-9"><input type="text" name="upload_limit" value="${config.upload_limit}" class="form-control" placeholder="0鎴栫暀绌轰负涓嶉檺鍒?/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">瑙嗛鏂囦欢闇€瑕佸鏍?/label>
    <div class="col-sm-9"><select class="form-control" name="videoreview" default="${config.videoreview}"><option value="0">鍏抽棴</option><option value="1">寮€鍚?/option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">涓婁紶澶у皬闄愬埗</label>
    <div class="col-sm-9"><div class="input-group"><input type="text" name="upload_size" value="${config.upload_size}" class="form-control" placeholder="涓嶅～鍐欏垯涓嶉檺鍒跺ぇ灏?/><span class="input-group-addon">MB</span></div></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">浠呴檺鐧诲綍鐢ㄦ埛涓婁紶</label>
    <div class="col-sm-9"><select class="form-control" name="forcelogin" default="${config.forcelogin}"><option value="0">鍚?/option><option value="1">鏄?/option></select></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>`;
  } else if (mod === 'green') {
    pageTitle = '鍥剧墖妫€娴嬭缃?;
    const greenLabelPorn = config.green_label_porn ? config.green_label_porn.split(',') : [];
    const greenLabelTerrorism = config.green_label_terrorism ? config.green_label_terrorism.split(',') : [];
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">鍥剧墖妫€娴嬭缃?/h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
    <div class="form-group">
    <label class="col-sm-3 control-label">鍥剧墖杩濊妫€娴?/label>
    <div class="col-sm-9"><select class="form-control" name="green_check" default="${config.green_check}"><option value="0">鍏抽棴</option><option value="1">闃块噷浜戝唴瀹瑰畨鍏ㄦ帴鍙?/option><option value="2">鑵捐浜戝唴瀹瑰畨鍏ㄦ帴鍙?/option></select></div>
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
    <label class="col-sm-3 control-label">鍥剧墖妫€娴嬫帴鍏ュ尯鍩?/label>
    <div class="col-sm-9"><select class="form-control" name="green_region" default="${config.green_region}"><option value="cn-beijing">鍗庡寳2锛堝寳浜級</option><option value="cn-shanghai">鍗庝笢2锛堜笂娴凤級</option><option value="cn-shenzhen">鍗庡崡1锛堟繁鍦筹級</option><option value="ap-southeast-1">鏂板姞鍧?/option><option value="us-west-1">缇庤タ</option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">鍥剧墖鏅鸿兘閴撮粍</label>
    <div class="col-sm-9"><select class="form-control" name="green_check_porn" default="${config.green_check_porn}"><option value="0">鍏抽棴</option><option value="1">寮€鍚?/option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">鍥剧墖鏅鸿兘閴撮粍灞忚斀绫诲瀷</label>
    <div class="col-sm-9">
    <label class="checkbox-inline"><input type="checkbox" name="green_label_porn" value="porn" ${greenLabelPorn.includes('porn') ? 'checked' : ''}/> 鑹叉儏鍥剧墖锛坧orn锛?/label>
    <label class="checkbox-inline"><input type="checkbox" name="green_label_porn" value="sexy" ${greenLabelPorn.includes('sexy') ? 'checked' : ''}/> 鎬ф劅鍥剧墖锛坰exy锛?/label>
    </div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">鍥剧墖鏆存亹娑夋斂璇嗗埆</label>
    <div class="col-sm-9"><select class="form-control" name="green_check_terrorism" default="${config.green_check_terrorism}"><option value="0">鍏抽棴</option><option value="1">寮€鍚?/option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">鍥剧墖鏆存亹娑夋斂璇嗗埆灞忚斀绫诲瀷</label>
    <div class="col-sm-9">
    <label class="checkbox-inline"><input type="checkbox" name="green_label_terrorism" value="bloody" ${greenLabelTerrorism.includes('bloody') ? 'checked' : ''}/> 琛€鑵ワ紙bloody锛?/label>
    <label class="checkbox-inline"><input type="checkbox" name="green_label_terrorism" value="terrorism" ${greenLabelTerrorism.includes('terrorism') ? 'checked' : ''}/> 鏆存亹锛坱errorism锛?/label>
    </div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>`;
  } else if (mod === 'api') {
    pageTitle = '涓婁紶API璁剧疆';
    const siteUrlStr2 = siteUrl(c);
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">涓婁紶API璁剧疆</h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-3 control-label">涓婁紶API寮€鍏?/label>
    <div class="col-sm-9"><select class="form-control" name="api_open" default="${config.api_open}"><option value="0">鍏抽棴</option><option value="1">寮€鍚?/option></select></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-3 control-label">鏉ユ簮鍩熷悕鐧藉悕鍗?/label>
    <div class="col-sm-9"><input type="text" name="api_referer" value="${config.api_referer}" class="form-control" placeholder="澶氫釜鍩熷悕鐢▅闅斿紑"/><font color="green">澶氫釜鍩熷悕鐢▅闅斿紑锛屼笉濉啓鍒欎笉闄愬埗鏉ユ簮鍩熷悕</font></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-3 col-sm-9"><input type="submit" name="submit" value="淇敼" class="btn btn-primary form-control"/><br/>
   </div>
  </div>
  </form>
</div>
</div>
<div class="panel panel-info">
<div class="panel-heading"><h3 class="panel-title">涓婁紶API鏂囨。</h3></div>
<div class="panel-body">
<pre>
API鎺ュ彛鍦板潃锛?{siteUrlStr2}api.php

褰撳墠API鏀寔JSON銆丣SONP銆丗ORM 3绉嶈繑鍥炴柟寮忥紝鏀寔Web璺ㄥ煙璋冪敤锛屼篃鏀寔绋嬪簭涓洿鎺ヨ皟鐢ㄣ€?
璇锋眰鏂瑰紡锛歅OST  multipart/form-data

璇锋眰鍙傛暟璇存槑锛?file - 鏂囦欢锛堝繀濉級
show - 鏄惁棣栭〉鏄剧ず锛堥粯璁?锛?ispwd - 鏄惁璁剧疆瀵嗙爜锛堥粯璁?锛?pwd - 涓嬭浇瀵嗙爜
format - 杩斿洖鏍煎紡锛坖son/jsonp/form锛岄粯璁son锛?
杩斿洖鍙傛暟璇存槑锛?code - 0涓烘垚鍔?msg - 鎻愮ず淇℃伅
hash - 鏂囦欢MD5
name - 鏂囦欢鍚嶇О
size - 鏂囦欢澶у皬
type - 鏂囦欢鏍煎紡
downurl - 涓嬭浇鍦板潃
</pre>
</div>
</div>`;
  } else if (mod === 'account') {
    pageTitle = '绠＄悊鍛樿处鍙疯缃?;
    panelBody = `<div class="panel panel-primary">
<div class="panel-heading"><h3 class="panel-title">绠＄悊鍛樿处鍙疯缃?/h3></div>
<div class="panel-body">
  <form onsubmit="return saveSetting(this)" method="post" class="form-horizontal" role="form">
  <div class="form-group">
    <label class="col-sm-2 control-label">鐢ㄦ埛鍚?/label>
    <div class="col-sm-10"><input type="text" name="admin_user" value="${config.admin_user}" class="form-control" required/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">鏃у瘑鐮?/label>
    <div class="col-sm-10"><input type="password" name="oldpwd" value="" class="form-control" placeholder="璇疯緭鍏ュ綋鍓嶇殑绠＄悊鍛樺瘑鐮?/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">鏂板瘑鐮?/label>
    <div class="col-sm-10"><input type="password" name="newpwd" value="" class="form-control" placeholder="涓嶄慨鏀硅鐣欑┖"/></div>
  </div><br/>
  <div class="form-group">
    <label class="col-sm-2 control-label">閲嶈緭瀵嗙爜</label>
    <div class="col-sm-10"><input type="password" name="newpwd2" value="" class="form-control" placeholder="涓嶄慨鏀硅鐣欑┖"/></div>
  </div><br/>
  <div class="form-group">
    <div class="col-sm-offset-2 col-sm-10"><input type="submit" name="submit" value="淇敼" class="btn btn-primary form-control"/><br/>
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

// ===================== /admin/restore 兼容跳转（已迁移到 /install 流程） =====================
frontend.get('/admin/restore', async (c) => {
  // 兼容旧书签：直接 302 到 /install
  return c.redirect('/install');
});

// ===================== 调试：测试 DB 连通性和计数 =====================
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

/** 浠〃鐩樼粺璁?*/
frontend.get('/admin/ajax/getcount', async (c) => {
  // 鏁翠釜澶勭悊鍣ㄥ寘涓€灞?try-catch锛岄伩鍏嶄换浣曞紓甯稿鑷村墠绔仠鐣欏湪 0
  try {
    // auth
    if (!await checkAdmin(c)) {
      console.warn('[getcount] auth failed');
      return c.json({ code: -1, msg: 'auth failed' });
    }
    const db = getDB(c);
    const config = getConf(c);

    // 鏂囦欢鎬绘暟锛氭寜 max(id) 鍙栨渶鏂颁竴鏉?id 浣滀负鏄剧ず鍊?    let total = 0;
    try {
      const r = await db.prepare('SELECT MAX(id) as c FROM pre_file').first<{ c: number }>();
      total = r?.c ?? 0;
    } catch (e: any) {
      console.error('[getcount] getFileTotal(max id) failed:', e?.message || e);
    }

    // 鎶芥牱绗竴鏉￠獙璇?    let sample: any = null;
    try {
      sample = await db.prepare('SELECT id, name, hash, addtime FROM pre_file ORDER BY id DESC LIMIT 1').first();
    } catch (e: any) {
      console.error('[getcount] sample failed:', e?.message || e);
    }

    // 鏃ユ湡杈圭晫锛堝叏閮ㄤ娇鐢?UTC锛屽洜涓?Workers 杩愯鍦?UTC 鏃跺尯锛?    const isoNow = new Date().toISOString(); // e.g. "2026-07-01T15:30:00.000Z"
    const todayStr = isoNow.substring(0, 10);
    const todayBoundary = todayStr + ' 00:00:00';

    // 鏄庡ぉ锛氬姞 1 澶╃殑 UTC 鏃ユ湡
    const tomorrowDate = new Date(Date.now() + 86400000);
    const tomorrowBoundary = tomorrowDate.toISOString().substring(0, 10) + ' 00:00:00';

    // 鏄ㄥぉ锛氬噺 1 澶╃殑 UTC 鏃ユ湡
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
    const count4 = config.storage.toUpperCase();

    console.log(`[getcount] total=${count1} today=${count2} yesterday=${count3} storage=${count4} sample=${sample ? sample.id + ':' + sample.name : 'none'} todayBoundary=${todayBoundary} tomorrow=${tomorrowBoundary} yesterday=${yesterdayBoundary}`);

    return c.json({
      code: 0,
      count1, count2, count3, count4,
      debug: {
        today: todayBoundary,
        tomorrow: tomorrowBoundary,
        yesterday: yesterdayBoundary,
        sample: sample ? { id: sample.id, name: sample.name, hash: sample.hash, addtime: sample.addtime } : null,
      },
    });
  } catch (e: any) {
    console.error('[getcount] unhandled exception:', e?.message || e, e?.stack);
    // 鍏滃簳锛氫粛鐒惰繑鍥?code:0 浠ヤ繚璇佸墠绔笉浼氬仠鍦?0锛岃嚦灏戠粰涓€涓┖鍊?    return c.json({
      code: 0,
      count1: 0,
      count2: 0,
      count3: 0,
      count4: 'UNKNOWN',
      error: e?.message || String(e),
    });
  }
});

/** 鏂囦欢绠＄悊鍒楄〃 */
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
  if (!row) return c.json({ code: -1, msg: '鏂囦欢涓嶅瓨鍦? });
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

  if (!name) return c.json({ code: -1, msg: '鏂囦欢鍚嶇О涓嶈兘涓虹┖' });
  if (ispwd === 1 && pwd && !/^[a-zA-Z0-9]+$/.test(pwd)) {
    return c.json({ code: -1, msg: '涓嬭浇瀵嗙爜鍙兘涓哄瓧姣嶅拰鏁板瓧' });
  }

  await updateFile(db, { id, name, type, hide, pwd });
  return c.json({ code: 0, msg: '淇敼鎴愬姛' });
});

frontend.get('/admin/ajax/setBlock', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  const status = parseInt(c.req.query('status') || '0');
  await setFileBlock(db, id, status);
  return c.json({ code: 0, msg: '淇敼鎴愬姛' });
});

frontend.get('/admin/ajax/delFile', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const id = parseInt(c.req.query('id') || '0');
  const row = await getFileById(db, id);
  if (!row) return c.json({ code: -1, msg: '鏂囦欢涓嶅瓨鍦? });
  try {
    await stor.delete(row.hash);
  } catch {}
  await deleteFile(db, id);
  return c.json({ code: 0, msg: '鍒犻櫎鎴愬姛' });
});

frontend.post('/admin/ajax/operation', async (c) => {
  if (!await checkAdmin(c)) return c.json({ code: -1 });
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const status = parseInt(String(body['status'] || '0'));
  const idsStr = String(body['ids'] || '');
  const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  if (ids.length === 0) return c.json({ code: -1, msg: '鏈€変腑鏂囦欢' });

  let opname = '澶勭悊';
  if (status === 0) opname = '鍒犻櫎';
  else if (status === 1) opname = '灏佺';
  else if (status === 2) opname = '瑙ｅ皝';

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
  return c.json({ code: 0, msg: `鎴愬姛${opname} ${count} 涓枃浠禶 });
});

export default frontend;
