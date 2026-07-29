// 彩虹外链网盘 - 存储工厂

import type { IStorage } from './IStorage';
import { R2Storage } from './R2Storage';
import { S3Storage } from './S3Storage';
import { GitHubApiStorage } from './GitHubApiStorage';
import { WebDavStorage } from './WebDavStorage';
import { UpYunStorage } from './UpYunStorage';
import { QiniuStorage } from './QiniuStorage';
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

    case 'webdav':
      if (!config.webdav_endpoint || !config.webdav_user || !config.webdav_pass) {
        console.error('WebDAV config incomplete (need endpoint/user/pass)');
        return null;
      }
      try {
        return new WebDavStorage({
          endpoint: config.webdav_endpoint,
          username: config.webdav_user,
          password: config.webdav_pass,
          defaultFolder: config.webdav_folder || 'file',
        });
      } catch (e: any) {
        console.error('WebDAV create error:', e);
        return null;
      }

    case 'upyun':
      if (!config.upyun_bucket || !config.upyun_operator || !config.upyun_password) {
        console.error('UpYun config incomplete (need bucket/operator/password)');
        return null;
      }
      return new UpYunStorage({
        bucket: config.upyun_bucket,
        operator: config.upyun_operator,
        password: config.upyun_password,
        endpoint: config.upyun_endpoint || undefined,
        domain: config.upyun_domain || undefined,
        folder: config.upyun_folder || 'file',
      });

    case 'qiniu':
      if (!config.qiniu_ak || !config.qiniu_sk || !config.qiniu_bucket) {
        console.error('Qiniu config incomplete (need ak/sk/bucket)');
        return null;
      }
      return new QiniuStorage({
        accessKey: config.qiniu_ak,
        secretKey: config.qiniu_sk,
        bucket: config.qiniu_bucket,
        domain: config.qiniu_domain || undefined,
        folder: config.qiniu_folder || 'file',
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
    case 'webdav':
      return !!(config.webdav_endpoint && config.webdav_user && config.webdav_pass);
    case 'upyun':
      return !!(config.upyun_bucket && config.upyun_operator && config.upyun_password);
    case 'qiniu':
      return !!(config.qiniu_ak && config.qiniu_sk && config.qiniu_bucket);
    default:
      return false;
  }
}
