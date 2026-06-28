// 彩虹外链网盘 - 前端 AJAX 路由 (对应原 ajax.php)

import { Hono } from 'hono';
import type { AppEnv, AppVariables } from '../middleware';
import { getDB, getStorOrThrow, getConf } from '../middleware';
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

// 统一处理 ?act=xxx 和 /xxx 两种路由方式
ajax.post('/', async (c) => {
  const act = c.req.query('act');
  if (act === 'pre_upload') return handlePreUpload(c);
  if (act === 'upload_part') return handleUploadPart(c);
  if (act === 'complete_upload') return handleCompleteUpload(c);
  if (act === 'deleteFile') return handleDeleteFile(c);
  return jsonError(c, 'Unknown action');
});

// 路径方式的路由（兼容）
ajax.post('/pre_upload', handlePreUpload);
ajax.post('/upload_part', handleUploadPart);
ajax.post('/complete_upload', handleCompleteUpload);
ajax.post('/deleteFile', handleDeleteFile);

// 文件预上传 (秒传检测)
async function handlePreUpload(c: any) {
  const db = getDB(c);
  const config = getConf(c);
  const body = await c.req.parseBody() as Record<string, string>;
  const ip = getClientIP(c);

  const csrfToken = body['csrf_token'];
  // 验证 cookie 中的 token
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }

  if (config.forcelogin === 1) {
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

  const limitSize = config.upload_size;
  const size = parseInt(sizeStr);

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

  // Workers 没有本地磁盘，强制 chunks=1 让前端一次发送整个文件
  const chunkSize = 8 * 1024 * 1024;
  const chunks = 1;

  return jsonResult(c, {
    code: 0, third: false, hash,
    chunksize: chunkSize, chunks,
  });
}

// 文件分片上传
async function handleUploadPart(c: any) {
  const db = getDB(c);
  const config = getConf(c);
  const ip = getClientIP(c);

  const body = await c.req.parseBody() as Record<string, string | File>;
  const file = body['file'] as File | undefined;
  if (!file) return jsonError(c, '请选择文件');

  const csrfToken = String(body['csrf_token'] || '');
  // 验证 cookie 中的 token
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }

  const hash = String(body['hash'] || '');

  if (config.forcelogin === 1) {
    const userToken = c.req.header('cookie')?.match(/user_token=([^;]+)/)?.[1];
    if (!userToken) return jsonError(c, '请先登录');
  }

  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');

  const realName = sanitizeFileName(String(body['name'] || file.name || 'file'));
  const ext = getFileExt(realName);
  const arrayBuf = await file.arrayBuffer();
  const realSize = arrayBuf.byteLength || parseInt(String(body['size'] || '0')) || file.size;

  const stor = getStorOrThrow(c);
  const success = await stor.upload(hash, arrayBuf, getMimeType(ext));
  if (!success) return jsonError(c, '文件上传失败');

  // 入库（去重）
  const existing = await getFileByHash(db, hash);
  if (existing) {
    delete csrfTokens[ip];
    return jsonResult(c, {
      code: 1, msg: '本站已存在该文件', exists: 1, hash, name: existing.name, size: existing.size, type: existing.type, id: existing.id,
    });
  }

  const id = await insertFile(db, {
    name: realName, type: ext, size: realSize, hash, ip, hide: 0, pwd: null, uid: 0,
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
    code: 1, msg: '文件上传成功！', exists: 0, hash, name: realName, size: realSize, type: ext, id,
  });
}

// 完成上传
async function handleCompleteUpload(c: any) {
  const db = getDB(c);
  const config = getConf(c);
  const stor = getStorOrThrow(c);
  const ip = getClientIP(c);
  const body = await c.req.parseBody() as Record<string, string>;
  const hash = String(body['hash'] || '');
  const csrfToken = String(body['csrf_token'] || '');

  // 验证 cookie 中的 token
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }

  // 确认文件在存储中存在
  const exists = await stor.exists(hash);
  if (!exists) return jsonError(c, '文件上传失败：存储中未找到文件，请刷新重试');

  // 去重
  const existing = await getFileByHash(db, hash);
  if (existing) {
    return jsonResult(c, {
      code: 1, msg: '本站已存在该文件', exists: 1, hash,
      name: existing.name, size: existing.size, type: existing.type, id: existing.id,
    });
  }

  // 从存储获取实际文件信息（与 PHP complete_upload 一致：从 session 取，回调没有 session 则从存储取）
  let fileSize = parseInt(String(body['size'] || '0'));
  let fileType = '';
  const fileName = String(body['name'] || 'file').replace(/[\/\\:*"<>|?]/g, '');
  const ext = getFileExt(fileName);

  try {
    const info = await stor.getinfo(hash);
    if (info) {
      fileSize = info.length || fileSize;
      fileType = info.content_type || '';
    }
  } catch { /* getinfo 失败不阻塞 */ }

  const id = await insertFile(db, {
    name: fileName, type: ext, size: fileSize, hash, ip, hide: 0, pwd: null, uid: 0,
  });

  return jsonResult(c, {
    code: 1, msg: '文件上传成功！', exists: 0, hash, name: fileName, size: fileSize, type: ext, id,
  });
}

// 删除文件
async function handleDeleteFile(c: any) {
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const body = await c.req.parseBody() as Record<string, string>;

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
}

export default ajax;
