// 彩虹外链网盘 - 加密工具
// 用 AES-GCM 替代原 PHP authcode(RC4 变种)

const ENC_ALGO = { name: 'AES-GCM', length: 256 };
const IV_LENGTH = 12; // 96 bits for GCM

async function getKey(secret: string, salt: string = 'pan_salt'): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret + salt),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    ENC_ALGO,
    false,
    ['encrypt', 'decrypt']
  );
}

/** AES-GCM 加密，返回 base64(IV+ciphertext) */
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/** AES-GCM 解密，输入 base64(IV+ciphertext) */
export async function decrypt(cipherBase64: string, secret: string): Promise<string | null> {
  try {
    const key = await getKey(secret);
    const combined = new Uint8Array(
      atob(cipherBase64).split('').map(c => c.charCodeAt(0))
    );
    const iv = combined.slice(0, IV_LENGTH);
    const data = combined.slice(IV_LENGTH);
    const dec = new TextDecoder();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    return dec.decode(plaintext);
  } catch {
    return null;
  }
}

/** SHA-256 哈希，返回 hex */
export async function sha256(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 生成随机字符串 */
export function randomStr(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

/** 安全的 base64URL 编码 (无 = 填充) */
export function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    str += BASE64URL_CHARS[a >> 2];
    str += BASE64URL_CHARS[((a & 3) << 4) | (b >> 4)];
    str += i + 1 < bytes.length ? BASE64URL_CHARS[((b & 15) << 2) | (c >> 6)] : '';
    str += i + 2 < bytes.length ? BASE64URL_CHARS[c & 63] : '';
  }
  return str;
}

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
