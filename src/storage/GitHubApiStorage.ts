// 彩虹外链网盘 - GitHub API 存储实现
// 参考 CloudPaste 的 GithubApiStorageDriver 实现
// 通过 GitHub Contents API (读) + Git Database API (写) 把仓库映射为文件存储

import type { IStorage } from './IStorage';

const DEFAULT_API_BASE = 'https://api.github.com';
const MAX_GITHUB_BLOB = 100 * 1024 * 1024; // 100MB 单 blob 上限

interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
  ref?: string;
  defaultFolder?: string;
  apiBase?: string;
  ghProxy?: string;
}

/** 把字符串编码为 base64（兼容 Workers 环境） */
function utf8ToBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

/** ArrayBuffer/字符串转 base64 */
function toBase64(data: ArrayBuffer | string): string {
  if (typeof data === 'string') return utf8ToBase64(data);
  const bytes = new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** SHA-1 hash for Git blobs */
async function sha1(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export class GitHubApiStorage implements IStorage {
  private cfg: GitHubConfig;
  private resolvedRef: string | null = null;
  private branchName: string | null = null;
  private isOnBranch = false;
  private repoIsEmpty = false;

  constructor(config: GitHubConfig) {
    this.cfg = config;
  }

  private get apiBase(): string {
    return this.cfg.apiBase || DEFAULT_API_BASE;
  }

  private get token(): string {
    return this.cfg.token;
  }

  /** 拼接仓库文件 API URL */
  private fileApiUrl(path: string = ''): string {
    return `${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}/contents/${path}${this.resolvedRef ? `?ref=${encodeURIComponent(this.resolvedRef)}` : ''}`;
  }

  /** 拼接仓库 meta API URL */
  private repoApiUrl(): string {
    return `${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}`;
  }

  /** 拼接 Git Database API URL */
  private gitRefUrl(ref: string): string {
    return `${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}/git/refs/${ref}`;
  }
  private gitCommitsUrl(): string {
    return `${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}/git/commits`;
  }
  private gitBlobUrl(): string {
    return `${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}/git/blobs`;
  }
  private gitTreesUrl(): string {
    return `${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}/git/trees`;
  }

  /** 发起 GitHub API 请求 */
  private async fetchJson(url: string, init: RequestInit = {}): Promise<any> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pan-worker-github-storage',
      ...(init.headers as Record<string, string> || {}),
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status}: ${text}`);
    }
    return res.json();
  }

  /** 初始化：解析仓库元信息，确定 ref / 分支 */
  async initialize(): Promise<void> {
    const errors: string[] = [];
    if (!this.cfg.owner) errors.push('GitHub 配置缺少 owner');
    if (!this.cfg.repo) errors.push('GitHub 配置缺少 repo');
    if (!this.cfg.token) errors.push('GitHub 配置缺少 token（写入必须）');
    if (errors.length) {
      throw new Error(errors.join('；'));
    }

    // 1. 获取仓库元信息
    const repoMeta = await this.fetchJson(this.repoApiUrl());
    const defaultBranch: string = repoMeta.default_branch;
    const refName = this.cfg.ref || defaultBranch;
    this.resolvedRef = refName;
    this.branchName = refName;
    this.isOnBranch = true;

    // 2. 检查 ref 是否存在
    try {
      await this.fetchJson(this.fileApiUrl(''));
    } catch (e: any) {
      if (String(e.message).includes('409') || String(e.message).includes('404')) {
        this.repoIsEmpty = true;
      }
    }
  }

  /** 把 hash 映射到仓库内路径（按 2 级目录切分） */
  private hashToPath(hash: string): string {
    if (this.cfg.defaultFolder) {
      return `${this.cfg.defaultFolder.replace(/\/$/, '')}/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash}`;
    }
    return `file/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash}`;
  }

  async exists(name: string): Promise<boolean> {
    if (!this.resolvedRef) await this.initialize();
    try {
      await this.fetchJson(this.fileApiUrl(this.hashToPath(name)));
      return true;
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
    if (!this.resolvedRef) await this.initialize();
    try {
      const meta = await this.fetchJson(this.fileApiUrl(this.hashToPath(name)));
      const rawUrl = meta.download_url;
      if (!rawUrl) return null;

      // 用 GitHub raw URL 走直链（无需 token，CDN 加速）
      const headers: Record<string, string> = {};
      if (range) {
        headers['Range'] = `bytes=${range[0]}-${range[1]}`;
      }
      const res = await fetch(rawUrl, { headers });
      if (!res.ok) return null;

      const out = new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
      return out;
    } catch {
      return null;
    }
  }

  async upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean> {
    if (!this.resolvedRef) await this.initialize();
    try {
      const path = this.hashToPath(name);
      const buf = body instanceof ArrayBuffer
        ? body
        : await new Response(body as ReadableStream).arrayBuffer();

      // 1. 创建 blob
      const blobRes = await this.fetchJson(this.gitBlobUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: toBase64(buf), encoding: 'base64' }),
      });
      const blobSha = blobRes.sha;

      // 2. 获取当前 ref 指向的 commit
      let parentSha: string | null = null;
      let baseTreeSha: string | null = null;
      try {
        const refRes = await this.fetchJson(this.gitRefUrl(`heads/${this.branchName}`));
        parentSha = refRes.object.sha;
        const commitRes = await this.fetchJson(`${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}/git/commits/${parentSha}`);
        baseTreeSha = commitRes.tree.sha;
      } catch {
        // 空仓库
        this.repoIsEmpty = true;
      }

      // 3. 创建 tree（包含新文件）
      const treeRes = await this.fetchJson(this.gitTreesUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: [{
            path,
            mode: '100644',
            type: 'blob',
            sha: blobSha,
          }],
        }),
      });
      const newTreeSha = treeRes.sha;

      // 4. 创建 commit
      const commitRes = await this.fetchJson(this.gitCommitsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `upload ${name}`,
          tree: newTreeSha,
          parents: parentSha ? [parentSha] : [],
        }),
      });
      const newCommitSha = commitRes.sha;

      // 5. 更新 ref
      if (this.repoIsEmpty) {
        // 空仓库：先创建 ref
        await this.fetchJson(this.gitRefUrl('heads'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${this.branchName}`, sha: newCommitSha }),
        });
        this.repoIsEmpty = false;
      } else {
        await this.fetchJson(this.gitRefUrl(`heads/${this.branchName}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: newCommitSha, force: false }),
        });
      }
      return true;
    } catch (e) {
      console.error('GitHub upload error:', e);
      return false;
    }
  }

  async savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean> {
    // GitHub API 不需要本地临时文件
    return this.upload(name, new Uint8Array(0) as unknown as ArrayBuffer, contentType);
  }

  async getinfo(name: string): Promise<{ length: number; content_type: string } | null> {
    if (!this.resolvedRef) await this.initialize();
    try {
      const meta = await this.fetchJson(this.fileApiUrl(this.hashToPath(name)));
      return {
        length: meta.size,
        content_type: meta.type || 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<boolean> {
    if (!this.resolvedRef) await this.initialize();
    try {
      const path = this.hashToPath(name);
      // 1. 获取文件 sha
      const meta = await this.fetchJson(this.fileApiUrl(path));
      // 2. 删除
      await this.fetchJson(this.fileApiUrl(path), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `delete ${name}`,
          sha: meta.sha,
          branch: this.branchName,
        }),
      });
      return true;
    } catch (e) {
      console.error('GitHub delete error:', e);
      return false;
    }
  }

  async getDownUrl(name: string, filename: string, contentType?: string): Promise<string | null> {
    if (!this.resolvedRef) await this.initialize();
    try {
      const meta = await this.fetchJson(this.fileApiUrl(this.hashToPath(name)));
      return meta.download_url || null;
    } catch {
      return null;
    }
  }

  /** 验证配置是否有效 */
  static async testConnection(config: GitHubConfig): Promise<{ ok: boolean; message: string }> {
    try {
      const driver = new GitHubApiStorage(config);
      await driver.initialize();
      return { ok: true, message: 'GitHub 存储配置有效' };
    } catch (e: any) {
      return { ok: false, message: e.message || '未知错误' };
    }
  }
}
