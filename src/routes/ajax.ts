// 彩虹外链网盘 - 前端 AJAX 路由 (对应原 ajax.php)

import { Hono } from 'hono';
import type { AppEnv, AppVariables } from '../middleware';
import { getDB, getStor, getConf } from '../middleware';
import { getFileByHash, insertFile, deleteFile, getFileById, getTodayUploadCount, now } from '../db';
import { isBlocked, sanitizeFileName } from '../services/upload';
import { getFileExt, getMimeType, isView as isViewExt } from '../utils/mime';
import { jsonError, jsonResult, generateCsrfToken, getClientIP } from '../utils/response';
import { checkImage } from '../services/green';

let csrfTokens: Record<string, string> = {};

const ajax = new Hono<AppEnv>();

// CSRF Token 获取
ajax.get('/csrf', (c) => {
  const token = generateCsrfToken();
  const ip = getClientIP(c);
  csrfTokens[ip] = token;
  return jsonResult(c, { code: 0, token });
});

// 文件预上传 (秒传检测)
ajax.post('/pre_upload', async (c) => {
  const db = getDB(c);
  const config = getConf(c);
  const body = await c.req.parseBody<Record<string, string>>();

  const csrfToken = body['csrf_token'];
  const ip = getClientIP(c);
  if (!csrfToken || csrfToken !== csrfTokens[ip]) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }

  if (config.forcelogin === 1) {
    // 简单检查 user_token cookie
    const userToken = c.req.header('cookie')?.match(/user_token=([^;]+)/)?.[1];
    if (!userToken) return jsonError(c, '请先登录');
  }

  let name = sanitizeFileName(String(body['name'] || ''));
  const hash = String(body['hash'] || '');
  const sizeStr = String(body['size'] || '0');
  const show = String(body['show'] || '1');
  const ispwd = String(body['ispwd'] || '0');
  let pwd = ispwd === '1' ? String(body['pwd'] || '') : null;
  const hide = show === '1' ? 0 : 1;

  if (!name) return jsonError(c, '文件名不能为空');
  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');

  const ext = getFileExt(name);
  const blockMsg = isBlocked(name, ext);
  if (blockMsg) return jsonError(c, '文件上传失败，不支持上传该格式文件');

  if (pwd && !/^[a-zA-Z0-9]+$/.test(pwd)) {
    return jsonError(c, '文件密码只能为字母和数字');
  }

  // 大小限制
  const limitSize = config.upload_size;
  const size = parseInt(sizeStr);

  // 每日上传限制
  const todayCount = await getTodayUploadCount(db, ip, 0);
  if (config.upload_limit > 0 && todayCount >= config.upload_limit) {
    return jsonError(c, '你今天上传文件的数量已超过限制');
  }

  // 秒传检测
  const existing = await getFileByHash(db, hash);
  if (existing) {
    delete csrfTokens[ip];
    return jsonResult(c, {
      code: 1, msg: '本站已存在该文件', exists: 1, hash, name, size, type: ext, id: existing.id,
    });
  }

  // 当前实现：网站中转模式（前端分片上传到 Worker）
  const chunkSize = 8 * 1024 * 1024;
  const chunks = Math.max(1, Math.ceil(size / chunkSize));

  return jsonResult(c, {
    code: 0, third: false, hash,
    chunksize: chunkSize, chunks,
  });
});

// 文件分片上传
ajax.post('/upload_part', async (c) => {
  const db = getDB(c);
  const config = getConf(c);

  const body = await c.req.parseBody<Record<string, string | File>>();
  const file = body['file'] as File | undefined;
  if (!file) return jsonError(c, '请选择文件');

  const csrfToken = String(body['csrf_token'] || '');
  const ip = getClientIP(c);
  if (!csrfToken || csrfToken !== csrfTokens[ip]) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }

  const hash = String(body['hash'] || '');

  if (config.forcelogin === 1) {
    const userToken = c.req.header('cookie')?.match(/user_token=([^;]+)/)?.[1];
    if (!userToken) return jsonError(c, '请先登录');
  }

  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');

  const stor = getStor(c);
  const ext = getFileExt(file.name);
  const arrayBuf = await file.arrayBuffer();

  const success = await stor.upload(hash, arrayBuf, getMimeType(ext));
  if (!success) return jsonError(c, '文件上传失败');

  // 入库
  const name = sanitizeFileName(file.name);
  const hide = 0;
  const pwd = null;

  const existing = await getFileByHash(db, hash);
  if (existing) {
    delete csrfTokens[ip];
    return jsonResult(c, {
      code: 1, msg: '本站已存在该文件', exists: 1, hash, name, size: file.size, type: ext, id: existing.id,
    });
  }

  const id = await insertFile(db, {
    name, type: ext, size: file.size, hash, ip, hide, pwd, uid: 0,
  });

  // 鉴黄
  if (config.green_check > 0) {
    const typeImage = config.type_image.split('|').map(s => s.toLowerCase());
    if (typeImage.includes(ext.toLowerCase())) {
      const checkResult = await checkImage(hash, ext, c.env);
      if (!checkResult.safe) {
        await db.prepare('UPDATE pre_file SET block = 1 WHERE id = ?').bind(id).run();
      }
    }
  }

  // 视频审核
  if (config.videoreview === 1) {
    const typeVideo = config.type_video.split('|').map(s => s.toLowerCase());
    if (typeVideo.includes(ext.toLowerCase())) {
      await db.prepare('UPDATE pre_file SET block = 2 WHERE id = ?').bind(id).run();
    }
  }

  delete csrfTokens[ip];
  return jsonResult(c, {
    code: 1, msg: '文件上传成功！', exists: 0, hash, name, size: file.size, type: ext, id,
  });
});

// 删除文件
ajax.post('/deleteFile', async (c) => {
  const db = getDB(c);
  const stor = getStor(c);
  const body = await c.req.parseBody<Record<string, string>>();

  const hash = String(body['hash'] || '');
  const csrfToken = String(body['csrf_token'] || '');
  const ip = getClientIP(c);

  if (!csrfToken || csrfToken !== csrfTokens[ip]) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }
  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');

  const row = await getFileByHash(db, hash);
  if (!row) return jsonError(c, '文件不存在');
  if (row.block === 1) return jsonError(c, '文件已被冻结，无法删除');

  await stor.delete(row.hash);
  const ok = await deleteFile(db, row.id);
  if (ok) return jsonResult(c, { code: 0, msg: '删除文件成功！' });
  return jsonError(c, '删除文件失败');
});

export default ajax;
