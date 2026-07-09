// 彩虹外链网盘 - 安装/恢复向导路由
// 首次部署/存储未配置时自动跳转到此页
// 整合：全新安装 + 从原 PHP 备份恢复（不再有 /admin/restore）

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB } from '../middleware';
import { createStorage } from '../storage/factory';
import { updateConfig, clearConfigCache, loadConfig } from '../config';
import { jsonResult, jsonError } from '../utils/response';
import { extractFromSql, filterPreConfigForApply } from '../services/restorePreExtract';
import {
  createInstallSession,
  getInstallSession,
  updateInstallSession,
  sessionSetCookieHeader,
  readSessionId,
} from '../services/restoreSession';
import {
  createRestoreTask,
  getRestoreStatus,
  cancelRestore,
  restoreDatabaseFromSql,
  restoreFilesFromSource,
} from '../services/restore';

const install = new Hono<AppEnv>();

/* ---------------------------------------------------------------------- *
 * 页面：单页多步骤安装向导
 * step 状态由前端 JS 控制，步骤：
 *   0 - 选择（全新安装 / 从备份恢复）
 *   1F- 全新安装：填管理员 + 选存储
 *   1R- 从备份恢复：上传 SQL
 *   2R- 从备份恢复：勾选配置 + 选存储
 *   3R- 从备份恢复：输入原站点地址（仅当有 pre_file 时）并显示进度
 *   4 - 完成
 * ---------------------------------------------------------------------- */
