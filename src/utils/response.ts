// 彩虹外链网盘 - HTTP 响应工具
import type { Context } from 'hono';
import { D1_BOOKMARK_COOKIE, D1_BOOKMARK_MAX_AGE } from '../middleware';

/** JSON 成功响应 */
export function jsonOk(c: Context, data: Record<string, unknown>, status: 200 | 201 = 200): Response {
  return c.json(data, status);
}

/** JSON 错误响应 */
export function jsonError(c: Context, msg: string, code = -1, status: 200 | 400 | 403 | 404 | 500 = 200): Response {
  return c.json({ code, msg }, status);
}

/** JSON 响应（带自定义 HTTP 状态） */
export function jsonResult(c: Context, result: Record<string, unknown>, status: 200 | 201 | 400 | 500 = 200): Response {
  return c.json(result, status);
}

/** HTML 响应 */
export function html(c: Context, body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

/** 获取客户端真实 IP */
export function getClientIP(c: Context, ipType = 0): string {
  const req = c.req.raw;
  const headers = c.req.header.bind(c.req);

  if (ipType <= 0) {
    const xff = headers('x-forwarded-for');
    if (xff) {
      const ips = xff.split(',').map(s => s.trim());
      for (const ip of ips) {
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          const parts = ip.split('.').map(Number);
          if (parts[0] !== 10 && !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) && parts[0] !== 192 && parts[0] !== 168) {
            return ip;
          }
        }
      }
    }
    const cf = headers('cf-connecting-ip');
    if (cf) return cf;
    const xri = headers('x-real-ip');
    if (xri) return xri;
  }
  return headers('cf-connecting-ip') || '127.0.0.1';
}

/** 生成伪 CSRF token (前端校验用) */
export function generateCsrfToken(): string {
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/** 转义 HTML 特殊字符 */
export function htmlspecialchars(str: string): string {
  const map: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#039;',
  };
  return str.replace(/[&<>"']/g, c => map[c] || c);
}

/**
 * 将 D1 会话 bookmark 写入 Cookie（Cloudflare read-after-write 一致性）
 * 写入时使用 append，避免覆盖其他路由的 Set-Cookie（upload_csrf / admin_token 等）。
 */
export function setD1BookmarkCookie(c: Context, bookmark: string | null | undefined): void {
  if (!bookmark) return;
  const cookieValue = `${D1_BOOKMARK_COOKIE}=${encodeURIComponent(bookmark)}; Path=/; Max-Age=${D1_BOOKMARK_MAX_AGE}; SameSite=Lax; HttpOnly`;
  c.header('Set-Cookie', cookieValue, { append: true });
}
