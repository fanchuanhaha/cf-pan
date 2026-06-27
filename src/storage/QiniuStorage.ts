// 彩虹外链网盘 - 七牛云对象存储实现
// 参考原 PHP 项目 includes/lib/Storage/Qiniu.php 和 includes/Qiniu/Storage/BucketManager.php
// 关键点：
//  1) 通过 https://api.qiniu.com/v2/query?ak=&bucket= 自动获取 region（与 PHP Region::queryRegion 一致）
//  2) 管理 API（stat/delete）使用 V2 签名（Qiniu + HMAC-SHA1）
//  3) 路径用 entry = base64UrlSafeEncode(bucket:key)
//  4) 上传使用 UploadToken + FormData multipart

import type { IStorage } from './IStorage';

interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  domain?: string;
  folder?: string;
}

interface QiniuRegion {
  srcUpHosts: string[];
  cdnUpHosts: string[];
  rsHost: string;
  rsfHost: string;
  apiHost: string;
  iovipHost: string;
}

const DEFAULT_FOLDER = 'file';
const UC_QUERY_URL = 'https://api.qiniu.com/v2/query';
const MANAGEMENT_CONTENT_TYPE = 'application/x-www-form-urlencoded';

export class QiniuStorage implements IStorage {
  private cfg: QiniuConfig;
  private region: QiniuRegion | null = null;

  constructor(config: QiniuConfig) {
    this.cfg = config;
  }

  /** 把 hash 映射到存储 key */
  private hashToKey(hash: string): string {
    const folder = (this.cfg.folder || DEFAULT_FOLDER).replace(/\/+$/, '');
    return `${folder}/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash}`;
  }

