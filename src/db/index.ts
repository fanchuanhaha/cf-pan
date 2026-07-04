// 彩虹外链网盘 - D1 数据库封装

export interface FileRow {
  id: number;
  name: string;
  type: string;
  size: number;
  hash: string;
  addtime: string;
  lasttime: string | null;
  ip: string;
  hide: number;
  pwd: string | null;
  uid: number;
  block: number;
  count: number;
}

export interface UserRow {
  uid: number;
  type: string;
  openid: string;
  nickname: string;
  faceimg: string;
  level: number;
  enable: number;
  regip: string;
  loginip: string;
  addtime: string;
  lasttime: string;
}

/** 获取当前时间字符串 */
export function now(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * 选择 D1 执行器
 * 优先使用传入的 session（Cloudflare D1 Sessions API，read-after-write 一致性）；
 * 若未传入，则回退为 'first-primary' 强制走主库，保证至少不弱于主库最新数据，
 * 从而避免 D1 读副本滞后导致"上传成功但后台仍为 0 个文件"的问题。
 */
type D1Executor = {
  prepare: (query: string) => D1PreparedStatement;
};
function pickExecutor(db: D1Database, session?: D1DatabaseSession): D1Executor {
  if (session) return session;
  return db.withSession('first-primary');
}

/**
 * 插入文件记录
 * 使用 D1 会话（write 操作强制走主库），并返回当前会话的 bookmark。
 * 调用方应通过 setD1BookmarkCookie(c, bookmark) 将书签回写到客户端 Cookie，
 * 以便后续请求（admin 统计、文件列表）能够 read-after-write 看到本次写入。
 */
export async function insertFile(db: D1Database, data: {
  name: string; type: string; size: number; hash: string;
  ip: string; hide: number; pwd: string | null; uid: number;
}): Promise<{ id: number; bookmark: string | null }> {
  const session = db.withSession();
  const result = await session.prepare(
    `INSERT INTO pre_file (name, type, size, hash, addtime, ip, hide, pwd, uid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(data.name, data.type, data.size, data.hash, now(), data.ip, data.hide ?? 0, data.pwd ?? null, data.uid ?? 0)
    .run();
  return {
    id: result.meta.last_row_id,
    bookmark: session.getBookmark() ?? null,
  };
}

/** 根据 hash 查询文件 */
export async function getFileByHash(db: D1Database, hash: string, session?: D1DatabaseSession): Promise<FileRow | null> {
  return pickExecutor(db, session).prepare(
    `SELECT * FROM pre_file WHERE hash = ? LIMIT 1`
  ).bind(hash).first<FileRow>();
}

/** 根据 id 查询文件 */
export async function getFileById(db: D1Database, id: number, session?: D1DatabaseSession): Promise<FileRow | null> {
  return pickExecutor(db, session).prepare('SELECT * FROM pre_file WHERE id = ? LIMIT 1').bind(id).first<FileRow>();
}

/** 删除文件 */
export async function deleteFile(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM pre_file WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

/** 更新文件信息 */
export async function updateFile(db: D1Database, data: {
  id: number; name: string; type: string; hide: number; pwd: string | null;
}): Promise<void> {
  await db.prepare(
    `UPDATE pre_file SET name = ?, type = ?, hide = ?, pwd = ? WHERE id = ?`
  ).bind(data.name, data.type || '', data.hide ?? 0, data.pwd ?? null, data.id).run();
}

/** 获取所有文件总数 */
export async function getFileTotal(db: D1Database, session?: D1DatabaseSession): Promise<number> {
  const r = await pickExecutor(db, session).prepare('SELECT count(*) as c FROM pre_file').first<{ c: number }>();
  return r?.c ?? 0;
}

/** 获取指定日期范围文件数 */
export async function getFileCountByDateRange(db: D1Database, from: string, to?: string, session?: D1DatabaseSession): Promise<number> {
  const exec = pickExecutor(db, session);
  if (to) {
    const r = await exec.prepare(
      'SELECT count(*) as c FROM pre_file WHERE addtime >= ? AND addtime < ?'
    ).bind(from, to).first<{ c: number }>();
    return r?.c ?? 0;
  }
  const r = await exec.prepare(
    'SELECT count(*) as c FROM pre_file WHERE addtime >= ?'
  ).bind(from).first<{ c: number }>();
  return r?.c ?? 0;
}

/** 分页查询所有文件（无附加条件，仪表盘使用） */
export async function getFileListAll(db: D1Database, options: {
  offset: number; limit: number; orderby?: string;
}, session?: D1DatabaseSession): Promise<{ total: number; rows: FileRow[] }> {
  const exec = pickExecutor(db, session);
  const order = options.orderby === 'count' ? 'count DESC' : 'id DESC';
  const r = await exec.prepare('SELECT count(*) as c FROM pre_file').first<{ c: number }>();
  const { results } = await exec.prepare(
    `SELECT * FROM pre_file ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(options.limit, options.offset).all<FileRow>();
  return { total: r?.c ?? 0, rows: results };
}

/** 获取所有文件（用于迁移） */
export async function getAllFiles(db: D1Database, session?: D1DatabaseSession): Promise<FileRow[]> {
  const { results } = await pickExecutor(db, session).prepare(
    `SELECT * FROM pre_file`
  ).all<FileRow>();
  return results;
}

/** 更新文件计数与最后访问时间 */
export async function touchFile(db: D1Database, id: number): Promise<void> {
  await db.prepare(
    `UPDATE pre_file SET lasttime = ?, count = count + 1 WHERE id = ?`
  ).bind(now(), id).run();
}

/** 更新文件 block 状态 */
export async function setFileBlock(db: D1Database, id: number, block: number, session?: D1DatabaseSession): Promise<void> {
  await pickExecutor(db, session).prepare('UPDATE pre_file SET block = ? WHERE id = ?').bind(block, id).run();
}

/** 查询用户当日上传数 */
export async function getTodayUploadCount(db: D1Database, ip: string, uid: number, session?: D1DatabaseSession): Promise<number> {
  const exec = pickExecutor(db, session);
  const today = new Date().toISOString().substring(0, 10) + ' 00:00:00';
  let count: number;
  if (uid > 0) {
    const result = await exec.prepare(
      "SELECT count(*) as cnt FROM pre_file WHERE uid = ? AND addtime >= ?"
    ).bind(uid, today).first<{ cnt: number }>();
    count = result?.cnt ?? 0;
  } else {
    const result = await exec.prepare(
      "SELECT count(*) as cnt FROM pre_file WHERE ip = ? AND addtime >= ?"
    ).bind(ip, today).first<{ cnt: number }>();
    count = result?.cnt ?? 0;
  }
  return count;
}

/** 分页查询文件列表 */
export async function getFileList(db: D1Database, options: {
  search?: string; type?: string; dstatus?: number;
  offset: number; limit: number; orderby?: string;
}, session?: D1DatabaseSession): Promise<{ total: number; rows: FileRow[] }> {
  const exec = pickExecutor(db, session);
  let where = '1=1';
  const params: unknown[] = [];

  if (options.dstatus !== undefined && options.dstatus >= 0) {
    where += ' AND block = ?';
    params.push(options.dstatus);
  }
  if (options.search) {
    if (options.type === 'name') {
      where += ' AND name LIKE ?';
      params.push(`%${options.search}%`);
    } else if (options.type === 'hash') {
      where += ' AND hash = ?';
      params.push(options.search);
    }
  }

  const order = options.orderby === 'count' ? 'count DESC' : 'id DESC';

  const countResult = await exec.prepare(`SELECT count(*) as cnt FROM pre_file WHERE ${where}`)
    .bind(...params).first<{ cnt: number }>();

  const rows = await exec.prepare(
    `SELECT * FROM pre_file WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(...params, options.limit, options.offset).all<FileRow>();

  return { total: countResult?.cnt ?? 0, rows: rows.results };
}

/** 查询用户 */
export async function getUserById(db: D1Database, uid: number): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM pre_user WHERE uid = ? LIMIT 1').bind(uid).first<UserRow>();
}

/** 更新用户登录信息 */
export async function updateUserLogin(db: D1Database, uid: number, ip: string): Promise<void> {
  await db.prepare(
    'UPDATE pre_user SET loginip = ?, lasttime = ? WHERE uid = ?'
  ).bind(ip, now(), uid).run();
}
