// 彩虹外链网盘 - WebDAV 存储驱动
// 通过标准 WebDAV 协议 (PROPFIND/PUT/DELETE) 操作远程 WebDAV 服务器
// 兼容坚果云 / 群晖 / Nextcloud / ownCloud / 通用 WebDAV 服务

import type { IStorage } from './IStorage';

const FILE_PREFIX = 'file/';

interface WebDavConfig {
  endpoint: string;       // WebDAV 服务地址，如 https://dav.example.com/remote.php/webdav/
  username: string;       // 用户名
  password: string;       // 密码
  defaultFolder?: string; // 存储子目录（可选）
  tlsInsecure?: boolean;  // 跳过证书验证
}

export class WebDavStorage implements IStorage {
  private cfg: WebDavConfig;
  private authHeader: string;

  constructor(config: WebDavConfig) {
    // 规范化 endpoint：必须以 / 结尾
    let endpoint = config.endpoint.trim();
    if (!endpoint) {
      throw new Error('WebDAV endpoint 不能为空');
    }
    if (!endpoint.endsWith('/')) {
      endpoint += '/';
    }
    this.cfg = { ...config, endpoint };
    this.authHeader = 'Basic ' + btoa(`${config.username}:${config.password}`);
  }

  /** 拼接文件完整路径 (WebDAV URL + file prefix + hash) */
  private fullPath(name: string): string {
    const folder = (this.cfg.defaultFolder || FILE_PREFIX).replace(/^\/+|\/+$/g, '');
    return `${folder}/${name}`;
  }

  /** 完整 URL */
  private fileUrl(name: string): string {
    return this.cfg.endpoint + this.fullPath(name);
  }

  /** 公共 fetch 包装 */
  private async davFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Authorization': this.authHeader,
      'User-Agent': 'pan-worker-webdav',
      ...(init.headers as Record<string, string> || {}),
    };
    return fetch(url, { ...init, headers });
  }

  async exists(name: string): Promise<boolean> {
    try {
      const res = await this.davFetch(this.fileUrl(name), { method: 'HEAD' });
      return res.ok;
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
    try {
      const headers: Record<string, string> = {};
      if (range) {
        headers['Range'] = `bytes=${range[0]}-${range[1]}`;
      }
      const res = await this.davFetch(this.fileUrl(name), { headers });
      if (!res.ok && res.status !== 206) return null;
      return res;
    } catch (e) {
      console.error('WebDAV downfile error:', e);
      return null;
    }
  }

  async upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean> {
    try {
      // 确保父目录存在 (WebDAV MKCOL)
      await this.ensureParentDirs(name);

      const headers: Record<string, string> = {
        'Content-Type': contentType || 'application/octet-stream',
      };
      const res = await this.davFetch(this.fileUrl(name), {
        method: 'PUT',
        headers,
        body: body as BodyInit,
      });
      if (!res.ok && res.status !== 201 && res.status !== 204) {
        console.error('WebDAV upload failed:', res.status, await res.text());
        return false;
      }
      return true;
    } catch (e) {
      console.error('WebDAV upload error:', e);
      return false;
    }
  }

  async savefile(name: string, _tmpfile: string, _contentType?: string): Promise<boolean> {
    return false; // WebDAV 使用 upload 替代
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    try {
      // WebDAV 用 PROPFIND 获取 size/content-type
      const res = await this.davFetch(this.fileUrl(name), {
        method: 'PROPFIND',
        headers: { 'Depth': '0' },
      });
      if (!res.ok) {
        // 退回到 HEAD
        const headRes = await this.davFetch(this.fileUrl(name), { method: 'HEAD' });
        if (!headRes.ok) return null;
        return {
          length: parseInt(headRes.headers.get('Content-Length') || '0'),
          content_type: headRes.headers.get('Content-Type') || 'application/octet-stream',
        };
      }
      const text = await res.text();
      // 解析 PROPFIND 响应（极简解析，匹配 getcontentlength/getcontenttype）
      const sizeMatch = text.match(/<getcontentlength>(\d+)<\/getcontentlength>/i);
      const typeMatch = text.match(/<getcontenttype>([^<]*)<\/getcontenttype>/i);
      return {
        length: sizeMatch ? parseInt(sizeMatch[1]) : 0,
        content_type: typeMatch ? typeMatch[1] : 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<boolean> {
    try {
      const res = await this.davFetch(this.fileUrl(name), { method: 'DELETE' });
      // 200, 202, 204 都是成功
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  /**
   * 递归创建父目录（WebDAV 的 MKCOL 不会自动创建中间目录）
   * file/xx/yy/hash → 确保 file/xx/yy/ 存在
   */
  private async ensureParentDirs(name: string): Promise<void> {
    const path = this.fullPath(name);
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 1) return;

    // 逐级 MKCOL
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath += parts[i] + '/';
      const url = this.cfg.endpoint + currentPath;
      const res = await this.davFetch(url, { method: 'MKCOL' });
      // 405 = 已存在，视为成功
      if (!res.ok && res.status !== 405) {
        // 忽略错误，继续尝试
      }
    }
  }

  /** 测试 WebDAV 连接 */
  static async testConnection(config: WebDavConfig): Promise<{ ok: boolean; message: string }> {
    try {
      const driver = new WebDavStorage(config);
      // 用 PROPFIND 检测根目录
      const res = await driver.davFetch(driver.cfg.endpoint, {
        method: 'PROPFIND',
        headers: { 'Depth': '0' },
      });
      if (res.ok || res.status === 207) {
        return { ok: true, message: `WebDAV 连接成功！服务器响应 ${res.status}` };
      }
      return { ok: false, message: `WebDAV 服务器返回 ${res.status}: ${await res.text().then(t => t.substring(0, 200))}` };
    } catch (e: any) {
      return { ok: false, message: e.message || '未知错误' };
    }
  }
}
