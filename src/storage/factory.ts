// 彩虹外链网盘 - 存储工厂

import type { IStorage } from './IStorage';
import { R2Storage } from './R2Storage';
import { S3Storage } from './S3Storage';
import { GitHubApiStorage } from './GitHubApiStorage';
import type { AppConfig, StorageType } from '../config';

export type StorageInitResult = {
  ok: boolean;
  stor: IStorage | null;
  error?: string;
  storageType?: StorageType;
};

export function createStorage(config: AppConfig, env?: { FILE_R2?: R2Bucket }): IStorage | null {
  switch (config.storage) {
    case 'r2':
      if (!env?.FILE_R2) {
        console.error('R2 bucket binding not found');
        return null;
      }
      return new R2Storage(env.FILE_R2);

    case 's3':
      if (!config.s3_endpoint || !config.s3_bucket) {
        console.error('S3 config incomplete');
        return null;
      }
      return new S3Storage({
        endpoint: config.s3_endpoint,
        region: config.s3_region || 'auto',
        bucket: config.s3_bucket,
        accessKeyId: config.s3_ak,
        secretAccessKey: config.s3_sk,
      });

    case 'github':
      if (!config.gh_owner || !config.gh_repo || !config.gh_token) {
        console.error('GitHub config incomplete (need owner/repo/token)');
        return null;
      }
      return new GitHubApiStorage({
        owner: config.gh_owner,
        repo: config.gh_repo,
        token: config.gh_token,
        ref: config.gh_ref || undefined,
        defaultFolder: config.gh_folder || undefined,
        apiBase: config.gh_api_base || undefined,
      });

    default:
      console.error('Unknown storage type:', config.storage);
      return null;
  }
}

/** 检查配置是否已完整填写某种存储（用于判断是否需要进入安装流程） */
export function isStorageConfigured(config: AppConfig, env?: { FILE_R2?: R2Bucket }): boolean {
  if (config.installed === 1) return true;
  switch (config.storage) {
    case 'r2':
      return !!env?.FILE_R2;
    case 's3':
      return !!(config.s3_endpoint && config.s3_bucket && config.s3_ak && config.s3_sk);
    case 'github':
      return !!(config.gh_owner && config.gh_repo && config.gh_token);
    default:
      return false;
  }
}
