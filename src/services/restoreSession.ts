// 彩虹外链网盘 - 安装/恢复会话
// 主存：D1 表 install_session（跨实例共享，30 分钟过期）
// 缓存：内存 Map（避免每次都查 D1）
// 备份：Cookie（仅 session id，最简）
//
// Workers 是多实例分布的，内存 Map 不可靠，所以主存必须用 D1。
// 之前用 cookie 备份 sqlText 会触发 4KB cookie 大小限制；改用 D1 后无此问题。

import type { SqlPreExtractResult } from './restorePreExtract';

const SESSION_TTL_MS = 30 * 60 * 1000;
const COOKIE_NAME = 'install_sess';

export interface InstallSession {
  id: string;
  createdAt: number;
  /** 原始 SQL 文本（用于 apply 时回写 pre_file / pre_user 等） */
  sqlText: string;
  /** 预提取结果 */
  preExtract: SqlPreExtractResult;
  /** 当前已选择的 storage 类型（r2/s3/github/webdav/upyun/qiniu） */
  storageType: string;
  /** 当前 storage 配置字段（不含 storage 字段本身） */
  storageFields: Record<string, string>;
  /** 用户在"勾选配置"步骤勾选的 pre_config 键值对（可能剔除 storage） */
  selectedConfig: Record<string, string>;
  /** 用户在"输入原站点"步骤填写的 source URL */
  sourceUrl?: string;
  /** 是否走"全新安装"流程（不写 SQL） */
  freshInstall: boolean;
}

const cache = new Map<string, InstallSession>();

/** 生成 session id */
function genId(): string {
  return 'inst_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

interface DbSessionRow {
  id: string;
  created_at: number;
  sql_text: string;
  pre_extract: string;
  storage_type: string | null;
  storage_fields: string | null;
  selected_config: string | null;
  source_url: string | null;
  fresh_install: number;
}

function rowToSession(row: DbSessionRow): InstallSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    sqlText: row.sql_text,
    preExtract: JSON.parse(row.pre_extract),
    storageType: row.storage_type || '',
    storageFields: row.storage_fields ? JSON.parse(row.storage_fields) : {},
    selectedConfig: row.selected_config ? JSON.parse(row.selected_config) : {},
    sourceUrl: row.source_url || undefined,
    freshInstall: row.fresh_install === 1,
  };
}

function sessionToRow(s: InstallSession): DbSessionRow {
  return {
    id: s.id,
    created_at: s.createdAt,
    sql_text: s.sqlText,
    pre_extract: JSON.stringify(s.preExtract),
    storage_type: s.storageType || null,
    storage_fields: JSON.stringify(s.storageFields || {}),
    selected_config: JSON.stringify(s.selectedConfig || {}),
    source_url: s.sourceUrl || null,
    fresh_install: s.freshInstall ? 1 : 0,
  };
}

/** 从 D1 读取 session（自动检查过期） */
async function loadFromDb(db: D1Database, id: string): Promise<InstallSession | null> {
  // 顺手清理过期记录（每 100 次调用清理一次）
  if (Math.random() < 0.01) {
    try {
      await db.prepare('DELETE FROM install_session WHERE created_at < ?')
        .bind(Date.now() - SESSION_TTL_MS)
        .run();
    } catch { /* 忽略 */ }
  }
  const row = await db.prepare('SELECT * FROM install_session WHERE id = ?')
    .bind(id).first<DbSessionRow>();
  if (!row) return null;
  if (Date.now() - row.created_at > SESSION_TTL_MS) {
    // 过期
    await db.prepare('DELETE FROM install_session WHERE id = ?').bind(id).run();
    return null;
  }
  return rowToSession(row);
}

/** 把 session 写入 D1（覆盖） */
async function saveToDb(db: D1Database, s: InstallSession): Promise<void> {
  const r = sessionToRow(s);
  await db.prepare(
    `INSERT OR REPLACE INTO install_session
       (id, created_at, sql_text, pre_extract, storage_type, storage_fields, selected_config, source_url, fresh_install)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    r.id, r.created_at, r.sql_text, r.pre_extract,
    r.storage_type, r.storage_fields, r.selected_config, r.source_url, r.fresh_install
  ).run();
}

/** 创建 session（需要 D1 句柄） */
export async function createInstallSession(db: D1Database, opts: {
  sqlText: string;
  preExtract: SqlPreExtractResult;
  freshInstall?: boolean;
}): Promise<InstallSession> {
  const sess: InstallSession = {
    id: genId(),
    createdAt: Date.now(),
    sqlText: opts.sqlText,
    preExtract: opts.preExtract,
    storageType: '',
    storageFields: {},
    selectedConfig: {},
    sourceUrl: undefined,
    freshInstall: !!opts.freshInstall,
  };
  await saveToDb(db, sess);
  cache.set(sess.id, sess);
  return sess;
}

/** 读取 session（需要 D1 句柄） */
export async function getInstallSession(db: D1Database, id: string): Promise<InstallSession | null> {
  // 1) 内存缓存
  const cached = cache.get(id);
  if (cached) {
    if (Date.now() - cached.createdAt > SESSION_TTL_MS) {
      cache.delete(id);
    } else {
      // 滑动过期
      cached.createdAt = Date.now();
      return cached;
    }
  }
  // 2) D1 主存
  const s = await loadFromDb(db, id);
  if (!s) return null;
  // 滑动过期
  s.createdAt = Date.now();
  cache.set(s.id, s);
  return s;
}
/** 更新 session（需要 D1 句柄） */
export async function updateInstallSession(
  db: D1Database,
  id: string,
  patch: Partial<Omit<InstallSession, 'id' | 'sqlText' | 'preExtract' | 'freshInstall' | 'createdAt'>>
): Promise<InstallSession | null> {
  const s = await getInstallSession(db, id);
  if (!s) return null;
  Object.assign(s, patch);
  await saveToDb(db, s);
  cache.set(s.id, s);
  return s;
}

/** 删除 session */
export async function deleteInstallSession(db: D1Database, id: string): Promise<void> {
  cache.delete(id);
  try {
    await db.prepare('DELETE FROM install_session WHERE id = ?').bind(id).run();
  } catch { /* 忽略 */ }
}

/** 列出所有 session（调试用） */
export function listInstallSessions(): Array<{ id: string; createdAt: number; freshInstall: boolean }> {
  const now = Date.now();
  return Array.from(cache.values())
    .filter(s => now - s.createdAt <= SESSION_TTL_MS)
    .map(s => ({ id: s.id, createdAt: s.createdAt, freshInstall: s.freshInstall }));
}

/** 生成 Set-Cookie 头（仅存 session id，30 分钟过期） */
export function sessionSetCookieHeader(id: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

/** 生成清除 cookie 头 */
export function sessionClearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** 从请求中读 session id（cookie 或 query） */
export function readSessionId(req: Request): string {
  // 1) 优先 query（方便调试和跨域）
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('s');
    if (q) return decodeURIComponent(q);
  } catch { /* 忽略 */ }
  // 2) cookie
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

export { COOKIE_NAME };
