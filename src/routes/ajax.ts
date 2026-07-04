// 彩虹外链网盘 - 前端 AJAX 路由 (对应原 ajax.php)

import { Hono } from 'hono';
import type { AppEnv, AppVariables } from '../middleware';
import { getDB, getStorOrThrow, getConf, getDBSession, flushDBSession } from '../middleware';
import { deleteFile, getFileByHash, getFileById, getTodayUploadCount, now } from '../db';
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

  // 秒传检测 —— 使用 D1 Session 走主库，避免刚上传完成的文件被误判为不存在
  const session = getDBSession(c);
  const existing = await session.prepare(
    'SELECT * FROM pre_file WHERE hash = ? LIMIT 1'
  ).bind(hash).first();
  if (existing) {
    delete csrfTokens[ip];
    flushDBSession(c);
    return jsonResult(c, {
      code: 1, msg: '本站已存在该文件', exists: 1, hash, name, size, type: ext, id: existing.id,
    });
  }

  // Workers 没有本地磁盘，强制 chunks=1 让前端一次发送整个文件
  const chunkSize = 8 * 1024 * 1024;
  const chunks = 1;

  flushDBSession(c);
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  return jsonResult(c, {
    code: 0, third: false, hash,
    chunksize: chunkSize, chunks,
  });
}

// 文件分片上传
async function handleUploadPart(c: any) {
  // 使用 D1 Session：保证后续读秒传记录能看到本次请求刚写入的记录
  // 也保证本次请求的 INSERT 立即对同一 session 可见，并允许把 bookmark 传回客户端
  const session = getDBSession(c);
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
  const realSize = parseInt(String(body['size'] || '0')) || file.size;
  const ext = getFileExt(realName);
  const arrayBuf = await file.arrayBuffer();

  const stor = getStorOrThrow(c);
  const success = await stor.upload(hash, arrayBuf, getMimeType(ext));
  if (!success) return jsonError(c, '文件上传失败');

  // 入库（去重）—— 走 session，保证读写一致
  const existing = await session.prepare(
    'SELECT * FROM pre_file WHERE hash = ? LIMIT 1'
  ).bind(hash).first();
  if (existing) {
    delete csrfTokens[ip];
    // 命中秒传：把 bookmark 回写到 cookie，使后台能立刻看到这条记录
    flushDBSession(c);
    return jsonResult(c, {
      code: 1, msg: '本站已存在该文件', exists: 1, hash, name: existing.name, size: existing.size, type: existing.type, id: existing.id,
    });
  }

  // 插入文件记录 —— 走 session，并使用 D1 Batch 保证原子性
  let id = 0;
  try {
    const result = await session.prepare(
      `INSERT INTO pre_file (name, type, size, hash, addtime, ip, hide, pwd, uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(realName, ext, realSize, hash, now(), ip, 0, null, 0).run();
    id = result.meta.last_row_id;
  } catch (e: any) {
    console.error('[upload_part] insert failed:', e);
    return jsonError(c, '文件信息入库失败，请稍后再试');
  }

  // 鉴黄
  if (config.green_check > 0) {
    const typeImage = config.type_image.split('|').map(s => s.toLowerCase());
    if (typeImage.includes(ext.toLowerCase())) {
      const checkResult = await checkImage(hash, ext, c.env);
      if (!checkResult.safe) {
        await session.prepare('UPDATE pre_file SET block = 1 WHERE id = ?').bind(id).run();
      }
    }
  }

  // 视频审核
  if (config.videoreview === 1) {
    const typeVideo = config.type_video.split('|').map(s => s.toLowerCase());
    if (typeVideo.includes(ext.toLowerCase())) {
      await session.prepare('UPDATE pre_file SET block = 2 WHERE id = ?').bind(id).run();
    }
  }

  delete csrfTokens[ip];
  // 把 session 的 bookmark 写回 cookie，让后台的 getcount/fileList 立刻读到本次写入
  flushDBSession(c);
  // 响应禁止被 Cloudflare 边缘缓存
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  return jsonResult(c, {
    code: 1, msg: '文件上传成功！', exists: 0, hash, name: realName, size: realSize, type: ext, id,
  });
}

// 完成上传
async function handleCompleteUpload(c: any) {
  const body = await c.req.parseBody() as Record<string, string>;
  const hash = String(body['hash'] || '');
  const csrfToken = String(body['csrf_token'] || '');

  // 验证 cookie 中的 token
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }

  const db = getDB(c);
  const file = await getFileByHash(db, hash);
  if (!file) return jsonError(c, '文件不存在');

  return jsonResult(c, {
    code: 1, msg: '文件上传成功！', hash, name: file.name, size: file.size, type: file.type, id: file.id,
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
