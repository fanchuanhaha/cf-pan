// 彩虹外链网盘 - 上传服务

import { getConfig } from '../config';
import { insertFile, getFileByHash, getTodayUploadCount, now } from '../db';
import type { IStorage } from '../storage/IStorage';
import { getFileExt } from '../utils/mime';
import { getClientIP, htmlspecialchars } from '../utils/response';
import type { Context } from 'hono';

/** 从文件名中移除非法字符 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\/\\:*"<>|?]/g, '');
}

/** 校验文件名和扩展名是否在黑名单中 */
export function isBlocked(name: string, ext: string): string | null {
  const config = getConfig();
  
  if (config.type_block) {
    const typeBlock = config.type_block.split('|').map(s => s.toLowerCase());
    if (typeBlock.includes(ext.toLowerCase())) return 'block_type';
  }
  
  if (config.name_block) {
    const nameBlock = config.name_block.split('|');
    for (const kw of nameBlock) {
      if (name.includes(kw)) return 'block_name';
    }
  }
  
  return null;
}

/** 向浏览器输出文件流 (带 Range 支持) */
export async function fileOutput(
  c: Context,
  stor: IStorage,
  hash: string,
  type: string,
  size: number,
  name: string,
  forceDownload: boolean = false
): Promise<Response> {
  const ext = type.toLowerCase();
  const inlineExtList = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico',
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
    'mp4', 'webm', 'mov', 'flv', 'avi', 'mkv',
  ];
  const isInline = !forceDownload && inlineExtList.includes(ext);

  const contentDisposition = isInline
    ? `inline; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
    : `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;

  const rangeHeader = c.req.header('range');
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : size - 1;
      const response = await stor.downfile(hash, [start, end]);
      if (response) {
        const headers = new Headers(response.headers);
        headers.set('Content-Disposition', contentDisposition);
        headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream');
        return new Response(response.body, {
          status: 206,
          headers,
        });
      }
    }
  }

  const response = await stor.downfile(hash);
  if (!response) return new Response('File not found', { status: 404 });

  const headers = new Headers(response.headers);
  headers.set('Content-Disposition', contentDisposition);
  headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Content-Length', String(size));
  
  return new Response(response.body, {
    status: 200,
    headers,
  });
}

/** 检验上传参数 + 入库 */
export async function handleUploadComplete(
  db: D1Database,
  stor: IStorage,
  input: {
    name: string;
    hash: string;
    size: number;
    ext: string;
    hide: number;
    pwd: string | null;
    ip: string;
    uid: number;
  },
  env?: { FILE_R2: R2Bucket; AI?: unknown }
): Promise<{ code: number; msg: string; id?: number; hash?: string }> {
  const config = getConfig();
  
  // 检查是否已存在
  const existing = await getFileByHash(db, input.hash);
  if (existing) {
    return { code: 1, msg: '本站已存在该文件', hash: input.hash, id: existing.id };
  }

  // 检查存储中是否存在
  if (!(await stor.exists(input.hash))) {
    return { code: -1, msg: '文件上传失败' };
  }

  const { id } = await insertFile(db, {
    name: input.name,
    type: input.ext,
    size: input.size,
    hash: input.hash,
    ip: input.ip,
    hide: input.hide,
    pwd: input.pwd,
    uid: input.uid,
  });

  return { code: 1, msg: '文件上传成功！', id, hash: input.hash };
}
