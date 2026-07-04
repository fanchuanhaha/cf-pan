// 彩虹外链网盘 - 第三方上传 API (对应原 api.php)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getStorOrThrow, getConf, getDBSession, flushDBSession } from '../middleware';
import { isBlocked, sanitizeFileName } from '../services/upload';
import { getFileExt, getMimeType } from '../utils/mime';
import { jsonResult, jsonError, html, getClientIP } from '../utils/response';

const api = new Hono<AppEnv>();

api.post('/', async (c) => {
  const stor = getStorOrThrow(c);
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

  // 秒传 —— 使用 D1 Session 走主库，避免读副本延迟
  const session = getDBSession(c);
  const existing = await session.prepare(
    'SELECT * FROM pre_file WHERE hash = ? LIMIT 1'
  ).bind(hash).first() as any;
  if (existing) {
    flushDBSession(c);
    return formatResponse(c, format, {
      code: 0, msg: '本站已存在该文件', exists: 1, hash, name, size, type: ext, id: existing.id,
    });
  }

  const ok = await stor.upload(hash, fileBody, getMimeType(ext));
  if (!ok) return formatResponse(c, format, { code: -1, msg: '文件上传失败' });

  // 插入文件记录 —— 走 session
  let id = 0;
  try {
    const result = await session.prepare(
      `INSERT INTO pre_file (name, type, size, hash, addtime, ip, hide, pwd, uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, ext, size, hash, new Date().toISOString().replace('T', ' ').substring(0, 19), getClientIP(c), 0, null, 0).run();
    id = result.meta.last_row_id;
  } catch (e: any) {
    console.error('[api/upload] insert failed:', e);
    return formatResponse(c, format, { code: -1, msg: '文件信息入库失败' });
  }

  // 把 session 的 bookmark 回写到 cookie，使后台立刻看到这条记录
  flushDBSession(c);
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');

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
