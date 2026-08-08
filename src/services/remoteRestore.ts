const REMOTE_RESTORE_TTL = 300;

async function keyBytes(secret: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))));
}

async function encrypt(secret: string, value: unknown, tagFirst = true): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', await keyBytes(secret), { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(value))));
  const tag = encrypted.slice(-16);
  const cipher = encrypted.slice(0, -16);
  const output = tagFirst
    ? new Uint8Array([...iv, ...tag, ...cipher])
    : new Uint8Array([...iv, ...cipher, ...tag]);
  return btoa(String.fromCharCode(...output));
}

async function decrypt(secret: string, value: string): Promise<any> {
  const raw = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', await keyBytes(secret), { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = raw.slice(0, 12);
  const attempts = [
    new Uint8Array([...raw.slice(12 + 16), ...raw.slice(12, 12 + 16)]),
    raw.slice(12),
  ];
  for (const encrypted of attempts) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encrypted);
      return JSON.parse(new TextDecoder().decode(plain));
    } catch { /* 尝试另一种密文排列 */ }
  }
  throw new Error('远程 PHP 响应解密失败，请更新 rec.php');
}

function endpoint(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  if (/\/remote_restore\.php$/i.test(url.pathname)) return url.toString();
  // Accept a root URL or the old /down.php URL, but always call the agent file.
  const basePath = /\/down\.php$/i.test(url.pathname) ? url.pathname.replace(/\/down\.php$/i, '') : url.pathname;
  url.pathname = basePath.replace(/\/+$/, '') + '/rec.php';
  url.search = '';
  return url.toString();
}

async function remoteRequestOnce(secret: string, sourceUrl: string, action: string, payload: Record<string, unknown>, tagFirst: boolean): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const encrypted = await encrypt(secret, payload, tagFirst);
  const signature = await hmac(secret, `${timestamp}\n${nonce}\n${action}\n${encrypted}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(endpoint(sourceUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ timestamp, nonce, action, payload: encrypted, signature }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`远程 PHP 返回非 JSON (${response.status})`); }
    if (!response.ok || !json.ok) throw new Error(json.error || `远程 PHP 请求失败 (${response.status})`);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function remoteRequestWithRetry(secret: string, sourceUrl: string, action: string, payload: Record<string, unknown>, tagFirst: boolean, retries = 2): Promise<any> {
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await remoteRequestOnce(secret, sourceUrl, action, payload, tagFirst);
    } catch (e: any) {
      lastError = e;
      const msg = String(e?.message || e);
      if (msg.includes('加密请求校验失败') && tagFirst) {
        tagFirst = false;
        attempt--; // 不算次数，换 tagFirst 重试
        continue;
      }
      if (attempt < retries) {
        console.warn(`[remoteRequest] ${action} attempt ${attempt + 1} failed: ${msg}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function remoteRequest(secret: string, sourceUrl: string, action: string, payload: Record<string, unknown>): Promise<any> {
  return remoteRequestWithRetry(secret, sourceUrl, action, payload, true);
}

export async function remoteExport(sourceUrl: string, adminUser: string, adminPassword: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(endpoint(sourceUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action: 'export', admin_user: adminUser, admin_password: adminPassword }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`原站 rec.php 返回非 JSON (${response.status})`); }
    if (!response.ok || !json.ok) throw new Error(json.error || `远程导出失败 (${response.status})`);
    if (!json.data) throw new Error('远程 PHP 没有返回导出数据');
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}

