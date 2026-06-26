// 彩虹外链网盘 - 下载路由 (对应原 down.php)

import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getDB, getStor } from '../middleware';
import { getFileByHash, touchFile } from '../db';
import { fileOutput } from '../services/upload';

const download = new Hono<AppEnv>();

// 处理 /down.php/:hash.:ext 和 /down.php/:hash.:ext&:pwd
download.get('/*', async (c) => {
  const db = getDB(c);
  const stor = getStor(c);

  const path = c.req.path.replace(/^\/down\.php\//, '');
  const parts = path.split('&');
  let url = parts[0];
  const pwd = parts.length > 1 ? parts[parts.length - 1] : null;

  let hash: string;
  const dotPos = url.indexOf('.');
  if (dotPos !== -1) {
    hash = url.substring(0, dotPos);
  } else {
    hash = url;
  }

  if (!/^[0-9a-f]{32}$/i.test(hash)) {
    return new Response('Invalid hash', { status: 400 });
  }

  const row = await getFileByHash(db, hash);
  if (!row) return new Response('404 Not Found', { status: 404 });
  if (row.block >= 1) return new Response('File is blocked!', { status: 403 });

  // 密码校验
  if (row.pwd !== null && row.pwd !== '' && row.pwd !== pwd) {
    return new Response(`
      <meta http-equiv="content-type" content="text/html;charset=utf-8"/>
      <title>请输入密码下载文件</title>
      <script type="text/javascript">
      var pwd=prompt("请输入密码","")
      if (pwd!=null && pwd!="")
      {
          window.location.href='/down.php/${hash}&'+pwd
      }
      </script>
      请刷新页面，或[ <a href="javascript:history.back();">返回上一页</a> ]
    `, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // 检查文件是否在存储中存在
  const exists = await stor.exists(hash);
  if (!exists) return new Response('File Not Found', { status: 404 });

  await touchFile(db, row.id);

  return fileOutput(c, stor, hash, row.type, row.size, row.name, true);
});

export default download;