  /** URL 安全的 Base64（Base64URL） */
  private base64UrlEncode(input: string | Uint8Array): string {
    let raw: string;
    if (typeof input === 'string') {
      raw = btoa(unescape(encodeURIComponent(input)));
    } else {
      let bin = '';
      for (let i = 0; i < input.length; i++) bin += String.fromCharCode(input[i]);
      raw = btoa(bin);
    }
    return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** base64url(entry(bucket,key))  —— 与 PHP Qiniu\entry() 一致 */
  private entry(bucket: string, key: string): string {
    return this.base64UrlEncode(`${bucket}:${key}`);
  }

  /** HMAC-SHA1，返回原始字节的 base64 字符串 */
  private async hmacSha1Raw(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  /** 把 base64 字符串转为 base64url */
  private toBase64Url(b64: string): string {
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** 自动查询 region（与 PHP Region::queryRegion 行为一致） */
  private async queryRegion(): Promise<QiniuRegion> {
    const url = `${UC_QUERY_URL}?ak=${encodeURIComponent(this.cfg.accessKey)}&bucket=${encodeURIComponent(this.cfg.bucket)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`查询七牛云 region 失败 (${res.status}): ${text.substring(0, 200)}`);
    }
    const r: any = await res.json();
    if (!r || !r.io || !r.up) {
      throw new Error('七牛云返回的 region 数据格式不正确: ' + JSON.stringify(r).substring(0, 200));
    }

    const iovipHost: string = r.io.src.main[0];
    const cdnUpHosts: string[] = [r.up.acc.main[0]];
    if (Array.isArray(r.up.acc.backup)) cdnUpHosts.push(...r.up.acc.backup);
    const srcUpHosts: string[] = [r.up.src.main[0]];
    if (Array.isArray(r.up.src.backup)) srcUpHosts.push(...r.up.src.backup);

    // 根据 iovipHost 判断其他 host（与 PHP Region.php 规则一致）
    let rsHost = 'rs.qbox.me';
    let rsfHost = 'rsf.qbox.me';
    let apiHost = 'api.qiniu.com';
    if (iovipHost.includes('z1')) {
      rsHost = 'rs-z1.qbox.me'; rsfHost = 'rsf-z1.qbox.me'; apiHost = 'api-z1.qiniu.com';
    } else if (iovipHost.includes('z2')) {
      rsHost = 'rs-z2.qbox.me'; rsfHost = 'rsf-z2.qbox.me'; apiHost = 'api-z2.qiniu.com';
    } else if (iovipHost.includes('cn-east-2')) {
      rsHost = 'rs-cn-east-2.qiniuapi.com'; rsfHost = 'rsf-cn-east-2.qiniuapi.com'; apiHost = 'api-cn-east-2.qiniuapi.com';
    } else if (iovipHost.includes('na0')) {
      rsHost = 'rs-na0.qbox.me'; rsfHost = 'rsf-na0.qbox.me'; apiHost = 'api-na0.qiniu.com';
    } else if (iovipHost.includes('as0')) {
      rsHost = 'rs-as0.qbox.me'; rsfHost = 'rsf-as0.qbox.me'; apiHost = 'api-as0.qiniu.com';
    }

    return { srcUpHosts, cdnUpHosts, rsHost, rsfHost, apiHost, iovipHost };
  }

  private async ensureRegion(): Promise<QiniuRegion> {
    if (!this.region) this.region = await this.queryRegion();
    return this.region;
  }

  /** 上传令牌（UploadToken），与 PHP Auth::uploadToken 行为一致 */
  private async makeUploadToken(): Promise<string> {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const scope = this.cfg.bucket;
    const putPolicy = { scope, deadline };
    const encoded = this.base64UrlEncode(JSON.stringify(putPolicy));
    const sig = await this.hmacSha1Raw(this.cfg.secretKey, encoded);
    return this.cfg.accessKey + ':' + this.toBase64Url(sig) + ':' + encoded;
  }

  /**
   * 管理 API V2 签名（与 PHP Auth::signQiniuAuthorization + authorizationV2 完全一致）
   * 签名字符串：<Method> <Path>\nHost: <Host>\nContent-Type: <CT>\nX-Qiniu-Date: <Date>\n\n<Body>
   * 输出 Header: { 'Authorization': 'Qiniu <token>', 'Content-Type', 'X-Qiniu-Date' }
   */
  private async makeV2AuthHeaders(
    method: 'GET' | 'POST',
    host: string,
    path: string,
    body: string
  ): Promise<Record<string, string>> {
    const signDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace(/(\d{2})(\d{2})$/, '$1:$2');
    // 上面的 replace 顺序：把 ISO "2025-01-01T00:00:00.000Z" 转成 "20250101T000000Z"

    const dataToSign =
      `${method} ${path}\n` +
      `Host: ${host}\n` +
      `Content-Type: ${MANAGEMENT_CONTENT_TYPE}\n` +
      `X-Qiniu-Date: ${signDate}\n` +
      `\n` +
      body;
    const sig = await this.hmacSha1Raw(this.cfg.secretKey, dataToSign);
    const signToken = this.cfg.accessKey + ':' + this.toBase64Url(sig);

    return {
      'Authorization': 'Qiniu ' + signToken,
      'Content-Type': MANAGEMENT_CONTENT_TYPE,
      'X-Qiniu-Date': signDate,
    };
  }

  /** 调用管理 API（rs） */
  private async callRsApi(method: 'GET' | 'POST', path: string): Promise<any> {
    const region = await this.ensureRegion();
    const url = `https://${region.rsHost}${path}`;
    const headers = await this.makeV2AuthHeaders(method, region.rsHost, path, '');
    const res = await fetch(url, { method, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`七牛云管理 API 失败 (${res.status}): ${text.substring(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async exists(name: string): Promise<boolean> {
    const key = this.hashToKey(name);
    const en = this.entry(this.cfg.bucket, key);
    try {
      const data = await this.callRsApi('GET', `/stat/${en}`);
      // PHP rsGet 返回 {code: 200, data: {...}}，无 error
      return data && (data.code === 200 || data.fsize !== undefined);
    } catch {
      return false;
    }
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
    const key = this.hashToKey(name);
    const region = await this.ensureRegion();
    // 优先用用户填的 domain；否则用 iovipHost
    const urlBase = (this.cfg.domain && this.cfg.domain.trim())
      ? this.cfg.domain.replace(/\/+$/, '').replace(/^https?:\/\//, '')
      : region.iovipHost;
    const url = `https://${urlBase}/${key}`;
    const headers: Record<string, string> = {};
    if (range) {
      headers['Range'] = `bytes=${range[0]}-${range[1]}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return res;
  }

  async upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean> {
    const key = this.hashToKey(name);
    let buf: ArrayBuffer;
    if (body instanceof ArrayBuffer) {
      buf = body;
    } else {
      buf = await new Response(body as ReadableStream).arrayBuffer();
    }

    const region = await this.ensureRegion();
    const token = await this.makeUploadToken();
    const formData = new FormData();
    formData.append('file', new Blob([buf], { type: contentType || 'application/octet-stream' }), name);
    formData.append('key', key);
    formData.append('token', token);

    // 优先用 cdnUpHosts，失败再回退到 srcUpHosts（与 PHP getUpHost 行为一致）
    const hosts = [...region.cdnUpHosts, ...region.srcUpHosts];
    let lastErr = '';
    for (const host of hosts) {
      const res = await fetch(`https://${host}/`, { method: 'POST', body: formData });
      if (res.ok) return true;
      lastErr = `host=${host} status=${res.status} body=${(await res.text()).substring(0, 200)}`;
    }
    throw new Error(`七牛云上传失败：${lastErr || '无可用上传 host'}`);
  }

  async savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean> {
    return this.upload(name, new Uint8Array(0) as unknown as ArrayBuffer, contentType);
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    const key = this.hashToKey(name);
    const en = this.entry(this.cfg.bucket, key);
    try {
      const data = await this.callRsApi('GET', `/stat/${en}`);
      if (data && (data.code === 200 || data.fsize !== undefined)) {
        return {
          length: data.fsize || 0,
          content_type: data.mimeType || 'application/octet-stream',
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<boolean> {
    const key = this.hashToKey(name);
    const en = this.entry(this.cfg.bucket, key);
    try {
      const data = await this.callRsApi('POST', `/delete/${en}`);
      // 成功: {code: 200} 或直接 true
      if (data === true) return true;
      if (data && typeof data === 'object' && (data.code === 200 || !data.error)) return true;
      // 没有 error 字段也认为成功
      return !!(data && (data.code === undefined || data.code === 200));
    } catch {
      return false;
    }
  }

  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    const key = this.hashToKey(name);
    if (this.cfg.domain && this.cfg.domain.trim()) {
      return this.cfg.domain.replace(/\/+$/, '') + '/' + key;
    }
    try {
      const region = await this.ensureRegion();
      return `https://${region.iovipHost}/${key}`;
    } catch {
      return null;
    }
  }

  /** 测试连接：与 PHP 一致——只测上传+删除，不测读（避免私有读 Bucket 误判） */
  static async testConnection(config: QiniuConfig): Promise<{ ok: boolean; message: string }> {
    try {
      if (!config.accessKey || !config.secretKey || !config.bucket) {
        return { ok: false, message: '请填写 AK、SK、Bucket' };
      }
      const driver = new QiniuStorage(config);
      const region = await driver.queryRegion();
      const testHash = 'test' + Date.now();
      const testContent = '彩虹外链网盘存储测试';
      const encoder = new TextEncoder();
      const testData = encoder.encode(testContent);
      const uploaded = await driver.upload(testHash, testData.buffer as ArrayBuffer, 'text/plain');
      if (!uploaded) {
        return { ok: false, message: '上传失败：AK 可能没有该 Bucket 的写权限' };
      }
      await driver.delete(testHash);
      return { ok: true, message: `连接成功！区域: ${region.iovipHost}` };
    } catch (e: any) {
      let msg = (e && e.message) || '未知错误';
      if (msg.includes('no such bucket') || msg.includes('612')) {
        msg = 'Bucket 不存在或与 AK 不在同一账号下';
      } else if (msg.includes('401') || msg.toLowerCase().includes('bad token') || msg.toLowerCase().includes('incorrect')) {
        msg = 'AK 或 SK 无效';
      } else if (msg.includes('403') || msg.toLowerCase().includes('no perm')) {
        msg = '权限不足：AK 需要对该 Bucket 有读写权限';
      } else if (msg.includes('region')) {
        msg = '查询 region 失败：' + msg;
      }
      return { ok: false, message: '七牛云测试失败: ' + msg };
    }
  }
}
