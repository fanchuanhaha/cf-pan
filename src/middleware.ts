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
    const config = await loadConfig(db, { FILE_R2: c.env.FILE_R2 });
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
    const storageType = c.var.config?.storage || '(未设置)';
    const installed = c.var.config?.installed;
    // 给出更具体的错误信息，便于排查是哪种情况导致的 storage 不可用
    let detail = `storage="${storageType}"`;
    if (installed === 1) {
      detail += '（系统已 installed=1，但当前 storage 类型不可用，常见原因：曾通过 SQL 恢复覆盖了 pre_config 表的 storage 字段为 PHP 项目的 "local"，请到后台【系统设置】重新选择并保存存储类型）';
    } else {
      detail += '（系统尚未安装，请在安装向导中选择并配置存储后端）';
    }
    throw new Error('Storage not configured: ' + detail);
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
