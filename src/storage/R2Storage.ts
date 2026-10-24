// 彩虹外链网盘 - Cloudflare R2 存储实现

import type { IStorage, MultipartPart, StorageObject } from './IStorage';

const FILE_PREFIX = 'file/';

export class R2Storage implements IStorage {
  private bucket: R2Bucket;
  private publicUrl: string;

  constructor(bucket: R2Bucket, publicUrl?: string) {
    this.bucket = bucket;
    this.publicUrl = (publicUrl || '').trim().replace(/\/+$/, '');
  }

  private key(name: string): string {
    return FILE_PREFIX + name;
  }

  async exists(name: string): Promise<boolean> {
    const obj = await this.bucket.head(this.key(name));
    return obj !== null;
  }

  async get(name: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(this.key(name));
  }

  async downfile(name: string, range?: [number, number]): Promise<Response | null> {
    const key = this.key(name);
    if (range) {
      const obj = await this.bucket.head(key);
      if (!obj) return null;
      const headers: Record<string, string> = {
        'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
      };
      const end = Math.min(range[1], obj.size - 1);
      headers['Content-Range'] = `bytes ${range[0]}-${end}/${obj.size}`;
      headers['Content-Length'] = String(end - range[0] + 1);
      
      const body = await this.bucket.get(key, {
        range: { offset: range[0], length: end - range[0] + 1 },
      });
      if (!body) return null;
      return new Response(body.body, { status: 206, headers });
    }

    const obj = await this.bucket.get(key);
    if (!obj) return null;

    const headers: Record<string, string> = {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000',
    };
    return new Response(obj.body, { headers });
  }

  async upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean> {
    try {
      await this.bucket.put(this.key(name), body as ReadableStream | ArrayBuffer, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
      return true;
    } catch (e) {
      console.error('R2 upload error:', e);
      return false;
    }
  }

  async savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean> {
    return this.upload(name, new Uint8Array(0) as unknown as ArrayBuffer, contentType); // R2 不需要本地文件
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    const obj = await this.bucket.head(this.key(name));
    if (!obj) return null;
    return {
      length: obj.size,
      content_type: obj.httpMetadata?.contentType || 'application/octet-stream',
    };
  }

  async delete(name: string): Promise<boolean> {
    try {
      await this.bucket.delete(this.key(name));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<StorageObject[]> {
    const out: StorageObject[] = [];
    let cursor: string | undefined;
    // R2 每次最多返回 1000 个对象，循环取完；上限防止异常情况下无限翻页
    for (let page = 0; page < 100; page++) {
      const result = await this.bucket.list({ prefix: FILE_PREFIX, cursor, limit: 1000 });
      for (const obj of result.objects) {
        out.push({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded ? obj.uploaded.toISOString() : undefined,
        });
      }
      if (!result.truncated) break;
      cursor = result.cursor;
    }
    return out;
  }

  async createMultipartUpload(name: string, contentType?: string): Promise<string | null> {
    try {
      const upload = await this.bucket.createMultipartUpload(this.key(name), {
        httpMetadata: contentType ? { contentType } : undefined,
      });
      return upload.uploadId;
    } catch (e) {
      console.error('R2 createMultipartUpload error:', e);
      return null;
    }
  }

  async uploadPart(name: string, uploadId: string, partNumber: number, body: ArrayBuffer | Blob): Promise<string | null> {
    try {
      const upload = this.bucket.resumeMultipartUpload(this.key(name), uploadId);
      const part = await upload.uploadPart(partNumber, body);
      return part.etag;
    } catch (e) {
      console.error('R2 uploadPart error:', e);
      return null;
    }
  }

  async completeMultipartUpload(name: string, uploadId: string, parts: MultipartPart[]): Promise<boolean> {
    try {
      const upload = this.bucket.resumeMultipartUpload(this.key(name), uploadId);
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      await upload.complete(sorted);
      return true;
    } catch (e) {
      console.error('R2 completeMultipartUpload error:', e);
      return false;
    }
  }

  async abortMultipartUpload(name: string, uploadId: string): Promise<boolean> {
    try {
      const upload = this.bucket.resumeMultipartUpload(this.key(name), uploadId);
      await upload.abort();
      return true;
    } catch (e) {
      console.error('R2 abortMultipartUpload error:', e);
      return false;
    }
  }

  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    // R2 绑定本身不能签发预签名 URL：
    // - 配置了公开访问域名（r2_public_url / 自定义域）时返回公开直链
    // - 否则返回 null，继续走 Worker 中转
    if (!this.publicUrl) return null;
    return `${this.publicUrl}/file/${encodeURIComponent(name)}`;
  }
}