export function remoteFileRequest(secret: string, sourceUrl: string, hash: string, type: string, adminUser: string, adminPassword: string): Promise<Response> {
  return (async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const encrypted = await encrypt(secret, { hash, type, admin_user: adminUser, admin_password: adminPassword });
    const signature = await hmac(secret, `${timestamp}\n${nonce}\nfile\n${encrypted}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    try {
      return await fetch(endpoint(sourceUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/octet-stream' },
        body: JSON.stringify({ timestamp, nonce, action: 'file', payload: encrypted, signature }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  })();
}

async function remoteRequestPayload(secret: string, sourceUrl: string, action: string, payload: Record<string, unknown>): Promise<any> {
  const result = await remoteRequest(secret, sourceUrl, action, payload);
  if (!result.payload) throw new Error(`远程 PHP 没有返回 ${action} 数据`);
  return decrypt(secret, result.payload);
}

export async function remoteUploadFile(
  secret: string,
  sourceUrl: string,
  hash: string,
  type: string,
  adminUser: string,
  adminPassword: string,
  targetStorage: string,
  targetFields: Record<string, string>,
  onProgress?: (event: { type: string; uploaded?: number; total?: number; ok?: boolean; error?: string }) => void,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const base = { hash, type, admin_user: adminUser, admin_password: adminPassword, target_storage: targetStorage, target_fields: targetFields };
    const BLOCK = 4 * 1024 * 1024;
    const CONCURRENCY = 4;
    const DIRECT_THRESHOLD = 8 * 1024 * 1024; // 小于等于该大小直接整文件上传，不分块

    onProgress?.({ type: 'start' });
    const stat = await remoteRequestPayload(secret, sourceUrl, 'stat-file', { ...base, hash });
    if (!stat.ok) return { ok: false, error: stat.error || '远程文件不可用' };
    const total = Number(stat.size) || 0;
    onProgress?.({ type: 'progress', uploaded: 0, total });
    if (total <= 0) return { ok: false, error: '远程文件大小为 0，跳过' };

    // 小文件：单次整文件上传，减少请求往返
    if (total <= DIRECT_THRESHOLD) {
      const block = await remoteRequestPayload(secret, sourceUrl, 'upload-block', { ...base, hash, offset: 0, length: total });
      if (!block.ok) return { ok: false, error: block.error || '直传失败' };
      const finalize = await remoteRequestPayload(secret, sourceUrl, 'mkfile', { ...base, hash, contexts: [block.ctx], size: total });
      if (!finalize.ok) return { ok: false, error: finalize.error || 'mkfile 失败' };
      onProgress?.({ type: 'progress', uploaded: total, total });
      onProgress?.({ type: 'done', uploaded: total, total, ok: true });
      return { ok: true, data: finalize };
    }

    // 大文件：并发分块上传。每块独立请求，ctx 按 offset 收集，完成后按序拼装。
    // 七牛 mkblk 每块互相独立，mkfile 只需 ctx 顺序与文件字节顺序一致。
    const blockCount = Math.ceil(total / BLOCK);
    const ctxByOffset = new Map<number, string>();
    let uploaded = 0;
    let next = 0;
    let failed: { offset: number; error: string } | null | undefined = null;

    const uploadOne = async (offset: number): Promise<void> => {
      if (failed) return;
      const MAX_RETRY = 2;
      for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
          const block = await remoteRequestPayload(secret, sourceUrl, 'upload-block', { ...base, hash, offset, length: BLOCK });
          if (!block.ok) {
            if (!(block.error && String(block.error).includes('offset 超出'))) {
              if (attempt < MAX_RETRY) {
                console.warn(`[remoteUpload] block offset=${offset} failed: ${block.error}, retry ${attempt + 1}/${MAX_RETRY}`);
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
              }
              failed = { offset, error: block.error || `分块上传失败 (offset ${offset})` };
            }
            return;
          }
          ctxByOffset.set(Number(block.offset), block.ctx);
          const newUploaded = Math.min(uploaded + (Number(block.len) || 0), total);
          if (newUploaded !== uploaded) {
            uploaded = newUploaded;
            onProgress?.({ type: 'progress', uploaded, total });
          }
          return;
        } catch (e: any) {
          if (attempt < MAX_RETRY) {
            console.warn(`[remoteUpload] block offset=${offset} error: ${e?.message}, retry ${attempt + 1}/${MAX_RETRY}`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          failed = { offset, error: String(e?.message || e) };
        }
      }
    };

    while (next < blockCount && !failed) {
      const batch: Promise<void>[] = [];
      while (next < blockCount && batch.length < CONCURRENCY) {
        batch.push(uploadOne(next * BLOCK));
        next++;
      }
      await Promise.allSettled(batch);
    }
    if (failed) return { ok: false, error: (failed as { offset: number; error: string }).error };
    const contexts: string[] = [];
    for (let i = 0; i < blockCount; i++) {
      const ctx = ctxByOffset.get(i * BLOCK);
      if (!ctx) return { ok: false, error: `缺少第 ${i + 1} 个分块上下文` };
      contexts.push(ctx);
    }

    const finalize = await remoteRequestPayload(secret, sourceUrl, 'mkfile', { ...base, hash, contexts, size: total });
    if (!finalize.ok) return { ok: false, error: finalize.error || 'mkfile 失败' };
    onProgress?.({ type: 'done', uploaded: total, total, ok: true });
    return { ok: true, data: finalize };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }
}
