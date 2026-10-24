// 彩虹外链网盘 - 前端 AJAX 路由 (对应原 ajax.php)

import { Hono } from 'hono';
import type { AppEnv, AppVariables } from '../middleware';
import { getDB, getStorOrThrow, getConf } from '../middleware';
import { getFileByHash, insertFile, deleteFile, getFileById, getTodayUploadCount, now } from '../db';
import { isBlocked, sanitizeFileName } from '../services/upload';
import { getFileExt, getMimeType, isView as isViewExt } from '../utils/mime';
import { jsonError, jsonResult, generateCsrfToken, getClientIP } from '../utils/response';
import { checkImage } from '../services/green';
import { S3Storage } from '../storage/S3Storage';
import { getStorageBackends, deleteObjectFromBackends, objectExistsInBackends } from '../storage/backends';
import { purgeHomeCache } from '../utils/cache';

let csrfTokens: Record<string, string> = {};

// 每次只把 25MB 分片发给 Worker，避免 Cloudflare 单次请求 100MB 限制。
// 25MB 比原来的 8MB 少 3 倍请求，配合前端 3 路并发可明显提高中转上传速度。
const MULTIPART_CHUNK_SIZE = 25 * 1024 * 1024;

/** 中转分片并发数：R2 绑定内存占用低可用 3 路，S3 API 每片会多占内存，保守用 2 路 */
function getMultipartConcurrency(c: any, config: any): number {
  if (config?.storage === 'r2' && c?.env?.FILE_R2) return 3;
  return 2;
}

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
  if (act === 'prepare_multipart') return handlePrepareMultipart(c);
  if (act === 'upload_part') return handleUploadPart(c);
  if (act === 'complete_upload') return handleCompleteUpload(c);
  if (act === 'abort_multipart') return handleAbortMultipart(c);
  if (act === 'deleteFile') return handleDeleteFile(c);
  return jsonError(c, 'Unknown action');
});

// 文件列表（静态首页 data-source，仅读查询，动态不缓存）
ajax.get('/list', handleList);
ajax.get('/', async (c) => {
  const act = c.req.query('act');
  if (act === 'list') return handleList(c);
  return jsonError(c, 'Unknown action');
});

async function handleList(c: any) {
  const db = getDB(c);
  const config = getConf(c);
  const isMine = c.req.query('m') === 'mine';
  const kw = (c.req.query('kw') || '').trim();
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const pageSize = Math.min(50, Math.max(1, parseInt(c.req.query('pageSize') || '15')));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: any[] = [];
  if (isMine) {
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

  const rows = rawRows.map((r: any) => ({
    id: r.id,
    name: r.name,
    type: r.type || '',
    size: r.size,
    hash: r.hash,
    addtime: r.addtime,
    ip: (r.ip || '').replace(/\d+$/, '*'),
  }));
  return jsonResult(c, { code: 0, rows, total: totalCount, page, pageSize, isMine, site: {
    title: config.title,
    gonggao: config.gonggao,
  } });
}

// 路径方式的路由（兼容）
ajax.post('/pre_upload', handlePreUpload);
ajax.post('/prepare_multipart', handlePrepareMultipart);
ajax.post('/upload_part', handleUploadPart);
ajax.post('/complete_upload', handleCompleteUpload);
ajax.post('/abort_multipart', handleAbortMultipart);
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

  const size = parseInt(sizeStr) || 0;
  if (config.upload_size > 0 && size > config.upload_size * 1024 * 1024) {
    return jsonError(c, `文件超过大小限制（最大 ${config.upload_size}MB）`);
  }

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

  const chunkSize = MULTIPART_CHUNK_SIZE;
  const chunks = size > 0 ? Math.max(1, Math.ceil(size / chunkSize)) : 1;

  let stor: any = null;
  try {
    stor = getStorOrThrow(c);
  } catch (e) {
    console.error('storage unavailable during pre_upload:', e);
  }

  // 直传模式：云存储支持时返回第三方直传参数（浏览器直接传存储商，Worker 不占流量）
  if (config.uploadfile_type === 1 && stor) {
    let param: any = null;
    if (stor.getUploadParam) {
      param = await stor.getUploadParam(hash, name, size);
    } else if (config.storage === 'r2' && config.r2_access_key_id && config.r2_secret_access_key && config.r2_bucket) {
      // R2 用 S3 兼容预签名直传（凭据在安装/恢复时写入配置）
      const endpoint = (config.r2_endpoint || '').trim() ||
        (config.r2_account_id ? `https://${config.r2_account_id}.r2.cloudflarestorage.com` : '');
      if (endpoint) {
        try {
          const r2s3 = new S3Storage({
            endpoint, region: 'auto', bucket: config.r2_bucket,
            accessKeyId: config.r2_access_key_id, secretAccessKey: config.r2_secret_access_key,
          });
          param = await r2s3.getUploadParam(hash, name, size);
        } catch (e) {
          console.error('R2 presign error:', e);
        }
      }
    }
    if (param) {
      return jsonResult(c, {
        code: 0, third: true,
        method: param.method || 'POST',
        url: param.url,
        post: param.post || {},
        headers: param.headers || {},
        hash, name, size, type: ext,
        chunksize: chunkSize, chunks,
        // 直传失败时前端会重新调用 prepare_multipart 走网站中转分片
        fallback: true,
      });
    }
  }

  // 网站中转：R2/S3 用存储端分片上传，浏览器每次只发 25MB 给 Worker
  if (size > 0 && stor?.createMultipartUpload) {
    try {
      const uploadId = await stor.createMultipartUpload(hash, getMimeType(ext));
      if (uploadId) {
        return jsonResult(c, {
          code: 0, third: false, multipart: true, uploadId,
          hash, name, size, type: ext,
          chunksize: chunkSize, chunks,
          concurrency: getMultipartConcurrency(c, config),
        });
      }
    } catch (e) {
      console.error('create multipart upload error:', e);
    }
  }

  // 没有分片能力时保留原来的单请求上传（只适合 100MB 以内的文件）
  if (size > 95 * 1024 * 1024) {
    return jsonError(c, '当前存储不支持分片上传，无法通过网站中转上传超过 100MB 的文件；请开启直传或更换为 R2/S3 存储');
  }

  return jsonResult(c, {
    code: 0, third: false, hash, name, size, type: ext,
    chunksize: chunkSize, chunks,
  });
}

