// 彩虹外链网盘 - 安装向导路由
// 首次部署/存储未配置时自动跳转到此页

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf } from '../middleware';
import { isStorageConfigured } from '../storage/factory';
import { updateConfig, clearConfigCache } from '../config';
import { jsonResult, jsonError } from '../utils/response';

const install = new Hono<AppEnv>();

/** 安装页面 HTML */
function installPage(errorMsg: string = '', selectedType: string = 'r2'): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>彩虹外链网盘 - 安装向导</title>
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
<style>
body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px 0; }
.install-box { max-width: 720px; margin: 30px auto; background: #fff; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); overflow: hidden; }
.install-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 30px; text-align: center; }
.install-header h1 { margin: 0; font-size: 28px; }
.install-header p { margin: 10px 0 0; opacity: 0.9; }
.install-body { padding: 30px; }
.storage-tabs { display: flex; border-bottom: 2px solid #eee; margin-bottom: 25px; }
.storage-tab { flex: 1; padding: 12px; text-align: center; cursor: pointer; background: #f8f9fa; color: #666; border: none; border-bottom: 3px solid transparent; transition: all 0.2s; }
.storage-tab.active { background: #fff; color: #667eea; border-bottom-color: #667eea; font-weight: bold; }
.storage-tab i { display: block; font-size: 24px; margin-bottom: 5px; }
.storage-form { display: none; }
.storage-form.active { display: block; }
.form-group { margin-bottom: 18px; }
.form-group label { font-weight: 600; color: #333; margin-bottom: 6px; display: block; }
.form-group .form-control { border-radius: 6px; border: 1px solid #ddd; padding: 10px 12px; }
.form-group .help-block { color: #999; font-size: 12px; margin-top: 4px; }
.alert { border-radius: 6px; padding: 12px 15px; margin-bottom: 20px; }
.alert-danger { background: #fee; color: #c33; border: 1px solid #fcc; }
.alert-info { background: #e7f3ff; color: #0c5da5; border: 1px solid #b8daff; }
.btn-install { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border: none; padding: 12px 30px; border-radius: 6px; font-size: 16px; cursor: pointer; width: 100%; }
.btn-install:hover { opacity: 0.9; color: #fff; }
.btn-install:disabled { opacity: 0.5; cursor: not-allowed; }
.required { color: #e44; }
</style>
</head>
<body>
<div class="install-box">
  <div class="install-header">
    <h1><i class="fa fa-cloud"></i> 彩虹外链网盘</h1>
    <p>Cloudflare Workers + D1 + 存储后端 一体化部署</p>
  </div>
  <div class="install-body">
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
          <div class="help-block">名称在 wrangler.toml 中固定配置</div>
        </div>
      </div>

      <!-- S3 表单 -->
      <div class="storage-form ${selectedType === 's3' ? 'active' : ''}" id="form-s3">
        <h4 style="margin-top:20px"><i class="fa fa-cloud"></i> S3 兼容存储配置</h4>
        <div class="form-group">
          <label>Endpoint (S3 API 地址) <span class="required">*</span></label>
          <input type="text" name="s3_endpoint" class="form-control" placeholder="https://s3.amazonaws.com 或 https://oss-cn-hangzhou.aliyuncs.com">
          <div class="help-block">支持 AWS S3 / 阿里云 OSS / 腾讯云 COS / MinIO 等</div>
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
          <div class="help-block">建议使用一个空的私有仓库</div>
        </div>
        <div class="form-group">
          <label>Personal Access Token <span class="required">*</span></label>
          <input type="password" name="gh_token" class="form-control" placeholder="ghp_xxxxxxxxxxxx">
          <div class="help-block">需要 <code>repo</code> 权限。Token 仅保存在 D1 中，不会上传到任何地方。</div>
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

      <input type="hidden" name="storage_type" id="storage_type" value="${selectedType}">

      <div class="form-group" style="margin-top:30px">
        <button type="submit" class="btn-install"><i class="fa fa-check"></i> 完成安装</button>
      </div>
    </form>
  </div>
</div>

<script>
document.querySelectorAll('.storage-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.storage-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.storage-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.target;
    document.getElementById(target).classList.add('active');
    document.getElementById('storage_type').value = tab.dataset.target.replace('form-', '');
  });
});
</script>
</body>
</html>`;
}

/** 安装向导首页 */
install.get('/', async (c) => {
  const config = getConf(c);
  // 已安装则跳到首页
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
  <a href="/admin/" class="btn" style="background:#364a60;margin-left:10px">管理后台</a>
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
      const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        endpoint,
        region: region || 'auto',
        credentials: { accessKeyId: ak, secretAccessKey: sk },
        forcePathStyle: true,
      });
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return jsonResult(c, { ok: true, message: 'S3 连接成功！' });
    } catch (e: any) {
      return jsonError(c, 'S3 测试失败: ' + (e.message || e));
    }
  }

  if (storageType === 'github') {
    const owner = String(body['gh_owner'] || '');
    const repo = String(body['gh_repo'] || '');
    const token = String(body['gh_token'] || '');
    const ref = String(body['gh_ref'] || '');
    const apiBase = String(body['gh_api_base'] || 'https://api.github.com');
    if (!owner || !repo || !token) {
      return jsonError(c, '请填写 owner/repo/token');
    }
    try {
      const res = await fetch(`${apiBase}/repos/${owner}/${repo}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pan-worker',
        },
      });
      if (!res.ok) {
        const t = await res.text();
        return jsonError(c, `GitHub API 错误 (${res.status}): ${t.substring(0, 200)}`);
      }
      const data = await res.json() as any;
      return jsonResult(c, {
        ok: true,
        message: `GitHub 连接成功！仓库: ${data.full_name}, 默认分支: ${data.default_branch}${ref && ref !== data.default_branch ? ' (注意：指定的 ref 与默认分支不同)' : ''}`
      });
    } catch (e: any) {
      return jsonError(c, 'GitHub 测试失败: ' + (e.message || e));
    }
  }

  return jsonError(c, '未知的存储类型');
});

export default install;
