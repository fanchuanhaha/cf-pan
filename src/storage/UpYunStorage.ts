// 彩虹外链网盘 - 又拍云存储实现
// 又拍云 REST API：https://docs.upyun.com/api/rest_api/
// 鉴权：HTTP Basic Auth（操作员 + 密码），使用 MD5 签名

import type { IStorage } from './IStorage';

interface UpYunConfig {
  bucket: string;        // 服务名（存储桶）
  operator: string;      // 操作员
  password: string;      // 密码
  endpoint?: string;     // API 端点（默认 v0.api.upyun.com）
  domain?: string;       // 加速域名（用于直链下载）
  folder?: string;       // 默认文件夹（默认 file）
}

/** MD5 哈希（用于又拍云签名） */
async function md5(str: string): Promise<string> {
  const buf = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest('MD5', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export class UpYunStorage implements IStorage {
  private cfg: UpYunConfig;
  private apiHost: string;

  constructor(config: UpYunConfig) {
    this.cfg = config;
    this.apiHost = config.endpoint || 'https://v0.api.upyun.com';
  }

  /** 把 hash 映射到存储路径 */
  private hashToPath(hash: string): string {
    const folder = (this.cfg.folder || 'file').replace(/\/$/, '');
    return `/${folder}/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash}`;
  }

  /** 生成 Authorization 头 */
  private async makeAuth(method: string, uri: string, date: string): Promise<string> {
    const signStr = `${method}&${uri}&${date}`;
    const passwordMd5 = await md5(this.cfg.password);
    const signature = await md5(signStr + '&' + passwordMd5);
    return `UPYUN ${this.cfg.operator}:${signature}`;
  }

  /** 通用请求 */
  private async request(
    method: string,
    uri: string,
    options: { body?: BodyInit | null; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const date = new Date().toUTCString();
    const auth = await this.makeAuth(method, uri, date);
    const headers: Record<string, string> = {
      'Authorization': auth,
      'Date': date,
      ...(options.headers || {}),
    };
    return fetch(`${this.apiHost}${uri}`, {
      method,
      headers,
      body: options.body,
    });
  }

  async exists(name: string): Promise<boolean> {
    const path = this.hashToPath(name);
    const res = await this.request('HEAD', path);
    return res.ok;
  }

  async get(name: string): Promise<R2ObjectBody | null> {
    const res = await this.downfile(name);
    if (!res) return null;
    return {
      body: res.body as ReadableStream,
      size: parseInt(res.headers.get('Content-Length') || '0'),
      httpMetadata: { contentType: res.headers.get('Content-Type') || 'application/octet-stream' },
      writeHttpMetadata() {},
      get httpEtag() { return res.headers.get('ETag') || ''; },
      set httpEtag(_: string) {},
      get customMetadata() { return {}; },
      set customMetadata(_: Record<string, string>) {},
      get range() { return undefined; },
      set range(_: R2Range | undefined) {},
    } as unknown as R2ObjectBody;
  }

  async downfile(name: string, range?: [number, number]): Promise<Response | null> {
    const path = this.hashToPath(name);
    const headers: Record<string, string> = {};
    if (range) {
      headers['Range'] = `bytes=${range[0]}-${range[1]}`;
    }
    const res = await this.request('GET', path, { headers });
    if (!res.ok) return null;
    return res;
  }

  async upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean> {
    const path = this.hashToPath(name);
    let buf: ArrayBuffer;
    if (body instanceof ArrayBuffer) {
      buf = body;
    } else {
      buf = await new Response(body as ReadableStream).arrayBuffer();
    }
    const headers: Record<string, string> = {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': String(buf.byteLength),
    };
    const res = await this.request('PUT', path, { body: buf, headers });
    return res.ok;
  }

  async savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean> {
    // 又拍云使用直传，无需本地临时文件
    return this.upload(name, new Uint8Array(0) as unknown as ArrayBuffer, contentType);
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    const path = this.hashToPath(name);
    const res = await this.request('HEAD', path);
    if (!res.ok) return null;
    return {
      length: parseInt(res.headers.get('Content-Length') || '0'),
      content_type: res.headers.get('Content-Type') || 'application/octet-stream',
    };
  }

  async delete(name: string): Promise<boolean> {
    const path = this.hashToPath(name);
    const res = await this.request('DELETE', path);
    return res.ok || res.status === 404;
  }

  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    if (!this.cfg.domain) {
      // 没有配置加速域名时使用又拍云默认域名
      const path = this.hashToPath(name).replace(/^\//, '');
      return `${this.apiHost}/${this.cfg.bucket}/${path}`;
    }
    const path = this.hashToPath(name).replace(/^\//, '');
    return `${this.cfg.domain.replace(/\/$/, '')}/${path}`;
  }

  /** 验证配置 */
  static async testConnection(config: UpYunConfig): Promise<{ ok: boolean; message: string }> {
    try {
      const driver = new UpYunStorage(config);
      // 测试访问根目录
      const path = '/';
      const date = new Date().toUTCString();
      const signStr = `HEAD&${path}&${date}`;
      const passwordMd5 = await md5(config.password);
      const signature = await md5(signStr + '&' + passwordMd5);
      const res = await fetch(`${driver.apiHost}${path}`, {
        method: 'HEAD',
        headers: {
          'Authorization': `UPYUN ${config.operator}:${signature}`,
          'Date': date,
        },
      });
      if (res.ok || res.status === 404) {
        return { ok: true, message: '又拍云存储配置有效' };
      }
      return { ok: false, message: `HTTP ${res.status}: ${await res.text()}` };
    } catch (e: any) {
      return { ok: false, message: e.message || '未知错误' };
    }
  }
}
