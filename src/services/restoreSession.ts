// 彩虹外链网盘 - 安装/恢复会话（内存暂存 SQL 解析结果）
// 30 分钟过期；进程内 Map。Cloudflare Workers 单实例 30 分钟内通常同 worker，
// 但跨实例时数据会丢失（已在前端提示）。

import type { SqlPreExtractResult } from './restorePreExtract';

const SESSION_TTL_MS = 30 * 60 * 1000;

interface InstallSession {
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

const sessions = new Map<string, InstallSession>();

/** 清理过期 session（每次操作前调用） */
function purgeExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

export function createInstallSession(opts: {
  sqlText: string;
  preExtract: SqlPreExtractResult;
  freshInstall?: boolean;
}): InstallSession {
  purgeExpired();
  const id = 'inst_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  const sess: InstallSession = {
    id,
    createdAt: Date.now(),
    sqlText: opts.sqlText,
    preExtract: opts.preExtract,
    storageType: '',
    storageFields: {},
    selectedConfig: {},
    sourceUrl: undefined,
    freshInstall: !!opts.freshInstall,
  };
  sessions.set(id, sess);
  return sess;
}

export function getInstallSession(id: string): InstallSession | null {
  purgeExpired();
  const s = sessions.get(id);
  if (!s) return null;
  // 滑动过期
  s.createdAt = Date.now();
  return s;
}

export function updateInstallSession(id: string, patch: Partial<InstallSession>): InstallSession | null {
  const s = getInstallSession(id);
  if (!s) return null;
  Object.assign(s, patch);
  return s;
}

export function deleteInstallSession(id: string): void {
  sessions.delete(id);
}

export function listInstallSessions(): Array<{ id: string; createdAt: number; freshInstall: boolean }> {
  purgeExpired();
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    createdAt: s.createdAt,
    freshInstall: s.freshInstall,
  }));
}