function wizardPage(errorMsg: string = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="renderer" content="webkit">
<meta name="viewport" content="width=device-width,height=device-height,inital-scale=1.0,maximum-scale=1.0,user-scalable=no;">
<title>彩虹外链网盘 - 安装向导</title>
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
<style>
body { background: linear-gradient(135deg, #5bc0de 0%, #2e8bcc 100%); min-height: 100vh; padding: 20px 0; }
.wizard-container { max-width: 820px; margin: 0 auto; background: #fff; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.15); overflow: hidden; }
.wizard-header { background: linear-gradient(135deg, #5bc0de 0%, #2e8bcc 100%); color: #fff; padding: 24px 30px; }
.wizard-header h2 { margin: 0 0 6px 0; font-weight: 400; font-size: 22px; }
.wizard-header small { color: rgba(255,255,255,0.85); }
.wizard-body { padding: 30px; min-height: 400px; }
.wizard-footer { padding: 16px 30px; border-top: 1px solid #eee; display: flex; justify-content: space-between; }
.steps-indicator { display: flex; padding: 12px 30px; background: #f8f9fa; border-bottom: 1px solid #eee; }
.step-pill { flex: 1; text-align: center; font-size: 12px; color: #999; padding: 6px 0; position: relative; }
.step-pill .num { display: inline-block; width: 22px; height: 22px; line-height: 22px; border-radius: 50%; background: #ddd; color: #fff; margin-right: 6px; }
.step-pill.active { color: #2e8bcc; font-weight: 600; }
.step-pill.active .num { background: #2e8bcc; }
.step-pill.done { color: #5cb85c; }
.step-pill.done .num { background: #5cb85c; }
.step { display: none; }
.step.active { display: block; animation: fadeIn 0.3s; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.choose-card { border: 2px solid #e7e7e7; border-radius: 8px; padding: 24px; cursor: pointer; transition: all 0.2s; height: 100%; text-align: center; background: #fff; }
.choose-card:hover { border-color: #2e8bcc; box-shadow: 0 4px 12px rgba(46,139,204,0.15); }
.choose-card i { font-size: 48px; color: #2e8bcc; margin-bottom: 12px; }
.choose-card h4 { margin: 8px 0; color: #333; }
.choose-card p { color: #777; font-size: 13px; margin: 0; }
.storage-tabs { display: flex; border-bottom: 2px solid #eee; margin-bottom: 20px; flex-wrap: wrap; }
.storage-tab { padding: 10px 16px; cursor: pointer; background: #f8f9fa; color: #666; border: 1px solid #e7e7e7; border-bottom: none; transition: all 0.2s; font-size: 13px; }
.storage-tab.active { background: #fff; color: #2e8bcc; font-weight: bold; border-bottom: 3px solid #2e8bcc; margin-bottom: -2px; }
.storage-form { display: none; }
.storage-form.active { display: block; }
.required { color: #e44; }
.btn-install { background: #2e8bcc; color: #fff; border: none; padding: 8px 24px; border-radius: 4px; cursor: pointer; }
.btn-install:hover { background: #2976a8; color: #fff; }
.btn-install:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: #6c757d; color: #fff; border: none; padding: 8px 24px; border-radius: 4px; cursor: pointer; }
.config-list { max-height: 360px; overflow-y: auto; border: 1px solid #eee; border-radius: 4px; }
.config-list table { margin: 0; }
.config-list td { vertical-align: middle; font-size: 13px; }
.config-list tr.selected { background: #f0f8ff; }
.progress { margin-top: 8px; }
.alert-warning { margin-top: 10px; }
</style>
</head>
<body>
<div class="wizard-container">
  <div class="wizard-header">
    <h2><i class="fa fa-magic"></i> 彩虹外链网盘 - 安装向导</h2>
    <small>单页多步骤：选择安装方式 → 配置存储 → 恢复数据（如有）</small>
  </div>

  <div class="steps-indicator" id="stepsIndicator">
    <div class="step-pill active" data-step="0"><span class="num">1</span>选择</div>
    <div class="step-pill" data-step="1"><span class="num">2</span>配置</div>
    <div class="step-pill" data-step="2"><span class="num">3</span>恢复</div>
    <div class="step-pill" data-step="3"><span class="num">4</span>完成</div>
  </div>

  <div class="wizard-body">
    ${errorMsg ? `<div class="alert alert-danger"><i class="fa fa-exclamation-triangle"></i> ${errorMsg}</div>` : ''}

    <!-- Step 0: 选择安装类型 -->
    <div class="step active" id="step-0">
      <h3 style="margin-top:0">请选择安装方式</h3>
      <p class="text-muted">首次部署选择「全新安装」；如果是迁移原 PHP 站点的数据，选择「从备份恢复」。</p>
      <div class="row" style="margin-top:24px">
        <div class="col-md-6">
          <div class="choose-card" onclick="goFreshInstall()">
            <i class="fa fa-rocket"></i>
            <h4>全新安装</h4>
            <p>从零开始配置管理员账号、站点信息和存储后端</p>
          </div>
        </div>
        <div class="col-md-6">
          <div class="choose-card" onclick="goRestore()">
            <i class="fa fa-history"></i>
            <h4>从备份恢复</h4>
            <p>导入原 PHP 项目的 SQL 备份并从原站点下载文件</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 1F: 全新安装表单 -->
    <div class="step" id="step-1f">
      <h3 style="margin-top:0">全新安装</h3>
      <form id="formFresh">
        <div class="row">
          <div class="col-md-6">
            <div class="form-group">
              <label>管理员账号 <span class="required">*</span></label>
              <input type="text" name="admin_user" class="form-control" value="admin" required>
            </div>
          </div>
          <div class="col-md-6">
            <div class="form-group">
              <label>管理员密码 <span class="required">*</span></label>
              <input type="password" name="admin_pwd" class="form-control" placeholder="请设置一个强密码" required>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>站点名称</label>
          <input type="text" name="title" class="form-control" value="彩虹外链网盘">
        </div>
        <h4 style="margin-top:24px"><i class="fa fa-database"></i> 存储后端</h4>
        <div class="storage-tabs" id="freshStorageTabs">
          <button type="button" class="storage-tab active" data-target="fresh-form-r2">R2</button>
          <button type="button" class="storage-tab" data-target="fresh-form-s3">S3</button>
          <button type="button" class="storage-tab" data-target="fresh-form-github">GitHub</button>
          <button type="button" class="storage-tab" data-target="fresh-form-webdav">WebDAV</button>
          <button type="button" class="storage-tab" data-target="fresh-form-upyun">又拍云</button>
          <button type="button" class="storage-tab" data-target="fresh-form-qiniu">七牛云</button>
        </div>
        ${renderStorageForms('fresh-')}
        <input type="hidden" name="storage_type" id="fresh_storage_type" value="r2">
        <div id="freshTestResult" style="display:none; margin-top:12px"></div>
      </form>
    </div>

    <!-- Step 1R: 上传 SQL -->
    <div class="step" id="step-1r">
      <h3 style="margin-top:0">从备份恢复 - 上传 SQL</h3>
      <p class="text-muted">上传原 PHP 项目导出的 <code>.sql</code> 文件。系统会先"预提取" <code>pre_config</code> 表供您选择，不会立刻写入 D1。</p>
      <form id="formSqlUpload">
        <div class="form-group">
          <label>SQL 备份文件 <span class="required">*</span></label>
          <input type="file" name="sql_file" accept=".sql" class="form-control" required>
          <span class="help-block">支持 mysqldump 导出的 .sql（自动跳过 SET/CREATE TABLE 等 D1 不支持的语句）</span>
        </div>
        <button type="button" class="btn-install" onclick="uploadSql()">
          <i class="fa fa-upload"></i> 上传并预提取
        </button>
        <div id="sqlUploadResult" style="display:none; margin-top:12px"></div>
      </form>
    </div>

    <!-- Step 2R: 勾选配置 + 选存储 -->
    <div class="step" id="step-2r">
      <h3 style="margin-top:0">从备份恢复 - 勾选配置 + 选择存储</h3>
      <div id="configWarnings"></div>
      <h4 style="margin-top:18px"><i class="fa fa-list"></i> SQL 中提取到的 <code>pre_config</code> 项</h4>
      <p class="text-muted" style="font-size:13px">
        默认全部勾选。点击行可切换；<code>storage</code> 永远不导入，必须在下方重新选择。
        检测到 <code>storage=local</code> 时会给出警告。
      </p>
      <div id="configList" class="config-list"></div>
      <div id="fileCountHint" class="text-muted" style="margin-top:8px"></div>

      <h4 style="margin-top:24px"><i class="fa fa-database"></i> 选择新的存储后端</h4>
      <div class="storage-tabs" id="restoreStorageTabs">
        <button type="button" class="storage-tab active" data-target="restore-form-r2">R2</button>
        <button type="button" class="storage-tab" data-target="restore-form-s3">S3</button>
        <button type="button" class="storage-tab" data-target="restore-form-github">GitHub</button>
        <button type="button" class="storage-tab" data-target="restore-form-webdav">WebDAV</button>
        <button type="button" class="storage-tab" data-target="restore-form-upyun">又拍云</button>
        <button type="button" class="storage-tab" data-target="restore-form-qiniu">七牛云</button>
      </div>
      ${renderStorageForms('restore-')}
      <input type="hidden" name="storage_type" id="restore_storage_type" value="r2">
      <div id="restoreTestResult" style="display:none; margin-top:12px"></div>
    </div>

    <!-- Step 3R: 输入原站点 + 文件下载进度 -->
    <div class="step" id="step-3r">
      <h3 style="margin-top:0">从备份恢复 - 输入原站点地址</h3>
      <p class="text-muted">系统会从 <code>{原站点}/file/{hash}</code> 批量下载所有文件到刚配置的存储后端。</p>
      <form id="formSource" onsubmit="event.preventDefault(); startFileDownload();">
        <div class="form-group">
          <label>原站点 URL <span class="required">*</span></label>
          <input type="text" name="source_url" class="form-control" placeholder="http://dl.example.com/" required>
          <span class="help-block">必须以 <code>http://</code> 或 <code>https://</code> 开头，末尾 <code>/</code> 可选</span>
        </div>
        <button type="submit" class="btn-install"><i class="fa fa-download"></i> 开始下载文件</button>
      </form>
      <div id="downloadProgress" style="display:none; margin-top:20px">
        <h4>下载进度</h4>
        <div>总文件 / 已下载: <span id="dpTotal">0 / 0</span></div>
        <div class="progress"><div id="dpBarTotal" class="progress-bar progress-bar-info" style="width:0%">0%</div></div>
        <div style="margin-top:8px">当前文件: <span id="dpCurrent">-</span></div>
        <div class="progress"><div id="dpBarCurrent" class="progress-bar progress-bar-success" style="width:0%">0%</div></div>
        <div>成功 / 失败: <span id="dpResult">0 / 0</span></div>
        <div id="dpStatus" class="text-muted" style="margin-top:6px"></div>
      </div>
    </div>

    <!-- Step 4: 完成 -->
    <div class="step" id="step-4">
      <div style="text-align:center; padding: 40px 0;">
        <div style="font-size:64px; color:#5cb85c;"><i class="fa fa-check-circle"></i></div>
        <h2 style="margin-top:12px">安装完成！</h2>
        <p id="doneSummary" class="text-muted"></p>
        <a href="/admin" class="btn-install" style="display:inline-block; text-decoration:none; margin-top:20px;">
          <i class="fa fa-sign-in"></i> 进入管理后台
        </a>
      </div>
    </div>
  </div>

  <div class="wizard-footer">
    <button type="button" class="btn btn-default" id="btnPrev" onclick="prevStep()" style="display:none">
      <i class="fa fa-arrow-left"></i> 上一步
    </button>
    <div></div>
    <button type="button" class="btn-install" id="btnNext" onclick="nextStep()" style="display:none">
      下一步 <i class="fa fa-arrow-right"></i>
    </button>
  </div>
</div>

<script>
/* ==================== 状态 ==================== */
const state = {
  mode: '',             // 'fresh' | 'restore'
  step: 0,
  sessionId: '',        // 恢复流程的会话
  selectedConfig: {},   // 勾选的 pre_config
  preExtract: null,
  fileTaskId: '',
  filePollTimer: null,
};

/* ==================== 步骤导航 ==================== */
function showStep(n) {
  state.step = n;
  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  // 根据安装模式选择步骤 ID
  const ids = state.mode === 'restore'
    ? ['step-0', 'step-1r', 'step-2r', 'step-3r', '', 'step-4']
    : ['step-0', 'step-1f', '', '', '', 'step-4'];
  const el = document.getElementById(ids[n]);
  if (el) el.classList.add('active');

  // 步骤指示器（restore: 0→1→1→2→3, fresh: 0→1→3）
  const map = state.mode === 'restore'
    ? { 0: 0, 1: 1, 2: 1, 3: 2, 5: 3 }
    : { 0: 0, 1: 1, 5: 3 };
  document.querySelectorAll('.step-pill').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i < map[n]) el.classList.add('done');
    else if (i === map[n]) el.classList.add('active');
  });

  // 按钮
  const prev = document.getElementById('btnPrev');
  const next = document.getElementById('btnNext');
  prev.style.display = n === 0 || n === 5 ? 'none' : '';
  if (n === 5) { next.style.display = 'none'; return; }
  if (n === 0) { next.style.display = 'none'; return; }
  next.style.display = '';
  if (n === 1 && state.mode === 'fresh') {
    next.innerHTML = '<i class="fa fa-check"></i> 完成安装';
  } else if (n === 3) {
    next.innerHTML = '<i class="fa fa-check"></i> 应用配置并完成';
  } else {
    next.innerHTML = '下一步 <i class="fa fa-arrow-right"></i>';
  }
}

function prevStep() {
  if (state.mode === 'fresh' && state.step === 1) showStep(0);
  else if (state.mode === 'restore' && state.step === 1) showStep(0);
  else if (state.mode === 'restore' && state.step === 2) showStep(1);
  else if (state.mode === 'restore' && state.step === 3) showStep(2);
  else if (state.step > 0) showStep(state.step - 1);
}

async function nextStep() {
  if (state.step === 1 && state.mode === 'fresh') {
    // 直接保存
    await submitFresh();
    return;
  }
  if (state.step === 3 && state.mode === 'restore') {
    // 应用配置并完成
    await applyConfigAndComplete();
    return;
  }
  showStep(state.step + 1);
}

/* ==================== 全新安装 ==================== */
function goFreshInstall() {
  state.mode = 'fresh';
  showStep(1);
}

async function submitFresh() {
  const form = document.getElementById('formFresh');
  const fd = new FormData(form);
  const testRes = document.getElementById('freshTestResult');
  testRes.style.display = 'block';
  testRes.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 正在保存配置...';
  try {
    const res = await fetch('/install/save', { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '保存失败');
    testRes.className = 'alert alert-success';
    testRes.innerHTML = '<i class="fa fa-check"></i> 配置已保存，正在跳转到完成页...';
    setTimeout(() => {
      document.getElementById('doneSummary').innerText = '管理员账号: ' + fd.get('admin_user') + '，存储: ' + fd.get('storage_type');
      showStep(5);
    }, 800);
  } catch (e) {
    testRes.className = 'alert alert-danger';
    testRes.innerHTML = '<i class="fa fa-exclamation-triangle"></i> ' + e.message;
  }
}

/* ==================== 恢复流程 ==================== */
function goRestore() {
  state.mode = 'restore';
  showStep(1);
}

async function uploadSql() {
  const form = document.getElementById('formSqlUpload');
  const fd = new FormData(form);
  const result = document.getElementById('sqlUploadResult');
  result.style.display = 'block';
  result.className = 'alert alert-info';
  result.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 上传并预提取中...';
  try {
    const res = await fetch('/install/api/sql-preview', { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '上传失败');
    state.sessionId = json.data.sessionId;
    state.preExtract = json.data.preExtract;
    state.selectedConfig = {};
    for (const k of Object.keys(state.preExtract.preConfig || {})) {
      if (k === 'storage') continue;
      state.selectedConfig[k] = state.preExtract.preConfig[k];
    }
    result.className = 'alert alert-success';
    result.innerHTML = '<i class="fa fa-check"></i> 预提取完成，提取到 ' + Object.keys(state.preExtract.preConfig).length + ' 条配置，' + state.preExtract.fileCount + ' 个文件';
    // 渲染 step 2r
    renderConfigList();
    renderWarnings();
    document.getElementById('fileCountHint').innerText = 'SQL 中检测到约 ' + state.preExtract.fileCount + ' 个文件记录';
    showStep(2);
  } catch (e) {
    result.className = 'alert alert-danger';
    result.innerHTML = '<i class="fa fa-exclamation-triangle"></i> ' + e.message;
  }
}

function renderWarnings() {
  const box = document.getElementById('configWarnings');
  if (!state.preExtract.warnings || state.preExtract.warnings.length === 0) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = state.preExtract.warnings.map(w =>
    '<div class="alert alert-warning" style="padding:8px 12px; margin:4px 0; font-size:13px"><i class="fa fa-exclamation-triangle"></i> ' + w + '</div>'
  ).join('');
}

function renderConfigList() {
  const box = document.getElementById('configList');
  const cfg = state.preExtract.preConfig || {};
  const keys = Object.keys(cfg).sort();
  if (keys.length === 0) {
    box.innerHTML = '<div style="padding:20px; text-align:center; color:#999">SQL 中未检测到 pre_config 数据</div>';
    return;
  }
  let html = '<table class="table table-condensed table-hover"><thead><tr><th style="width:40px">使用</th><th>键</th><th>值</th></tr></thead><tbody>';
  for (const k of keys) {
    const checked = k === 'storage' ? '' : 'checked';
    const v = (cfg[k] || '').toString();
    const display = v.length > 60 ? v.substring(0, 60) + '...' : v;
    const skip = k === 'storage' ? '<span class="text-muted" style="font-size:12px">（不导入）</span>' : '';
    html += '<tr class="' + (checked ? 'selected' : '') + '">' +
      '<td><input type="checkbox" data-key="' + k + '" ' + checked + (k === 'storage' ? ' disabled' : '') + ' onchange="toggleConfig(this)"></td>' +
      '<td><code>' + escapeHtml(k) + '</code></td>' +
      '<td><span title="' + escapeHtml(v) + '">' + escapeHtml(display) + '</span> ' + skip + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  box.innerHTML = html;
}

function toggleConfig(cb) {
  const k = cb.dataset.key;
  const tr = cb.closest('tr');
  if (cb.checked) {
    state.selectedConfig[k] = state.preExtract.preConfig[k];
    tr.classList.add('selected');
  } else {
    delete state.selectedConfig[k];
    tr.classList.remove('selected');
  }
}

async function setStorage(prefix) {
  const form = document.getElementById('step-' + (prefix === 'fresh-' ? '1f' : '2r'));
  const fd = new FormData();
  fd.set('storage_type', storageTypeEl(prefix).value);
  document.querySelectorAll('#step-' + (prefix === 'fresh-' ? '1f' : '2r') + ' input[name^="' + prefix.slice(0, -1) + '_"]').forEach(inp => {
    if (inp.name) fd.set(inp.name.replace(prefix, ''), inp.value);
  });
  return fd;
}

async function applyConfigAndComplete() {
  const cfg = state.selectedConfig;
  const fd = await setStorage('restore-');
  fd.set('sessionId', state.sessionId);
  fd.set('config_json', JSON.stringify(cfg));
  const result = document.getElementById('restoreTestResult');
  result.style.display = 'block';
  result.className = 'alert alert-info';
  result.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 正在应用配置、写入 D1...';
  try {
    const res = await fetch('/install/api/config-apply', { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '应用失败');
    result.className = 'alert alert-success';
    result.innerHTML = '<i class="fa fa-check"></i> 配置已应用';
    // 是否需要下载文件？
    if (state.preExtract.fileCount > 0) {
      // 跳到 step 3r 输入原站点
      showStep(3);
    } else {
      // 没有文件，直接完成
      const sum = document.getElementById('doneSummary');
      sum.innerText = '存储: ' + document.getElementById('restore_storage_type').value + '，已应用 ' + Object.keys(cfg).length + ' 条配置';
      showStep(5);
    }
  } catch (e) {
    result.className = 'alert alert-danger';
    result.innerHTML = '<i class="fa fa-exclamation-triangle"></i> ' + e.message;
  }
}

async function startFileDownload() {
  const form = document.getElementById('formSource');
  const fd = new FormData(form);
  fd.set('sessionId', state.sessionId);
  const prog = document.getElementById('downloadProgress');
  prog.style.display = 'block';
  document.getElementById('dpStatus').innerText = '正在启动...';
  try {
    const res = await fetch('/install/api/files-from-source', { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '启动失败');
    state.fileTaskId = json.data.taskId;
    pollFileStatus();
  } catch (e) {
    document.getElementById('dpStatus').innerText = '启动失败: ' + e.message;
    document.getElementById('dpStatus').className = 'text-danger';
  }
}

function pollFileStatus() {
  if (state.filePollTimer) clearInterval(state.filePollTimer);
  state.filePollTimer = setInterval(async () => {
    try {
      const res = await fetch('/install/api/status?taskId=' + state.fileTaskId, { credentials: 'same-origin' });
      const json = await res.json();
      if (json.code !== 0) {
        document.getElementById('dpStatus').innerText = '查询失败: ' + json.msg;
        clearInterval(state.filePollTimer);
        return;
      }
      const s = json.data;
      document.getElementById('dpTotal').innerText = s.processed + ' / ' + s.total;
      document.getElementById('dpResult').innerText = s.success + ' / ' + s.failed;
      const pct = s.total > 0 ? Math.floor(s.processed * 100 / s.total) : 0;
      document.getElementById('dpBarTotal').style.width = pct + '%';
      document.getElementById('dpBarTotal').innerText = pct + '%';
      if (s.currentFileName) {
        document.getElementById('dpCurrent').innerText = s.currentFileName;
        const cpct = s.currentFileTotal > 0 ? Math.floor(s.currentFileReceived * 100 / s.currentFileTotal) : 0;
        document.getElementById('dpBarCurrent').style.width = cpct + '%';
        document.getElementById('dpBarCurrent').innerText = cpct + '%';
      }
      if (s.status === 'completed') {
        clearInterval(state.filePollTimer);
        document.getElementById('dpStatus').innerText = '下载完成 ✅';
        const sum = document.getElementById('doneSummary');
        sum.innerText = '文件下载完成: 成功 ' + s.success + '，失败 ' + s.failed;
        setTimeout(() => showStep(5), 1200);
      } else if (s.status === 'failed') {
        clearInterval(state.filePollTimer);
        document.getElementById('dpStatus').innerText = '下载失败: ' + (s.errors && s.errors[0] || '未知错误');
      } else {
        document.getElementById('dpStatus').innerText = s.message || ('正在下载 ' + s.processed + '/' + s.total);
      }
    } catch (e) {
      console.error(e);
    }
  }, 1000);
}

/* 根据 prefix 获取 hidden storage_type 元素（HTML id 用下划线） */
function storageTypeEl(prefix) {
  return document.getElementById(prefix.replace(/-$/, '') + '_storage_type');
}

/* ==================== 存储测试 ==================== */
async function testStorage(prefix) {
  const div = document.getElementById(prefix + 'testResult');
  if (!div) return;
  div.className = 'alert alert-info';
  div.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 测试中...';
  const fd = new FormData();
  fd.set('storage_type', storageTypeEl(prefix).value);
  document.querySelectorAll('#step-' + (prefix === 'fresh-' ? '1f' : '2r') + ' input[name^="' + prefix.slice(0, -1) + '_"]').forEach(inp => {
    if (inp.name) fd.set(inp.name.replace(prefix, ''), inp.value);
  });
  // 上传一个真实测试文件（后端写存储后读取验证并删除）
  const testContent = 'install-test-' + Date.now();
  fd.set('test_file', new Blob([testContent], { type: 'text/plain' }), '_install_test_' + Date.now() + '.txt');
  try {
    const res = await fetch('/install/test', { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json();
    if (json.code === 0 && json.data && json.data.ok) {
      div.className = 'alert alert-success';
      div.innerHTML = '<i class="fa fa-check"></i> ' + (json.data.message || '测试通过');
    } else {
      div.className = 'alert alert-danger';
      div.innerHTML = '<i class="fa fa-exclamation-triangle"></i> ' + (json.msg || json.data?.message || '测试失败');
    }
  } catch (e) {
    div.className = 'alert alert-danger';
    div.innerHTML = '<i class="fa fa-exclamation-triangle"></i> ' + e.message;
  }
}

/* ==================== 存储 Tab 切换 ==================== */
function bindStorageTabs(prefix) {
  const tabs = document.querySelectorAll('#' + (prefix === 'fresh-' ? 'fresh' : 'restore') + 'StorageTabs .storage-tab');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const target = t.dataset.target;
      const root = document.getElementById(target.split('-')[0] === 'fresh' ? 'step-1f' : 'step-2r');
      root.querySelectorAll('.storage-form').forEach(f => f.classList.remove('active'));
      document.getElementById(target).classList.add('active');
      const hidden = storageTypeEl(prefix);
      hidden.value = target.replace(prefix + 'form-', '');
    });
  });
}
bindStorageTabs('fresh-');
bindStorageTabs('restore-');

/* ==================== 工具 ==================== */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
</script>
</body>
</html>`;
}

/* ---------------------------------------------------------------------- *
 * 6 个存储表单（共用代码：fresh- 前缀和 restore- 前缀同时渲染）
 * ---------------------------------------------------------------------- */
function renderStorageForms(prefix: string): string {
  return `
    <div class="storage-form active" id="${prefix}form-r2">
      <div class="alert alert-info">R2 存储桶需在 Cloudflare Dashboard 中手动创建，wrangler.toml 中已绑定 <code>FILE_R2</code>。</div>
      <button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button>
      <div id="${prefix}testResult" class="text-muted" style="margin-top:8px"></div>
    </div>
    <div class="storage-form" id="${prefix}form-s3">
      <div class="form-group"><label>Endpoint <span class="required">*</span></label>
        <input type="text" name="${prefix}s3_endpoint" class="form-control" placeholder="https://s3.amazonaws.com"></div>
      <div class="form-group"><label>Region <span class="required">*</span></label>
        <input type="text" name="${prefix}s3_region" class="form-control" placeholder="us-east-1"></div>
      <div class="form-group"><label>Bucket <span class="required">*</span></label>
        <input type="text" name="${prefix}s3_bucket" class="form-control"></div>
      <div class="form-group"><label>AccessKey ID <span class="required">*</span></label>
        <input type="text" name="${prefix}s3_ak" class="form-control"></div>
      <div class="form-group"><label>SecretAccessKey <span class="required">*</span></label>
        <input type="password" name="${prefix}s3_sk" class="form-control"></div>
      <button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button>
      <div id="${prefix}testResult" class="text-muted" style="margin-top:8px"></div>
    </div>
    <div class="storage-form" id="${prefix}form-github">
      <div class="alert alert-info">需要 Token 具备 <code>repo</code> 权限。</div>
      <div class="form-group"><label>仓库 Owner <span class="required">*</span></label>
        <input type="text" name="${prefix}gh_owner" class="form-control" placeholder="octocat"></div>
      <div class="form-group"><label>仓库名 <span class="required">*</span></label>
        <input type="text" name="${prefix}gh_repo" class="form-control"></div>
      <div class="form-group"><label>Personal Access Token <span class="required">*</span></label>
        <input type="password" name="${prefix}gh_token" class="form-control" placeholder="ghp_xxx"></div>
      <div class="form-group"><label>分支（留空用默认）</label>
        <input type="text" name="${prefix}gh_ref" class="form-control" placeholder="main"></div>
      <div class="form-group"><label>API Base</label>
        <input type="text" name="${prefix}gh_api_base" class="form-control" value="https://api.github.com"></div>
      <button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button>
      <div id="${prefix}testResult" class="text-muted" style="margin-top:8px"></div>
    </div>
    <div class="storage-form" id="${prefix}form-webdav">
      <div class="form-group"><label>WebDAV 服务地址 <span class="required">*</span></label>
        <input type="text" name="${prefix}webdav_endpoint" class="form-control" placeholder="https://dav.example.com/remote.php/webdav/"></div>
      <div class="form-group"><label>用户名 <span class="required">*</span></label>
        <input type="text" name="${prefix}webdav_user" class="form-control"></div>
      <div class="form-group"><label>密码 <span class="required">*</span></label>
        <input type="password" name="${prefix}webdav_pass" class="form-control"></div>
      <div class="form-group"><label>存储子目录</label>
        <input type="text" name="${prefix}webdav_folder" class="form-control" value="file"></div>
      <button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button>
      <div id="${prefix}testResult" class="text-muted" style="margin-top:8px"></div>
    </div>
    <div class="storage-form" id="${prefix}form-upyun">
      <div class="form-group"><label>服务名 (Bucket) <span class="required">*</span></label>
        <input type="text" name="${prefix}upyun_bucket" class="form-control"></div>
      <div class="form-group"><label>操作员 <span class="required">*</span></label>
        <input type="text" name="${prefix}upyun_operator" class="form-control"></div>
      <div class="form-group"><label>操作员密码 <span class="required">*</span></label>
        <input type="password" name="${prefix}upyun_password" class="form-control"></div>
      <div class="form-group"><label>API 端点</label>
        <input type="text" name="${prefix}upyun_endpoint" class="form-control" value="https://v0.api.upyun.com"></div>
      <div class="form-group"><label>加速域名</label>
        <input type="text" name="${prefix}upyun_domain" class="form-control" placeholder="https://xxx.b0.upaiyun.com"></div>
      <div class="form-group"><label>存储子目录</label>
        <input type="text" name="${prefix}upyun_folder" class="form-control" value="file"></div>
      <button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button>
      <div id="${prefix}testResult" class="text-muted" style="margin-top:8px"></div>
    </div>
    <div class="storage-form" id="${prefix}form-qiniu">
      <div class="form-group"><label>AccessKey (AK) <span class="required">*</span></label>
        <input type="text" name="${prefix}qiniu_ak" class="form-control"></div>
      <div class="form-group"><label>SecretKey (SK) <span class="required">*</span></label>
        <input type="password" name="${prefix}qiniu_sk" class="form-control"></div>
      <div class="form-group"><label>Bucket <span class="required">*</span></label>
        <input type="text" name="${prefix}qiniu_bucket" class="form-control"></div>
      <div class="form-group"><label>空间绑定域名</label>
        <input type="text" name="${prefix}qiniu_domain" class="form-control" placeholder="https://cdn.example.com"></div>
      <div class="form-group"><label>存储子目录</label>
        <input type="text" name="${prefix}qiniu_folder" class="form-control" value="file"></div>
      <button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button>
      <div id="${prefix}testResult" class="text-muted" style="margin-top:8px"></div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- *
 * 路由
 * ---------------------------------------------------------------------- */

/** GET /install - 安装向导首页 */
install.get('/', async (c) => {
  return c.html(wizardPage());
});

/** GET /install (兼容无尾斜杠) */
install.get('', async (c) => {
  return c.html(wizardPage());
});

/** POST /install/save - 兼容旧的"全新安装"一站式保存 */
install.post('/save', async (c) => {
  try {
    const body = await c.req.parseBody() as Record<string, string>;
    const storageType = String(body['storage_type'] || '');
    const adminUser = String(body['admin_user'] || 'admin');
    const adminPwd = String(body['admin_pwd'] || '');
    const title = String(body['title'] || '彩虹外链网盘');

    if (!adminPwd) return jsonError(c, '管理员密码不能为空');
    if (!storageType) return jsonError(c, '请选择存储类型');

    const db = getDB(c);

    // 写入所有字段
    await updateConfig(db, 'admin_user', adminUser);
    await updateConfig(db, 'admin_pwd', adminPwd);
    await updateConfig(db, 'title', title);
    await updateConfig(db, 'storage', storageType);

    // 存储相关字段
    const storageFields: Record<string, string> = {
      s3_endpoint: 's3_endpoint', s3_region: 's3_region', s3_bucket: 's3_bucket', s3_ak: 's3_ak', s3_sk: 's3_sk',
      gh_owner: 'gh_owner', gh_repo: 'gh_repo', gh_token: 'gh_token', gh_ref: 'gh_ref', gh_api_base: 'gh_api_base',
      webdav_endpoint: 'webdav_endpoint', webdav_user: 'webdav_user', webdav_pass: 'webdav_pass', webdav_folder: 'webdav_folder',
      upyun_bucket: 'upyun_bucket', upyun_operator: 'upyun_operator', upyun_password: 'upyun_password',
      upyun_endpoint: 'upyun_endpoint', upyun_domain: 'upyun_domain', upyun_folder: 'upyun_folder',
      qiniu_ak: 'qiniu_ak', qiniu_sk: 'qiniu_sk', qiniu_bucket: 'qiniu_bucket', qiniu_domain: 'qiniu_domain', qiniu_folder: 'qiniu_folder',
      uploadfile_type: 'uploadfile_type', downfile_type: 'downfile_type', downfile_protocol: 'downfile_protocol', downfile_domain: 'downfile_domain',
    };
    for (const [formKey, cfgKey] of Object.entries(storageFields)) {
      const v = body[formKey];
      if (v !== undefined && v !== '') {
        await updateConfig(db, cfgKey, String(v));
      }
    }
    await updateConfig(db, 'installed', '1');

    clearConfigCache();
    return jsonResult(c, { code: 0, msg: '安装成功', data: { storageType, adminUser } });
  } catch (e: any) {
    return jsonError(c, '保存配置失败: ' + (e.message || e));
  }
});

/** POST /install/test - 真实测试存储连接 + 读写（上传真实文件） */
install.post('/test', async (c) => {
  try {
    const formData = await c.req.formData();
    const storageType = String(formData.get('storage_type') || '');
    const testFile = formData.get('test_file') as File | null;
    if (!storageType) return jsonError(c, '请选择存储类型');
    if (!testFile || testFile.size === 0) return jsonError(c, '缺少测试文件');

    // 构造最小 AppConfig 传给 createStorage
    const cfg: Record<string, string> = { storage: storageType };
    for (const [k, v] of formData.entries()) {
      if (k === 'storage_type' || k === 'test_file') continue;
      cfg[k] = String(v);
    }
    const stor = createStorage(cfg as any, { FILE_R2: (c.env as any).FILE_R2 });
    if (!stor) {
      return jsonResult(c, { ok: false, message: '无法创建存储实例，请检查配置和 R2 绑定' });
    }

    const testKey = '_install_test_' + Date.now() + '.txt';
    const testBuf = await testFile.arrayBuffer();
    const expected = await testFile.text();
    try {
      const ok = await stor.upload(testKey, testBuf, testFile.type || 'text/plain');
      if (!ok) return jsonResult(c, { ok: false, message: '写入失败，请检查配置' });
      const got = await stor.get(testKey);
      if (!got) return jsonResult(c, { ok: false, message: '写入成功但读取失败' });
      const text = await new Response(got.body).text();
      await stor.delete(testKey);
      if (text !== expected) return jsonResult(c, { ok: false, message: '读取内容不一致' });
      return jsonResult(c, { ok: true, message: '读写测试通过' });
    } catch (e: any) {
      return jsonResult(c, { ok: false, message: '测试失败: ' + (e.message || e) });
    }
  } catch (e: any) {
    return jsonError(c, '测试失败: ' + (e.message || e));
  }
});

/* ---------------------------------------------------------------------- *
 * 恢复流程相关 API（迁移自 /admin/api/restore/*）
 * ---------------------------------------------------------------------- */

/** POST /install/api/sql-preview - 上传 SQL 并预提取 pre_config */
install.post('/api/sql-preview', async (c) => {
  try {
    const db = getDB(c);
    const formData = await c.req.formData();
    const sqlFile = formData.get('sql_file') as File | null;
    if (!sqlFile || sqlFile.size === 0) {
      return jsonError(c, '请选择 SQL 文件');
    }
    if (sqlFile.size > 90 * 1024 * 1024) {
      return jsonError(c, 'SQL 文件太大（' + (sqlFile.size / 1024 / 1024).toFixed(2) + 'MB），请拆分后上传（最大 90MB）');
    }
    const sqlText = await sqlFile.text();
    if (!sqlText || sqlText.trim().length === 0) {
      return jsonError(c, 'SQL 文件内容为空');
    }
    const preExtract = extractFromSql(sqlText);
    // 写入 D1（跨实例可用）
    const sess = await createInstallSession(db, { sqlText, preExtract, freshInstall: false });
    return new Response(JSON.stringify({
      code: 0,
      data: {
        sessionId: sess.id,
        preExtract,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionSetCookieHeader(sess.id),
      },
    });
  } catch (e: any) {
    console.error('sql-preview error:', e);
    return jsonError(c, '上传失败: ' + (e.message || e));
  }
});

/** POST /install/api/storage-set - 保存 storage 到 session */
install.post('/api/storage-set', async (c) => {
  try {
    const db = getDB(c);
    const formData = await c.req.formData();
    const sessionId = String(formData.get('sessionId') || '');
    const storageType = String(formData.get('storage_type') || '');
    if (!sessionId) return jsonError(c, '缺少 sessionId');
    if (!storageType) return jsonError(c, '请选择存储类型');
    const sess = await getInstallSession(db, sessionId);
    if (!sess) return jsonError(c, '会话不存在或已过期（30分钟），请重新上传 SQL');

    const fields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) {
      const key = String(k);
      if (key === 'sessionId' || key === 'storage_type') continue;
      const val = String(v);
      if (val !== '') fields[key] = val;
    }
    await updateInstallSession(db, sessionId, { storageType, storageFields: fields });
    return new Response(JSON.stringify({ code: 0, msg: '已保存' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionSetCookieHeader(sessionId),
      },
    });
  } catch (e: any) {
    console.error('storage-set error:', e);
    return jsonError(c, '保存失败: ' + (e.message || e));
  }
});

/** POST /install/api/config-apply - 应用选中的 pre_config + storage 到 D1，并写回其它 SQL 内容 */
install.post('/api/config-apply', async (c) => {
  try {
    const db = getDB(c);
    const formData = await c.req.formData();
    const sessionId = String(formData.get('sessionId') || '');
    const configJson = String(formData.get('config_json') || '{}');
    const storageType = String(formData.get('storage_type') || '');
    if (!sessionId) return jsonError(c, '缺少 sessionId');
    const sess = await getInstallSession(db, sessionId);
    if (!sess) return jsonError(c, '会话不存在或已过期（30分钟），请重新上传 SQL');
    if (!storageType) return jsonError(c, '请先选择存储类型');

    // 收集 storage 字段
    const storageFields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) {
      const key = String(k);
      if (key === 'sessionId' || key === 'config_json' || key === 'storage_type') continue;
      const val = String(v);
      if (val !== '') storageFields[key] = val;
    }

    // 解析用户勾选的 pre_config
    let selected: Record<string, string> = {};
    try {
      selected = JSON.parse(configJson);
    } catch {
      return jsonError(c, 'config_json 格式错误');
    }
    const filtered = filterPreConfigForApply(selected);

    // 1) 写存储配置
    await updateConfig(db, 'storage', storageType);
    for (const [k, v] of Object.entries(storageFields)) {
      await updateConfig(db, k, v);
    }
    // 2) 写用户勾选的 pre_config
    for (const [k, v] of Object.entries(filtered)) {
      await updateConfig(db, k, v);
    }
    // 3) 写回原 SQL 中的其它表（pre_file / pre_user 等），跳过 pre_config
    const taskId = 'inst_sql_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    createRestoreTask(taskId);
    // 同步执行（因为要返回结果）
    const result = await restoreDatabaseFromSql(db, sess.sqlText, taskId, { skipPreConfig: true });
    // 标记 installed
    await updateConfig(db, 'installed', '1');
    clearConfigCache();
    // 保留 session 以便后续 step-3 下载文件
    await updateInstallSession(db, sessionId, { storageType, storageFields, selectedConfig: filtered });

    return new Response(JSON.stringify({
      code: 0,
      msg: '配置已应用',
      data: {
        sessionId,
        appliedConfigCount: Object.keys(filtered).length,
        sqlResult: result,
        fileCount: sess.preExtract.fileCount,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionSetCookieHeader(sessionId),
      },
    });
  } catch (e: any) {
    console.error('config-apply error:', e);
    return jsonError(c, '应用失败: ' + (e.message || e));
  }
});

/** POST /install/api/files-from-source - 从原站点下载文件 */
install.post('/api/files-from-source', async (c) => {
  try {
    const db = getDB(c);
    const formData = await c.req.formData();
    const sessionId = String(formData.get('sessionId') || '');
    const sourceUrl = String(formData.get('source_url') || '').trim();
    if (!sessionId) return jsonError(c, '缺少 sessionId');
    if (!sourceUrl) return jsonError(c, '请提供原站点 URL');
    if (!sourceUrl.startsWith('http://') && !sourceUrl.startsWith('https://')) {
      return jsonError(c, '原站点 URL 必须以 http:// 或 https:// 开头');
    }
    const sess = await getInstallSession(db, sessionId);
    if (!sess) return jsonError(c, '会话不存在或已过期（30分钟），请重新上传 SQL');

    // config-apply 写入配置后，中间件里的 c.var.stor 仍是旧缓存，必须重新加载
    const freshConfig = await loadConfig(db);
    const stor = createStorage(freshConfig, { FILE_R2: (c.env as any).FILE_R2 });
    if (!stor) {
      return jsonError(c, 'Storage not configured: storage="' + freshConfig.storage + '"（配置刚写入但存储实例创建失败，请检查对应存储配置或 R2 绑定）');
    }
    const taskId = 'inst_dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    createRestoreTask(taskId);
    await updateInstallSession(db, sessionId, { sourceUrl });

    c.executionCtx.waitUntil((async () => {
      try {
        await restoreFilesFromSource(db, stor, sourceUrl, taskId, 'file');
        const t = getRestoreStatus(taskId);
        if (t) { t.status = 'completed'; t.stage = 'done'; }
      } catch (e: any) {
        console.error('[install/files-from-source] failed:', e?.message || e);
        const t = getRestoreStatus(taskId);
        if (t) { t.status = 'failed'; t.errors.push('下载失败: ' + (e.message || e)); }
      }
    })());

    return new Response(JSON.stringify({
      code: 0,
      msg: '任务已启动',
      data: { taskId },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionSetCookieHeader(sessionId),
      },
    });
  } catch (e: any) {
    console.error('files-from-source error:', e);
    return jsonError(c, '启动失败: ' + (e.message || e));
  }
});

/** GET /install/api/status?taskId=xxx - 查询任务状态 */
install.get('/api/status', async (c) => {
  const taskId = c.req.query('taskId') || '';
  if (!taskId) return jsonError(c, '缺少 taskId');
  const status = getRestoreStatus(taskId);
  if (!status) return jsonError(c, '任务不存在');
  return jsonResult(c, { code: 0, data: status });
});

/** POST /install/api/cancel - 取消任务 */
install.post('/api/cancel', async (c) => {
  try {
    const formData = await c.req.formData();
    const taskId = String(formData.get('taskId') || '');
    if (!taskId) return jsonError(c, '缺少 taskId');
    cancelRestore(taskId);
    return jsonResult(c, { code: 0, msg: '已取消' });
  } catch (e: any) {
    return jsonError(c, '取消失败: ' + (e.message || e));
  }
});

export default install;
