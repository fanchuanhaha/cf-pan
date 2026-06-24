// 彩虹外链网盘 - Cloudflare R2 存储实现

import type { IStorage } from './IStorage';

const FILE_PREFIX = 'file/';

export class R2Storage implements IStorage {
  private bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
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
      await this.bucket.put(this.key(name), body, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
      return true;
    } catch (e) {
      console.error('R2 upload error:', e);
      return false;
    }
  }

  async savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean> {
    return this.upload(name, new Uint8Array(0), contentType); // R2 不需要本地文件
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

  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    // R2 使用公开 URL 或签名 URL
    // 在 Worker 中可以直接代理下载，这里返回 null 表示走中转
    return null;
  }
}
