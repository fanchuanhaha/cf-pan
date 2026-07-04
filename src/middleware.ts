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

/**
 * D1 读写兼容类型：
 * - 原生 D1Database（admin/初始化等场景）
 * - D1DatabaseSession（带读后写一致性保证）
 *
 * 注意：Cloudflare D1 默认开启读副本（read replication），写入仅发生在主库，
 * 副本需要异步同步。当用户上传完文件后立即打开后台时，后台的读请求
 * 很可能命中还没同步的副本，导致"刚上传的文件看不到"（admin 列表显示 0）。
 *
 * 解决方案：使用 db.withSession('first-primary')，让每个请求的首次读强制走主库，
 * 保证 read-after-write 一致性。同一 session 内的后续读会自动用副本（性能不损失）。
 */
export type D1Like = D1Database | D1DatabaseSession;

// 扩展 Hono Context 的变量类型
export interface AppVariables {
  db: D1Like;
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

/** 中间件：加载配置 + 尝试创建存储实例 + 注入一致性 Session */
export const initApp = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const rawDb = c.env.DB;

    // 关键修复：为每个请求创建一个 D1 Session，first-primary 保证读后写一致性
    // 解决"文件已上传到对象存储，但后台还显示 0 个文件"的问题（D1 读副本滞后）
    const db = rawDb.withSession('first-primary');

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

/** 快速获取 db (带读后写一致性的 Session) */
export function getDB(c: Context<AppEnv>): D1Like {
  return c.var.db;
}

/** 获取原生 D1Database（仅在确实需要绕过 session 的场景使用，例如 D1 HTTP API 调用） */
export function getRawDB(c: Context<AppEnv>): D1Database {
  return c.env.DB;
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
