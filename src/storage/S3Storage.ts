// 彩虹外链网盘 - S3 兼容存储实现 (支持 OSS/COS/MinIO 等)

import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { IStorage } from './IStorage';

const FILE_PREFIX = 'file/';

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Storage implements IStorage {
  private cfg: S3Config;
  private client: S3Client;

  constructor(config: S3Config) {
    this.cfg = config;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  private key(name: string): string {
    return FILE_PREFIX + name;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
      }));
      return true;
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<R2ObjectBody | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
      }));
      if (!result.Body) return null;
      const buf = await result.Body.transformToByteArray();
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(buf));
            controller.close();
          },
        }),
        size: buf.byteLength,
        httpMetadata: { contentType: result.ContentType },
        writeHttpMetadata() {},
        get httpEtag() { return result.ETag || ''; },
        set httpEtag(_: string) {},
        get customMetadata() { return result.Metadata || {}; },
        set customMetadata(_: Record<string, string>) {},
        get range() { return undefined; },
        set range(_: R2Range | undefined) {},
      } as unknown as R2ObjectBody;
    } catch {
      return null;
    }
  }

  async downfile(name: string, range?: [number, number]): Promise<Response | null> {
    try {
      const cmd = new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        Range: range ? `bytes=${range[0]}-${range[1]}` : undefined,
      });
      const result = await this.client.send(cmd);
      if (!result.Body) return null;

      const headers: Record<string, string> = {
        'Content-Type': result.ContentType || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000',
      };
      if (range && result.ContentRange) headers['Content-Range'] = result.ContentRange;
      if (result.ContentLength) headers['Content-Length'] = String(result.ContentLength);
      if (result.ETag) headers['ETag'] = result.ETag;

      return new Response(result.Body as unknown as ReadableStream, {
        status: range ? 206 : 200,
        headers,
      });
    } catch (e) {
      console.error('S3 downfile error:', e);
      return null;
    }
  }

  async upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        Body: body instanceof ReadableStream
          ? body
          : new Uint8Array(body),
        ContentType: contentType || 'application/octet-stream',
      }));
      return true;
    } catch (e) {
      console.error('S3 upload error:', e);
      return false;
    }
  }

  async savefile(name: string, _tmpfile: string, _contentType?: string): Promise<boolean> {
    return false; // S3 使用 upload 替代
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
      }));
      return {
        length: result.ContentLength || 0,
        content_type: result.ContentType || 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
      }));
      return true;
    } catch {
      return false;
    }
  }
}
