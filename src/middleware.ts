// 彩虹外链网盘 - Hono 中间件：注入 db / stor / config
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

/** 中间件：加载配置 + 尝试创建存储实例 */
export const initApp = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const db = c.env.DB;
    const config = await loadConfig(db);
    const stor = createStorage(config, { FILE_R2: c.env.FILE_R2 });
    const storageOk = isStorageConfigured(config, { FILE_R2: c.env.FILE_R2 });

    c.set('db', db);
    c.set('stor', stor);
    c.set('config', config);
    c.set('storageOk', storageOk);

    await next();
  };
};

/** 快速获取 db */
export function getDB(c: Context<AppEnv>): D1Database {
  return c.var.db;
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

/**
 * 创建一个 D1 Session，用于保证读写一致性
 * Cloudflare D1 默认是最终一致性的，跨请求的读可能看不到刚写的记录
 * 使用 withSession() 后，写入和读取都会走主库，确保读到最新数据
 * 可选地支持从 cookie 中恢复 Session Token（Bookmark），用于跨请求强一致
 */
export function getDBSession(c: Context<AppEnv>): D1DatabaseSession {
  const db = c.env.DB;
  // 尝试从 cookie 中恢复 D1 Session Bookmark，实现跨请求读后写一致性
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/d1_session=([^;]+)/);
  const bookmark = match ? decodeURIComponent(match[1]) : undefined;
  const session = bookmark ? db.withSession(bookmark) : db.withSession();
  // 把 session 存到 ctx，方便路由结束时回写最新 bookmark
  (c as any)._d1Session = session;
  return session;
}

/**
 * 将当前 D1 Session 的 bookmark 写入到响应 Cookie，
 * 让后续请求（如后台统计）能看到本次请求的写入
 * 必须在 jsonResult 等最终响应之前调用
 */
export function flushDBSession(c: Context<AppEnv>): void {
  const session = (c as any)._d1Session as D1DatabaseSession | undefined;
  if (!session) return;
  // 取出当前 session 的 bookmark（不同 runtime 暴露方法可能不同，做兼容）
  const anySession = session as unknown as { getBookmark?: () => string; bookmark?: () => string };
  let bookmark: string | undefined;
  try {
    bookmark = (anySession.getBookmark && anySession.getBookmark())
      ?? (anySession.bookmark && anySession.bookmark())
      ?? undefined;
  } catch {
    bookmark = undefined;
  }
  if (bookmark) {
    c.header(
      'Set-Cookie',
      `d1_session=${encodeURIComponent(bookmark)}; Path=/; Max-Age=300; SameSite=Lax; HttpOnly`
    );
  }
}
