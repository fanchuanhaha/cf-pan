// 彩虹外链网盘 - 后台管理路由 (对应原 admin/ajax.php 系列)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getConf } from '../middleware';
import { getFileList, getFileById, deleteFile as dbDeleteFile, setFileBlock, getUserList, updateUser, deleteUser } from '../db';
import { updateConfig, clearConfigCache } from '../config';
import { purgeHomeCache } from '../utils/cache';
import { verifyAdminToken } from '../auth/admin';
import { typeToIcon, isView, getViewType, sizeFormat } from '../utils/mime';
import { jsonResult, jsonError } from '../utils/response';
import { getStorageBackends, deleteObjectFromBackends } from '../storage/backends';

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

// 注意：/getcount 端点已在 frontend.ts 中实现（路径 /admin/ajax/getcount）。
// 由于 frontendRoutes 比 adminAjaxRoutes 先注册，Hono 的 trie/smart router
// 会优先匹配第一个注册的处理器，因此这里不再重复实现。
// 文件列表
adminAjax.post('/fileList', async (c) => {
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const type = body['type'] || 'name';
  const kw = body['kw'] || '';
  const dstatus = parseInt(body['dstatus'] ?? '-1');
  const offset = parseInt(body['offset'] ?? '0');
  const limit = parseInt(body['limit'] ?? '15');
  const orderby = body['orderby'] || 'id';

  const { total, rows } = await getFileList(db, {
    search: kw, type, dstatus, offset, limit, orderby,
  });

  const rowsWithIcon = rows.map(row => ({
    ...row,
    icon: typeToIcon(row.type),
    view: isView(row.type),
    view_type: getViewType(row.type),
    size2: sizeFormat(row.size),
  }));

  return jsonResult(c, { total, rows: rowsWithIcon });
});

adminAjax.post('/userList', async (c) => {
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const typeMap: Record<string, string> = { '1': 'uid', '2': 'openid', '3': 'nickname', '4': 'ip' };
  const result = await getUserList(db, {
    search: body.kw || '', type: typeMap[body.type || '3'],
    enable: parseInt(body.dstatus ?? '-1'), offset: parseInt(body.offset || '0'), limit: parseInt(body.limit || '15'),
  });
  return jsonResult(c, result);
});

adminAjax.post('/setUserEnable', async (c) => {
  const body = await c.req.parseBody<Record<string, string>>();
  const uid = parseInt(body.uid || '0');
  if (!uid) return jsonError(c, '参数错误');
  await updateUser(getDB(c), uid, { enable: parseInt(body.enable || '0') });
  return jsonResult(c, { code: 0, msg: '状态已更新' });
});

adminAjax.post('/saveUserInfo', async (c) => {
  const body = await c.req.parseBody<Record<string, string>>();
  const uid = parseInt(body.uid || '0');
  if (!uid) return jsonError(c, '参数错误');
  await updateUser(getDB(c), uid, { level: parseInt(body.level || '0') });
  return jsonResult(c, { code: 0, msg: '用户信息已保存' });
});

adminAjax.post('/delUser', async (c) => {
  const body = await c.req.parseBody<Record<string, string>>();
  const uid = parseInt(body.uid || '0');
  if (!uid) return jsonError(c, '参数错误');
  return jsonResult(c, { code: 0, msg: (await deleteUser(getDB(c), uid)) ? '删除成功' : '用户不存在' });
});

// 封禁/解封文件
adminAjax.get('/setBlock', async (c) => {
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  const status = parseInt(c.req.query('status') || '0');
  if (!id) return jsonError(c, '参数错误');
  await setFileBlock(db, id, status);
  return jsonResult(c, { code: 0, msg: '修改成功！' });
});

// 删除文件
adminAjax.get('/delFile', async (c) => {
  const db = getDB(c);
  const id = parseInt(c.req.query('id') || '0');
  if (!id) return jsonError(c, '参数错误');

  const row = await getFileById(db, id);
  if (!row) return jsonError(c, '当前文件不存在！');

  const backends = getStorageBackends(getConf(c), c.env);
  const result = await deleteObjectFromBackends(backends, row.hash);
  if (!result.ok) {
    const detail = [...result.errors];
    if (result.remaining.length) detail.push(`仍存在：${result.remaining.join('、')}`);
    return jsonError(c, '存储删除失败，数据库记录已保留：' + (detail.join('；') || '未知错误'));
  }

  const ok = await dbDeleteFile(db, id);
  if (ok) return jsonResult(c, { code: 0, msg: '删除文件成功！' });
  return jsonError(c, '删除文件失败');
});

// 批量操作
adminAjax.post('/operation', async (c) => {
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  const status = parseInt(body['status'] || '0');
  const checkboxStr = body['checkbox[]'] || body['checkbox'];
  const ids = Array.isArray(checkboxStr) ? checkboxStr.map(Number) : [Number(checkboxStr)];

  let count = 0;
  const failures: string[] = [];
  const backends = status === 0 ? getStorageBackends(getConf(c), c.env) : [];

  for (const id of ids) {
    const row = await getFileById(db, id);
    if (!row) continue;
    if (status === 0) {
      const result = await deleteObjectFromBackends(backends, row.hash);
      if (!result.ok) {
        const detail = [...result.errors];
        if (result.remaining.length) detail.push(`仍存在：${result.remaining.join('、')}`);
        failures.push(`${row.name || row.hash}：${detail.join('；') || '存储删除失败'}`);
        continue;
      }
      if (await dbDeleteFile(db, id)) count++;
    } else if (status === 1 || status === 2) {
      await setFileBlock(db, id, status);
      count++;
    }
  }
  const opName = status === 0 ? '删除' : (status === 1 ? '封禁' : '解封');
  if (failures.length) {
    return jsonResult(c, {
      code: 0,
      msg: `成功${opName}${count}个文件，${failures.length}个失败：${failures.slice(0, 3).join('；')}${failures.length > 3 ? '……' : ''}`,
    });
  }
  return jsonResult(c, { code: 0, msg: `成功${opName}${count}个文件` });
});

// 保存存储设置
adminAjax.post('/saveSetting', async (c) => {
  const db = getDB(c);
  const body = await c.req.parseBody<Record<string, string>>();
  if (body.oldpwd !== undefined || body.newpwd !== undefined || body.newpwd2 !== undefined) {
    const config = getConf(c);
    if (body.oldpwd !== config.admin_pwd) return jsonError(c, '当前管理员密码错误');
    if (body.newpwd || body.newpwd2) {
      if (body.newpwd !== body.newpwd2) return jsonError(c, '两次输入的新密码不一致');
      if (body.newpwd.length < 4) return jsonError(c, '新密码至少需要 4 位');
      await updateConfig(db, 'admin_pwd', body.newpwd);
    }
    if (body.admin_user) await updateConfig(db, 'admin_user', body.admin_user);
    clearConfigCache();
    purgeHomeCache(c);
    return jsonResult(c, { code: 0, msg: '管理员账号已更新，请重新登录' });
  }
  for (const [k, v] of Object.entries(body)) {
    if (k === 'submit') continue;
    await updateConfig(db, k, v);
  }
  clearConfigCache();
  purgeHomeCache(c);
  return jsonResult(c, { code: 0, msg: '保存成功' });
});

export default adminAjax;
