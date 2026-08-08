// 彩虹外链网盘 - 安装/恢复向导路由
// 首次部署/存储未配置时自动跳转到此页
// 整合：全新安装 + 从原 PHP 备份恢复（不再有 /admin/restore）

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB } from '../middleware';
import { createStorage } from '../storage/factory';
import { updateConfig, clearConfigCache, loadConfig } from '../config';
import { jsonResult, jsonError, jsonResultWithCookie } from '../utils/response';
import { extractFromSql, extractPreFileRecords, filterPreConfigForApply, type SqlPreExtractResult } from '../services/restorePreExtract';
import {
  createInstallSession,
  getInstallSession,
  updateInstallSession,
  sessionSetCookieHeader,
  sessionClearCookieHeader,
  readSessionId,
} from '../services/restoreSession';
import {
  createRestoreTask,
  getRestoreStatus,
  cancelRestore,
  restoreDatabaseFromSql,
  restoreFilesFromSource,
} from '../services/restore';
import { remoteExport, remoteUploadFile } from '../services/remoteRestore';

const install = new Hono<AppEnv>();

function browserRestoreEndpoint(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  const basePath = /\/down\.php$/i.test(url.pathname)
    ? url.pathname.replace(/\/down\.php$/i, '')
    : url.pathname;
  url.pathname = basePath.replace(/\/+$/, '') + '/rec.php';
  url.search = '';
  return url.toString();
}

