// 彩虹外链网盘 - 安装向导路由
// 首次部署/存储未配置时自动跳转到此页

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf } from '../middleware';
import { isStorageConfigured } from '../storage/factory';
import { updateConfig, clearConfigCache } from '../config';
import { jsonResult, jsonError } from '../utils/response';

const install = new Hono<AppEnv>();

/** 安装页面 HTML（仿照原项目 header.php + footer.php 风格） */
function installPage(errorMsg: string = '', selectedType: string = 'r2'): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="renderer" content="webkit">
<meta name="viewport" content="width=device-width,height=device-height,inital-scale=1.0,maximum-scale=1.0,user-scalable=no;">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>彩虹外链网盘 - 安装向导</title>
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/css/bootstrap-material-design.min.css">
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/css/ripples.min.css">
<link rel="icon" href="favicon.ico" type="image/x-icon">
<!--[if lt IE 9]>
<script src="https://s4.zstatic.net/ajax/libs/html5shiv/3.7.3/html5shiv.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/respond.js/1.4.2/respond.min.js"></script>
<![endif]-->
<script src="https://s4.zstatic.net/ajax/libs/jquery/1.12.4/jquery.min.js"></script>
<style>
.install-header { background: linear-gradient(135deg, #5bc0de 0%, #2e8bcc 100%); color: #fff; padding: 20px 0; margin-bottom: 20px; }
.install-header h2 { margin: 0; font-weight: 400; }
.install-header small { color: #f1f1f1; }
.storage-tabs { display: flex; border-bottom: 2px solid #eee; margin-bottom: 25px; }
.storage-tab { flex: 1; padding: 12px; text-align: center; cursor: pointer; background: #f8f9fa; color: #666; border: 1px solid #e7e7e7; border-bottom: none; transition: all 0.2s; }
.storage-tab.active { background: #fff; color: #2e8bcc; font-weight: bold; border-bottom: 3px solid #2e8bcc; margin-bottom: -2px; }
.storage-tab i { display: block; font-size: 24px; margin-bottom: 5px; }
.storage-form { display: none; }
.storage-form.active { display: block; }
.required { color: #e44; }
.btn-install { background: #2e8bcc; color: #fff; border: none; padding: 10px 30px; border-radius: 4px; font-size: 16px; cursor: pointer; width: 100%; }
.btn-install:hover { background: #2976a8; color: #fff; }
.btn-install:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-test { background: #5bc0de; }
.btn-test:hover { background: #46b8da; }
</style>
</head>
<body>
<div class="install-header">
<div class="container">
  <h2><i class="fa fa-cloud"></i> 彩虹外链网盘 安装向导</h2>
  <small>Cloudflare Workers + D1 + 多存储后端 一体化部署</small>
</div>
</div>
<div class="container">
<div class="well bs-component">
  <div class="alert alert-info">
    <i class="fa fa-info-circle"></i> 请选择并配置一种存储后端。所有配置项都保存在 D1 数据库，可随时通过后台修改。
  </div>
  ${errorMsg ? `<div class="alert alert-danger"><i class="fa fa-exclamation-circle"></i> ${errorMsg}</div>` : ''}

  <div class="storage-tabs">
    <button type="button" class="storage-tab ${selectedType === 'r2' ? 'active' : ''}" data-target="form-r2">
      <i class="fa fa-database"></i>Cloudflare R2
    </button>
    <button type="button" class="storage-tab ${selectedType === 's3' ? 'active' : ''}" data-target="form-s3">
      <i class="fa fa-cloud"></i>S3 兼容
    </button>
    <button type="button" class="storage-tab ${selectedType === 'github' ? 'active' : ''}" data-target="form-github">
      <i class="fa fa-github"></i>GitHub API
    </button>
    <button type="button" class="storage-tab ${selectedType === 'webdav' ? 'active' : ''}" data-target="form-webdav">
      <i class="fa fa-cloud"></i>WebDAV
    </button>
  </div>

  <form id="installForm" method="POST" action="/install/save">
    <!-- 管理员账号 -->
    <div class="form-group">
      <label>管理员账号 <span class="required">*</span></label>
      <input type="text" name="admin_user" class="form-control" value="admin" required>
    </div>
    <div class="form-group">
      <label>管理员密码 <span class="required">*</span></label>
      <input type="password" name="admin_pwd" class="form-control" placeholder="请设置一个强密码" required>
    </div>
    <div class="form-group">
      <label>站点名称</label>
      <input type="text" name="title" class="form-control" value="彩虹外链网盘">
    </div>

    <!-- R2 表单 -->
    <div class="storage-form ${selectedType === 'r2' ? 'active' : ''}" id="form-r2">
      <h4 style="margin-top:20px"><i class="fa fa-database"></i> Cloudflare R2 配置</h4>
      <div class="alert alert-info">
        R2 存储桶需在 Cloudflare Dashboard 中手动创建。wrangler.toml 中已绑定 <code>FILE_R2</code>，此处只需确认即可。
      </div>
      <div class="form-group">
        <label>存储桶名称</label>
        <input type="text" class="form-control" value="pan-files" disabled>
        <span class="help-block">名称在 wrangler.toml 中固定配置</span>
      </div>
    </div>

    <!-- S3 表单 -->
    <div class="storage-form ${selectedType === 's3' ? 'active' : ''}" id="form-s3">
      <h4 style="margin-top:20px"><i class="fa fa-cloud"></i> S3 兼容存储配置</h4>
      <div class="form-group">
        <label>Endpoint (S3 API 地址) <span class="required">*</span></label>
        <input type="text" name="s3_endpoint" class="form-control" placeholder="https://s3.amazonaws.com 或 https://oss-cn-hangzhou.aliyuncs.com">
        <span class="help-block">支持 AWS S3 / 阿里云 OSS / 腾讯云 COS / MinIO 等</span>
      </div>
      <div class="form-group">
        <label>Region <span class="required">*</span></label>
        <input type="text" name="s3_region" class="form-control" placeholder="us-east-1 / cn-hangzhou / auto">
      </div>
      <div class="form-group">
        <label>Bucket 名称 <span class="required">*</span></label>
        <input type="text" name="s3_bucket" class="form-control" placeholder="my-bucket">
      </div>
      <div class="form-group">
        <label>AccessKey ID <span class="required">*</span></label>
        <input type="text" name="s3_ak" class="form-control">
      </div>
      <div class="form-group">
        <label>SecretAccessKey <span class="required">*</span></label>
        <input type="password" name="s3_sk" class="form-control">
      </div>
    </div>

    <!-- GitHub 表单 -->
    <div class="storage-form ${selectedType === 'github' ? 'active' : ''}" id="form-github">
      <h4 style="margin-top:20px"><i class="fa fa-github"></i> GitHub API 存储配置</h4>
      <div class="alert alert-info">
        适用于 Cloudflare API Token 无 R2 权限的场景。文件以 Git 提交方式存到 GitHub 仓库。
        <br>需要 Token 具备 <code>repo</code> (完整仓库) 权限。
      </div>
      <div class="form-group">
        <label>仓库 Owner (用户名或组织) <span class="required">*</span></label>
        <input type="text" name="gh_owner" class="form-control" placeholder="octocat">
      </div>
      <div class="form-group">
        <label>仓库名 <span class="required">*</span></label>
        <input type="text" name="gh_repo" class="form-control" placeholder="my-pan-storage">
        <span class="help-block">建议使用一个空的私有仓库</span>
      </div>
      <div class="form-group">
        <label>Personal Access Token <span class="required">*</span></label>
        <input type="password" name="gh_token" class="form-control" placeholder="ghp_xxxxxxxxxxxx">
        <span class="help-block">需要 <code>repo</code> 权限。Token 仅保存在 D1 中，不会上传到任何地方。</span>
      </div>
      <div class="form-group">
        <label>分支 (留空则使用默认分支)</label>
        <input type="text" name="gh_ref" class="form-control" placeholder="main">
      </div>
      <div class="form-group">
        <label>存储子目录 (可选)</label>
        <input type="text" name="gh_folder" class="form-control" placeholder="留空则使用 file/">
      </div>
      <div class="form-group">
        <label>API Base (自定义 GitHub 代理时填写)</label>
        <input type="text" name="gh_api_base" class="form-control" value="https://api.github.com">
      </div>
    </div>

    <!-- WebDAV 表单 -->
    <div class="storage-form ${selectedType === 'webdav' ? 'active' : ''}" id="form-webdav">
      <h4 style="margin-top:20px"><i class="fa fa-cloud"></i> WebDAV 存储配置</h4>
      <div class="alert alert-info">
        兼容坚果云 / 群晖 / Nextcloud / ownCloud / 通用 WebDAV 服务。通过 HTTP 协议 (Basic Auth) 操作远程存储。
      </div>
      <div class="form-group">
        <label>WebDAV 服务地址 <span class="required">*</span></label>
        <input type="text" name="webdav_endpoint" class="form-control" placeholder="https://dav.example.com/remote.php/webdav/">
        <span class="help-block">必须以 <code>http://</code> 或 <code>https://</code> 开头，路径末尾可有可无 <code>/</code></span>
      </div>
      <div class="form-group">
        <label>用户名 <span class="required">*</span></label>
        <input type="text" name="webdav_user" class="form-control" placeholder="username">
      </div>
      <div class="form-group">
        <label>密码 / 应用专用密码 <span class="required">*</span></label>
        <input type="password" name="webdav_pass" class="form-control" placeholder="password">
        <span class="help-block">坚果云 / 群晖等需使用"应用专用密码"，而非登录密码。密码仅保存在 D1 中。</span>
      </div>
      <div class="form-group">
        <label>存储子目录 (可选)</label>
        <input type="text" name="webdav_folder" class="form-control" value="file" placeholder="留空则使用 file/">
        <span class="help-block">文件会保存到此子目录下（路径分隔用 <code>/</code>）</span>
      </div>
    </div>

    <input type="hidden" name="storage_type" id="storage_type" value="${selectedType}">

    <div class="form-group" style="margin-top:30px">
      <button type="button" id="btnTest" class="btn-install btn-test" style="margin-bottom:10px;"><i class="fa fa-plug"></i> 测试连接</button>
      <button type="submit" class="btn-install"><i class="fa fa-check"></i> 完成安装</button>
    </div>
    <div id="testResult" style="margin-top:15px;display:none;"></div>
  </form>
</div>
</div>
<footer class="footer text-center">
<div class="container">
<p class="text-muted">Copyright &copy; ${new Date().getFullYear()} <a href="/">彩虹外链网盘</a></p>
</div>
</footer>
<script src="https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/js/bootstrap.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/js/material.min.js"></script>
<script src="https://s4.zstatic.net/ajax/libs/bootstrap-material-design/0.5.10/js/ripples.min.js"></script>
<script>
document.querySelectorAll('.storage-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.storage-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.storage-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.target;
    document.getElementById(target).classList.add('active');
    document.getElementById('storage_type').value = tab.dataset.target.replace('form-', '');
    document.getElementById('testResult').style.display = 'none';
  });
});

document.getElementById('btnTest').addEventListener('click', async () => {
  var btn = document.getElementById('btnTest');
  var result = document.getElementById('testResult');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 正在测试...';
  result.style.display = 'none';
  result.className = '';
  result.innerHTML = '';

  try {
    var form = document.getElementById('installForm');
    var fd = new FormData(form);
    var res = await fetch('/install/test', { method: 'POST', body: fd });
    var data = await res.json();
    result.style.display = 'block';
    if (data.ok) {
      result.className = 'alert alert-info';
      result.innerHTML = '<i class="fa fa-check-circle"></i> ' + data.msg;
    } else {
      result.className = 'alert alert-danger';
      result.innerHTML = '<i class="fa fa-exclamation-circle"></i> ' + (data.msg || '测试失败');
    }
  } catch (e) {
    result.style.display = 'block';
    result.className = 'alert alert-danger';
    result.innerHTML = '<i class="fa fa-exclamation-circle"></i> 网络错误: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa fa-plug"></i> 测试连接';
  }
});
$.material.init();
</script>
</body>
</html>`;
}

/** 安装向导首页（同时支持 /install 和 /install/） */
install.get('/', async (c) => {
  const config = getConf(c);
  // 已安装则跳到首页
  if (config.installed === 1) {
    return c.redirect('/');
  }
  return c.html(installPage());
});

/** 别名：访问 /install（无尾斜杠）也走同一逻辑 */
install.get('', async (c) => {
  const config = getConf(c);
  if (config.installed === 1) {
    return c.redirect('/');
  }
  return c.html(installPage());
});

/** 提交安装配置 */
install.post('/save', async (c) => {
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();

  const storageType = String(body['storage_type'] || 'r2');
  const adminUser = String(body['admin_user'] || '').trim();
  const adminPwd = String(body['admin_pwd'] || '');
  const title = String(body['title'] || '彩虹外链网盘').trim();

  // 基础校验
  if (!adminUser) return c.html(installPage('请输入管理员账号', storageType), 400);
  if (adminPwd.length < 6) return c.html(installPage('管理员密码至少 6 位', storageType), 400);

  // 存储相关校验
  if (storageType === 'r2') {
    // R2 只需 env 中存在即可（wrangler.toml 已绑定）
  } else if (storageType === 's3') {
    const required = ['s3_endpoint', 's3_region', 's3_bucket', 's3_ak', 's3_sk'];
    for (const f of required) {
      if (!String(body[f] || '').trim()) {
        return c.html(installPage(`S3 配置缺少: ${f}`, storageType), 400);
      }
    }
  } else if (storageType === 'github') {
    const required = ['gh_owner', 'gh_repo', 'gh_token'];
    for (const f of required) {
      if (!String(body[f] || '').trim()) {
        return c.html(installPage(`GitHub 配置缺少: ${f}`, storageType), 400);
      }
    }
  } else if (storageType === 'webdav') {
    const required = ['webdav_endpoint', 'webdav_user', 'webdav_pass'];
    for (const f of required) {
      if (!String(body[f] || '').trim()) {
        return c.html(installPage(`WebDAV 配置缺少: ${f}`, storageType), 400);
      }
    }
  } else {
    return c.html(installPage(`未知的存储类型: ${storageType}`, storageType), 400);
  }

  try {
    // 写入所有配置到 D1
    const fields: Array<[string, string]> = [
      ['storage', storageType],
      ['admin_user', adminUser],
      ['admin_pwd', adminPwd],
      ['title', title],
      ['installed', '1'],
    ];

    if (storageType === 's3') {
      fields.push(
        ['s3_endpoint', String(body['s3_endpoint'])],
        ['s3_region', String(body['s3_region'])],
        ['s3_bucket', String(body['s3_bucket'])],
        ['s3_ak', String(body['s3_ak'])],
        ['s3_sk', String(body['s3_sk'])],
      );
    } else if (storageType === 'github') {
      fields.push(
        ['gh_owner', String(body['gh_owner'])],
        ['gh_repo', String(body['gh_repo'])],
        ['gh_token', String(body['gh_token'])],
        ['gh_ref', String(body['gh_ref'] || '')],
        ['gh_folder', String(body['gh_folder'] || '')],
        ['gh_api_base', String(body['gh_api_base'] || 'https://api.github.com')],
      );
    } else if (storageType === 'webdav') {
      fields.push(
        ['webdav_endpoint', String(body['webdav_endpoint'])],
        ['webdav_user', String(body['webdav_user'])],
        ['webdav_pass', String(body['webdav_pass'])],
        ['webdav_folder', String(body['webdav_folder'] || 'file')],
      );
    }

    for (const [k, v] of fields) {
      await updateConfig(db, k, v);
    }

    // 清除配置缓存，使下次请求加载新配置
    clearConfigCache();

    return c.html(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>安装完成</title>
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
<style>
body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; }
.box { max-width: 500px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 40px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }
.icon { font-size: 64px; color: #67c23a; margin-bottom: 20px; }
h2 { color: #333; }
.btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 10px 30px; border-radius: 6px; text-decoration: none; display: inline-block; margin-top: 20px; }
</style>
</head>
<body>
<div class="box">
  <div class="icon">✓</div>
  <h2>安装成功！</h2>
  <p>存储类型: <strong>${storageType}</strong></p>
  <p>管理员账号: <strong>${adminUser}</strong></p>
  <p>请记住您的管理员密码</p>
  <a href="/" class="btn">进入网盘</a>
  <a href="/admin" class="btn" style="background:#364a60;margin-left:10px">管理后台</a>
</div>
</body>
</html>`);
  } catch (e: any) {
    return c.html(installPage('保存配置失败: ' + (e.message || e), storageType), 500);
  }
});

/** 测试存储连接 (AJAX) */
install.post('/test', async (c) => {
  const body = await c.req.parseBody<Record<string, string>>();
  const storageType = String(body['storage_type'] || '');

  if (storageType === 'r2') {
    return jsonResult(c, { ok: true, message: 'R2 存储将在部署时通过 wrangler.toml 绑定，请确认 Dashboard 中已创建存储桶' });
  }

  if (storageType === 's3') {
    const endpoint = String(body['s3_endpoint'] || '');
    const region = String(body['s3_region'] || '');
    const bucket = String(body['s3_bucket'] || '');
    const ak = String(body['s3_ak'] || '');
    const sk = String(body['s3_sk'] || '');
    if (!endpoint || !bucket || !ak || !sk) {
      return jsonError(c, '请填写完整的 S3 配置');
    }
    try {
      const { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        endpoint,
        region: region || 'auto',
        credentials: { accessKeyId: ak, secretAccessKey: sk },
        forcePathStyle: true,
      });

      // 测试连接
      await client.send(new HeadBucketCommand({ Bucket: bucket }));

      // 测试读写
      const testKey = 'test-' + Date.now() + '.txt';
      const testContent = '彩虹外链网盘存储测试文件';

      // 写入测试
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: testKey,
        Body: testContent,
        ContentType: 'text/plain; charset=utf-8',
      }));

      // 读取测试
      const getRes = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: testKey,
      }));
      const readContent = await getRes.Body?.transformToString();

      if (readContent !== testContent) {
        throw new Error('读取内容与写入内容不一致');
      }

      // 删除测试文件
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: testKey,
      }));

      return jsonResult(c, { ok: true, message: 'S3 连接成功！读写测试通过' });
    } catch (e: any) {
      return jsonError(c, 'S3 测试失败: ' + (e.message || e));
    }
  }

  if (storageType === 'github') {
    const owner = String(body['gh_owner'] || '').trim();
    const repo = String(body['gh_repo'] || '').trim();
    const token = String(body['gh_token'] || '').trim();
    const ref = String(body['gh_ref'] || '').trim();
    const apiBase = String(body['gh_api_base'] || 'https://api.github.com').trim();
    const folder = String(body['gh_folder'] || '').trim();
    
    if (!owner || !repo || !token) {
      return jsonError(c, '请填写 owner/repo/token');
    }
    
    try {
      // 直接使用 GitHubApiStorage 类进行测试，确保与实际使用完全一致
      const { GitHubApiStorage } = await import('../storage/GitHubApiStorage');
      const storage = new GitHubApiStorage({
        owner,
        repo,
        token,
        ref: ref || undefined,
        defaultFolder: folder || undefined,
        apiBase: apiBase || undefined,
      });
      
      // 调用 initialize 方法测试连接
      await storage.initialize();
      
      // 测试读写
      const testHash = 'test' + Date.now();
      const testContent = '彩虹外链网盘存储测试文件';
      
      // 写入测试
      const encoder = new TextEncoder();
      const testData = encoder.encode(testContent);
      const uploadSuccess = await storage.upload(testHash, testData.buffer as ArrayBuffer, 'text/plain');
      
      if (!uploadSuccess) {
        throw new Error('写入测试失败');
      }
      
      // 读取测试
      const downloadRes = await storage.downfile(testHash);
      if (!downloadRes) {
        throw new Error('读取测试失败：无法下载文件');
      }
      
      const downloadedText = await downloadRes.text();
      if (downloadedText !== testContent) {
        throw new Error('读取内容与写入内容不一致');
      }
      
      // 删除测试文件
      await storage.delete(testHash);
      
      return jsonResult(c, { 
        ok: true, 
        message: `GitHub 连接成功！读写测试通过。仓库: ${owner}/${repo}${ref ? `, 分支: ${ref}` : ''}` 
      });
    } catch (e: any) {
      let errorMsg = 'GitHub 测试失败';
      if (e.message) {
        if (e.message.includes('404')) {
          errorMsg = '仓库不存在或 Token 没有访问权限。请检查：1) 仓库名称是否正确 2) Token 是否有 repo 权限 3) 如果是私有仓库，Token 必须有访问权限';
        } else if (e.message.includes('401')) {
          errorMsg = 'Token 无效或已过期';
        } else if (e.message.includes('403')) {
          errorMsg = '访问被拒绝或 API 限制';
        } else {
          errorMsg = e.message;
        }
      }
      return jsonError(c, errorMsg);
    }
  }

  if (storageType === 'webdav') {
    const endpoint = String(body['webdav_endpoint'] || '').trim();
    const username = String(body['webdav_user'] || '').trim();
    const password = String(body['webdav_pass'] || '');
    if (!endpoint || !username || !password) {
      return jsonError(c, '请填写 endpoint/user/pass');
    }
    try {
      // 规范化 URL
      let ep = endpoint;
      if (!ep.endsWith('/')) ep += '/';
      const url = new URL(ep);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return jsonError(c, 'WebDAV 地址必须以 http:// 或 https:// 开头');
      }
      const auth = 'Basic ' + btoa(`${username}:${password}`);

      // 测试连接
      const res = await fetch(ep, {
        method: 'PROPFIND',
        headers: {
          'Authorization': auth,
          'Depth': '0',
          'User-Agent': 'pan-worker-webdav',
        },
      });
      if (!(res.ok || res.status === 207)) {
        const t = await res.text();
        return jsonError(c, `WebDAV 服务器返回 ${res.status}: ${t.substring(0, 200)}`);
      }

      // 测试读写
      const testFile = 'test-' + Date.now() + '.txt';
      const testContent = '彩虹外链网盘存储测试文件';
      const testUrl = ep + testFile;

      // 写入测试
      const putRes = await fetch(testUrl, {
        method: 'PUT',
        headers: {
          'Authorization': auth,
          'Content-Type': 'text/plain; charset=utf-8',
          'User-Agent': 'pan-worker-webdav',
        },
        body: testContent,
      });

      if (!putRes.ok && putRes.status !== 201 && putRes.status !== 204) {
        throw new Error(`写入测试失败: HTTP ${putRes.status}`);
      }

      // 读取测试
      const getRes = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'Authorization': auth,
          'User-Agent': 'pan-worker-webdav',
        },
      });

      if (getRes.ok) {
        const readContent = await getRes.text();
        if (readContent !== testContent) {
          throw new Error('读取内容与写入内容不一致');
        }
      }

      // 删除测试文件
      await fetch(testUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': auth,
          'User-Agent': 'pan-worker-webdav',
        },
      });

      return jsonResult(c, { ok: true, message: 'WebDAV 连接成功！读写测试通过' });
    } catch (e: any) {
      return jsonError(c, 'WebDAV 测试失败: ' + (e.message || e));
    }
  }

  return jsonError(c, '未知的存储类型');
});

export default install;
