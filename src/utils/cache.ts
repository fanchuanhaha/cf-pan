// 首页公共缓存清理
// 注意：Cache API 的 delete 只影响当前 PoP，其他边缘节点仍靠 Cache-Control TTL 过期
export function purgeHomeCache(c: any): void {
  try {
    const cache = (globalThis as any).caches?.default;
    if (!cache) return;
    const req = new Request(new URL('/', c.req.url).toString(), { method: 'GET' });
    const p = cache.delete(req);
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      p.catch(() => {});
    }
  } catch {}
}
