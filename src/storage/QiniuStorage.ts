// 彩虹外链网盘 - 七牛云对象存储实现
// 参考原 PHP 项目的七牛 SDK：上传走 UploadToken，管理 API 走 /v2/query 自动发现 region
// 查询接口：https://api.qiniu.com/v2/query?ak=<ak>&bucket=<bucket>

import type { IStorage } from './IStorage';

interface QiniuConfig {
  accessKey: string;     // AK
  secretKey: string;     // SK
  bucket: string;        // 存储空间名
  domain?: string;       // 加速域名（用于直链下载）
  folder?: string;       // 默认文件夹（默认 file）
}

interface QiniuRegion {
  srcUpHosts: string[];   // 源站上传域名
  cdnUpHosts: string[];   // CDN 加速上传域名
  rsHost: string;         // 资源管理域名
  rsfHost: string;        // 资源列举域名
  apiHost: string;        // 资源处理域名
  iovipHost: string;      // 资源下载域名
}

const DEFAULT_FOLDER = 'file';
const UC_QUERY_URL = 'https://api.qiniu.com/v2/query';

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

  /** URL 安全的 Base64 编码（去掉 =, +, / 替换为 -_） */
  private base64UrlEncode(str: string): string {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
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
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  /** 调用 uc 接口自动查询 region（与原 PHP SDK 一致） */
  private async queryRegion(): Promise<QiniuRegion> {
    const url = `${UC_QUERY_URL}?ak=${encodeURIComponent(this.cfg.accessKey)}&bucket=${encodeURIComponent(this.cfg.bucket)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'pan-worker-qiniu' } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`查询七牛云 region 失败 (${res.status}): ${text.substring(0, 200)}`);
    }
    const r: any = await res.json();
    if (!r.io || !r.up) {
      throw new Error('七牛云返回的 region 数据格式不正确');
    }

    const iovipHost: string = r.io.src.main[0];
    const srcUpHosts: string[] = [r.up.src.main[0]];
    if (Array.isArray(r.up.src.backup)) srcUpHosts.push(...r.up.src.backup);
    const cdnUpHosts: string[] = [r.up.acc.main[0]];
    if (Array.isArray(r.up.acc.backup)) cdnUpHosts.push(...r.up.acc.backup);

    // 根据 iovipHost 判断其他 host（与 PHP Region.php 规则一致）
    let rsHost = 'rs.qbox.me';
    let rsfHost = 'rsf.qbox.me';
    let apiHost = 'api.qiniu.com';
    if (iovipHost.includes('z1')) {
      rsHost = 'rs-z1.qbox.me';
      rsfHost = 'rsf-z1.qbox.me';
      apiHost = 'api-z1.qiniu.com';
    } else if (iovipHost.includes('z2')) {
      rsHost = 'rs-z2.qbox.me';
      rsfHost = 'rsf-z2.qbox.me';
      apiHost = 'api-z2.qiniu.com';
    } else if (iovipHost.includes('cn-east-2')) {
      rsHost = 'rs-cn-east-2.qiniuapi.com';
      rsfHost = 'rsf-cn-east-2.qiniuapi.com';
      apiHost = 'api-cn-east-2.qiniuapi.com';
    } else if (iovipHost.includes('na0')) {
      rsHost = 'rs-na0.qbox.me';
      rsfHost = 'rsf-na0.qbox.me';
      apiHost = 'api-na0.qiniu.com';
    } else if (iovipHost.includes('as0')) {
      rsHost = 'rs-as0.qbox.me';
      rsfHost = 'rsf-as0.qbox.me';
      apiHost = 'api-as0.qiniu.com';
    }

    return { srcUpHosts, cdnUpHosts, rsHost, rsfHost, apiHost, iovipHost };
  }

  /** 确保 region 已加载 */
  private async ensureRegion(): Promise<QiniuRegion> {
    if (!this.region) this.region = await this.queryRegion();
    return this.region;
  }

  /** 生成上传凭证（UploadToken） */
  private async makeUploadToken(): Promise<string> {
    const putPolicy = {
      scope: this.cfg.bucket,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    };
    const encoded = this.base64UrlEncode(JSON.stringify(putPolicy));
    const sign = await this.hmacSha1(this.cfg.secretKey, encoded);
    const encodedSign = sign.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return this.cfg.accessKey + ':' + encodedSign + ':' + encoded;
  }

  /** 生成管理 API 凭证（QBox token） */
  private async makeManageToken(urlPathWithQuery: string, body: string = ''): Promise<string> {
    const urlObj = new URL(urlPathWithQuery, 'http://x');
    const path = urlObj.pathname + urlObj.search;
    // 管理 API 签名规则：<Method> <Path>\nHost: <Host>\n\n<Body>
    const region = await this.ensureRegion();
    const data = `POST ${path}\nHost: ${region.rsHost}\n\n${body}`;
    const encoded = this.base64UrlEncode(data);
    const sign = await this.hmacSha1(this.cfg.secretKey, encoded);
    const encodedSign = sign.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return this.cfg.accessKey + ':' + encodedSign;
  }

  async exists(name: string): Promise<boolean> {
    const key = this.hashToKey(name);
    const region = await this.ensureRegion();
    const path = `/stat/${encodeURIComponent(this.cfg.bucket)}/${encodeURIComponent(key)}`;
    const token = await this.makeManageToken(`http://${region.rsHost}${path}`);
    const res = await fetch(`http://${region.rsHost}${path}`, {
      method: 'POST',
      headers: { 'Authorization': 'QBox ' + token },
    });
    if (!res.ok) return false;
    const data: any = await res.json();
    return data.code === 200;
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
    const urlBase = this.cfg.domain
      ? this.cfg.domain.replace(/\/$/, '')
      : `http://${(await this.ensureRegion()).iovipHost}`;
    const url = `${urlBase}/${key}`;
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
    // 与 PHP FormUploader 一致：使用 multipart/form-data，字段顺序为 file, key, token
    const formData = new FormData();
    formData.append('file', new Blob([buf], { type: contentType || 'application/octet-stream' }), name);
    formData.append('key', key);
    formData.append('token', token);

    // 优先用 cdnUpHosts（加速上传），失败再回退到 srcUpHosts
    const hosts = [...region.cdnUpHosts, ...region.srcUpHosts];
    for (const host of hosts) {
      const res = await fetch(`https://${host}/`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) return true;
    }
    return false;
  }

  async savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean> {
    return this.upload(name, new Uint8Array(0) as unknown as ArrayBuffer, contentType);
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    const key = this.hashToKey(name);
    const region = await this.ensureRegion();
    const path = `/stat/${encodeURIComponent(this.cfg.bucket)}/${encodeURIComponent(key)}`;
    const token = await this.makeManageToken(`http://${region.rsHost}${path}`);
    const res = await fetch(`http://${region.rsHost}${path}`, {
      method: 'POST',
      headers: { 'Authorization': 'QBox ' + token },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data.code !== 200) return null;
    return {
      length: data.data?.fsize || 0,
      content_type: data.data?.mimeType || 'application/octet-stream',
    };
  }

  async delete(name: string): Promise<boolean> {
    const key = this.hashToKey(name);
    const region = await this.ensureRegion();
    const path = `/delete/${encodeURIComponent(this.cfg.bucket)}/${encodeURIComponent(key)}`;
    const token = await this.makeManageToken(`http://${region.rsHost}${path}`);
    const res = await fetch(`http://${region.rsHost}${path}`, {
      method: 'POST',
      headers: { 'Authorization': 'QBox ' + token },
    });
    return res.ok;
  }

  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    const key = this.hashToKey(name);
    if (this.cfg.domain) {
      return `${this.cfg.domain.replace(/\/$/, '')}/${key}`;
    }
    try {
      const region = await this.ensureRegion();
      return `http://${region.iovipHost}/${key}`;
    } catch {
      return null;
    }
  }

  /** 验证配置（与 PHP 一致：实际上传+读取+删除） */
  static async testConnection(config: QiniuConfig): Promise<{ ok: boolean; message: string }> {
    try {
      if (!config.accessKey || !config.secretKey || !config.bucket) {
        return { ok: false, message: '缺少 AK/SK/Bucket' };
      }
      const driver = new QiniuStorage(config);
      // 查询 region（同时验证 AK 和 Bucket）
      const region = await driver.queryRegion();
      // 上传测试
      const testHash = 'test' + Date.now();
      const testContent = '彩虹外链网盘存储测试';
      const testBytes = new TextEncoder().encode(testContent);
      const uploaded = await driver.upload(testHash, testBytes.buffer as ArrayBuffer, 'text/plain');
      if (!uploaded) {
        return { ok: false, message: '上传到七牛云失败：可能是 Bucket 私有写、AK/SK 无权限或域名问题' };
      }
      // 删除测试文件
      await driver.delete(testHash);
      return { ok: true, message: `七牛云连接成功！区域: ${region.iovipHost}` };
    } catch (e: any) {
      let msg = e.message || '未知错误';
      if (msg.includes('612') || msg.includes('no such bucket')) {
        msg = 'Bucket 不存在，请检查存储空间名称';
      } else if (msg.includes('401')) {
        msg = 'AK/SK 无效或已过期';
      } else if (msg.includes('403')) {
        msg = '权限不足：AK 需对该 Bucket 有读写权限';
      }
      return { ok: false, message: '七牛云测试失败: ' + msg };
    }
  }
}
