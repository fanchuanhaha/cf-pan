// 彩虹外链网盘 - 管理员认证 (AES-GCM 加密 Token)

import { encrypt, decrypt } from '../utils/crypto';

const PASSWORD_HASH = '!@#%!s!0';

/** 签发管理员 Token，有效期 see days */
export async function signAdminToken(
  adminUser: string,
  adminPwd: string,
  syskey: string,
  expiryDays: number = 7
): Promise<string> {
  const sid = await simpleHash(adminUser + adminPwd + PASSWORD_HASH);
  const expireTime = Math.floor(Date.now() / 1000) + expiryDays * 86400;
  const payload = `${adminUser}\t${sid}\t${expireTime}`;
  return encrypt(payload, syskey);
}

/** 验证管理员 Token，返回 admin 用户名或 null */
export async function verifyAdminToken(
  token: string,
  adminUser: string,
  adminPwd: string,
  syskey: string
): Promise<boolean> {
  const decrypted = await decrypt(token, syskey);
  if (!decrypted) {
    // 尝试用 url decode 再解
    const decrypted2 = await decrypt(decodeURIComponent(token), syskey);
    if (!decrypted2) return false;
    return validateToken(decrypted2, adminUser, adminPwd);
  }
  return validateToken(decrypted, adminUser, adminPwd);
}

async function validateToken(payload: string, adminUser: string, adminPwd: string): Promise<boolean> {
  const parts = payload.split('\t');
  if (parts.length !== 3) return false;
  const [user, sid, expStr] = parts;
  if (user !== adminUser) return false;
  const expectedSid = await simpleHash(adminUser + adminPwd + PASSWORD_HASH);
  if (sid !== expectedSid) return false;
  const expTime = parseInt(expStr);
  if (isNaN(expTime) || expTime < Date.now() / 1000) return false;
  return true;
}

async function simpleHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('MD5', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
