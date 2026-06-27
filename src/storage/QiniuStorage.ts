// 彩虹外链网盘 - 七牛云对象存储实现
// 七牛云 SDK 签名算法：https://developer.qiniu.com/kodo/manual/1201/access-token
// 区域：z0(华东) z1(华北) z2(华南) na0(北美) as0(东南亚)

import type { IStorage } from './IStorage';

interface QiniuConfig {
  accessKey: string;     // AK
  secretKey: string;     // SK
  bucket: string;        // 存储空间名
  region?: string;       // 区域代码 默认 z0
  domain?: string;       // 加速域名（用于直链）
  folder?: string;       // 默认文件夹（默认 file）
}

const REGION_HOSTS: Record<string, string> = {
  'z0': 'up.qiniup.com',         // 华东
  'z1': 'up-z1.qiniup.com',      // 华北
  'z2': 'up-z2.qiniup.com',      // 华南
  'na0': 'up-na0.qiniup.com',    // 北美
  'as0': 'up-as0.qiniup.com',    // 东南亚
  'cn-east-2': 'up-cn-east-2.qiniup.com',
};

const REGION_DOMAINS: Record<string, string> = {
  'z0': 'iovip.qbox.me',
  'z1': 'iovip-z1.qbox.me',
  'z2': 'iovip-z2.qbox.me',
  'na0': 'iovip-na0.qbox.me',
  'as0': 'iovip-as0.qbox.me',
};

export class QiniuStorage implements IStorage {
  private cfg: QiniuConfig;
  private uploadHost: string;

  constructor(config: QiniuConfig) {
    this.cfg = config;
    const region = config.region || 'z0';
    this.uploadHost = REGION_HOSTS[region] || REGION_HOSTS['z0'];
  }

  /** 把 hash 映射到存储路径 */
  private hashToKey(hash: string): string {
    const folder = (this.cfg.folder || 'file').replace(/\/+$/, '');
    return `${folder}/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash}`;
  }

