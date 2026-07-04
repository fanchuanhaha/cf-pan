// 彩虹外链网盘 - 后台管理路由 (对应原 admin/ajax.php 系列)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getStorOrThrow, getConf, getDBSession, flushDBSession } from '../middleware';
import { getFileById, deleteFile as dbDeleteFile, setFileBlock } from '../db';
import { updateConfig, clearConfigCache } from '../config';
import { verifyAdminToken } from '../auth/admin';
import { typeToIcon, isView, getViewType, sizeFormat } from '../utils/mime';
import { jsonResult, jsonError } from '../utils/response';

/** 给响应添加防缓存头，避免 Cloudflare 边缘缓存后台数据 */
function setNoCache(c: any) {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  c.header('Vary', 'Cookie');
}

const adminAjax = new Hono<AppEnv>();

// 鉴权中间件
adminAjax.use('*', async (c, next) => {
  const config = getConf(c);
  const token = c.req.header('cookie')?.match(/admin_token=([^;]+)/)?.[1];
  if (!token) {
    console.log('[admin/ajax] auth: no token in cookie');
    return jsonError(c, 'Unauthorized');
  }
  const valid = await verifyAdminToken(token, config.admin_user, config.admin_pwd, config.syskey);
  if (!valid) {
    console.log('[admin/ajax] auth: invalid token');
    return jsonError(c, 'Unauthorized');
  }
  console.log('[admin/ajax] auth: ok');
  await next();
});

// 统计面板
adminAjax.get('/getcount', async (c) => {
  // 使用 D1 Session 强制走主库读，避免读副本延迟导致统计为 0
  const session = getDBSession(c);
  const config = getConf(c);
  const today = new Date().toISOString().substring(0, 10) + ' 00:00:00';
  const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10) + ' 00:00:00';

  let total = 0, todayCount = 0, yesterdayCount = 0;
  try {
    const [totalR, todayR, yesterdayR] = await Promise.all([
      session.prepare('SELECT count(*) as cnt FROM pre_file').first<{ cnt: number }>(),
      session.prepare("SELECT count(*) as cnt FROM pre_file WHERE addtime >= ?").bind(today).first<{ cnt: number }>(),
      session.prepare("SELECT count(*) as cnt FROM pre_file WHERE addtime >= ? AND addtime < ?").bind(yesterday, today).first<{ cnt: number }>(),
    ]);
    total = totalR?.cnt ?? 0;
    todayCount = todayR?.cnt ?? 0;
    yesterdayCount = yesterdayR?.cnt ?? 0;
  } catch (e: any) {
    console.error('[admin/getcount] query failed:', e);
  }

  console.log(`[admin/getcount] total=${total} today=${todayCount} yesterday=${yesterdayCount} storage=${config.storage}`);

  setNoCache(c);
  flushDBSession(c);

  return jsonResult(c, {
    code: 0,
    count1: total,
    count2: todayCount,
    count3: yesterdayCount,
    count4: config.storage.toUpperCase(),
  });
});

// 文件列表
adminAjax.post('/fileList', async (c) => {
  // 使用 D1 Session 走主库，保证读到最新记录
  const session = getDBSession(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const type = body['type'] || 'name';
  const kw = body['kw'] || '';
  const dstatus = parseInt(body['dstatus'] ?? '-1');
  const offset = parseInt(body['offset'] ?? '0');
  const limit = parseInt(body['limit'] ?? '15');
  const orderby = body['orderby'] || 'id';

  // 直接用 session 查询，绕开 getFileList 内部使用的 db
  let where = '1=1';
  const params: unknown[] = [];

  if (dstatus >= 0) {
    where += ' AND block = ?';
    params.push(dstatus);
  }
  if (kw) {
    if (type === 'name') {
      where += ' AND name LIKE ?';
      params.push(`%${kw}%`);
    } else if (type === 'hash') {
      where += ' AND hash = ?';
      params.push(kw);
    }
  }

  const order = orderby === 'count' ? 'count DESC' : 'id DESC';

  let total = 0;
  const rows: any[] = [];
  try {
    const countResult = await session.prepare(
      `SELECT count(*) as cnt FROM pre_file WHERE ${where}`
    ).bind(...params).first<{ cnt: number }>();
    total = countResult?.cnt ?? 0;

    const rowsResult = await session.prepare(
      `SELECT * FROM pre_file WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();
    rows.push(...(rowsResult.results || []));
  } catch (e: any) {
    console.error('[admin/fileList] query failed:', e);
  }

  const rowsWithIcon = rows.map((row: any) => ({
    ...row,
    icon: typeToIcon(row.type),
    view: isView(row.type),
    view_type: getViewType(row.type),
    size2: sizeFormat(row.size),
  }));

  setNoCache(c);
  flushDBSession(c);

  return jsonResult(c, { total, rows: rowsWithIcon });
});

// 封禁/解封文件
adminAjax.get('/setBlock', async (c) => {
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  const status = parseInt(c.req.query('status') || '0');
  if (!id) return jsonError(c, '参数错误');
  await setFileBlock(db, id, status);
  setNoCache(c);
  return jsonResult(c, { code: 0, msg: '修改成功！' });
});

// 删除文件
adminAjax.get('/delFile', async (c) => {
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const id = parseInt(c.req.query('id') || '0');
  if (!id) return jsonError(c, '参数错误');

  const row = await getFileById(db, id);
  if (!row) return jsonError(c, '当前文件不存在！');

  await stor.delete(row.hash);
  const ok = await dbDeleteFile(db, id);
  setNoCache(c);
  flushDBSession(c);
  if (ok) return jsonResult(c, { code: 0, msg: '删除文件成功！' });
  return jsonError(c, '删除文件失败');
});

// 批量操作
adminAjax.post('/operation', async (c) => {
  const db = getDB(c);
  const stor = getStorOrThrow(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const status = parseInt(body['status'] || '0');
  const checkboxStr = body['checkbox[]'] || body['checkbox'];
  const ids = Array.isArray(checkboxStr) ? checkboxStr.map(Number) : [Number(checkboxStr)];

  let count = 0;
  for (const id of ids) {
    const row = await getFileById(db, id);
    if (!row) continue;
    if (status === 0) {
      await stor.delete(row.hash);
      await dbDeleteFile(db, id);
    } else if (status === 1 || status === 2) {
      await setFileBlock(db, id, status);
    }
    count++;
  }
  const opName = status === 0 ? '删除' : (status === 1 ? '封禁' : '解封');
  setNoCache(c);
  flushDBSession(c);
  return jsonResult(c, { code: 0, msg: `成功${opName}${count}个文件` });
});

// 保存存储设置
adminAjax.post('/saveSetting', async (c) => {
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  for (const [k, v] of Object.entries(body)) {
    if (k === 'submit') continue;
    await updateConfig(db, k, v);
  }
  clearConfigCache();
  setNoCache(c);
  return jsonResult(c, { code: 0, msg: '保存成功' });
});

export default adminAjax;
