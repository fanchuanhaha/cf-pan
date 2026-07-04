// 彩虹外链网盘 - Hono 中间件：注入 db / dbSession / stor / config
// 关键点：基于 Cloudflare D1 Sessions API（bookmark + withSession）实现
// read-after-write 一致性，避免 D1 读副本滞后导致"上传成功但后台仍为 0"的问题。
import type { Context, MiddlewareHandler } from 'hono';
import type { IStorage } from './storage/IStorage';
import type { AppConfig } from './config';
import { loadConfig } from './config';
import { createStorage, isStorageConfigured } from './storage/factory';

export type AppBindings = {
  DB: D1Database;
  FILE_R2?: R2Bucket; // 改为可选
  AI?: unknown;
};

// 扩展 Hono Context 的变量类型
export interface AppVariables {
  db: D1Database;
  /** D1 会话（带 bookmark，Cloudflare read-after-write 一致性） */
  dbSession: D1DatabaseSession;
  stor: IStorage | null;
  config: AppConfig;
  storageOk: boolean;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};

/** 绑定类型增强的 Context */
export type AppContext = Context<AppEnv>;

/** D1 会话书签 Cookie 名称 */
export const D1_BOOKMARK_COOKIE = 'd1_bookmark';
/** D1 会话书签有效期（秒） */
export const D1_BOOKMARK_MAX_AGE = 86400;

/** 解析请求 Cookie 中的 D1 bookmark */
function readBookmarkFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const m = cookieHeader.match(/(?:^|;\s*)d1_bookmark=([^;]+)/);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** 中间件：加载配置 + 创建存储 + 创建 D1 会话 */
export const initApp = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const db = c.env.DB;
    const config = await loadConfig(db);
    const stor = createStorage(config, { FILE_R2: c.env.FILE_R2 });
    const storageOk = isStorageConfigured(config, { FILE_R2: c.env.FILE_R2 });

    // 读取 D1 bookmark（来自客户端的 Cookie）
    // 用作 read-after-write 一致性保障：跨请求读能立即看到最近的写
    const bookmark = readBookmarkFromCookie(c.req.header('cookie'));

    // 创建 D1 会话
    //   - 有 bookmark：用书签作为起点，Cloudflare 会确保新会话至少能读到该版本，
    //                 允许路由到本地副本（低延迟），同时保证强一致。
    //   - 无 bookmark：用 'first-primary' 强制走主库，避免读副本的初始滞后。
    const dbSession = bookmark ? db.withSession(bookmark) : db.withSession('first-primary');

    c.set('db', db);
    c.set('dbSession', dbSession);
    c.set('stor', stor);
    c.set('config', config);
    c.set('storageOk', storageOk);

    await next();

    // 请求结束后，把当前会话的最新 bookmark 写回 Cookie
    // 这样后续请求（admin 查统计、文件列表等）能立即看到本次的写入
    const newBookmark = dbSession.getBookmark();
    if (newBookmark) {
      const cookieValue = `${D1_BOOKMARK_COOKIE}=${encodeURIComponent(newBookmark)}; Path=/; Max-Age=${D1_BOOKMARK_MAX_AGE}; SameSite=Lax; HttpOnly`;
      // append:true 避免覆盖其他路由已经写入的 Set-Cookie（如 upload_csrf / admin_token）
      c.header('Set-Cookie', cookieValue, { append: true });
    }
  };
};

/** 快速获取 db（原始绑定，写入仍走主库） */
export function getDB(c: Context<AppEnv>): D1Database {
  return c.var.db;
}

/**
 * 快速获取 D1 会话（带 bookmark，Cloudflare read-after-write 一致性）
 * 如果中间件未注入（例如直接调用），自动回退为 'first-primary' 强制走主库，
 * 仍然可以避免读副本滞后问题。
 */
export function getDBSession(c: Context<AppEnv>): D1DatabaseSession {
  if (c.var?.dbSession) return c.var.dbSession;
  return c.var.db.withSession('first-primary');
}

/** 快速获取 stor（可能为 null） */
export function getStor(c: Context<AppEnv>): IStorage | null {
  return c.var.stor;
}

/** 快速获取 stor，如果未就绪则抛错 */
export function getStorOrThrow(c: Context<AppEnv>): IStorage {
  if (!c.var.stor) {
    throw new Error('Storage not configured');
  }
  return c.var.stor;
}

/** 快速获取 config */
export function getConf(c: Context<AppEnv>): AppConfig {
  return c.var.config;
}

/** 检查存储是否就绪 */
export function isStorageReady(c: Context<AppEnv>): boolean {
  return c.var.storageOk && c.var.stor !== null;
}
