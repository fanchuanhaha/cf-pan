// 彩虹外链网盘 - 存储工厂

import type { IStorage } from './IStorage';
import { R2Storage } from './R2Storage';
import { S3Storage } from './S3Storage';
import type { AppConfig, StorageType } from '../config';

export function createStorage(config: AppConfig, env?: { FILE_R2: R2Bucket }): IStorage | null {
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
    
    default:
      console.error('Unknown storage type:', config.storage);
      return null;
  }
}
