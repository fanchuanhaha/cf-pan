// 彩虹外链网盘 - 用户认证 (AES-GCM 加密 Cookie)

import { encrypt, decrypt, sha256 } from '../utils/crypto';

const PASSWORD_HASH = '!@#%!s!0';

/** 签发用户登录 Token */
export async function signUserToken(
  uid: number,
  userType: string,
  openid: string,
  syskey: string,
  expiryDays: number = 30
): Promise<string> {
  const sid = await sha256(userType + openid + PASSWORD_HASH);
  const expireTime = Math.floor(Date.now() / 1000) + expiryDays * 86400;
  const payload = `${uid}\t${sid}\t${expireTime}`;
  return encrypt(payload, syskey);
}

/** 解析用户 Token，返回 { uid, sid, expiretime } 或 null */
export async function parseUserToken(
  token: string,
  syskey: string
): Promise<{ uid: number; sid: string; expireTime: number } | null> {
  let decrypted = await decrypt(token, syskey);
  if (!decrypted) {
    decrypted = await decrypt(decodeURIComponent(token), syskey);
  }
  if (!decrypted) return null;

  const parts = decrypted.split('\t');
  if (parts.length !== 3) return null;
  const uid = parseInt(parts[0]);
  const sid = parts[1];
  const expireTime = parseInt(parts[2]);
  if (isNaN(uid) || isNaN(expireTime)) return null;
  if (expireTime < Date.now() / 1000) return null;
  return { uid, sid, expireTime };
}

/** 校验用户 Token 是否有效 */
export async function validateUserToken(
  token: string,
  userType: string,
  openid: string,
  syskey: string
): Promise<{ uid: number } | null> {
  const parsed = await parseUserToken(token, syskey);
  if (!parsed) return null;

  const expectedSid = await sha256(userType + openid + PASSWORD_HASH);
  if (parsed.sid !== expectedSid) return null;

  return { uid: parsed.uid };
}