async function saveRemoteRestoreConfig(
  sourceUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const endpoint = browserRestoreEndpoint(sourceUrl);
    const response = await fetch(endpoint + '?action=set-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let result: any;
    try { result = JSON.parse(text); } catch { throw new Error(`原站 rec.php 返回非 JSON (${response.status})`); }
    if (!response.ok || !result.ok) {
      throw new Error((result && result.error) ? String(result.error) : `原站恢复配置保存失败 (${response.status})`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

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
html, body { height: 100%; }
body { background: #000; min-height: 100%; margin: 0; padding: 0; color: #333; font-family: Arial, "Microsoft YaHei", sans-serif; }
.wizard-container { width: 100%; min-height: 100%; margin: 0; background: #fff; border: 0; }
.wizard-header { background: #3c78a8; color: #fff; padding: 14px 20px; border-bottom: 4px solid #28577d; }
.wizard-header h2 { margin: 0 0 5px 0; font-weight: bold; font-size: 20px; }
.wizard-header small { color: #e5edf4; }
.wizard-body { padding: 20px 28px; min-height: 400px; }
.wizard-footer { padding: 10px 20px; border-top: 1px solid #ccc; background: #f7f7f7; overflow: hidden; }
.wizard-footer > * { float: left; }
.wizard-footer > div { float: right; }
.steps-indicator { padding: 0; background: #e9e9e9; border-bottom: 1px solid #bbb; overflow: hidden; }
.step-pill { float: left; width: 25%; text-align: center; font-size: 12px; color: #777; padding: 9px 0; border-right: 1px solid #ccc; }
.step-pill .num { display: inline-block; width: 20px; height: 20px; line-height: 20px; border-radius: 2px; background: #aaa; color: #fff; margin-right: 5px; }
.step-pill.active { color: #245b85; font-weight: bold; background: #fff; }
.step-pill.active .num { background: #3c78a8; }
.step-pill.done { color: #38733e; background: #f5faf5; }
.step-pill.done .num { background: #5b9661; }
.step { display: none; }
.step.active { display: block; }
.choose-card { border: 1px solid #bbb; padding: 18px; cursor: pointer; height: 100%; text-align: center; background: #fafafa; }
.choose-card:hover { border-color: #3c78a8; background: #f0f6fb; }
.choose-card i { font-size: 36px; color: #3c78a8; margin-bottom: 8px; }
.choose-card h4 { margin: 8px 0; color: #333; }
.choose-card p { color: #777; font-size: 13px; margin: 0; }
.storage-tabs { border-bottom: 1px solid #aaa; margin-bottom: 15px; overflow: hidden; }
.storage-tab { float: left; padding: 7px 13px; cursor: pointer; background: #e9e9e9; color: #555; border: 1px solid #bbb; border-bottom: none; font-size: 13px; margin-right: 3px; }
.storage-tab.active { background: #fff; color: #245b85; font-weight: bold; border-top: 2px solid #3c78a8; padding-top: 6px; }
.storage-form { display: none; }
.storage-form.active { display: block; }
.required { color: #e44; }
.btn-install { background: #3c78a8; color: #fff; border: 1px solid #28577d; padding: 6px 18px; cursor: pointer; }
.btn-install:hover { background: #28577d; color: #fff; }
.btn-install:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: #777; color: #fff; border: 1px solid #555; padding: 6px 18px; cursor: pointer; }
.config-list { max-height: 360px; overflow-y: auto; border: 1px solid #bbb; }
.config-list table { margin: 0; }
.config-list td { vertical-align: middle; font-size: 13px; }
.config-list tr.selected { background: #eef5fb; }
#restoreSourceUrlDisplay { background: #f5f5f5; color: #333; }
.progress { margin-top: 8px; }
.alert-warning { margin-top: 10px; }
.button-row { overflow: hidden; }
.button-row .btn { margin-right: 6px; }
.finish-buttons { text-align: center; margin-top: 20px; }
.finish-buttons .btn-install { margin: 0 4px; }
/* 全屏阻塞模态框 */
.suggest-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.62); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.suggest-modal-box { background: #fff; color: #333; width: 100%; max-width: 520px; border-radius: 8px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.45); }
.suggest-modal-head { background: #2e8bcc; color: #fff; padding: 16px 20px; font-size: 16px; font-weight: bold; }
.suggest-modal-body { padding: 22px 20px; font-size: 14px; color: #555; line-height: 1.7; }
.suggest-modal-body code { background: #f3f3f3; color: #c0392b; padding: 1px 5px; border-radius: 3px; }
.suggest-modal-foot { padding: 14px 20px; background: #f5f5f5; text-align: right; border-top: 1px solid #e0e0e0; }
.suggest-modal-foot .btn-install, .suggest-modal-foot .btn-secondary { margin-left: 8px; font-size: 14px; }
@media (max-width: 640px) { .wizard-body { padding: 12px; } .wizard-header { padding: 12px; } .step-pill { font-size: 11px; } .step-pill .num { display: none; } }
@media (prefers-color-scheme: dark) {
  body { background: #000; color: #ddd; }
  .wizard-container { background: #1d1d1d; color: #ddd; }
  .wizard-body { background: #1d1d1d; }
  .wizard-footer { background: #252525; border-color: #444; }
  .steps-indicator { background: #252525; border-color: #444; }
  .step-pill { color: #aaa; border-color: #444; }
  .step-pill.active { background: #1d1d1d; color: #8fc7ef; }
  .step-pill.done { background: #202a22; color: #8dcc95; }
  .choose-card { background: #252525; border-color: #555; }
  .choose-card:hover { background: #303b45; border-color: #6fa9d3; }
  .choose-card h4, h3, h4, label { color: #ddd; }
  .choose-card p, .text-muted, .help-block { color: #aaa; }
  .storage-tab { background: #303030; color: #bbb; border-color: #555; }
  .storage-tab.active { background: #1d1d1d; color: #8fc7ef; }
  .form-control { background: #292929; color: #eee; border-color: #555; }
  .form-control:focus { background: #303030; color: #fff; border-color: #6fa9d3; }
  #restoreSourceUrlDisplay { background: #292929 !important; color: #eee !important; border-color: #555; }
  .config-list { border-color: #555; }
  .config-list tr.selected { background: #263746; }
  .table { color: #ddd; }
  .table > thead > tr > th, .table > tbody > tr > td { border-color: #555; }
  code { background: #303030; color: #f0c674; }
  .alert-info { background: #203746; border-color: #37647c; color: #c6e5f5; }
  .alert-success { background: #203a28; border-color: #3d744c; color: #c9efcf; }
  .alert-warning { background: #40361d; border-color: #806b2e; color: #f2df9b; }
  .alert-danger { background: #432525; border-color: #854545; color: #f3caca; }
  .suggest-modal-box { background: #1d1d1d; color: #ddd; }
  .suggest-modal-head { background: #21597f; }
  .suggest-modal-body { color: #bbb; }
  .suggest-modal-body code { background: #303030; color: #f0c674; }
  .suggest-modal-foot { background: #252525; border-color: #444; }
}
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
    ${errorMsg ? '<div class="alert alert-danger"><i class="fa fa-exclamation-triangle"></i> ' + errorMsg + '</div>' : ''}

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
            <p>从原 PHP 站点迁移数据</p>
          </div>
        </div>
      </div>
      <p style="margin-top:12px"><small class="text-muted">项目地址: <a href="https://github.com/fanchuanhaha/cf-pan" target="_blank">https://github.com/fanchuanhaha/cf-pan</a></small></p>
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
        <h4 style="margin-top:24px"><i class="fa fa-exchange"></i> 文件传输方式</h4>
        <div class="row">
          <div class="col-md-6">
            <div class="form-group">
              <label>文件上传方式</label>
              <select name="uploadfile_type" class="form-control">
                <option value="0" selected>网站代理上传</option>
                <option value="1">存储直传</option>
              </select>
              <span class="help-block">网站代理由 Worker 接收文件后上传；存储直传需要存储后端支持直传。</span>
            </div>
          </div>
          <div class="col-md-6">
            <div class="form-group">
              <label>文件下载方式</label>
              <select name="downfile_type" class="form-control" onchange="toggleFreshDownloadMode(this.value)">
                <option value="0" selected>网站代理下载</option>
                <option value="1">存储直链下载</option>
              </select>
              <span class="help-block">网站代理支持权限和 Range；存储直链需要配置公开或签名下载地址。</span>
            </div>
          </div>
        </div>
        <div class="form-group" id="freshDownloadDomainGroup" style="display:none">
          <label>直链协议和域名</label>
          <div class="row">
            <div class="col-xs-4 col-md-3" style="padding-right:0">
              <select name="downfile_protocol" class="form-control">
                <option value="0">http://</option>
                <option value="1" selected>https://</option>
              </select>
            </div>
            <div class="col-xs-8 col-md-9" style="padding-left:0">
              <input type="text" name="downfile_domain" class="form-control" placeholder="可留空，使用存储默认域名">
            </div>
          </div>
          <span class="help-block">仅在选择“存储直链下载”时使用；留空由存储驱动生成直链。</span>
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

    <!-- Step 1R: 连接原站点导出 -->
    <div class="step" id="step-1r">
      <h3 style="margin-top:0">从备份恢复 - 连接原站点</h3>
       <p class="text-muted">输入原站点信息后，系统会通过原站点根目录的 <code>/rec.php</code> 自动导出数据库并预提取 <code>pre_config</code> 表供您选择，不会立刻写入 D1。</p>
      <div class="alert alert-warning" style="margin-top:10px">
        <i class="fa fa-exclamation-triangle"></i> 请先将 <a href="https://raw.githubusercontent.com/fanchuanhaha/cf-pan/refs/heads/master/rec.php" target="_blank">rec.php</a> 上传到原站点根目录，否则无法连接进行恢复。
      </div>
      <form id="formSqlUpload">
        <div class="form-group">
          <label>原站点地址 <span class="required">*</span></label>
          <input type="text" name="remote_source_url" class="form-control" placeholder="https://原站点.example.com" required>
          <span class="help-block">系统会自动调用原站点根目录的 <code>/rec.php</code>。</span>
        </div>
        <div class="row">
          <div class="col-md-6"><div class="form-group"><label>原站管理员账号 <span class="required">*</span></label><input type="text" name="remote_admin_user" class="form-control" required></div></div>
          <div class="col-md-6"><div class="form-group"><label>原站管理员密码 <span class="required">*</span></label><input type="password" name="remote_admin_password" class="form-control" required></div></div>
        </div>
        <button type="button" class="btn-install" onclick="uploadSql()">
          <i class="fa fa-link"></i> 连接原站点
        </button>
        <div id="sqlUploadResult" style="display:none; margin-top:12px"></div>
      </form>
    </div>

    <!-- Step 2R: 勾选配置 + 选存储 -->
    <div class="step" id="step-2r">
      <h3 style="margin-top:0">从备份恢复 - 勾选配置 + 选择存储</h3>
      <div id="configWarnings"></div>
      <!-- 存储推荐全屏模态框（阻塞式，必须点按钮才能继续） -->
      <div id="storageSuggestModal" class="suggest-modal-overlay" style="display:none">
        <div class="suggest-modal-box" role="dialog" aria-modal="true">
          <div class="suggest-modal-head"><i class="fa fa-lightbulb-o"></i> <span id="suggestTitle"></span></div>
          <div class="suggest-modal-body">
            <div id="suggestDetail"></div>
          </div>
          <div class="suggest-modal-foot">
            <button type="button" class="btn-secondary" onclick="dismissSuggestedStorage()"><i class="fa fa-times"></i> 不使用，手动选择</button>
            <button type="button" class="btn-install" onclick="acceptSuggestedStorage()"><i class="fa fa-check"></i> 使用推荐存储</button>
          </div>
        </div>
      </div>
      <h4 style="margin-top:18px"><i class="fa fa-list"></i> SQL 中提取到的 <code>pre_config</code> 项</h4>
      <p class="text-muted" style="font-size:13px">
        默认全部勾选。点击行可切换；<code>storage</code> 永远不导入，必须在下方重新选择。
        检测到 <code>storage=local</code> 时会给出警告。
      </p>
      <div id="configList" class="config-list"></div>
      <div id="fileCountHint" class="text-muted" style="margin-top:8px"></div>
      <div id="restoreTransferConfig" style="margin-top:18px"></div>

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

    <!-- Step 3R: 原站 PHP 直传 + 文件恢复进度 -->
    <div class="step" id="step-3r">
      <h3 style="margin-top:0">从备份恢复 - 开始恢复文件</h3>
      <div id="restoreSending" style="text-align:center;padding:40px">
        <i class="fa fa-spinner fa-spin fa-3x" style="color:#2196f3"></i>
        <p style="margin-top:16px">正在保存配置并跳转...</p>
      </div>
      <div id="restoreError" style="display:none;color:#dc3545;padding:20px"></div>
      <div id="restoreGuide" style="display:none;text-align:center;padding:30px">
        <p style="margin-bottom:20px;font-size:15px">配置已保存，请在新标签页完成文件恢复</p>
        <a id="recLink" href="#" target="_blank" class="btn-install" style="text-decoration:none">
          <i class="fa fa-external-link"></i> 前往恢复页面
        </a>
        <p style="color:#999;font-size:13px;margin-top:16px">输入密码开始恢复后，在原站页面点击"返回 Worker 站点"即可回来</p>
        <button type="button" class="btn-install" style="background:#999;border-color:#777;margin-left:8px" onclick="skipRestore()">
          <i class="fa fa-forward"></i> 跳过恢复
        </button>
      </div>
      <div id="restoreManual" style="display:none;text-align:center;padding:30px">
        <p style="margin-bottom:12px">请手动访问：</p>
        <input id="restoreManualUrl" type="text" class="form-control" readonly style="margin-bottom:16px">
      </div>
    </div>

    <!-- Step 4: 完成 -->
    <div class="step" id="step-4">
      <div style="text-align:center; padding: 40px 0;">
        <div style="font-size:64px; color:#5cb85c;"><i class="fa fa-check-circle"></i></div>
        <h2 style="margin-top:12px">安装完成！</h2>
        <p id="doneSummary" class="text-muted"></p>
        <div class="finish-buttons">
          <a href="/" class="btn-install" style="display:inline-block; text-decoration:none;">
            <i class="fa fa-home"></i> 返回主页
          </a>
          <a href="/admin" class="btn-install" style="display:inline-block; text-decoration:none;">
            <i class="fa fa-sign-in"></i> 进入管理后台
          </a>
        </div>
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

<script src="https://cdn.jsdelivr.net/npm/es6-promise@4/dist/es6-promise.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/es6-promise@4/dist/es6-promise.auto.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/core-js-bundle@3.45.1/minified.js"></script>
<script src="https://cdn.jsdelivr.net/npm/whatwg-fetch@3.6.20/dist/fetch.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.5/babel.min.js"></script>
<script type="text/babel" data-presets="env,typescript">
/* ==================== 状态 ==================== */
const state = {
  mode: '',             // 'fresh' | 'restore'
  step: 0,
  sessionId: '',        // 恢复流程的会话
  selectedConfig: {},   // 勾选的 pre_config
  preExtract: null,
  fileTaskId: '',
  filePollTimer: null,
  applyInProgress: false,
  confirmedStorage: '', // 用户在 step-2r/fresh 中点"确定使用"后存到这
  storageSaved: false,  // storage-set 已成功写入 D1
  storageSaveInProgress: false,
  storageTested: false, // 存储读写测试是否通过（restore 流程确认前必须为 true）
  suggestedStorageName: '', // 检测到的推荐存储类型（如 qiniu）
  suggestedStorageFields: {}, // 推荐存储的字段值
  suggestDismissed: false, // 存储推荐弹窗已被用户关闭后不再弹出
  resumed: false,
  remoteSourceUrl: '',
  remoteConfirmed: false, // 连接原站点并确认后才允许进入下一步
  recToken: '',           // rec.php 恢复页免密令牌（由向导生成，随配置下发给原站）
};

async function saveDraft() {
  if (!state.sessionId || !state.selectedConfig) return;
  const fd = new FormData();
  fd.set('sessionId', state.sessionId);
  fd.set('config_json', JSON.stringify(state.selectedConfig));
  try {
    await fetch('/install/api/draft', { method: 'POST', body: fd, credentials: 'same-origin' });
  } catch (e) {
    console.warn('[install] draft save failed:', e);
  }
}

async function restoreInstallSession() {
  try {
    const res = await fetch('/install/api/session', { credentials: 'same-origin' });
    const json = await res.json();
    const data = json.data;
    if (!data) return;
    state.resumed = true;
    state.mode = 'restore';
    state.sessionId = data.sessionId;
    state.preExtract = data.preExtract;
    state.selectedConfig = data.selectedConfig || {};
    state.confirmedStorage = data.storageType || '';
    state.storageSaved = data.storageType === 'r2' || Object.keys(data.storageFields || {}).length > 0;
    state.fileTaskId = data.taskId || '';
    state.remoteSourceUrl = data.remoteSourceUrl || '';
    state.remoteConfirmed = !!(data.preExtract);
    const remoteUrlInput = document.querySelector('#formSqlUpload input[name="remote_source_url"]');
    const remoteUserInput = document.querySelector('#formSqlUpload input[name="remote_admin_user"]');
    const remotePasswordInput = document.querySelector('#formSqlUpload input[name="remote_admin_password"]');
    if (remoteUrlInput && data.remoteSourceUrl) remoteUrlInput.value = data.remoteSourceUrl;
    if (remoteUserInput && data.remoteAdminUser) remoteUserInput.value = data.remoteAdminUser;
    if (remotePasswordInput) {
      try { remotePasswordInput.value = sessionStorage.getItem('remote_restore_password') || ''; } catch (_) {}
    }
    renderConfigList();
    renderRestoreTransferConfig();
    renderWarnings();
    document.getElementById('fileCountHint').innerText = 'SQL 中检测到约 ' + state.preExtract.fileCount + ' 个文件记录';
    if (data.storageType) {
      applySuggestedStorage(data.storageType, data.storageFields || {});
      state.confirmedStorage = data.storageType;
      state.storageSaved = data.storageType === 'r2' || Object.keys(data.storageFields || {}).length > 0;
    }
    if (data.sourceUrl) setRestoreSourceUrl(data.sourceUrl);
    if (data.remoteSourceUrl) {
      const sourceInput = document.querySelector('#formSource input[name="source_url"]');
      if (sourceInput && !sourceInput.value) setRestoreSourceUrl(data.remoteSourceUrl);
    }
    if (data.taskId) {
      const isLocalBackup = String((data.preExtract && data.preExtract.preConfig && data.preExtract.preConfig.storage) || '').trim() === 'local';
      if (isLocalBackup) {
        showStep(3);
        document.getElementById('restoreGuide').style.display = 'block';
        document.getElementById('restoreSending').style.display = 'none';
        document.getElementById('restoreManual').style.display = 'none';
        const recUrl = (data.remoteSourceUrl || '').replace(/[/]+$/, '') + '/rec.php';
        const token = await genRecToken();
        const recLink = recUrl + (recUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(token);
        document.getElementById('recLink').href = recLink;
        document.getElementById('restoreManualUrl').value = recLink;
      } else {
        showStep(2);
      }
    } else if (data.storageType) {
      showStep(2);
    } else if (data.preExtract) {
      // 已经完成 SQL 预提取但尚未确认存储，刷新后应回到第二步，确保推荐存储提示可见。
      showStep(2);
    } else {
      showStep(1);
    }
    if (new URLSearchParams(location.search).get('restore_done')) {
      await confirmRestoreDone(data.remoteSourceUrl || '');
    }
  } catch (e) {
    console.warn('[install] session restore failed:', e);
  }
}

/* ==================== 原站恢复完成确认 ==================== */
async function confirmRestoreDone(sourceUrl) {
  const panel = document.getElementById('restoreSending');
  const guide = document.getElementById('restoreGuide');
  const errorEl = document.getElementById('restoreError');
  if (!sourceUrl) {
    errorEl.style.display = 'block';
    errorEl.innerText = '缺少原站点地址，无法确认恢复结果';
    return;
  }
  showStep(3);
  guide.style.display = 'none';
  errorEl.style.display = 'none';
  panel.style.display = 'block';
  const tip = panel.querySelector('p');
  if (tip) tip.innerText = '正在确认原站恢复结果...';
  const recUrl = sourceUrl.replace(/[/]+$/, '') + '/rec.php';
  const deadline = Date.now() + 60000;
  let nullCount = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/install/api/check-restore?url=' + encodeURIComponent(recUrl), { credentials: 'same-origin' });
      const json = await res.json();
      const s = json.data;
      if (s && (s.status === 'completed' || (s.processed || 0) >= (s.total || 0))) {
        document.getElementById('doneSummary').innerText =
          '文件恢复完成：' + (s.processed || 0) + ' / ' + (s.total || 0) + ' 个文件，成功 ' + (s.success || 0) + ' 个，失败 ' + (s.failed || 0) + ' 个';
        clearInstallData();
        showStep(4);
        return;
      }
      if (!s) {
        // 原站没有恢复任务（配置或状态文件缺失）：立即提示，不空转等待
        nullCount++;
        if (nullCount >= 2) break;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  panel.style.display = 'none';
  guide.style.display = 'block';
  errorEl.style.display = 'block';
  errorEl.innerText = '未能确认到恢复完成：原站未检测到恢复任务（restore_config.php / restore_status.json 不存在或为空）。' +
    '请回到向导第 2 步重新点击「应用配置并完成」保存配置，再到原站 rec.php 页面开始恢复，完成后点击「返回 Worker 站点」。';
}

function setRestoreSourceUrl(url) {
  const value = String(url || '');
  const input = document.getElementById('restoreSourceUrlDisplay');
  if (input) input.value = value;
}

/* ==================== 存储推荐提示 ==================== */
function showStorageSuggest(storageType, fields, fieldSummary) {
  state.suggestedStorageName = storageType;
  state.suggestedStorageFields = fields;
  document.getElementById('suggestTitle').textContent = '检测到备份包含完整的 ' + storageType + ' 配置';
  document.getElementById('suggestDetail').innerHTML =
    '检测到原站点配置了完整的 <code>' + storageType + '</code> 云存储（' + fieldSummary + '）。<br>是否直接沿用这些配置作为新的存储后端？';
  document.getElementById('storageSuggestModal').style.display = 'flex';
}

function renderSuggestedStorage(preExtract) {
  if (!preExtract) return;
  if (state.suggestDismissed) return;
  const config = preExtract.preConfig || {};
  if (String(config.storage || '').trim() !== 'local') return;
  const candidates = [
    { name: 'qiniu', required: ['qiniu_ak', 'qiniu_sk', 'qiniu_bucket'], prefix: 'qiniu_' },
    { name: 'upyun', required: ['upyun_bucket', 'upyun_operator', 'upyun_password'], prefix: 'upyun_' },
    { name: 'webdav', required: ['webdav_endpoint', 'webdav_user', 'webdav_pass'], prefix: 'webdav_' },
    { name: 's3', required: ['s3_endpoint', 's3_bucket', 's3_ak', 's3_sk'], prefix: 's3_' },
    { name: 'github', required: ['gh_owner', 'gh_repo', 'gh_token'], prefix: 'gh_' },
    { name: 'r2', required: ['r2_account_id', 'r2_access_key_id', 'r2_secret_access_key', 'r2_bucket'], prefix: 'r2_' }
  ];
  const candidate = candidates.find(item => item.required.every(key => String(config[key] || '').trim() !== ''));
  if (!candidate) return;
  const fields = {};
  Object.keys(config).forEach(key => {
    if (key.indexOf(candidate.prefix) === 0 && config[key] !== '') fields[key] = config[key];
  });
  const summary = Object.keys(fields).length + ' 个字段（' + Object.keys(fields).join(', ') + '）';
  preExtract.suggestedStorage = candidate.name;
  preExtract.suggestedStorageFields = fields;
  showStorageSuggest(candidate.name, fields, summary);
}

function acceptSuggestedStorage() {
  state.suggestDismissed = true;
  const sug = state.suggestedStorageName;
  const fields = state.suggestedStorageFields;
  if (sug && fields) {
    applySuggestedStorage(sug, fields);
  }
  document.getElementById('storageSuggestModal').style.display = 'none';
}

function dismissSuggestedStorage() {
  const isLocalBackup = String((state.preExtract && state.preExtract.preConfig && state.preExtract.preConfig.storage) || '').trim() === 'local';
  if (!isLocalBackup && !confirm('不使用推荐存储的话，你稍后需要自己把原站点本地存储里的文件上传到新的存储后端，否则文件将无法下载。继续？')) return;
  state.suggestDismissed = true;
  document.getElementById('storageSuggestModal').style.display = 'none';
  state.suggestedStorageName = '';
  state.suggestedStorageFields = {};
}

/* ==================== 步骤导航 ==================== */
function showStep(n) {
  state.step = n;
  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  // 根据安装模式选择步骤 ID
  const ids = state.mode === 'restore'
    ? ['step-0', 'step-1r', 'step-2r', 'step-3r', 'step-4', 'step-4']
    : ['step-0', 'step-1f', '', '', '', 'step-4'];
  const el = document.getElementById(ids[n]);
  if (el) el.classList.add('active');
  if (n === 2 && state.mode === 'restore' && state.preExtract) {
    renderSuggestedStorage(state.preExtract);
  }

  // 步骤指示器（restore: 0→1→1→2→3, fresh: 0→1→3）
  const map = state.mode === 'restore'
    ? { 0: 0, 1: 1, 2: 1, 3: 2, 4: 3, 5: 3 }
    : { 0: 0, 1: 1, 5: 3 };
  document.querySelectorAll('.step-pill').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i < map[n]) el.classList.add('done');
    else if (i === map[n]) el.classList.add('active');
  });

  // 按钮
  const prev = document.getElementById('btnPrev');
  const next = document.getElementById('btnNext');
  next.disabled = false;
  prev.style.display = n === 0 || n === 4 || n === 5 ? 'none' : '';
  if (n === 4 || n === 5) { next.style.display = 'none'; return; }
  if (n === 0) { next.style.display = 'none'; return; }
  next.style.display = '';
  if (n === 1 && state.mode === 'restore' && !state.remoteConfirmed) {
    next.disabled = true;
  }
  if (n === 1 && state.mode === 'fresh') {
    next.innerHTML = '<i class="fa fa-check"></i> 完成安装';
  } else if (n === 2 && state.mode === 'restore') {
    next.innerHTML = '<i class="fa fa-check"></i> 应用配置并完成';
  } else if (n === 3) {
    next.style.display = 'none';
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
  if (state.step === 1 && state.mode === 'restore') {
    if (!state.remoteConfirmed) {
      const next = document.getElementById('btnNext');
      next.innerHTML = '<i class="fa fa-exclamation-triangle"></i> 请先连接原站点并确认';
      setTimeout(() => {
        if (!state.remoteConfirmed) next.innerHTML = '下一步 <i class="fa fa-arrow-right"></i>';
      }, 2500);
      return;
    }
  }
  if (state.step === 1 && state.mode === 'fresh') {
    // 直接保存
    await submitFresh();
    return;
  }
  if (state.step === 2 && state.mode === 'restore') {
    if (!state.storageSaved || !state.confirmedStorage) {
      const next = document.getElementById('btnNext');
      next.innerHTML = '<i class="fa fa-exclamation-triangle"></i> 请先点击“确定使用”保存存储';
      const tip = document.getElementById('restoreTestResult');
      if (tip) {
        tip.style.display = 'block';
        tip.className = 'alert alert-warning';
        tip.innerHTML = '<i class="fa fa-exclamation-triangle"></i> 存储配置尚未保存到数据库，请先点击当前存储页的“确定使用”。';
      }
      setTimeout(() => {
        if (!state.applyInProgress && !state.storageSaveInProgress) {
          next.innerHTML = '下一步 <i class="fa fa-arrow-right"></i>';
        }
      }, 2500);
      return;
    }
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

function toggleFreshDownloadMode(value) {
  const group = document.getElementById('freshDownloadDomainGroup');
  if (group) group.style.display = String(value) === '1' ? 'block' : 'none';
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
    clearInstallData();
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
  try { sessionStorage.setItem('remote_restore_password', String(fd.get('remote_admin_password') || '')); } catch (_) {}
  const result = document.getElementById('sqlUploadResult');
  result.style.display = 'block';
  result.className = 'alert alert-info';
  result.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 上传并预提取中...';
  try {
     const res = await fetch('/install/api/sql-preview', { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '上传失败');
    state.sessionId = json.data.sessionId;
    state.remoteSourceUrl = json.data.remoteSourceUrl || '';
    if (state.remoteSourceUrl) setRestoreSourceUrl(state.remoteSourceUrl);
    state.preExtract = json.data.preExtract;
    state.selectedConfig = {};
    for (const k of Object.keys(state.preExtract.preConfig || {})) {
      if (k === 'storage') continue;
      state.selectedConfig[k] = state.preExtract.preConfig[k];
    }
    result.className = 'alert alert-success';
    result.innerHTML = '<i class="fa fa-check"></i> 连接成功，读写测试通过，提取到 ' + Object.keys(state.preExtract.preConfig).length + ' 条配置，' + state.preExtract.fileCount + ' 个文件。<br>' +
      '<button type="button" class="btn-install" style="margin-top:10px" onclick="confirmRemote()"><i class="fa fa-check-circle"></i> 确认连接，进入下一步</button>';
    // 渲染 step 2r（暂不跳转，等待确认）
    renderConfigList();
    renderRestoreTransferConfig();
    renderWarnings();
    renderSuggestedStorage(state.preExtract);
    document.getElementById('fileCountHint').innerText = 'SQL 中检测到约 ' + state.preExtract.fileCount + ' 个文件记录';
    // 智能建议：检测到原系统配置了非 local 存储时，显示选择提示
    console.log('[install] 检测存储推荐:', state.preExtract.preConfig || {});
  } catch (e) {
    console.error('[install] uploadSql error:', e);
    result.className = 'alert alert-danger';
    result.innerHTML = '<i class="fa fa-exclamation-triangle"></i> ' + e.message;
  }
}

function confirmRemote() {
  state.remoteConfirmed = true;
  showStep(2);
}

async function genRecToken() {
  if (state.recToken) return state.recToken;
  try {
    state.recToken = sessionStorage.getItem('rec_token') || '';
  } catch (_) {}
  if (!state.recToken) {
    try {
      const arr = new Uint8Array(24);
      crypto.getRandomValues(arr);
      state.recToken = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('rec_token', state.recToken);
    } catch (_) {}
  }
  return state.recToken;
}

async function clearInstallData() {
  try { sessionStorage.removeItem('remote_restore_password'); } catch (_) {}
  try { sessionStorage.removeItem('rec_token'); } catch (_) {}
  try {
    await fetch('/install/api/finish', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
}

function skipRestore() {
  if (!confirm('若你刚配置的存储里面没有对应文件，将会全部文件无法下载。确认跳过恢复？')) return;
  clearInstallData();
  showStep(4);
  const doneSummary = document.getElementById('doneSummary');
  if (doneSummary) {
    doneSummary.innerHTML = '<i class="fa fa-info-circle"></i> 已跳过文件恢复。如需恢复文件，请稍后在管理后台重新操作。';
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

/* 把 SQL 里检测到的存储配置自动填到对应 tab 的表单，并切换到该 tab */
function applySuggestedStorage(storageType, fields) {
  console.log('[install] applySuggestedStorage:', storageType, fields);
  // 自动填表不等于已经保存。必须由 confirmStorage 调用 storage-set 后
  // 才能允许进入下一步。
  state.confirmedStorage = '';
  state.storageSaved = false;
  // 1) 切到对应 tab
  const tab = document.querySelector('#restoreStorageTabs .storage-tab[data-target="restore-form-' + storageType + '"]');
  if (tab) {
    document.querySelectorAll('#restoreStorageTabs .storage-tab').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('#step-2r .storage-form').forEach(f => f.classList.remove('active'));
    document.getElementById('restore-form-' + storageType).classList.add('active');
    storageTypeEl('restore-').value = storageType;
    console.log('[install] 切换到 tab:', storageType, ', hidden storage_type =', storageTypeEl('restore-').value);
  } else {
    console.warn('[install] 找不到 tab: restore-form-' + storageType);
  }
  // 2) 填字段
  let filled = 0;
  for (const [k, v] of Object.entries(fields)) {
    const inp = document.querySelector('#step-2r input[name="restore_' + k + '"]');
    if (inp) {
      inp.value = v;
      filled++;
      console.log('[install] 填充字段', k, '=', v.length > 40 ? v.substring(0, 40) + '...' : v);
    } else {
      console.warn('[install] 找不到 input: restore-' + k);
    }
  }
  // 3) 显示已确认角标
  document.querySelectorAll('[id$="confirmedBadge"]').forEach(b => b.style.display = 'none');
  const badge = document.getElementById('restore-confirmedBadge');
  if (badge) badge.style.display = 'none';
  // 4) 提示用户
  const tip = document.getElementById('restoreTestResult');
  if (tip) {
    tip.style.display = 'block';
    tip.className = 'alert alert-info';
    tip.innerHTML = '<i class="fa fa-info-circle"></i> 已自动填入 ' + storageType + ' 配置（' + filled + ' 个字段），请点击“确定使用”保存后再继续。';
  }
}

function renderConfigList() {
  const box = document.getElementById('configList');
  const cfg = state.preExtract.preConfig || {};
  const keys = Object.keys(cfg).sort();
  if (keys.length === 0) {
    box.innerHTML = '<div style="padding:20px; text-align:center; color:#999">SQL 中未检测到 pre_config 数据</div>';
    return;
  }
  const labelMap = {
    title: '网站标题', logo: '网站Logo', keywords: '网站关键词', description: '网站描述',
    upload_size: '上传大小限制(MB)', upload_type: '允许上传的文件类型', type_image: '图片格式',
    type_audio: '音频格式', type_video: '视频格式', type_block: '禁止上传的格式',
    name_block: '禁止上传的文件名', downfile_type: '下载方式(0中转/1直连)',
    downfile_protocol: '下载协议(0http/1https)', downfile_domain: '下载域名',
    uploadfile_type: '上传方式(0中转/1直传)', uploadfile_protocol: '上传协议',
    uploadfile_domain: '上传域名', upload_size: '上传大小限制(MB)',
    storage: '存储类型', storage_local_path: '本地存储路径',
    qiniu_ak: '七牛AccessKey', qiniu_sk: '七牛SecretKey', qiniu_bucket: '七牛存储桶',
    qiniu_domain: '七牛域名', qiniu_region: '七牛区域',
    upyun_bucket: '又拍存储桶', upyun_operator: '又拍操作员', upyun_password: '又拍密码',
    upyun_domain: '又拍域名',
    s3_endpoint: 'S3端点', s3_region: 'S3区域', s3_bucket: 'S3存储桶',
    s3_ak: 'S3 AccessKey', s3_sk: 'S3 SecretKey', s3_domain: 'S3域名',
    gh_owner: 'GitHub仓库拥有者', gh_repo: 'GitHub仓库名', gh_token: 'GitHub Token',
    gh_branch: 'GitHub分支', gh_domain: 'GitHub域名', gh_download_proxy: 'GitHub直连下载代理前缀',
    webdav_endpoint: 'WebDAV地址', webdav_user: 'WebDAV用户名',
    webdav_pass: 'WebDAV密码', webdav_domain: 'WebDAV域名',
    green_check: '图片鉴黄(0关/1开)', green_apikey: '鉴黄API密钥',
    videoreview: '视频审核(0关/1开)',
    api_open: '上传API(0关/1开)', api_key: 'API密钥',
    admin_user: '管理员用户名', admin_pwd: '管理员密码',
    bg_color: '背景颜色', notice: '首页公告', tongji: '统计代码',
    login_qq: 'QQ登录(0关/1开)', login_wx: '微信登录(0关/1开)',
    installed: '是否已安装', syskey: '系统密钥',
    index_title: '首页标题', index_content: '首页内容',
    type_text: '文本格式', type_code: '代码格式', type_archive: '压缩包格式',
    type_word: 'Word格式', type_excel: 'Excel格式', type_pdf: 'PDF格式',
    type_powerpoint: 'PPT格式', type_android: '安卓应用', type_apple: '苹果应用',
    type_windows: 'Windows程序', type_linux: 'Linux安装包',
    page_size: '每页显示数量',
  };
  const hasRestoredConfig = state.resumed;
  const restoredConfig = state.selectedConfig || {};
  state.selectedConfig = {};
  let html = '<table class="table table-condensed table-hover"><thead><tr><th style="width:40px">使用</th><th>键</th><th>用途</th><th>值</th></tr></thead><tbody>';
  for (const k of keys) {
    if (k === 'storage') {
      html += '<tr class="text-muted">' +
        '<td><input type="checkbox" disabled></td>' +
        '<td><code>' + escapeHtml(k) + '</code></td>' +
        '<td style="font-size:12px;color:#999">存储类型</td>' +
        '<td><span style="font-size:12px">（不导入，请在下方重新选择存储类型）</span></td>' +
        '</tr>';
      continue;
    }
    const v = (cfg[k] || '').toString();
    if (hasRestoredConfig && Object.prototype.hasOwnProperty.call(restoredConfig, k)) {
      state.selectedConfig[k] = restoredConfig[k];
    } else if (!hasRestoredConfig) {
      state.selectedConfig[k] = v;
    }
    const checked = Object.prototype.hasOwnProperty.call(state.selectedConfig, k);
    const label = labelMap[k] || '';
    html += '<tr class="selected">' +
      '<td><input type="checkbox" data-key="' + escapeHtml(k) + '"' + (checked ? ' checked' : '') + ' onchange="toggleConfig(this)"></td>' +
      '<td><code>' + escapeHtml(k) + '</code></td>' +
      '<td style="font-size:12px;color:#888">' + escapeHtml(label) + '</td>' +
      '<td><input type="text" class="form-control input-sm" data-key="' + escapeHtml(k) + '" value="' + escapeHtml(state.selectedConfig[k]) + '" oninput="editConfigValue(this)"></td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  box.innerHTML = html;
}

function renderRestoreTransferConfig() {
  const box = document.getElementById('restoreTransferConfig');
  if (!box || !state.preExtract) return;
  const source = state.preExtract.preConfig || {};
  const value = (key, fallback) => {
    const selected = state.selectedConfig && state.selectedConfig[key];
    const raw = selected !== undefined ? selected : source[key];
    return raw === undefined || raw === '' ? fallback : String(raw);
  };
  const uploadType = value('uploadfile_type', '0') === '1' ? '1' : '0';
  const downloadType = value('downfile_type', '0') === '1' ? '1' : '0';
  const protocol = value('downfile_protocol', '1') === '1' ? '1' : '0';
  const domain = value('downfile_domain', '');
  box.innerHTML =
    '<h4 style="margin-top:18px"><i class="fa fa-exchange"></i> 文件传输方式</h4>' +
    '<div class="row">' +
    '<div class="col-md-6" id="restoreUploadTypeWrap"><div class="form-group">' +
    '<label>文件上传方式</label>' +
    '<select id="restore_uploadfile_type" class="form-control" onchange="updateRestoreTransferConfig()">' +
    '<option value="0"' + (uploadType === '0' ? ' selected' : '') + '>网站代理上传</option>' +
    '<option value="1"' + (uploadType === '1' ? ' selected' : '') + '>存储直传</option>' +
    '</select></div></div>' +
    '<div class="col-md-6" id="restoreDownloadTypeWrap"><div class="form-group">' +
    '<label>文件下载方式</label>' +
    '<select id="restore_downfile_type" class="form-control" onchange="updateRestoreTransferConfig()">' +
    '<option value="0"' + (downloadType === '0' ? ' selected' : '') + '>网站代理下载</option>' +
    '<option value="1"' + (downloadType === '1' ? ' selected' : '') + '>存储直链下载</option>' +
    '</select></div></div></div>' +
    '<div class="form-group" id="restoreDownloadDomainGroup" style="display:' + (downloadType === '1' ? 'block' : 'none') + '">' +
    '<label>直链协议和域名</label><div class="row">' +
    '<div class="col-xs-4 col-md-3" style="padding-right:0"><select id="restore_downfile_protocol" class="form-control" onchange="updateRestoreTransferConfig()">' +
    '<option value="0"' + (protocol === '0' ? ' selected' : '') + '>http://</option>' +
    '<option value="1"' + (protocol === '1' ? ' selected' : '') + '>https://</option></select></div>' +
    '<div class="col-xs-8 col-md-9" style="padding-left:0"><input id="restore_downfile_domain" type="text" class="form-control" value="' + escapeHtml(domain) + '" placeholder="可留空，使用存储默认域名" oninput="updateRestoreTransferConfig()"></div>' +
    '</div><span class="help-block">系统会识别 SQL 中对应键的原值，也可以在这里修改；点击下一步时写入 D1。</span></div>' +
    '<span class="help-block" style="color:#999">直连下载相关设置仅在对应存储类型支持时显示。</span>';
  applyRestoreTransferView();
}

/* 按所选存储类型过滤"文件传输方式"的可见字段（与后台存储设置一致） */
function applyRestoreTransferView() {
  const t = storageTypeEl('restore-').value || 'r2';
  const uploadWrap = document.getElementById('restoreUploadTypeWrap');
  const downloadWrap = document.getElementById('restoreDownloadTypeWrap');
  if (uploadWrap) uploadWrap.style.display = (t === 'qiniu' || t === 'upyun' || t === 's3' || t === 'r2') ? '' : 'none';
  if (downloadWrap) downloadWrap.style.display = (t === 'qiniu' || t === 'upyun' || t === 'github') ? '' : 'none';
  const download = document.getElementById('restore_downfile_type');
  const domainGroup = document.getElementById('restoreDownloadDomainGroup');
  if (domainGroup) {
    const isDirect = download && download.value === '1';
    domainGroup.style.display = (t === 'qiniu' && isDirect) ? 'block' : 'none';
  }
}

function updateRestoreTransferConfig() {
  const upload = document.getElementById('restore_uploadfile_type');
  const download = document.getElementById('restore_downfile_type');
  const protocol = document.getElementById('restore_downfile_protocol');
  const domain = document.getElementById('restore_downfile_domain');
  if (!upload || !download || !protocol || !domain) return;
  state.selectedConfig.uploadfile_type = upload.value;
  state.selectedConfig.downfile_type = download.value;
  state.selectedConfig.downfile_protocol = protocol.value;
  state.selectedConfig.downfile_domain = domain.value;
  applyRestoreTransferView();
  saveDraft();
}

function toggleConfig(cb) {
  const k = cb.dataset.key;
  const tr = cb.closest('tr');
  const inp = tr.querySelector('input[type="text"]');
  if (cb.checked) {
    state.selectedConfig[k] = inp ? inp.value : state.preExtract.preConfig[k];
    tr.classList.add('selected');
  } else {
    delete state.selectedConfig[k];
    tr.classList.remove('selected');
  }
  saveDraft();
}

function editConfigValue(inp) {
  const k = inp.dataset.key;
  const cb = inp.closest('tr').querySelector('input[type="checkbox"]');
  if (cb && cb.checked) {
    state.selectedConfig[k] = inp.value;
    saveDraft();
    saveDraft();
  }
}

async function setStorage(prefix) {
  const fd = new FormData();
  const storageType = storageTypeEl(prefix).value;
  fd.set('storage_type', storageType);
  console.log('[install] setStorage: prefix=' + prefix + ', storageType=' + storageType);
  const activeForm = document.querySelector('#step-' + (prefix === 'fresh-' ? '1f' : '2r') + ' .storage-form.active');
  const fields = [];
  if (activeForm) {
    const stripPrefix = prefix.replace(/-$/, '_');
    activeForm.querySelectorAll('input[name^="' + prefix.slice(0, -1) + '_"]').forEach(inp => {
      if (inp.name) {
        fd.set(inp.name.replace(stripPrefix, ''), inp.value);
        fields.push(inp.name.replace(stripPrefix, '') + '=' + (inp.value ? (inp.name.includes('token') || inp.name.includes('sk') || inp.name.includes('pass') ? '***' : inp.value) : '(空)'));
      }
    });
  }
  console.log('[install] setStorage: 收集到', fields.length, '个字段:', fields);
  return fd;
}

async function applyConfigAndComplete() {
  if (state.applyInProgress) {
    console.warn('[install] applyConfigAndComplete: 请求已在处理中，忽略重复点击');
    return;
  }
  const cfg = state.selectedConfig;
  // 检查 storage 是否已"确定"
  if (!state.confirmedStorage) {
    const next = document.getElementById('btnNext');
    next.innerHTML = '<i class="fa fa-exclamation-triangle"></i> 请先确认存储';
    setTimeout(() => { if (!state.applyInProgress) next.innerHTML = '应用配置并完成'; }, 2000);
    return;
  }
  console.log('[install] applyConfigAndComplete: confirmedStorage=' + state.confirmedStorage + ', selectedConfig keys=' + Object.keys(cfg).length);
  state.applyInProgress = true;
  const next = document.getElementById('btnNext');
  next.disabled = true;
  next.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 应用中...';
  const fd = await setStorage('restore-');
  fd.set('sessionId', state.sessionId);
  fd.set('config_json', JSON.stringify(cfg));
  const recToken = await genRecToken();
  if (recToken) fd.set('auth_token', recToken);
  console.log('[install] applyConfigAndComplete: fd 中 storage_type=' + fd.get('storage_type'));
  try {
    const res = await fetch('/install/api/config-apply', { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '应用失败');
    // 是否需要下载文件？
    if (state.preExtract.fileCount > 0) {
      // 跳到 step 3r 并自动发送配置到 PHP
      showStep(3);
      setTimeout(() => startFileDownload(), 500);
    } else {
      // 没有文件，直接完成
      const sum = document.getElementById('doneSummary');
      sum.innerText = '存储: ' + document.getElementById('restore_storage_type').value + '，已应用 ' + Object.keys(cfg).length + ' 条配置';
      clearInstallData();
      showStep(5);
    }
  } catch (e) {
    next.innerHTML = '<i class="fa fa-exclamation-triangle"></i> 应用失败';
    state.applyInProgress = false;
    next.disabled = false;
    setTimeout(() => { if (!state.applyInProgress) next.innerHTML = '<i class="fa fa-check"></i> 应用配置并完成'; }, 2000);
  }
}

async function startFileDownload() {
  const sending = document.getElementById('restoreSending');
  const guide = document.getElementById('restoreGuide');
  const errorEl = document.getElementById('restoreError');
  const manualEl = document.getElementById('restoreManual');
  sending.style.display = 'none';
  guide.style.display = 'none';
  errorEl.style.display = 'none';
  manualEl.style.display = 'none';

  const sourceUrl = state.remoteSourceUrl || '';
  if (!sourceUrl) {
    errorEl.style.display = 'block';
    errorEl.innerText = '未找到原站点地址，请返回第二步填写';
    return;
  }

  const recUrl = sourceUrl.replace(/[/]+$/, '') + '/rec.php';
  const token = await genRecToken();
  const recLink = recUrl + (recUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(token);
  document.getElementById('recLink').href = recLink;
  const manualUrl = document.getElementById('restoreManualUrl');
  if (manualUrl) manualUrl.value = recLink;
  guide.style.display = 'block';
}

function pollFileStatus() {
  if (state.filePollTimer) clearInterval(state.filePollTimer);
      var pollFailCount = 0;
      var lastProgress = '';
      var stuckSince = 0;
      state.filePollTimer = setInterval(async () => {
    try {
      var res = await fetch('/install/api/status?taskId=' + state.fileTaskId, { credentials: 'same-origin' });
      if (!res.ok) {
        pollFailCount++;
        if (pollFailCount > 30) {
          document.getElementById('dpStatus').innerText = '轮询失败超过30次，请检查网络';
          clearInterval(state.filePollTimer);
        }
        return;
      }
      var json = await res.json();
      pollFailCount = 0;
      if (json.code !== 0) {
        // 任务可能还在内存中恢复，不立即停止
        pollFailCount++;
        if (pollFailCount > 15) {
          document.getElementById('dpStatus').innerText = '查询失败: ' + json.msg;
          clearInterval(state.filePollTimer);
        }
        return;
      }
      pollFailCount = 0;
      var s = json.data;
      console.log('[install] files-from-source: status', {
        taskId: state.fileTaskId,
        status: s.status,
        stage: s.stage,
        processed: s.processed,
        total: s.total,
        success: s.success,
        failed: s.failed,
        currentItem: s.currentItem,
        currentFileStage: s.currentFileStage,
        currentFileReceived: s.currentFileReceived,
        currentFileTotal: s.currentFileTotal,
        message: s.message,
        errors: s.errors,
        logs: s.logs,
      });
      document.getElementById('dpTotal').innerText = s.processed + ' / ' + s.total;
      document.getElementById('dpResult').innerText = s.success + ' / ' + s.failed;
      document.getElementById('dpSkipped').innerText = (s.skipped && s.skipped.length) || 0;
      if (s.skipped && s.skipped.length) {
        document.getElementById('dpSkippedList').innerText = s.skipped.join('\\n');
      }
      if (s.errors && s.errors.length) {
        document.getElementById('dpFailedList').innerText = '失败文件:\\n' + s.errors.join('\\n');
      }
      const pct = s.total > 0 ? Math.floor(s.processed * 100 / s.total) : 0;
      document.getElementById('dpBarTotal').style.width = pct + '%';
      document.getElementById('dpBarTotal').innerText = pct + '%';
      var chunked = !!s.currentFileChunked;
      document.getElementById('dpCurrentPanel').style.display = 'block';
      document.getElementById('dpTransferMode').innerText = chunked ? '（文件过大，尝试分片上传）' : '';
      document.getElementById('dpBytes').innerText = '已上传大小 / 总文件大小: ' + formatSize(s.processedBytes || 0) + ' / ' + formatSize(s.totalBytes || 0);
      if (s.currentItem) {
        document.getElementById('dpCurrent').innerText = s.currentItem;
        const cpct = s.currentFileTotal > 0 ? Math.floor(s.currentFileReceived * 100 / s.currentFileTotal) : 0;
        document.getElementById('dpBarCurrent').style.width = cpct + '%';
        document.getElementById('dpBarCurrent').innerText = cpct + '%';
        document.getElementById('dpBarCurrent').className = 'progress-bar ' + (s.currentFileStage === 'upload' ? 'progress-bar-success' : 'progress-bar-info');
        document.getElementById('dpCurrentDetail').innerText = '上传中: ' + formatSize(s.currentFileReceived || 0) + ' / ' + formatSize(s.currentFileTotal || 0) + '，速度: ' + formatSize(s.currentFileSpeed || 0) + '/s';
        document.getElementById('dpStatus').innerText = '正在从原站点读取并上传到目标存储: ' + s.currentItem;
        var progressKey = s.currentItem + '|' + (s.currentFileReceived || 0);
        if (progressKey === lastProgress) {
          if (!stuckSince) stuckSince = Date.now();
          var stuckSec = Math.floor((Date.now() - stuckSince) / 1000);
          if (stuckSec >= 60) {
            document.getElementById('dpStatus').innerHTML = '当前文件进度停滞 ' + stuckSec + ' 秒，建议 <a href="javascript:location.reload()" style="color:#3c78a8;font-weight:bold">刷新页面</a> 后恢复会继续';
          } else if (stuckSec >= 15) {
            document.getElementById('dpStatus').innerText = '当前文件进度停滞 ' + stuckSec + ' 秒，如长时间无变化请刷新页面';
          }
        } else {
          lastProgress = progressKey;
          stuckSince = 0;
        }
      }
      if (s.status === 'completed') {
        clearInterval(state.filePollTimer);
        document.getElementById('dpStatus').innerText = s.failed > 0 ? '处理完成，但有 ' + s.failed + ' 个文件失败' : '恢复上传完成 ✅';
        const sum = document.getElementById('doneSummary');
        sum.innerText = '文件处理完成: 上传成功 ' + s.success + '，跳过 ' + ((s.skipped && s.skipped.length) || 0) + '，失败 ' + s.failed;
        if (s.failed === 0) setTimeout(() => showStep(5), 1200);
      } else if (s.status === 'failed') {
        clearInterval(state.filePollTimer);
        const error = s.errors && s.errors.length ? s.errors.join('；') : (s.message || '服务端未返回具体错误');
        document.getElementById('dpStatus').innerText = '恢复失败: ' + error;
        document.getElementById('dpFailedList').innerText = s.errors && s.errors.length
          ? '失败文件:\\n' + s.errors.join('\\n')
          : '失败文件明细未返回，请查看 F12 控制台日志';
        console.error('[install] files-from-source: 任务失败', { taskId: state.fileTaskId, error, status: s });
      } else {
          document.getElementById('dpStatus').innerText = s.message || ('正在恢复上传 ' + s.processed + '/' + s.total);
      }
    } catch (e) {
      console.error('[install] files-from-source: 轮询异常', e);
    }
  }, 1000);
}

/* 根据 prefix 获取 hidden storage_type 元素（HTML id 用下划线） */
function storageTypeEl(prefix) {
  return document.getElementById(prefix.replace(/-$/, '') + '_storage_type');
}

function activeStorageForm(prefix) {
  const rootId = prefix === 'fresh-' ? 'step-1f' : 'step-2r';
  return document.querySelector('#' + rootId + ' .storage-form.active');
}

/* ==================== 存储测试 ==================== */
async function testStorage(prefix) {
  const activeForm = activeStorageForm(prefix);
  if (!activeForm) {
    console.error('[install] testStorage: 找不到当前存储表单 ' + prefix);
    return;
  }
  console.log('[install] testStorage: prefix=' + prefix + ', storageType=' + storageTypeEl(prefix).value);
  const testBtn = activeForm.querySelector('button[onclick*="testStorage"]');
  if (testBtn) {
    testBtn.disabled = true;
    testBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 测试中...';
  }
  const fd = new FormData();
  fd.set('storage_type', storageTypeEl(prefix).value);
  const fields = [];
  const stripPrefix = prefix.replace(/-$/, '_');
  activeForm.querySelectorAll('input[name^="' + prefix.slice(0, -1) + '_"]').forEach(inp => {
    if (inp.name) {
      fd.set(inp.name.replace(stripPrefix, ''), inp.value);
      fields.push(inp.name.replace(stripPrefix, '') + '=' + (inp.value ? '***' : '(空)'));
    }
  });
  console.log('[install] testStorage: 收集到字段', fields);
  const testContent = 'install-test-' + Date.now();
  const testBlob = new Blob([testContent], { type: 'text/plain' });
  fd.set('test_file', testBlob, '_install_test_' + Date.now() + '.txt');
  console.log('[install] testStorage: 发送 fetch /install/test');
  try {
    const res = await fetch('/install/test', { method: 'POST', body: fd, credentials: 'same-origin' });
    console.log('[install] testStorage: 响应 status=' + res.status);
    const json = await res.json();
    console.log('[install] testStorage: 响应 JSON', json);
    if (json.code === 0 && json.data && json.data.ok) {
      state.storageTested = true;
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.className = 'btn btn-sm btn-success';
        testBtn.innerHTML = '<i class="fa fa-check"></i> 测试成功';
      }
    } else {
      state.storageTested = false;
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.className = 'btn btn-sm btn-danger';
        testBtn.innerHTML = '<i class="fa fa-times"></i> 测试失败';
      }
    }
  } catch (e) {
    console.error('[install] testStorage: fetch 异常', e);
    state.storageTested = false;
    if (testBtn) {
      testBtn.disabled = false;
      testBtn.className = 'btn btn-sm btn-danger';
      testBtn.innerHTML = '<i class="fa fa-times"></i> 测试失败';
    }
  }
}

/* 用户点击"确定使用"按钮：把当前 tab 的 storageType 锁定为已确认 */
async function confirmStorage(prefix) {
  const type = storageTypeEl(prefix).value;
  console.log('[install] confirmStorage: prefix=' + prefix + ', type=' + type);
  if (!type) {
    alert('请先选择存储类型');
    return;
  }
  const activeForm = activeStorageForm(prefix);
  const rootId = prefix === 'fresh-' ? 'step-1f' : 'step-2r';
  const confirmBtn = activeForm && activeForm.querySelector('button[onclick*="confirmStorage"]');
  if (prefix === 'restore-') {
    if (!state.storageTested) {
      if (confirmBtn) {
        confirmBtn.className = 'btn btn-sm btn-danger';
        confirmBtn.innerHTML = '<i class="fa fa-exclamation-triangle"></i> 请先测试存储';
      }
      const tip = document.getElementById('restoreTestResult');
      if (tip) {
        tip.style.display = 'block';
        tip.className = 'alert alert-warning';
        tip.innerHTML = '<i class="fa fa-exclamation-triangle"></i> 必须先点击"测试存储"并成功，才能"确定使用"。';
      }
      setTimeout(() => {
        if (confirmBtn && !state.storageSaveInProgress) {
          confirmBtn.className = 'btn btn-sm btn-primary';
          confirmBtn.innerHTML = '<i class="fa fa-check"></i> 确定使用';
        }
      }, 2500);
      return;
    }
    if (!state.sessionId) {
      if (confirmBtn) {
        confirmBtn.className = 'btn btn-sm btn-danger';
        confirmBtn.innerHTML = '<i class="fa fa-times"></i> 会话失效';
      }
      return;
    }
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 保存中...';
    }
    state.storageSaveInProgress = true;
    state.storageSaved = false;
    state.confirmedStorage = '';
    try {
      const fd = await setStorage(prefix);
      fd.set('sessionId', state.sessionId);
      const res = await fetch('/install/api/storage-set', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.msg || '保存存储配置失败');
      state.storageSaved = true;
      state.confirmedStorage = type;
    } catch (e) {
      console.error('[install] confirmStorage: 保存失败', e);
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fa fa-check"></i> 确定使用';
      }
      if (confirmBtn) {
        confirmBtn.className = 'btn btn-sm btn-danger';
        confirmBtn.innerHTML = '<i class="fa fa-times"></i> 保存失败';
      }
      state.confirmedStorage = '';
      state.storageSaved = false;
      document.querySelectorAll('#' + rootId + ' [id$="confirmedBadge"]').forEach(b => b.style.display = 'none');
      state.storageSaveInProgress = false;
      return;
    }
    state.storageSaveInProgress = false;
  }
  state.confirmedStorage = type;
  if (prefix !== 'restore-') state.storageSaved = true;
  document.querySelectorAll('#' + rootId + ' [id$="confirmedBadge"]').forEach(b => b.style.display = 'none');
  const badge = activeForm && activeForm.querySelector('[id$="confirmedBadge"]');
  if (badge) badge.style.display = 'inline';
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.className = 'btn btn-sm btn-success';
    confirmBtn.innerHTML = '<i class="fa fa-check"></i> 已确认使用';
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
      if (prefix === 'restore-') {
        state.confirmedStorage = '';
        state.storageSaved = false;
        state.storageTested = false;
        applyRestoreTransferView();
        const badge = document.querySelector('#step-2r [id$="confirmedBadge"]');
        if (badge) badge.style.display = 'none';
        document.querySelectorAll('#step-2r .storage-form [id$="testResult"]').forEach(el => {
          el.style.display = 'none';
        });
        document.querySelectorAll('#step-2r .storage-form button[onclick*="testStorage"]').forEach(btn => {
          btn.className = 'btn btn-sm btn-primary';
          btn.innerHTML = '<i class="fa fa-flask"></i> 测试存储';
        });
        document.querySelectorAll('#step-2r .storage-form button[onclick*="confirmStorage"]').forEach(btn => {
          btn.className = 'btn btn-sm btn-primary';
          btn.innerHTML = '<i class="fa fa-check"></i> 确定使用';
        });
      }
    });
  });
}
bindStorageTabs('fresh-');
bindStorageTabs('restore-');
restoreInstallSession();

/* ==================== 工具 ==================== */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return (index === 0 ? Math.round(value) : value.toFixed(2)) + ' ' + units[index];
}
</script>
</body>
</html>`;
}

/* ---------------------------------------------------------------------- *
 * 6 个存储表单（共用代码：fresh- 前缀和 restore- 前缀同时渲染）
 * ---------------------------------------------------------------------- */
function renderStorageForms(prefix: string): string {
  const p = prefix.replace(/-$/, '_');
  return `
    <div class="storage-form active" id="${prefix}form-r2">
      <div class="alert alert-info">Worker 运行时使用 <code>FILE_R2</code> 绑定。远程恢复文件时，还需填写 R2 S3 API 凭据供原站 rec.php 直接流式上传。</div>
      <div class="form-group"><label>Account ID</label>
        <input type="text" name="${p}r2_account_id" class="form-control"></div>
      <div class="form-group"><label>Bucket</label>
        <input type="text" name="${p}r2_bucket" class="form-control"></div>
      <div class="form-group"><label>Access Key ID</label>
        <input type="text" name="${p}r2_access_key_id" class="form-control"></div>
      <div class="form-group"><label>Secret Access Key</label>
        <input type="password" name="${p}r2_secret_access_key" class="form-control"></div>
      <div class="form-group"><label>S3 API Endpoint（可选）</label>
        <input type="text" name="${p}r2_endpoint" class="form-control" placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com"></div>
      <div class="button-row"><button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button><button type="button" class="btn btn-sm btn-primary" onclick="confirmStorage('${prefix}')"><i class="fa fa-check"></i> 确定使用</button><span id="${prefix}confirmedBadge" style="display:none; color:#5cb85c; font-size:13px"><i class="fa fa-check-circle"></i> 已确认</span></div>
      <div id="${prefix}testResult" style="display:none"></div>
    </div>
    <div class="storage-form" id="${prefix}form-s3">
      <div class="form-group"><label>Endpoint <span class="required">*</span></label>
        <input type="text" name="${p}s3_endpoint" class="form-control" placeholder="https://s3.amazonaws.com"></div>
      <div class="form-group"><label>Region <span class="required">*</span></label>
        <input type="text" name="${p}s3_region" class="form-control" placeholder="us-east-1"></div>
      <div class="form-group"><label>Bucket <span class="required">*</span></label>
        <input type="text" name="${p}s3_bucket" class="form-control"></div>
      <div class="form-group"><label>AccessKey ID <span class="required">*</span></label>
        <input type="text" name="${p}s3_ak" class="form-control"></div>
      <div class="form-group"><label>SecretAccessKey <span class="required">*</span></label>
        <input type="password" name="${p}s3_sk" class="form-control"></div>
      <div class="button-row"><button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button><button type="button" class="btn btn-sm btn-primary" onclick="confirmStorage('${prefix}')"><i class="fa fa-check"></i> 确定使用</button><span id="${prefix}confirmedBadge" style="display:none; color:#5cb85c; font-size:13px"><i class="fa fa-check-circle"></i> 已确认</span></div>
      <div id="${prefix}testResult" style="display:none"></div>
    </div>
    <div class="storage-form" id="${prefix}form-github">
      <div class="alert alert-info">需要 Token 具备 <code>repo</code> 权限。</div>
      <div class="form-group"><label>仓库 Owner <span class="required">*</span></label>
        <input type="text" name="${p}gh_owner" class="form-control" placeholder="octocat"></div>
      <div class="form-group"><label>仓库名 <span class="required">*</span></label>
        <input type="text" name="${p}gh_repo" class="form-control"></div>
      <div class="form-group"><label>Personal Access Token <span class="required">*</span></label>
        <input type="password" name="${p}gh_token" class="form-control" placeholder="ghp_xxx"></div>
      <div class="form-group"><label>分支（留空用默认）</label>
        <input type="text" name="${p}gh_ref" class="form-control" placeholder="main"></div>
      <div class="form-group"><label>API Base</label>
        <input type="text" name="${p}gh_api_base" class="form-control" value="https://api.github.com"></div>
      <div class="form-group"><label>直连下载代理前缀（可留空）</label>
        <input type="text" name="${p}gh_download_proxy" class="form-control" placeholder="https://ghfast.top/"></div>
      <div class="button-row"><button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button><button type="button" class="btn btn-sm btn-primary" onclick="confirmStorage('${prefix}')"><i class="fa fa-check"></i> 确定使用</button><span id="${prefix}confirmedBadge" style="display:none; color:#5cb85c; font-size:13px"><i class="fa fa-check-circle"></i> 已确认</span></div>
      <div id="${prefix}testResult" style="display:none"></div>
    </div>
    <div class="storage-form" id="${prefix}form-webdav">
      <div class="form-group"><label>WebDAV 服务地址 <span class="required">*</span></label>
        <input type="text" name="${p}webdav_endpoint" class="form-control" placeholder="https://dav.example.com/remote.php/webdav/"></div>
      <div class="form-group"><label>用户名 <span class="required">*</span></label>
        <input type="text" name="${p}webdav_user" class="form-control"></div>
      <div class="form-group"><label>密码 <span class="required">*</span></label>
        <input type="password" name="${p}webdav_pass" class="form-control"></div>
      <div class="form-group"><label>存储子目录</label>
        <input type="text" name="${p}webdav_folder" class="form-control" value="file"></div>
      <div class="button-row"><button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button><button type="button" class="btn btn-sm btn-primary" onclick="confirmStorage('${prefix}')"><i class="fa fa-check"></i> 确定使用</button><span id="${prefix}confirmedBadge" style="display:none; color:#5cb85c; font-size:13px"><i class="fa fa-check-circle"></i> 已确认</span></div>
      <div id="${prefix}testResult" style="display:none"></div>
    </div>
    <div class="storage-form" id="${prefix}form-upyun">
      <div class="form-group"><label>服务名 (Bucket) <span class="required">*</span></label>
        <input type="text" name="${p}upyun_bucket" class="form-control"></div>
      <div class="form-group"><label>操作员 <span class="required">*</span></label>
        <input type="text" name="${p}upyun_operator" class="form-control"></div>
      <div class="form-group"><label>操作员密码 <span class="required">*</span></label>
        <input type="password" name="${p}upyun_password" class="form-control"></div>
      <div class="form-group"><label>API 端点</label>
        <input type="text" name="${p}upyun_endpoint" class="form-control" value="https://v0.api.upyun.com"></div>
      <div class="form-group"><label>加速域名</label>
        <input type="text" name="${p}upyun_domain" class="form-control" placeholder="https://xxx.b0.upaiyun.com"></div>
      <div class="form-group"><label>存储子目录</label>
        <input type="text" name="${p}upyun_folder" class="form-control" value="file"></div>
      <div class="button-row"><button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button><button type="button" class="btn btn-sm btn-primary" onclick="confirmStorage('${prefix}')"><i class="fa fa-check"></i> 确定使用</button><span id="${prefix}confirmedBadge" style="display:none; color:#5cb85c; font-size:13px"><i class="fa fa-check-circle"></i> 已确认</span></div>
      <div id="${prefix}testResult" style="display:none"></div>
    </div>
    <div class="storage-form" id="${prefix}form-qiniu">
      <div class="form-group"><label>AccessKey (AK) <span class="required">*</span></label>
        <input type="text" name="${p}qiniu_ak" class="form-control"></div>
      <div class="form-group"><label>SecretKey (SK) <span class="required">*</span></label>
        <input type="password" name="${p}qiniu_sk" class="form-control"></div>
      <div class="form-group"><label>Bucket <span class="required">*</span></label>
        <input type="text" name="${p}qiniu_bucket" class="form-control"></div>
      <div class="form-group"><label>空间绑定域名</label>
        <input type="text" name="${p}qiniu_domain" class="form-control" placeholder="https://cdn.example.com"></div>
      <div class="form-group"><label>存储子目录</label>
        <input type="text" name="${p}qiniu_folder" class="form-control" value="file"></div>
      <div class="button-row"><button type="button" class="btn btn-sm btn-info" onclick="testStorage('${prefix}')"><i class="fa fa-flask"></i> 测试读写</button><button type="button" class="btn btn-sm btn-primary" onclick="confirmStorage('${prefix}')"><i class="fa fa-check"></i> 确定使用</button><span id="${prefix}confirmedBadge" style="display:none; color:#5cb85c; font-size:13px"><i class="fa fa-check-circle"></i> 已确认</span></div>
      <div id="${prefix}testResult" style="display:none"></div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- *
 * 路由
 * ---------------------------------------------------------------------- */

/** 站点已安装时锁定 /install：除携带有效恢复会话的请求外，页面与安装 API 一律拒绝 */
async function isInstallLocked(c: any): Promise<boolean> {
  try {
    const db = getDB(c);
    const { results } = await db.prepare("SELECT v FROM pre_config WHERE k='installed'").all<{ v: string }>();
    if (results[0]?.v !== '1') return false;
    const sessId = readSessionId(c.req.raw);
    if (sessId) {
      const sess = await getInstallSession(db, sessId);
      if (sess && !sess.freshInstall) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function installLockedResponse(c: any) {
  return c.json({ code: 1, msg: '站点已安装，安装接口已锁定' }, 403);
}

/** GET /install - 安装向导首页 */
install.get('/', async (c) => {
  if (await isInstallLocked(c)) {
    return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>已安装 - 彩虹外链网盘</title>
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
<link rel="stylesheet" href="https://s4.zstatic.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
<style>
body { background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
.install-locked { background: #fff; padding: 40px 50px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.13); text-align: center; max-width: 500px; }
.install-locked i { font-size: 48px; color: #5b9661; margin-bottom: 15px; }
.install-locked h3 { margin: 10px 0; color: #333; }
.install-locked p { color: #777; margin: 8px 0 20px; line-height: 1.6; }
.install-locked a { color: #3c78a8; text-decoration: none; }
.install-locked a:hover { text-decoration: underline; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; }
  .install-locked { background: #2a2a2a; box-shadow: 0 1px 3px rgba(0,0,0,.5); }
  .install-locked h3 { color: #eee; }
  .install-locked p { color: #aaa; }
  .install-locked code { background: #333; color: #f0c674; padding: 2px 6px; border-radius: 3px; }
}
</style>
</head>
<body>
<div class="install-locked">
  <i class="fa fa-check-circle"></i>
  <h3>你已经成功安装</h3>
  <p>如需重新安装，请在 Cloudflare D1 数据库中执行以下 SQL 删除安装锁：</p>
  <code>DELETE FROM pre_config WHERE k='installed';</code>
  <div id="reinstallMsg" style="display:none; margin:10px 0; padding:8px 12px; border-radius:4px; font-size:13px;"></div>
  <form id="reinstallForm" onsubmit="return false;">
    <div style="text-align:left; max-width:320px; margin:16px auto 0;">
      <div style="font-weight:bold; margin-bottom:8px;">重新安装</div>
      <input id="reinstallUser" type="text" class="form-control" placeholder="管理员账号" style="margin-bottom:6px; height:34px;">
      <input id="reinstallPass" type="password" class="form-control" placeholder="管理员密码" style="margin-bottom:10px; height:34px;">
      <button type="button" class="btn btn-danger btn-block" onclick="doReinstall()"><i class="fa fa-refresh"></i> 验证并重新安装</button>
    </div>
  </form>
  <p style="margin-top:20px"><a href="/"><i class="fa fa-home"></i> 返回首页</a> &nbsp;|&nbsp; <a href="/admin"><i class="fa fa-cog"></i> 管理后台</a></p>
</div>
<script>
function doReinstall() {
  var user = document.getElementById('reinstallUser').value;
  var pass = document.getElementById('reinstallPass').value;
  var msg = document.getElementById('reinstallMsg');
  function show(txt, isErr) {
    msg.style.display = 'block';
    msg.style.background = isErr ? '#f2dede' : '#dff0d8';
    msg.style.color = isErr ? '#a94442' : '#3c763d';
    msg.textContent = txt;
  }
  if (!user || !pass) { show('请填写管理员账号和密码', true); return; }
  fetch('/install/api/reinstall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: user, pass: pass }),
    credentials: 'same-origin',
  }).then(function (r) { return r.json(); }).then(function (json) {
    if (json.code === 0 && json.verified) {
      if (!confirm('即将清除当前安装数据并重新进入安装向导，确定继续吗？')) {
        show('已取消重新安装', true);
        return;
      }
      fetch('/install/api/reinstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user, pass: pass, confirm: true }),
        credentials: 'same-origin',
      }).then(function (r) { return r.json(); }).then(function (json2) {
        if (json2.code === 0) {
          show('验证通过，即将进入安装向导…', false);
          setTimeout(function () { window.location.href = '/install'; }, 800);
        } else {
          show(json2.msg || json2.error || '解锁失败', true);
        }
      }).catch(function () { show('网络错误', true); });
    } else if (json.code === 0) {
      show(json.msg || '验证通过', false);
      setTimeout(function () { window.location.href = '/install'; }, 800);
    } else {
      show(json.msg || json.error || '验证失败', true);
    }
  }).catch(function () { show('网络错误', true); });
}
</script>
</body>
</html>`, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  return c.html(wizardPage());
});

/** GET /install (兼容无尾斜杠) */
install.get('', async (c) => {
  try {
    const db = getDB(c);
    const { results } = await db.prepare("SELECT v FROM pre_config WHERE k='installed'").all<{ v: string }>();
    if (results[0]?.v === '1') {
      return c.redirect('/install', 302);
    }
  } catch {}
  return c.html(wizardPage());
});

/** POST /install/api/reinstall - 验证管理员密码后解锁重新安装（需 confirm=true 才真正删除锁） */
install.post('/api/reinstall', async (c) => {
  try {
    const db = getDB(c);
    const { results } = await db.prepare("SELECT v FROM pre_config WHERE k='installed'").all<{ v: string }>();
    if (results[0]?.v !== '1') return jsonResult(c, { code: 0, msg: '尚未安装，无需解锁' });
    const body = await c.req.json().catch(() => ({}));
    const user = String(body.user || '');
    const pass = String(body.pass || '');
    const confirm = body.confirm === true || body.confirm === 'true';
    const adminUser = await db.prepare("SELECT v FROM pre_config WHERE k='admin_user'").first<{ v: string }>();
    const adminPwd = await db.prepare("SELECT v FROM pre_config WHERE k='admin_pwd'").first<{ v: string }>();
    if (user && adminUser?.v && pass && adminPwd?.v
      && user === adminUser.v && pass === adminPwd.v) {
      if (!confirm) {
        // 第一步：仅验证账号密码，不删除锁
        return jsonResult(c, { code: 0, msg: '管理员验证通过', verified: true });
      }
      // 第二步：确认后删除安装锁并清空安装会话，允许重新进入向导
      await db.prepare("DELETE FROM pre_config WHERE k='installed'").run();
      const tableCheck = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='install_session'").first<{ name: string }>();
      if (tableCheck) await db.prepare('DELETE FROM install_session').run();
      clearConfigCache();
      return jsonResult(c, { code: 0, msg: '已解锁，重新开始安装' });
    }
    return jsonError(c, '管理员账号或密码错误');
  } catch (e: any) {
    return jsonError(c, '解锁失败: ' + (e?.message || e));
  }
});

/** GET /install/api/session - 刷新安装向导后恢复会话状态 */
install.get('/api/session', async (c) => {
  if (await isInstallLocked(c)) return installLockedResponse(c);
  try {
    const db = getDB(c);
    const sessionId = readSessionId(c.req.raw);
    if (!sessionId) return jsonResult(c, { code: 0, data: null });
    const sess = await getInstallSession(db, sessionId);
    if (!sess || sess.freshInstall) return jsonResult(c, { code: 0, data: null });
    return new Response(JSON.stringify({
      code: 0,
      data: {
        sessionId: sess.id,
        preExtract: sess.preExtract,
        storageType: sess.storageType,
        storageFields: sess.storageFields,
        selectedConfig: sess.selectedConfig,
        sourceUrl: sess.sourceUrl || '',
        remoteSourceUrl: sess.remoteSourceUrl || '',
        remoteAdminUser: sess.remoteAdminUser || '',
        taskId: sess.taskId || '',
        taskStatus: sess.taskStatus || null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sessionSetCookieHeader(sess.id) } });
  } catch (e: any) {
    return jsonError(c, '恢复安装会话失败: ' + (e.message || e));
  }
});

/** POST /install/api/draft - 保存用户修改的配置勾选和值 */
install.post('/api/draft', async (c) => {
  if (await isInstallLocked(c)) return installLockedResponse(c);
  try {
    const db = getDB(c);
    const formData = await c.req.formData();
    const sessionId = String(formData.get('sessionId') || '');
    const configJson = String(formData.get('config_json') || '{}');
    if (!sessionId) return jsonError(c, '缺少 sessionId');
    const selectedConfig = JSON.parse(configJson);
    if (!selectedConfig || typeof selectedConfig !== 'object') return jsonError(c, 'config_json 格式错误');
    const sess = await updateInstallSession(db, sessionId, { selectedConfig });
    if (!sess) return jsonError(c, '会话不存在或已过期');
    return jsonResult(c, { code: 0, msg: '草稿已保存' });
  } catch (e: any) {
    return jsonError(c, '保存草稿失败: ' + (e.message || e));
  }
});

/** POST /install/save - 兼容旧的"全新安装"一站式保存 */
install.post('/save', async (c) => {
  if (await isInstallLocked(c)) return installLockedResponse(c);
  try {
    const body = await c.req.parseBody() as Record<string, string>;
    const storageType = String(body['storage_type'] || '');
    const adminUser = String(body['admin_user'] || 'admin');
    const adminPwd = String(body['admin_pwd'] || '');
    const title = String(body['title'] || '彩虹外链网盘');

    if (!adminPwd) return jsonError(c, '管理员密码不能为空');
    if (!storageType) return jsonError(c, '请选择存储类型');

    const db = getDB(c);

    // The fresh-install form prefixes storage fields with fresh_. Normalize
    // them before writing so the config keys match the storage factory.
    const storageKeys = [
      'r2_account_id', 'r2_bucket', 'r2_access_key_id', 'r2_secret_access_key', 'r2_endpoint',
      's3_endpoint', 's3_region', 's3_bucket', 's3_ak', 's3_sk',
      'gh_owner', 'gh_repo', 'gh_token', 'gh_ref', 'gh_api_base', 'gh_download_proxy',
      'webdav_endpoint', 'webdav_user', 'webdav_pass', 'webdav_folder',
      'upyun_bucket', 'upyun_operator', 'upyun_password', 'upyun_endpoint', 'upyun_domain', 'upyun_folder',
      'qiniu_ak', 'qiniu_sk', 'qiniu_bucket', 'qiniu_domain', 'qiniu_folder',
      'uploadfile_type', 'downfile_type', 'downfile_protocol', 'downfile_domain',
    ];
    const normalized: Record<string, string> = {};
    for (const key of storageKeys) {
      const value = body[key] ?? body['fresh_' + key];
      if (value !== undefined && String(value) !== '') normalized[key] = String(value);
    }

    const required: Record<string, string[]> = {
      s3: ['s3_endpoint', 's3_bucket', 's3_ak', 's3_sk'],
      github: ['gh_owner', 'gh_repo', 'gh_token'],
      webdav: ['webdav_endpoint', 'webdav_user', 'webdav_pass'],
      upyun: ['upyun_bucket', 'upyun_operator', 'upyun_password'],
      qiniu: ['qiniu_ak', 'qiniu_sk', 'qiniu_bucket'],
    };
    const missing = (required[storageType] || []).filter(key => !normalized[key]);
    if (missing.length) return jsonError(c, '存储配置不完整，缺少: ' + missing.join(', '));
    if (storageType === 'r2' && !(c.env as any).FILE_R2) {
      return jsonError(c, 'R2 绑定 FILE_R2 未找到，请先在 Cloudflare 配置 R2 绑定');
    }

    // 写入所有字段
    await updateConfig(db, 'admin_user', adminUser);
    await updateConfig(db, 'admin_pwd', adminPwd);
    await updateConfig(db, 'title', title);
    await updateConfig(db, 'storage', storageType);

    // 存储相关字段
    for (const [cfgKey, value] of Object.entries(normalized)) {
      await updateConfig(db, cfgKey, value);
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
  if (await isInstallLocked(c)) return installLockedResponse(c);
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
    // 传完整 c.env（factory 内部可能读 env 上的其它绑定）
    const stor = createStorage(cfg as any, c.env as any);
    if (!stor) {
      let extra = '';
      if (storageType === 'r2' && !(c.env as any).FILE_R2) {
        extra = '（R2 绑定 FILE_R2 未找到，请检查 wrangler.toml 或 Cloudflare Dashboard 中的绑定配置）';
      } else {
        const missing: string[] = [];
        const req: Record<string, string[]> = {
          s3: ['s3_endpoint', 's3_bucket', 's3_ak', 's3_sk'],
          github: ['gh_owner', 'gh_repo', 'gh_token'],
          webdav: ['webdav_endpoint', 'webdav_user', 'webdav_pass'],
          upyun: ['upyun_bucket', 'upyun_operator', 'upyun_password'],
          qiniu: ['qiniu_ak', 'qiniu_sk', 'qiniu_bucket'],
        };
        for (const k of req[storageType] || []) if (!cfg[k]) missing.push(k);
        if (missing.length) extra = '（缺少必填字段: ' + missing.join(', ') + '）';
      }
      return jsonResult(c, { code: -1, msg: '无法创建存储实例，请检查配置' + extra, data: { ok: false, message: '无法创建存储实例，请检查配置' + extra } });
    }

    const testKey = '_install_test_' + Date.now() + '.txt';
    const testBuf = await testFile.arrayBuffer();
    const expected = await testFile.text();
    try {
      const ok = await stor.upload(testKey, testBuf, testFile.type || 'text/plain');
      if (!ok) return jsonResult(c, { code: -1, msg: '写入失败，请检查配置', data: { ok: false, message: '写入失败，请检查配置' } });
      const got = await stor.get(testKey);
      if (!got) return jsonResult(c, { code: -1, msg: '写入成功但读取失败', data: { ok: false, message: '写入成功但读取失败' } });
      const text = await new Response(got.body).text();
      await stor.delete(testKey);
      if (text !== expected) return jsonResult(c, { code: -1, msg: '读取内容不一致', data: { ok: false, message: '读取内容不一致' } });
      return jsonResult(c, { code: 0, msg: '读写测试通过', data: { ok: true, message: '读写测试通过' } });
    } catch (e: any) {
      return jsonResult(c, { code: -1, msg: '测试失败: ' + (e.message || e), data: { ok: false, message: '测试失败: ' + (e.message || e) } });
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
  if (await isInstallLocked(c)) return installLockedResponse(c);
  try {
    const db = getDB(c);
    const formData = await c.req.formData();
    const remoteSourceUrl = String(formData.get('remote_source_url') || '').trim();
    const remoteAdminUser = String(formData.get('remote_admin_user') || '').trim();
    const remoteAdminPassword = String(formData.get('remote_admin_password') || '');
    if (!remoteSourceUrl || !remoteAdminUser || !remoteAdminPassword) return jsonError(c, '请填写原站地址、管理员账号和密码');
    if (!remoteSourceUrl.startsWith('http://') && !remoteSourceUrl.startsWith('https://')) return jsonError(c, '原站地址必须以 http:// 或 https:// 开头');
    const sqlFile = formData.get('sql_file') as File | null;
    let sqlText = '';
    let preExtract: SqlPreExtractResult;
    if (sqlFile && sqlFile.size > 0) {
      if (sqlFile.size > 90 * 1024 * 1024) return jsonError(c, 'SQL 文件太大');
      sqlText = await sqlFile.text();
      if (!sqlText.trim()) return jsonError(c, 'SQL 文件内容为空');
      preExtract = extractFromSql(sqlText);
    } else {
      const secret = c.env.REMOTE_RESTORE_SECRET;
      if (!secret) return jsonError(c, '未配置远程恢复通信密钥');
      const exported: any = await remoteExport(secret, remoteSourceUrl, remoteAdminUser, remoteAdminPassword);
      sqlText = String(exported.sql || '');
      preExtract = extractFromSql(sqlText);
      // PHP 同时返回配置字典。即使 SQL 解析器遇到方言或转义差异，也不能丢失
      // storage=local 和 qiniu_* 等字段，否则第二步无法显示存储推荐。
      for (const [key, value] of Object.entries(exported.settings || {})) {
        preExtract.preConfig[key] = String(value ?? '');
      }
      const remoteCandidates: Array<{ name: string; required: string[]; prefix: string }> = [
        { name: 'r2', required: ['r2_account_id', 'r2_access_key_id', 'r2_secret_access_key', 'r2_bucket'], prefix: 'r2_' },
        { name: 'qiniu', required: ['qiniu_ak', 'qiniu_sk', 'qiniu_bucket'], prefix: 'qiniu_' },
        { name: 'upyun', required: ['upyun_bucket', 'upyun_operator', 'upyun_password'], prefix: 'upyun_' },
        { name: 'webdav', required: ['webdav_endpoint', 'webdav_user', 'webdav_pass'], prefix: 'webdav_' },
        { name: 's3', required: ['s3_endpoint', 's3_bucket', 's3_ak', 's3_sk'], prefix: 's3_' },
        { name: 'github', required: ['gh_owner', 'gh_repo', 'gh_token'], prefix: 'gh_' },
      ];
      const remoteCandidate = remoteCandidates.find(item => item.required.every(key => String(preExtract.preConfig[key] || '').trim() !== ''));
      if (preExtract.preConfig.storage === 'local' && remoteCandidate) {
        preExtract.suggestedStorage = remoteCandidate.name;
        preExtract.suggestedStorageFields = {};
        for (const [key, value] of Object.entries(preExtract.preConfig)) {
          if (key.startsWith(remoteCandidate.prefix) && value) preExtract.suggestedStorageFields[key] = value;
        }
      }
    }
    // 写入 D1（跨实例可用）
    const sess = await createInstallSession(db, { sqlText, preExtract, freshInstall: false, remoteSourceUrl, remoteAdminUser, remoteAdminPassword });
    return new Response(JSON.stringify({
      code: 0,
      data: {
        sessionId: sess.id,
        preExtract,
        remoteSourceUrl,
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
  if (await isInstallLocked(c)) return installLockedResponse(c);
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
    const required: Record<string, string[]> = {
      s3: ['s3_endpoint', 's3_bucket', 's3_ak', 's3_sk'],
      github: ['gh_owner', 'gh_repo', 'gh_token'],
      webdav: ['webdav_endpoint', 'webdav_user', 'webdav_pass'],
      upyun: ['upyun_bucket', 'upyun_operator', 'upyun_password'],
      qiniu: ['qiniu_ak', 'qiniu_sk', 'qiniu_bucket'],
    };
    if (storageType === 'r2' && (sess.preExtract?.fileCount || 0) > 0) {
      required.r2 = ['r2_account_id', 'r2_bucket', 'r2_access_key_id', 'r2_secret_access_key'];
    }
    const missing = (required[storageType] || []).filter(key => !fields[key]);
    if (missing.length) return jsonError(c, '存储配置不完整，缺少: ' + missing.join(', '));
    if (storageType === 'r2' && !(c.env as any).FILE_R2) {
      return jsonError(c, 'R2 绑定 FILE_R2 未找到，请先在 Cloudflare 配置 R2 绑定');
    }
    const candidate = createStorage({ storage: storageType, ...fields } as any, c.env as any);
    if (!candidate) return jsonError(c, '无法创建存储实例，请检查存储配置');
    // 确定使用时先持久化存储配置，后续文件下载请求可直接从 D1 重载。
    await updateConfig(db, 'storage', storageType);
    for (const [k, v] of Object.entries(fields)) {
      await updateConfig(db, k, v);
    }
    clearConfigCache();
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
  if (await isInstallLocked(c)) return installLockedResponse(c);
  try {
    const db = getDB(c);
    const formData = await c.req.formData();
    const sessionId = String(formData.get('sessionId') || '');
    const configJson = String(formData.get('config_json') || '{}');
    const storageType = String(formData.get('storage_type') || '');
    const authToken = String(formData.get('auth_token') || '');
    if (!sessionId) return jsonError(c, '缺少 sessionId');
    const sess = await getInstallSession(db, sessionId);
    if (!sess) return jsonError(c, '会话不存在或已过期（30分钟），请重新上传 SQL');
    if (!storageType) return jsonError(c, '请先选择存储类型');
    if (sess.storageType !== storageType || (storageType !== 'r2' && (!sess.storageFields || Object.keys(sess.storageFields).length === 0))) {
      return jsonError(c, '存储配置尚未确认保存，请先在第二步点击“确定使用”');
    }

    // 收集 storage 字段
    const storageFields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) {
      const key = String(k);
      if (key === 'sessionId' || key === 'config_json' || key === 'storage_type' || key === 'auth_token') continue;
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
    console.log('[install] config-apply: storageType =', storageType, 'storageFields =', JSON.stringify(storageFields));
    await updateConfig(db, 'storage', storageType);
    for (const [k, v] of Object.entries(storageFields)) {
      console.log('[install] config-apply: updateConfig', k, '=', v);
      await updateConfig(db, k, v);
    }
    // 2) 写用户勾选的 pre_config
    for (const [k, v] of Object.entries(filtered)) {
      console.log('[install] config-apply: updateConfig (selected)', k, '=', v);
      await updateConfig(db, k, v);
    }
    // 3) 写回原 SQL 中的其它表（pre_file / pre_user 等），跳过 pre_config
    // 确保核心表存在（用户的 SQL 可能没有 CREATE TABLE）
    await db.prepare(`CREATE TABLE IF NOT EXISTS pre_file (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
      hash TEXT NOT NULL, addtime TEXT NOT NULL, lasttime TEXT, ip TEXT,
      hide INTEGER DEFAULT 0, pwd TEXT, uid INTEGER DEFAULT 0, block INTEGER DEFAULT 0, count INTEGER DEFAULT 0
    )`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pre_file_hash ON pre_file(hash)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pre_file_uid ON pre_file(uid)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pre_file_ip ON pre_file(ip)').run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS pre_user (
      uid INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT, openid TEXT, nickname TEXT, faceimg TEXT,
      level INTEGER DEFAULT 0, enable INTEGER DEFAULT 1,
      regip TEXT, loginip TEXT, addtime TEXT, lasttime TEXT
    )`).run();
    const taskId = 'inst_sql_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    createRestoreTask(taskId);
    // 同步执行（因为要返回结果）
    const result = await restoreDatabaseFromSql(db, sess.sqlText, taskId, { skipPreConfig: true });
    // 某些 MySQL 转储的 pre_file INSERT 可能因方言差异无法直接执行，兜底用解析后的字段写入 D1。
    const fileCountRow = await db.prepare('SELECT COUNT(*) AS count FROM pre_file').first<{ count: number }>();
    if (sess.preExtract.fileCount > 0) {
      const records = extractPreFileRecords(sess.sqlText);
      console.warn('[install] config-apply: 解析 pre_file，D1 当前记录数=' + (fileCountRow?.count || 0) + '，解析记录数=' + records.length);
      if (records.length === 0) {
        return jsonError(c, 'SQL 中检测到 ' + sess.preExtract.fileCount + ' 个文件，但无法解析 pre_file 记录，文件元数据未写入 D1');
      }
      for (const file of records) {
        await db.prepare(
          `INSERT OR REPLACE INTO pre_file (id, name, type, size, hash, addtime, lasttime, ip, hide, pwd, block, count, uid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          file.id, file.name, file.type, file.size, file.hash,
          file.addtime, file.lasttime, file.ip, file.hide, file.pwd, file.block, file.count, file.uid,
        ).run();
      }
    }
    const finalFileCount = await db.prepare('SELECT COUNT(*) AS count FROM pre_file').first<{ count: number }>();
    if (sess.preExtract.fileCount > 0 && !(finalFileCount?.count || 0)) {
      return jsonError(c, '文件元数据写入 D1 失败，pre_file 仍为空');
    }
    // 标记 installed
    await updateConfig(db, 'installed', '1');
    clearConfigCache();
    // 保留 session 以便后续 step-3 下载文件
    await updateInstallSession(db, sessionId, { storageType, storageFields, selectedConfig: filtered });

    if (sess.remoteSourceUrl && sess.remoteAdminUser && sess.remoteAdminPassword) {
      const remoteStorageFields = Object.fromEntries(Object.entries(storageFields).map(([k, v]) => [k, String(v)]));
      const workerUrl = new URL(c.req.url).origin + '/install';
      await saveRemoteRestoreConfig(sess.remoteSourceUrl, {
        admin_user: sess.remoteAdminUser,
        admin_password: sess.remoteAdminPassword,
        storage_type: storageType,
        storage_fields: remoteStorageFields,
        worker_url: workerUrl,
        auth_token: authToken,
      });
    }

    return new Response(JSON.stringify({
      code: 0,
      msg: '配置已应用',
      data: {
        sessionId,
        appliedConfigCount: Object.keys(filtered).length,
        sqlResult: result,
        fileCount: sess.preExtract.fileCount,
        databaseFileCount: finalFileCount?.count || 0,
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

/** POST /install/api/skip-restore - 跳过文件恢复，清除安装会话 */
install.post('/api/skip-restore', async (c) => {
  const db = getDB(c);
  const sessionId = readSessionId(c.req.raw);
  if (sessionId) {
    try {
      await db.prepare('DELETE FROM install_session WHERE id = ?').bind(sessionId).run();
    } catch { /* 忽略 */ }
  }
  return jsonResultWithCookie(c, { code: 0, msg: '已跳过恢复' }, sessionClearCookieHeader());
});

/** POST /install/api/finish - 安装完成后清除安装会话与浏览器 Cookie */
install.post('/api/finish', async (c) => {
  const db = getDB(c);
  const sessionId = readSessionId(c.req.raw);
  if (sessionId) {
    try {
      await db.prepare('DELETE FROM install_session WHERE id = ?').bind(sessionId).run();
    } catch { /* 忽略 */ }
  }
  return jsonResultWithCookie(c, { code: 0, msg: 'ok' }, sessionClearCookieHeader());
});

/** POST /install/api/files-from-source - 从原站点下载文件 */
install.post('/api/files-from-source', async (c) => {
  if (await isInstallLocked(c)) return installLockedResponse(c);
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

    // 防止恢复流程跳过 config-apply：文件任务开始前必须先把管理员和恢复配置写入 D1。
    const currentConfig = await loadConfig(db);
    const selectedConfig = sess.selectedConfig || {};
    if (!currentConfig.admin_user || !currentConfig.admin_pwd || currentConfig.installed !== 1) {
      const adminUser = selectedConfig.admin_user || currentConfig.admin_user || 'admin';
      const adminPwd = selectedConfig.admin_pwd || currentConfig.admin_pwd || '';
      if (!adminPwd) return jsonError(c, '管理员密码未写入，请返回上一步点击“应用配置并完成”');
      await updateConfig(db, 'admin_user', adminUser);
      await updateConfig(db, 'admin_pwd', adminPwd);
      for (const [k, v] of Object.entries(selectedConfig)) {
        if (k === 'storage' || k === 'installed' || k === 'admin_user' || k === 'admin_pwd') continue;
        await updateConfig(db, k, String(v));
      }
      await updateConfig(db, 'installed', '1');
      clearConfigCache();
    }

    // config-apply 写入配置后，中间件里的 c.var.stor 仍是旧缓存，必须重新加载
    const freshConfig = await loadConfig(db);
    // 传完整 c.env（factory 内部可能读 env 上的其它绑定）
    const stor = createStorage(freshConfig, c.env as any);
    if (!stor) {
      const type = freshConfig.storage;
      let extra = '';
      if (type === 'r2' && !(c.env as any).FILE_R2) {
        extra = '（R2 绑定 FILE_R2 未找到，请检查 wrangler.toml 或 Cloudflare Dashboard 中的绑定配置）';
      } else {
        const missing: string[] = [];
        const req: Record<string, string[]> = {
          s3: ['s3_endpoint', 's3_bucket', 's3_ak', 's3_sk'],
          github: ['gh_owner', 'gh_repo', 'gh_token'],
          webdav: ['webdav_endpoint', 'webdav_user', 'webdav_pass'],
          upyun: ['upyun_bucket', 'upyun_operator', 'upyun_password'],
          qiniu: ['qiniu_ak', 'qiniu_sk', 'qiniu_bucket'],
        };
        for (const k of req[type] || []) if (!(freshConfig as any)[k]) missing.push(k);
        if (missing.length) extra = '（D1 中缺少必填字段: ' + missing.join(', ') + '）';
      }
      return jsonError(c, 'Storage not configured: storage="' + type + '"' + extra);
    }
    const taskId = 'inst_dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const task = createRestoreTask(taskId);
    await updateInstallSession(db, sessionId, { sourceUrl, taskId, taskStatus: task as unknown as Record<string, unknown> });

    c.executionCtx.waitUntil((async () => {
      let persistTimer: ReturnType<typeof setInterval> | undefined;
      const persistTask = async () => {
        const current = getRestoreStatus(taskId);
        if (current) await updateInstallSession(db, sessionId, { taskStatus: current as unknown as Record<string, unknown> });
      };
      try {
        // 任务进度原本只在 Worker 内存中，定期写入 D1，刷新或实例切换后仍可显示。
        persistTimer = setInterval(() => { void persistTask(); }, 1000);
        const remote = sess.remoteSourceUrl && sess.remoteAdminUser && sess.remoteAdminPassword
          ? {
              secret: c.env.REMOTE_RESTORE_SECRET || '',
              sourceUrl: sess.remoteSourceUrl,
              adminUser: sess.remoteAdminUser,
              adminPassword: sess.remoteAdminPassword,
            }
          : undefined;
        if (remote) {
          const remoteTask = getRestoreStatus(taskId);
          // 兜底：确保 pre_file 表存在（config-apply 阶段可能因 SQL 方言未成功建表）
          await db.prepare(`CREATE TABLE IF NOT EXISTS pre_file (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
            hash TEXT NOT NULL, addtime TEXT NOT NULL, lasttime TEXT, ip TEXT,
            hide INTEGER DEFAULT 0, pwd TEXT, uid INTEGER DEFAULT 0, block INTEGER DEFAULT 0, count INTEGER DEFAULT 0
          )`).run();
          await db.prepare('CREATE INDEX IF NOT EXISTS idx_pre_file_hash ON pre_file(hash)').run();
          // 如果表为空但 session 中有解析好的 pre_file 记录，补写入
          const countRow = await db.prepare('SELECT COUNT(*) AS c FROM pre_file').first<{ c: number }>();
          if (!(countRow?.c || 0) && sess.preExtract?.fileCount > 0 && sess.sqlText) {
            const records = extractPreFileRecords(sess.sqlText);
            if (records.length) {
              for (const file of records) {
                await db.prepare(
                  `INSERT OR REPLACE INTO pre_file (id, name, type, size, hash, addtime, lasttime, ip, hide, pwd, block, count, uid)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                  file.id, file.name, file.type, file.size, file.hash,
                  file.addtime, file.lasttime, file.ip, file.hide, file.pwd, file.block, file.count, file.uid,
                ).run();
              }
            }
          }
          const files = await db.prepare('SELECT id, name, hash, size, type FROM pre_file ORDER BY id').all();
          const fileList: any[] = (files.results || []) as any[];
          if (!fileList.length) throw new Error('pre_file 中没有可恢复的文件记录');
          if (remoteTask) {
            remoteTask.stage = 'files';
            remoteTask.total = fileList.length;
            remoteTask.status = 'running';
            remoteTask.message = '原站 PHP 正在直接上传到目标存储';
            remoteTask.totalBytes = fileList.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
          }
          for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            const current = getRestoreStatus(taskId);
            if (current) {
              current.currentItem = file.name;
              current.currentFileStage = 'upload';
              current.message = `原站 PHP 直传 (${i + 1}/${fileList.length}): ${file.name}`;
            }
            try {
              let lastUploaded = -1;
              const result = await remoteUploadFile(remote.secret, remote.sourceUrl, file.hash, file.type || 'file', remote.adminUser, remote.adminPassword, sess.storageType, sess.storageFields || {}, (ev) => {
                const st = getRestoreStatus(taskId);
                if (!st) return;
                if (ev.type === 'start') {
                  st.fileSpeedStart = Date.now();
                  if (ev.total) {
                    st.currentFileReceived = 0;
                    st.currentFileTotal = ev.total;
                  }
                  return;
                }
                if (ev.type === 'done') {
                  if (ev.total) st.currentFileReceived = st.currentFileTotal || ev.total;
                  return;
                }
                if (ev.type === 'progress' && ev.total) {
                  const up = ev.uploaded || 0;
                  if (up === lastUploaded) return;
                  lastUploaded = up;
                  st.processedBytes = (Number(file.size) || 0) * i + up;
                  st.currentFileStage = 'upload';
                  st.currentFileReceived = up;
                  st.currentFileTotal = ev.total;
                  st.currentFileChunked = true;
                  st.currentFileSpeed = up / Math.max(1, (Date.now() - (st.fileSpeedStart || st.startTime)) / 1000);
                  st.message = `原站 PHP 分片上传 (${i + 1}/${fileList.length}): ${file.name} ${Math.round((up / ev.total) * 100)}%`;
                }
              });
              if (!result.ok) throw new Error(result.error || 'PHP 上传失败');
              const done = getRestoreStatus(taskId);
              if (done) {
                done.success++;
                done.processed = done.success + done.failed;
                done.processedBytes += Number(file.size) || 0;
                done.logs.push(new Date().toISOString() + ` PHP 直传成功: ${file.name}`);
              }
            } catch (error: any) {
              const failed = getRestoreStatus(taskId);
              const message = `${file.name}: PHP 直传失败: ${error.message || error}`;
              if (failed) {
                failed.failed++;
                failed.processed = failed.success + failed.failed;
                failed.errors.push(message);
                failed.logs.push(new Date().toISOString() + ' ' + message);
              }
            }
          }
        } else {
          await restoreFilesFromSource(db, stor, sourceUrl, taskId, 'file', sess.sqlText);
        }
        const t = getRestoreStatus(taskId);
        if (t && t.status !== 'cancelled') {
          t.status = t.failed > 0 ? 'failed' : 'completed';
          t.stage = 'done';
          t.endTime = Date.now();
          t.message = t.failed > 0
            ? `处理完成: 上传成功 ${t.success}, 失败 ${t.failed}`
            : `恢复上传完成: 成功 ${t.success}`;
        }
        await persistTask();
      } catch (e: any) {
        console.error('[install/files-from-source] failed:', e?.message || e);
        const t = getRestoreStatus(taskId);
        if (t) { t.status = 'failed'; t.errors.push('下载失败: ' + (e.message || e)); }
        await persistTask();
      } finally {
        if (persistTimer) clearInterval(persistTimer);
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
  if (await isInstallLocked(c)) return installLockedResponse(c);
  const taskId = c.req.query('taskId') || '';
  if (!taskId) return jsonError(c, '缺少 taskId');
  const db = getDB(c);
  const status = getRestoreStatus(taskId);
  if (status) {
    console.log('[install/status]', taskId, status.status, status.processed + '/' + status.total, status.message);
    // 安装结束（成功或失败）：清除安装会话 cookie，避免下次访问 /install 仍进入恢复模式
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
      const sessionId = readSessionId(c.req.raw);
      if (sessionId) {
        try {
          await db.prepare('DELETE FROM install_session WHERE id = ?').bind(sessionId).run();
        } catch { /* 忽略 */ }
      }
      return jsonResultWithCookie(c, { code: 0, data: status }, sessionClearCookieHeader());
    }
    return jsonResult(c, { code: 0, data: status });
  }
  // 内存中没有任务（可能 Worker 实例切换了），从 D1 恢复
  const sessionId = readSessionId(c.req.raw);
  const sess = sessionId ? await getInstallSession(db, sessionId) : null;
  if (sess?.taskId === taskId && sess.taskStatus) {
    if (sess.taskStatus.status === 'completed' || sess.taskStatus.status === 'failed' || sess.taskStatus.status === 'cancelled') {
      try {
        await db.prepare('DELETE FROM install_session WHERE id = ?').bind(sessionId).run();
      } catch { /* 忽略 */ }
      return jsonResultWithCookie(c, { code: 0, data: sess.taskStatus }, sessionClearCookieHeader());
    }
    return jsonResult(c, { code: 0, data: sess.taskStatus });
  }
  // 实在找不到，返回 waiting 让前端继续轮询而不是报错
  return jsonResult(c, { code: 0, data: {
    status: 'waiting',
    stage: 'files',
    total: 0, processed: 0, success: 0, failed: 0,
    currentItem: '', errors: [], skipped: [],
    startTime: Date.now(),
    message: '任务状态同步中，请等待...',
    totalBytes: 0, processedBytes: 0,
    logs: [],
  }});
});

/** GET /install/api/diag?url=xxx - 诊断源站连通性 */
install.get('/api/diag', async (c) => {
  if (await isInstallLocked(c)) return installLockedResponse(c);
  const url = c.req.query('url') || '';
  if (!url) return jsonError(c, '缺少 url 参数');
  const start = Date.now();
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Range: 'bytes=0-0',
    };
    const res = await fetch(url, { method: 'GET', headers, cf: { cacheTtl: -1 } });
    const elapsed = Date.now() - start;
    const contentLength = res.headers.get('content-length');
    const contentRange = res.headers.get('content-range');
    if (res.body) await res.body.cancel();
    return jsonResult(c, {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type'),
      contentLength,
      contentRange,
      responseBody: res.body ? 'stream' : 'empty',
      elapsed: `${elapsed}ms`,
      headers: Object.fromEntries([...res.headers].slice(0, 10)),
    });
  } catch (e: any) {
    const elapsed = Date.now() - start;
    return jsonResult(c, {
      ok: false,
      error: e?.message || String(e),
      elapsed: `${elapsed}ms`,
    });
  }
});

/** POST /install/api/cancel - 取消任务 */
install.post('/api/cancel', async (c) => {
  if (await isInstallLocked(c)) return installLockedResponse(c);
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

/** GET /install/api/check-restore?url=xxx - 代理查询 rec.php 恢复状态 */
install.get('/api/check-restore', async (c) => {
  if (await isInstallLocked(c)) return installLockedResponse(c);
  const url = c.req.query('url') || '';
  if (!url) return jsonError(c, '缺少 url');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(url + '?action=status', { cf: { cacheTtl: -1 }, signal: controller.signal });
    const json = await resp.json() as any;
    return jsonResult(c, { code: 0, data: json.status || null });
  } catch (e: any) {
    return jsonResult(c, { code: 0, data: null, error: e?.message || '查询失败' });
  } finally {
    clearTimeout(timeout);
  }
});

export default install;