  /** URL 安全的 Base64 编码 */
  private base64UrlEncode(str: string): string {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** HMAC-SHA1 签名 */
  private async hmacSha1(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    const bytes = new Uint8Array(sig);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** 生成管理凭证（用于删除、查询） */
  private async makeManageToken(targetUrl: string, method: string = 'POST', body: string = ''): Promise<string> {
    const path = targetUrl.replace(/^https?:\/\/[^/]+/, '');
    const data = method + ' ' + path + '\nHost: ' + (REGION_DOMAINS[this.cfg.region || 'z0']) + '\n\n' + body;
    const encoded = this.base64UrlEncode(data);
    const sign = await this.hmacSha1(this.cfg.secretKey, encoded);
    const encodedSign = sign.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return this.cfg.accessKey + ':' + encodedSign;
  }

  /** 生成上传凭证 */
  private async makeUploadToken(): Promise<string> {
    const putPolicy = {
      scope: this.cfg.bucket,
      deadline: Math.floor(Date.now() / 1000) + 3600, // 1小时有效
    };
    const encoded = this.base64UrlEncode(JSON.stringify(putPolicy));
    const sign = await this.hmacSha1(this.cfg.secretKey, encoded);
    const encodedSign = sign.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return this.cfg.accessKey + ':' + encodedSign + ':' + encoded;
  }

  /** 简单 GET 公共资源（无需签名） */
  async downfile(name: string, range?: [number, number]): Promise<Response | null> {
    const key = this.hashToKey(name);
    let urlBase: string;
    if (this.cfg.domain) {
      urlBase = this.cfg.domain.replace(/\/$/, '');
    } else {
      const region = this.cfg.region || 'z0';
      urlBase = `http://${REGION_DOMAINS[region] || REGION_DOMAINS['z0']}`;
    }
    const url = `${urlBase}/${key}`;
    const headers: Record<string, string> = {};
    if (range) {
      headers['Range'] = `bytes=${range[0]}-${range[1]}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return res;
  }

  async exists(name: string): Promise<boolean> {
    const key = this.hashToKey(name);
    // 使用资源管理 API 查询
    const entryUrl = `http://${REGION_DOMAINS[this.cfg.region || 'z0']}/rs-batch/`;
    const body = JSON.stringify({ op: 'stat', entries: [encodeURIComponent(key)] });
    const token = await this.makeManageToken(entryUrl, 'POST', body);
    const res = await fetch(entryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'QBox ' + token,
      },
      body,
    });
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

  async upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean> {
    const key = this.hashToKey(name);
    let buf: ArrayBuffer;
    if (body instanceof ArrayBuffer) {
      buf = body;
    } else {
      buf = await new Response(body as ReadableStream).arrayBuffer();
    }
    
    const token = await this.makeUploadToken();
    const formData = new FormData();
    formData.append('token', token);
    formData.append('key', key);
    formData.append('file', new Blob([buf], { type: contentType || 'application/octet-stream' }));
    
    const res = await fetch(`https://${this.uploadHost}/`, {
      method: 'POST',
      body: formData,
    });
    return res.ok;
  }

  async savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean> {
    return this.upload(name, new Uint8Array(0) as unknown as ArrayBuffer, contentType);
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    const key = this.hashToKey(name);
    const region = this.cfg.region || 'z0';
    const host = REGION_DOMAINS[region] || REGION_DOMAINS['z0'];
    const url = `http://${host}/rs-batch/`;
    const body = JSON.stringify({ op: 'stat', entries: [encodeURIComponent(key)] });
    const token = await this.makeManageToken(url, 'POST', body);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'QBox ' + token,
      },
      body,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const entry = data.entries?.[0];
    if (entry?.code !== 200) return null;
    return {
      length: entry.data?.fsize || 0,
      content_type: 'application/octet-stream',
    };
  }

  async delete(name: string): Promise<boolean> {
    const key = this.hashToKey(name);
    const region = this.cfg.region || 'z0';
    const host = REGION_DOMAINS[region] || REGION_DOMAINS['z0'];
    const path = `/delete/${this.cfg.bucket}/${encodeURIComponent(key)}`;
    const url = `http://${host}${path}`;
    const token = await this.makeManageToken(url, 'POST', '');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'QBox ' + token,
      },
    });
    return res.ok;
  }

  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    const key = this.hashToKey(name);
    if (this.cfg.domain) {
      return `${this.cfg.domain.replace(/\/$/, '')}/${key}`;
    }
    const region = this.cfg.region || 'z0';
    const host = REGION_DOMAINS[region] || REGION_DOMAINS['z0'];
    return `http://${host}/${key}`;
  }

  /** 验证配置 */
  static async testConnection(config: QiniuConfig): Promise<{ ok: boolean; message: string }> {
    try {
      if (!config.accessKey || !config.secretKey || !config.bucket) {
        return { ok: false, message: '缺少 AK/SK/Bucket' };
      }
      // 测试获取 bucket 信息
      const region = config.region || 'z0';
      const host = REGION_DOMAINS[region] || REGION_DOMAINS['z0'];
      const path = `/rs-batch/`;
      const body = JSON.stringify({ op: 'list', bucket: config.bucket, max: 1 });
      const putPolicy = { scope: config.bucket, deadline: Math.floor(Date.now() / 1000) + 60 };
      // 简单测试：尝试用上传凭证上传一个测试文件
      const driver = new QiniuStorage(config);
      const token = await driver.makeUploadToken();
      const formData = new FormData();
      formData.append('token', token);
      formData.append('key', '__test_' + Date.now());
      formData.append('file', new Blob(['ok'], { type: 'text/plain' }));
      const res = await fetch(`https://${driver.uploadHost}/`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        // 清理测试文件
        const delToken = await driver.makeManageToken(`http://${host}/delete/${config.bucket}/__test_${Date.now() - 1000}`);
        return { ok: true, message: '七牛云存储配置有效' };
      }
      const text = await res.text();
      return { ok: false, message: `上传测试失败 (${res.status}): ${text.substring(0, 200)}` };
    } catch (e: any) {
      return { ok: false, message: e.message || '未知错误' };
    }
  }
}
