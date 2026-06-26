// 彩虹外链网盘 - 在线预览路由 (对应原 view.php / file_output inline)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getStor } from '../middleware';
import { getFileByHash, touchFile } from '../db';
import { fileOutput } from '../services/upload';

const view = new Hono<AppEnv>();

// /view.php/:hash.:ext 直接流式输出文件 (用于 img/audio/video src)
view.get('/*', async (c) => {
  const db = getDB(c);
  const stor = getStor(c);

  const path = c.req.path.replace(/^\/view\.php\//, '');
  let hash: string;
  const dotPos = path.indexOf('.');
  if (dotPos !== -1) {
    hash = path.substring(0, dotPos);
  } else {
    hash = path;
  }

  if (!/^[0-9a-f]{32}$/i.test(hash)) {
    return new Response('Invalid hash', { status: 400 });
  }

  const row = await getFileByHash(db, hash);
  if (!row) return new Response('404 Not Found', { status: 404 });
  if (row.block >= 1) return new Response('File is blocked!', { status: 403 });

  const exists = await stor.exists(hash);
  if (!exists) return new Response('File Not Found', { status: 404 });

  return fileOutput(c, stor, hash, row.type, row.size, row.name);
});

export default view;