// 直传失败后，按需创建一个网站中转的分片上传任务
async function handlePrepareMultipart(c: any) {
  const db = getDB(c);
  const config = getConf(c);
  const body = await c.req.parseBody() as Record<string, string>;
  const ip = getClientIP(c);

  const csrfToken = String(body['csrf_token'] || '');
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) return jsonError(c, 'CSRF TOKEN ERROR');

  if (config.forcelogin === 1) {
    const userToken = c.req.header('cookie')?.match(/user_token=([^;]+)/)?.[1];
    if (!userToken) return jsonError(c, '请先登录');
  }

  const name = sanitizeFileName(String(body['name'] || ''));
  const hash = String(body['hash'] || '');
  const size = parseInt(String(body['size'] || '0')) || 0;
  if (!name) return jsonError(c, '文件名不能为空');
  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');
  if (config.upload_size > 0 && size > config.upload_size * 1024 * 1024) {
    return jsonError(c, `文件超过大小限制（最大 ${config.upload_size}MB）`);
  }

  const ext = getFileExt(name);
  if (isBlocked(name, ext)) return jsonError(c, '文件上传失败，不支持上传该格式文件');

  const existing = await getFileByHash(db, hash);
  if (existing) {
    return jsonResult(c, {
      code: 1, msg: '本站已存在该文件', exists: 1, hash, name: existing.name,
      size: existing.size, type: existing.type, id: existing.id,
    });
  }

  // 空文件无法做 S3/R2 multipart，回退到单请求上传
  if (size <= 0) {
    return jsonResult(c, {
      code: 0, multipart: false, hash, name, size, type: ext,
      chunksize: MULTIPART_CHUNK_SIZE, chunks: 1,
    });
  }

  if (config.upload_limit > 0) {
    const todayCount = await getTodayUploadCount(db, ip, 0);
    if (todayCount >= config.upload_limit) return jsonError(c, '你今天上传文件的数量已超过限制');
  }

  try {
    const stor = getStorOrThrow(c);
    if (!stor.createMultipartUpload) return jsonError(c, '当前存储不支持分片上传');
    const uploadId = await stor.createMultipartUpload(hash, getMimeType(ext));
    if (!uploadId) return jsonError(c, '初始化分片上传失败');
    const chunks = size > 0 ? Math.max(1, Math.ceil(size / MULTIPART_CHUNK_SIZE)) : 1;
    return jsonResult(c, {
      code: 0, multipart: true, uploadId,
      hash, name, size, type: ext,
      chunksize: MULTIPART_CHUNK_SIZE, chunks,
      concurrency: getMultipartConcurrency(c, config),
    });
  } catch (e: any) {
    console.error('prepare multipart upload error:', e);
    return jsonError(c, '初始化分片上传失败：' + String(e?.message || e));
  }
}

