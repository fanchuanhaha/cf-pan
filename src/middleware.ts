// 彩虹外链网盘 - Hono 中间件：注入 db / stor / config
import type { Context, MiddlewareHandler } from 'hono';
import type { IStorage } from '../storage/IStorage';
import type { AppConfig } from '../config';
import { loadConfig, getConfig } from '../config';
import { createStorage } from '../storage/factory';

// 扩展 Hono Context 的变量类型
export interface AppVariables {
  db: D1Database;
  stor: IStorage;
  config: AppConfig;
}

/** 绑定类型增强的 Context */
export type AppContext = Context<{
  Bindings: {
    DB: D1Database;
    FILE_R2: R2Bucket;
    AI?: unknown;
  };
  Variables: AppVariables;
}>;

/** 中间件：加载配置并创建存储实例 */
export const initApp = (): MiddlewareHandler<{
  Bindings: { DB: D1Database; FILE_R2: R2Bucket; AI?: unknown };
  Variables: AppVariables;
}> => {
  return async (c, next) => {
    const db = c.env.DB;
    const config = await loadConfig(db);
    const stor = createStorage(config, { FILE_R2: c.env.FILE_R2 });
    if (!stor) {
      return c.text('Storage initialization failed', 500);
    }
    c.set('db', db);
    c.set('stor', stor);
    c.set('config', config);
    await next();
  };
};

/** 快速获取 db */
export function getDB(c: Context<{ Variables: AppVariables }>): D1Database {
  return c.var.db;
}

/** 快速获取 stor */
export function getStor(c: Context<{ Variables: AppVariables }>): IStorage {
  return c.var.stor;
}

/** 快速获取 config */
export function getConf(c: Context<{ Variables: AppVariables }>): AppConfig {
  return c.var.config;
}
