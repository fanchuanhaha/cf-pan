// 彩虹外链网盘 - 存储后端集合与维护操作
//
// R2 有两种访问方式：
//   1. Worker 的 FILE_R2 绑定（R2Storage）
//   2. Account ID + AK/SK 的 S3 兼容 API（S3Storage，直传预签名也走这里）
// 当两种方式同时存在时，它们可能指向同一个桶，也可能指向不同桶。
// 删除、下载、差异检查都同时考虑这两种后端，避免只删掉数据库记录、
// 却在另一个桶里留下孤儿文件。

import type { AppConfig } from '../config';
import type { IStorage } from './IStorage';
import { R2Storage } from './R2Storage';
import { S3Storage, type S3Config } from './S3Storage';
import { createStorage } from './factory';

export interface StorageBackend {
  id: string;
  label: string;
  stor: IStorage;
}

export interface StorageDeleteResult {
  ok: boolean;
  /** 实际删除成功的后端 */
  deleted: string[];
  /** 删除过程中出现的错误（不会暴露密钥） */
  errors: string[];
  /** 删除后仍然存在的后端 */
  remaining: string[];
}

export interface StorageExistsResult {
  exists: boolean;
  foundIn: string[];
  errors: string[];
}

function errText(e: unknown): string {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  const anyErr = e as any;
  const name = anyErr.name ? `${anyErr.name}: ` : '';
  const msg = anyErr.message || String(e);
  return (name + msg).slice(0, 400);
}

function storageLabel(type: string): string {
  switch (type) {
    case 'r2': return 'R2';
    case 's3': return 'S3';
    case 'github': return 'GitHub API';
    case 'webdav': return 'WebDAV';
    case 'upyun': return '又拍云';
    case 'qiniu': return '七牛云';
    default: return type;
  }
}

/** 从配置中提取 R2 的 S3 兼容 API 参数；不完整时返回 null */
export function getR2S3Config(config: AppConfig): S3Config | null {
  if (config.storage !== 'r2') return null;
  const endpoint = (config.r2_endpoint || '').trim() ||
    (config.r2_account_id ? `https://${config.r2_account_id}.r2.cloudflarestorage.com` : '');
  if (!endpoint || !config.r2_bucket || !config.r2_access_key_id || !config.r2_secret_access_key) {
    return null;
  }
  return {
    endpoint,
    region: 'auto',
    bucket: config.r2_bucket,
    accessKeyId: config.r2_access_key_id,
    secretAccessKey: config.r2_secret_access_key,
  };
}

/**
 * 返回当前配置下所有可用的存储后端。
 * 对 R2 会同时返回绑定和 S3 API 两种（如果都配置了）。
 */
export function getStorageBackends(
  config: AppConfig,
  env?: { FILE_R2?: R2Bucket }
): StorageBackend[] {
  const out: StorageBackend[] = [];

  if (config.storage === 'r2') {
    if (env?.FILE_R2) {
      out.push({
        id: 'r2-binding',
        label: 'R2 绑定 (FILE_R2)',
        stor: new R2Storage(env.FILE_R2, config.r2_public_url),
      });
    }
    const s3cfg = getR2S3Config(config);
    if (s3cfg) {
      out.push({
        id: 'r2-s3',
        label: `R2 S3 API (${config.r2_bucket})`,
        stor: new S3Storage(s3cfg),
      });
    }
    if (out.length === 0) {
      const stor = createStorage(config, env);
      if (stor) out.push({ id: 'r2', label: 'R2', stor });
    }
    return out;
  }

  const stor = createStorage(config, env);
  if (stor) {
    out.push({ id: config.storage, label: storageLabel(config.storage), stor });
  }
  return out;
}

/** 检查对象是否存在于任一后端；用于直传完成校验和删除前确认 */
export async function objectExistsInBackends(
  backends: StorageBackend[],
  name: string
): Promise<StorageExistsResult> {
  const foundIn: string[] = [];
  const errors: string[] = [];
  for (const backend of backends) {
    try {
      if (await backend.stor.exists(name)) foundIn.push(backend.label);
    } catch (e) {
      errors.push(`${backend.label} 检查失败：${errText(e)}`);
    }
  }
  return { exists: foundIn.length > 0, foundIn, errors };
}

/**
 * 从所有后端删除同一个对象。
 * 只有确认所有后端都不再存在该对象时才返回 ok=true；
 * 如果某个后端无法检查/删除，也会返回 ok=false，调用方应保留数据库记录。
 */
export async function deleteObjectFromBackends(
  backends: StorageBackend[],
  name: string
): Promise<StorageDeleteResult> {
  const deleted: string[] = [];
  const errors: string[] = [];

  if (backends.length === 0) {
    return { ok: false, deleted, errors: ['没有可用的存储后端'], remaining: [] };
  }

  for (const backend of backends) {
    let exists = false;
    try {
      exists = await backend.stor.exists(name);
    } catch (e) {
      errors.push(`${backend.label} 检查失败：${errText(e)}`);
      continue;
    }
    if (!exists) continue;

    try {
      const ok = await backend.stor.delete(name);
      if (!ok) {
        errors.push(`${backend.label} 删除失败`);
        continue;
      }
      // R2/S3 的 delete 本身是幂等的，但再 HEAD 一次确认对象真的消失
      const still = await backend.stor.exists(name);
      if (still) errors.push(`${backend.label} 删除后对象仍然存在`);
      else deleted.push(backend.label);
    } catch (e) {
      errors.push(`${backend.label} 删除异常：${errText(e)}`);
    }
  }

  // 最终再确认一次，避免某个后端删除失败但接口返回成功
  const remaining: string[] = [];
  for (const backend of backends) {
    try {
      if (await backend.stor.exists(name)) remaining.push(backend.label);
    } catch (e) {
      errors.push(`${backend.label} 最终检查失败：${errText(e)}`);
    }
  }

  return {
    ok: remaining.length === 0 && errors.length === 0,
    deleted,
    errors,
    remaining,
  };
}

/** 查找对象所在的后端（下载/预览时使用），找不到返回 null */
export async function findStorageBackend(
  backends: StorageBackend[],
  name: string
): Promise<{ backend: StorageBackend | null; errors: string[] }> {
  const errors: string[] = [];
  for (const backend of backends) {
    try {
      if (await backend.stor.exists(name)) return { backend, errors };
    } catch (e) {
      errors.push(`${backend.label} 检查失败：${errText(e)}`);
    }
  }
  return { backend: null, errors };
}