// 取消分片上传（前端上传失败时清理存储端的未完成分片）
async function handleAbortMultipart(c: any) {
  const body = await c.req.parseBody() as Record<string, string>;
  const csrfToken = String(body['csrf_token'] || '');
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) return jsonError(c, 'CSRF TOKEN ERROR');

  const hash = String(body['hash'] || '');
  const uploadId = String(body['uploadId'] || '');
  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');
  if (!uploadId) return jsonError(c, 'uploadId 不能为空');

  try {
    const stor = getStorOrThrow(c);
    if (stor.abortMultipartUpload) await stor.abortMultipartUpload(hash, uploadId);
    return jsonResult(c, { code: 0 });
  } catch (e: any) {
    console.error('abort multipart upload error:', e);
    return jsonError(c, String(e?.message || e));
  }
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
  const realSize = parseInt(String(body['size'] || '0')) || file.size;
  const ext = getFileExt(realName);
  const arrayBuf = await file.arrayBuffer();

  // 分片上传：只把当前 25MB 分片交给存储，不在这里入库
  const uploadId = String(body['uploadId'] || '');
  const partNumber = parseInt(String(body['chunk'] || body['partNumber'] || '1')) || 1;
  if (uploadId) {
    if (partNumber < 1 || partNumber > 10000) return jsonError(c, '分片序号错误');
    const multipartStor = getStorOrThrow(c);
    if (!multipartStor.uploadPart) return jsonError(c, '当前存储不支持分片上传');
    try {
      const etag = await multipartStor.uploadPart(hash, uploadId, partNumber, arrayBuf);
      if (!etag) return jsonError(c, '分片上传失败');
      return jsonResult(c, { code: 0, multipart: true, partNumber, etag, hash });
    } catch (e: any) {
      console.error('upload multipart part error:', e);
      return jsonError(c, String(e?.message || e));
    }
  }

  const stor = getStorOrThrow(c);
  let success = false;
  try {
    success = await stor.upload(hash, arrayBuf, getMimeType(ext));
  } catch (e: any) {
    console.error('upload_part error:', e);
    return jsonError(c, String(e?.message || e));
  }
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
  purgeHomeCache(c);

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

  // 记录上传的文件ID到cookie（用于"我的文件"和管理权限）
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/file_ids=([^;]+)/);
  let ids: number[] = [];
  if (match) {
    try {
      ids = atob(decodeURIComponent(match[1])).split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
    } catch {}
  }
  if (!ids.includes(id)) {
    ids.unshift(id);
    if (ids.length > 60) ids = ids.slice(0, 60);
  }
  c.header('Set-Cookie', `file_ids=${encodeURIComponent(btoa(ids.join(',')))}; Path=/; Max-Age=604800; SameSite=Lax`);

  delete csrfTokens[ip];
  return jsonResult(c, {
    code: 1, msg: '文件上传成功！', exists: 0, hash, name: realName, size: realSize, type: ext, id,
  });
}

