内容由ai生成，请注意辨别

# 彩虹外链网盘 (Cloudflare Workers 版)

源项目地址https://github.com/netcccyun/pan
界面上相较于原站点只是适配了深色模式，其他都保持了不变

# 安装

> 如果以前跑过 PHP 版、想把数据搬过来，先看 [从原站点恢复](#从原站点恢复)。

## 用 GitHub Actions 部署（推荐）

1. Fork 这个仓库
2. 在 GitHub 仓库 Settings → Secrets and variables → Actions 里加两个 Secret：

| Secret | 说明 |
|---|---|
| [CLOUDFLARE_API_TOKEN](https://dash.cloudflare.com/profile/api-tokens) | Cloudflare API Token（要有 Workers / D1 / R2 Edit 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |

3. 往 `main` 分支推一次代码，Actions 会自动跑完这些事：
   - 创建 D1 数据库
   - 初始化表结构
   - 创建 R2 存储桶
   - 部署 Worker

不用配任何通信密钥，`rec.php` 那边第一次访问会自动生成。

## 部署完成后

打开 `https://你的域名/install/`，按向导走：

1. 设置管理员账号和密码
2. 选择存储后端，目前支持 R2 / S3 / 七牛 / 又拍 / GitHub / WebDAV
3. 填存储的参数（Key、Bucket 之类的），点一下测试连接
4. 完事

要是之前没用过 PHP 版，选「全新安装」直接建个空库就行。

---

# 从原站点恢复

老 PHP 站点的数据和文件可以直接整体搬过来，不用手动重新传文件。流程是：

- Worker 向导从原站导出数据库和文件清单（需要原站的管理员账号密码）
- 文件由原站服务器上的 `rec.php` 直接读出来传到新存储，不走 Worker，速度快也不受 Worker 超时限制

## 1. 上传 rec.php 到原站

把仓库根目录的 `rec.php` 传到原站根目录（和 `index.php` 同一个目录）。**不用改任何东西**，密钥第一次访问时自动生成、自动存到 `restore_secret.php`。

> 原站如果是静态托管（比如 Mohua 虚拟主机开了缓存），页面可能拿到旧内容，恢复的时候记得刷新。

## 2. 在向导里恢复

1. 打开 `https://你的域名/install/`，选「从备份恢复」
2. 填原站地址（比如 `https://老站点.com`）、原站管理员账号和密码
3. 系统自动从原站导出数据库，也可以手动传一个 `.sql` 文件代替
4. 勾选要带过来的 `pre_config` 配置项（`storage` 永远不导入，得重新选）
5. 选新存储（比如 GitHub 仓库），填好参数测试连接
6. 点「应用配置并完成」，向导会给你一个带令牌的恢复链接

## 3. 在原站开始恢复

用那个带令牌的链接打开原站 `rec.php` 页面，点「开始恢复」：

- 文件由原站 PHP 逐个传到新存储，页面上能看到实时进度
- 令牌链接有效期 7 天，第一次打开自动记住会话；没带令牌也可以直接输原站管理员账号密码进去
- 恢复完成点「返回 Worker 站点」回到向导确认，收工

### 关于 GitHub 存储

用 GitHub 仓库存文件是免费，但有几个限制要心里有数：

- 单文件上限 50MB，超过的会自动跳过并在结果里标出来
- 文件存成 `file/完整hash` 这样的扁平结构
- 需要填 GitHub 账号、仓库名和 token（token 要有仓库写入权限）

### 原站 PHP 那边要注意的

- PHP 需要装了 cURL 扩展
- `restore_config.php` / `restore_status.json` / `restore_secret.php` 会在原站目录自动生成，确认目录可写
- 站点静态缓存会挡住 `restore_status.json` 的实时状态，看进度时带个时间戳参数（向导已经自动处理了）

---

# 支持的存储后端

| 存储类型 | 说明 |
|---|---|
| **R2** | Cloudflare 原生对象存储，零流量费 |
| **S3 兼容** | 阿里云 OSS / 腾讯云 COS / AWS S3 / MinIO 等 |
| **七牛云** | Qiniu Kodo |
| **又拍云** | Upyun USS |
| **GitHub API** | 用 GitHub 仓库存，免费但有 50MB 单文件上限 |
| **WebDAV** | 坚果云等 WebDAV 服务 |

### 原站点云存储对接

老 PHP 版用的存储，在 Workers 版里这么配：

| 原站点存储 | Workers 版接入方式 | 说明 |
|---|---|---|
| 腾讯云 COS | **S3 兼容** | 填 COS 的 Endpoint、Region、Bucket、SecretId/SecretKey |
| 阿里云 OSS | **S3 兼容** | 填 OSS 的 Endpoint、Region、Bucket、AccessKey/SecretKey |
| 华为云 OBS | **S3 兼容** | 填 OBS 的 Endpoint、Region、Bucket、AK/SK |
| 七牛云 | **七牛云** | 直接选七牛云，填 AK / SK / Bucket |
| 又拍云 | **又拍云** | 直接选又拍云，填 Operator / 密码 / Bucket |

---

# 目录结构

```
├─ wrangler.spa.toml          # Worker 部署配置
├─ package.json
├─ tsconfig.json
├─ schema.sql                 # D1 建表 SQL
├─ rec.php                    # 原站恢复脚本（部署到原 PHP 站点根目录，不用改配置）
├─ public/                    # 前端静态资源 (Worker Assets)
│  ├─ favicon.ico
│  └─ assets/
│     ├─ css/                 # style / admin / ckplayer / bootstrap-table
│     ├─ js/                  # ckplayer / custom / upload / uploadnew
│     └─ img/                 # 占位图
└─ src/
   ├─ index.ts                # Worker 入口 (Hono 路由)
   ├─ config.ts               # 配置管理 (D1 读写)
   ├─ middleware.ts           # db / stor / config 注入
   ├─ db/index.ts             # D1 查询封装
   ├─ auth/
   │  ├─ admin.ts             # 管理员 AES-GCM Token
   │  └─ user.ts              # 用户 AES-GCM Token
   ├─ storage/
   │  ├─ IStorage.ts          # 存储抽象接口
   │  ├─ R2Storage.ts         # R2 实现
   │  ├─ S3Storage.ts         # S3 兼容实现
   │  └─ factory.ts           # 存储工厂
   ├─ services/
   │  ├─ upload.ts            # 上传服务
   │  ├─ green.ts             # 鉴黄服务
   │  ├─ remoteRestore.ts     # 远程恢复客户端（导出原站数据）
   │  ├─ restoreSession.ts    # 安装会话持久化
   │  ├─ restorePreExtract.ts # SQL 预提取 / pre_file 解析
   │  └─ restore.ts           # 从源 URL 恢复文件
   └─ routes/
      ├─ frontend.ts          # 页面渲染 (首页 / 文件查看 / 后台)
      ├─ ajax.ts              # 上传 (预检 / 分片 / 删除)
      ├─ api.ts               # 第三方上传 API
      ├─ download.ts          # 下载代理 (Range 断点续传)
      ├─ view.ts              # 预览代理
      ├─ admin.ts             # 后台管理 API
      └─ install.ts           # 安装向导 / 从备份恢复
```

---

# API 接口

## 上传 API

```
POST /api.php
Content-Type: multipart/form-data

file: 文件内容
format: json（可选，支持 json / jsonp / form）
```

回执格式支持 `json` / `jsonp` / `form` 三种，用 `POST` 参数 `format` 指定。

## 示例请求

```bash
curl -X POST https://你的域名/api.php \
  -F "file=@example.png" \
  -F "format=json"
```

返回：

```json
{
  "code": 0,
  "msg": "文件上传成功！",
  "hash": "d41d8cd98f00b204e9800998ecf8427e",
  "name": "example.png",
  "size": 12345,
  "type": "png",
  "id": 1,
  "downurl": "https://你的域名/down.php/d41d8cd98f00b204e9800998ecf8427e.png"
}
```

---

# 与原 PHP 版本的主要区别

| 项目 | PHP 版 | Workers 版 |
|---|---|---|
| 运行环境 | PHP 7.1+ / MySQL 5.5+ | Cloudflare Workers |
| 数据库 | MySQL | D1 (SQLite 兼容) |
| 存储 | 本地 / OSS / COS / OBS / Upyun / Qiniu | R2 + S3 兼容 + 七牛 / 又拍 / GitHub / WebDAV |
| 鉴权算法 | authcode (RC4) | AES-GCM |
| 前端框架 | jQuery + Bootstrap 3 | 保留原 jQuery + Bootstrap 3 |
| 页面渲染 | PHP 模板 | Worker SSR 模板直出 |
| 鉴黄 | 阿里云 Green / 腾讯云 IMS | Cloudflare AI |
| 部署 | 上传 PHP 主机 | GitHub Actions 一键部署 |
| 数据迁移 | - | 原站 rec.php 自动导出 + 文件直传 |

---

# 许可证

MIT License

---

# 相关链接

- 原 PHP 版：https://github.com/netcccyun/pan
- 原 PHP 版在线演示：https://pan.cccyun.cc/
- 作者博客：https://blog.cccyun.cn/
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Cloudflare D1 文档：https://developers.cloudflare.com/d1/
- Cloudflare R2 文档：https://developers.cloudflare.com/r2/
