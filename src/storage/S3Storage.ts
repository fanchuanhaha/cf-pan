// 彩虹外链网盘 - S3 兼容存储实现 (支持 OSS/COS/MinIO 等)

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { IStorage, MultipartPart, StorageObject } from './IStorage';
import { getFileExt, getMimeType } from '../utils/mime';

const FILE_PREFIX = 'file/';

/** 从 S3 XML 响应中取一个简单标签值（Workers 没有 DOMParser，不能交给 SDK 反序列化） */
function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return '';
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
      // 不要为了校验响应 checksum 而把整个响应体重新包装/读取一遍，
      // 否则大文件下载会占用大量内存并触发 Worker 128MB 限制。
      responseChecksumValidation: 'WHEN_REQUIRED',
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
    // 不用 AWS SDK 的 GetObject 返回值直接当 Response body。
    // SDK 在 Worker 里可能返回 Node 流，或者为了校验 checksum 再包一层
    // TransformStream；大文件下载时会额外占用内存/CPU，触发 128MB 内存
    // 或 CPU 限制，表现为下载到一半 503（error code: 1102）。
    // 这里先生成短期预签名 GET URL，再用 fetch 拿原始响应流，Worker 只做
    // 透明转发，不解析、不校验、不缓存文件内容。
    try {
      const url = await getSignedUrl(this.client, new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
      }), { expiresIn: 300 });

      const reqHeaders: Record<string, string> = {};
      if (range) reqHeaders['Range'] = `bytes=${range[0]}-${range[1]}`;

      const upstream = await fetch(url, { headers: reqHeaders });
      if (!upstream.ok || !upstream.body) {
        console.error('S3 downfile HTTP error:', upstream.status, (await upstream.text()).slice(0, 300));
        return null;
      }

      // Range 请求必须拿到 206；如果存储商忽略 Range 返回 200，
      // 不要把整个文件伪装成 206，交给上层返回 404/回退处理。
      if (range && upstream.status !== 206) {
        try { await upstream.body.cancel(); } catch { /* ignore */ }
        console.error('S3 downfile ignored Range, status:', upstream.status);
        return null;
      }

      const headers: Record<string, string> = {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000',
      };
      const contentRange = upstream.headers.get('content-range');
      const contentLength = upstream.headers.get('content-length');
      const etag = upstream.headers.get('etag');
      if (contentRange) headers['Content-Range'] = contentRange;
      if (contentLength) headers['Content-Length'] = contentLength;
      if (etag) headers['ETag'] = etag;

      return new Response(upstream.body, {
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

  // ===== 分片上传 =====
  // CreateMultipartUpload / CompleteMultipartUpload 的响应是 XML，AWS SDK
  // 在 Workers 里会调用 DOMParser 反序列化并报错。这里统一用预签名 URL +
  // fetch 发原始请求，再自己用正则取 UploadId，避免依赖 DOM。
  async createMultipartUpload(name: string, contentType?: string): Promise<string | null> {
    try {
      const url = await getSignedUrl(this.client, new CreateMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        ContentType: contentType || 'application/octet-stream',
      }), { expiresIn: 3600 });

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
      });
      const text = await response.text();
      if (!response.ok) {
        console.error('S3 CreateMultipartUpload HTTP error:', response.status, text.slice(0, 300));
        return null;
      }
      const uploadId = xmlTag(text, 'UploadId');
      if (!uploadId) {
        console.error('S3 CreateMultipartUpload missing UploadId:', text.slice(0, 300));
        return null;
      }
      return uploadId;
    } catch (e) {
      console.error('S3 createMultipartUpload error:', e);
      return null;
    }
  }

  async uploadPart(name: string, uploadId: string, partNumber: number, body: ArrayBuffer): Promise<string | null> {
    try {
      const bytes = new Uint8Array(body);
      const url = await getSignedUrl(this.client, new UploadPartCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: bytes,
        ContentLength: bytes.byteLength,
      }), { expiresIn: 3600 });

      const response = await fetch(url, { method: 'PUT', body: bytes });
      const etag = response.headers.get('etag');
      if (!response.ok || !etag) {
        const text = await response.text();
        console.error('S3 UploadPart HTTP error:', response.status, text.slice(0, 300));
        return null;
      }
      return etag;
    } catch (e) {
      console.error('S3 uploadPart error:', e);
      return null;
    }
  }

  async completeMultipartUpload(name: string, uploadId: string, parts: MultipartPart[]): Promise<boolean> {
    try {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      // 必须与 SDK 预签名时序列化出的 XML 完全一致（Content-Length 会被签名）。
      // SDK 的格式是：XML 声明 + S3 命名空间，Part 内先 ETag 后 PartNumber，
      // 且 ETag 里的引号会转义成 &quot;。不要加空格或换行。
      const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        sorted.map(p =>
          `<Part><ETag>${xmlEscape(p.etag)}</ETag><PartNumber>${p.partNumber}</PartNumber></Part>`
        ).join('') +
        '</CompleteMultipartUpload>';

      const url = await getSignedUrl(this.client, new CompleteMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }), { expiresIn: 3600 });

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xml,
      });
      const text = await response.text();
      if (!response.ok || /<Error>[\s\S]*?<\/Error>/i.test(text)) {
        console.error('S3 CompleteMultipartUpload HTTP error:', response.status, text.slice(0, 500));
        return false;
      }
      return true;
    } catch (e) {
      console.error('S3 completeMultipartUpload error:', e);
      return false;
    }
  }

  async abortMultipartUpload(name: string, uploadId: string): Promise<boolean> {
    try {
      const url = await getSignedUrl(this.client, new AbortMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(name),
        UploadId: uploadId,
      }), { expiresIn: 300 });
      const response = await fetch(url, { method: 'DELETE' });
      // 404 表示分片任务本来就不存在，按成功处理
      return response.ok || response.status === 404;
    } catch (e) {
      console.error('S3 abortMultipartUpload error:', e);
      return false;
    }
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