// 完成上传（第三方直传时调用：校验存储中存在后入库）
async function handleCompleteUpload(c: any) {
  const body = await c.req.parseBody() as Record<string, string>;
  const hash = String(body['hash'] || '');
  const csrfToken = String(body['csrf_token'] || '');
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }
  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');

  const db = getDB(c);
  const config = getConf(c);
  const ip = getClientIP(c);

  // 中转流程已入库，直接返回
  const existing = await getFileByHash(db, hash);
  if (existing) {
    delete csrfTokens[ip];
    return jsonResult(c, {
      code: 1, msg: '文件上传成功！', hash, name: existing.name, size: existing.size, type: existing.type, id: existing.id,
    });
  }

  const name = sanitizeFileName(String(body['name'] || ''));
  const size = parseInt(String(body['size'] || '0')) || 0;
  if (!name) return jsonError(c, '文件名不能为空');
  if (config.upload_size > 0 && size > config.upload_size * 1024 * 1024) {
    return jsonError(c, '文件超过大小限制');
  }
  const ext = getFileExt(name);
  if (isBlocked(name, ext)) return jsonError(c, '文件上传失败，不支持上传该格式文件');

  const pwdRaw = String(body['pwd'] || '');
  const pwd = pwdRaw ? pwdRaw : null;
  if (pwd && !/^[a-zA-Z0-9]+$/.test(pwd)) return jsonError(c, '文件密码只能为字母和数字');

  if (config.upload_limit > 0) {
    const todayCount = await getTodayUploadCount(db, ip, 0);
    if (todayCount >= config.upload_limit) return jsonError(c, '你今天上传文件的数量已超过限制');
  }

  // 网站中转的分片上传：先把所有分片合并成完整对象，再做存在性校验
  const uploadId = String(body['uploadId'] || '');
  if (uploadId) {
    let rawParts: any;
    try {
      rawParts = JSON.parse(String(body['parts'] || '[]'));
    } catch {
      return jsonError(c, '分片信息无效');
    }
    if (!Array.isArray(rawParts) || rawParts.length === 0) {
      return jsonError(c, '分片信息为空');
    }
    const parts = rawParts.map((p: any) => ({
      partNumber: parseInt(String(p?.partNumber || '0')) || 0,
      etag: String(p?.etag || ''),
    }));
    if (parts.some(p => p.partNumber < 1 || p.partNumber > 10000 || !p.etag)) {
      return jsonError(c, '分片信息无效');
    }
    try {
      const stor = getStorOrThrow(c);
      if (!stor.completeMultipartUpload) return jsonError(c, '当前存储不支持分片上传');
      const ok = await stor.completeMultipartUpload(hash, uploadId, parts);
      if (!ok) return jsonError(c, '合并分片失败');
    } catch (e: any) {
      console.error('complete multipart upload error:', e);
      return jsonError(c, '合并分片失败：' + String(e?.message || e));
    }
  }

  // 直传完成后校验文件确实已在存储中。
  // R2 可能同时配置了绑定和 S3 API，直传走 S3 API，因此要检查所有后端。
  const backends = getStorageBackends(config, c.env);
  const exists = await objectExistsInBackends(backends, hash);
  if (!exists.exists) {
    return jsonError(c, '文件未上传成功' + (exists.errors.length ? '：' + exists.errors.join('；') : ''));
  }

  const hide = String(body['show'] || '1') === '1' ? 0 : 1;
  const id = await insertFile(db, { name, type: ext, size, hash, ip, hide, pwd, uid: 0 });
  purgeHomeCache(c);

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

  // 记录上传的文件ID到cookie（用于"我的文件"和管理权限）
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/file_ids=([^;]+)/);
  let ids: number[] = [];
  if (match) {
    try {
      ids = atob(decodeURIComponent(match[1])).split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
    } catch {}
  }
  if (!ids.includes(id)) {
    ids.unshift(id);
    if (ids.length > 60) ids = ids.slice(0, 60);
  }
  c.header('Set-Cookie', `file_ids=${encodeURIComponent(btoa(ids.join(',')))}; Path=/; Max-Age=604800; SameSite=Lax`);

  delete csrfTokens[ip];
  return jsonResult(c, {
    code: 1, msg: '文件上传成功！', exists: 0, hash, name, size, type: ext, id,
  });
}

// 删除文件
async function handleDeleteFile(c: any) {
  const db = getDB(c);
  const body = await c.req.parseBody() as Record<string, string>;

  const hash = String(body['hash'] || '');
  const csrfToken = String(body['csrf_token'] || '');
  const cookieCsrf = c.req.header('cookie')?.match(/upload_csrf=([^;]+)/)?.[1];
  if (!csrfToken || csrfToken !== cookieCsrf) {
    return jsonError(c, 'CSRF TOKEN ERROR');
  }
  if (!/^[0-9a-f]{32}$/i.test(hash)) return jsonError(c, 'hash error');

  const row = await getFileByHash(db, hash);
  if (!row) return jsonError(c, '文件不存在');
  if (row.block === 1) return jsonError(c, '文件已被冻结，无法删除');

  const backends = getStorageBackends(getConf(c), c.env);
  const result = await deleteObjectFromBackends(backends, row.hash);
  if (!result.ok) {
    const detail = [...result.errors];
    if (result.remaining.length) detail.push(`仍存在：${result.remaining.join('、')}`);
    return jsonError(c, '存储删除失败，数据库记录已保留：' + (detail.join('；') || '未知错误'));
  }

  const ok = await deleteFile(db, row.id);
  if (ok) {
    purgeHomeCache(c);
    return jsonResult(c, { code: 0, msg: '删除文件成功！' });
  }
  return jsonError(c, '删除文件失败');
}

export default ajax;
