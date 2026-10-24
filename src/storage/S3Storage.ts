// 彩虹外链网盘 - S3 兼容存储实现 (支持 OSS/COS/MinIO 等)

import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { IStorage, StorageObject } from './IStorage';
import { getFileExt, getMimeType } from '../utils/mime';

const FILE_PREFIX = 'file/';

export interface S3Config {
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
      // 预签名 URL 不带 checksum，浏览器才能直接 PUT
      requestChecksumCalculation: 'WHEN_REQUIRED',
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
    } catch (e: any) {
      // 只有明确的 404 才能当作“对象不存在”。
      // 网络错误、AK/SK 失效、权限不足等必须抛出，否则删除流程会误以为
      // 文件已经不在存储里，从而只删数据库记录、留下 R2 孤儿文件。
      const status = e?.$metadata?.httpStatusCode ?? e?.$response?.statusCode;
      const code = String(e?.name || e?.Code || e?.code || '');
      if (status === 404 || code === 'NotFound' || code === 'NoSuchKey' || code === '404') {
        return false;
      }
      throw e;
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

  /** 前端直传参数：SigV4 预签名 PUT URL（浏览器直接 PUT，需存储商开启 CORS） */
  async getUploadParam(name: string, filename: string, _maxFileSize?: number): Promise<{
    url: string; post: Record<string, string>; method: 'PUT'; headers: Record<string, string>;
  } | null> {
    try {
      // 把 Content-Type 一起签进去，直传后对象才有正确的 MIME（否则 R2/S3 默认 octet-stream）
      const contentType = getMimeType(getFileExt(filename));
      const url = await getSignedUrl(this.client, new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        ContentType: contentType,
      }), { expiresIn: 3600 });
      return { method: 'PUT', url, post: {}, headers: { 'Content-Type': contentType } };
    } catch (e) {
      console.error('S3 presign error:', e);
      return null;
    }
  }

  /** 直链下载：私有桶用 1 小时有效的预签名 GET（只暴露 AK ID 和签名，不暴露 SK） */
  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    try {
      const url = await getSignedUrl(this.client, new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        ResponseContentDisposition: filename
          ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
          : undefined,
        ResponseContentType: contentType || undefined,
      }), { expiresIn: 3600 });
      return url;
    } catch (e) {
      console.error('S3 presign download error:', e);
      return null;
    }
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
    const key = this.key(name);
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
      }));
      return true;
    } catch (e) {
      console.error('S3 delete error, trying presigned DELETE fallback:', e);
    }

    // 某些 S3 兼容实现/网络环境下 SDK 请求可能失败，再用预签名 URL 发一次
    // 原始 DELETE。删除是幂等的，重复请求不会造成额外影响。
    try {
      const url = await getSignedUrl(this.client, new DeleteObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
      }), { expiresIn: 300 });
      const response = await fetch(url, { method: 'DELETE' });
      if (response.ok) return true;
      console.error('S3 delete fallback failed:', response.status, (await response.text()).slice(0, 300));
    } catch (e) {
      console.error('S3 delete fallback error:', e);
    }
    return false;
  }

  async list(): Promise<StorageObject[]> {
    const out: StorageObject[] = [];
    let token: string | undefined;

    // 注意：AWS SDK 的 ListObjectsV2Command 反序列化依赖 DOMParser，
    // Cloudflare Workers 运行时没有 DOMParser，会报 “DOMParser is not defined”。
    // 这里用预签名 URL + fetch 拿原始 XML，再用简单的标签解析，避免依赖 DOM。
    const xmlTag = (xml: string, tag: string): string => {
      const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      if (!m) return '';
      return m[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&amp;/g, '&');
    };

    // S3 ListObjectsV2 每次最多 1000 个对象，循环取完
    for (let page = 0; page < 100; page++) {
      const command = new ListObjectsV2Command({
        Bucket: this.cfg.bucket,
        Prefix: FILE_PREFIX,
        ContinuationToken: token,
        MaxKeys: 1000,
      });
      const url = await getSignedUrl(this.client, command, { expiresIn: 300 });
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`ListObjectsV2 HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      const blocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
      for (const block of blocks) {
        const key = xmlTag(block, 'Key');
        if (!key) continue;
        const size = parseInt(xmlTag(block, 'Size') || '0', 10) || 0;
        const uploaded = xmlTag(block, 'LastModified') || undefined;
        out.push({ key, size, uploaded });
      }

      if (xmlTag(text, 'IsTruncated').toLowerCase() !== 'true') break;
      token = xmlTag(text, 'NextContinuationToken') || undefined;
      if (!token) break;
    }
    return out;
  }
}
