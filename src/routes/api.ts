// 彩虹外链网盘 - 第三方上传 API (对应原 api.php)

import { Hono } from 'hono';
import type { AppVariables } from '../middleware';
import { getDB, getStor, getConf } from '../middleware';
import { getFileByHash, insertFile } from '../db';
import { isBlocked, sanitizeFileName } from '../services/upload';
import { getFileExt, getMimeType, isView as isViewExt } from '../utils/mime';
import { jsonResult, jsonError, html, getClientIP } from '../utils/response';
import { checkImage } from '../services/green';

const api = new Hono<{ Variables: AppVariables & { env: { FILE_R2: R2Bucket; AI?: unknown } } }>();

api.post('/', async (c) => {
  const db = getDB(c);
  const stor = getStor(c);
  const config = getConf(c);

  if (!config.api_open) {
    return jsonError(c, '当前站点未开启上传API');
  }

  // Referer 校验
  if (config.api_referer) {
    const referer = c.req.header('referer') || '';
    const referers = config.api_referer.split('|');
    try {
      const refHost = new URL(referer).hostname;
      if (!referers.map(r => r.toLowerCase()).includes(refHost.toLowerCase())) {
        return jsonError(c, '来源地址不正确');
      }
    } catch {
      return jsonError(c, '来源地址不正确');
    }
  }

  const contentType = c.req.header('content-type') || '';
  const format = contentType.includes('multipart/form-data')
    ? 'html'
    : (c.req.query('format') || 'json');

  let name: string;
  let size: number;
  let hash: string;
  let fileBody: ArrayBuffer;
  let ext: string;

  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody<Record<string, string | File>>();
    const file = body['file'] as File | undefined;
    if (!file) {
      return formatResponse(c, format, { code: -1, msg: '请选择文件' });
    }
    name = sanitizeFileName(file.name);
    size = file.size;
    fileBody = await file.arrayBuffer();
    ext = getFileExt(name);
  } else {
    // Raw body upload
    const disposition = c.req.header('content-disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
    name = filenameMatch ? sanitizeFileName(filenameMatch[1]) : 'file';
    fileBody = await c.req.raw.arrayBuffer();
    size = fileBody.byteLength;
    ext = getFileExt(name);
  }

  if (!name) return formatResponse(c, format, { code: -1, msg: '文件名不能为空' });

  const blockMsg = isBlocked(name, ext);
  if (blockMsg) return formatResponse(c, format, { code: -1, msg: '文件上传失败' });

  hash = await crypto.subtle.digest('MD5', fileBody).then(buf =>
    Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  );

  // 秒传
  const existing = await getFileByHash(db, hash);
  if (existing) {
    return formatResponse(c, format, {
      code: 0, msg: '本站已存在该文件', exists: 1, hash, name, size, type: ext, id: existing.id,
    });
  }

  const ok = await stor.upload(hash, fileBody, getMimeType(ext));
  if (!ok) return formatResponse(c, format, { code: -1, msg: '文件上传失败' });

  const id = await insertFile(db, {
    name, type: ext, size, hash,
    ip: getClientIP(c),
    hide: 0, pwd: null, uid: 0,
  });

  return formatResponse(c, format, {
    code: 0, msg: '文件上传成功！', exists: 0, hash, name, size, type: ext, id,
  });
});

function formatResponse(c: any, format: string, result: Record<string, unknown>): Response {
  if (format === 'json') {
    return jsonResult(c, result);
  } else if (format === 'jsonp') {
    const callback = c.req.query('callback') || 'callback';
    return new Response(`${callback}(${JSON.stringify(result)})`, {
      headers: { 'Content-Type': 'application/javascript; charset=UTF-8' },
    });
  } else {
    if (typeof result.code === 'number' && result.code === 0) {
      return html(c, `<html><head><meta charset="utf-8"/></head><body><form action="" method="post"><input name="file" type="hidden" value="${result.hash || ''}"/></form></body></html>`);
    }
    return html(c, `<html><head><meta charset="utf-8"/></head><body><h1>${result.msg}</h1></body></html>`);
  }
}

export default api;
