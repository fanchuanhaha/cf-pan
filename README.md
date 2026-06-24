# 彩虹外链网盘 (Cloudflare Workers 版)

彩虹外链网盘，是一款文件外链分享程序，支持所有格式文件的上传，可以生成文件外链、图片外链、音乐视频外链，生成外链同时自动生成相应的 UBB 代码和 HTML 代码，还可支持文本、图片、音乐、视频在线预览。

本版本基于 **Cloudflare Workers** 重写，使用 **D1 数据库** + **R2 对象存储**，零服务器，全球 300+ 节点就近响应，自动扩缩容。

---

## 特性

- **零运维**：基于 Cloudflare Workers，无需管理服务器
- **边缘计算**：全球节点就近响应，极低延迟
- **D1 数据库**：文件元数据存储，支持 SQL 查询
- **R2 对象存储**：零流量费，无限存储
- **S3 兼容**：支持接入 OSS / COS / MinIO 等 S3 兼容存储
- **极速秒传**：上传前计算 MD5，已存在文件秒传
- **分片上传**：大文件自动分片，支持前端直传
- **断点续传**：下载支持 Range 请求，视频可拖拽
- **文件预览**：图片 / 音频 / 视频在线预览
- **第三方 API**：支持 json / jsonp / form 三种回执格式
- **绿色鉴黄**：可选 Cloudflare AI NSFW 检测
- **视频审核**：可选人工审核模式
- **会员系统**：OAuth 登录，上传记录管理
- **一键部署**：GitHub Actions 自动创建 D1 + R2 + 部署

---

## 环境要求

- [Cloudflare 账号](https://dash.cloudflare.com/)
- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) >= 4.0

---

## 快速开始

### 1. 安装依赖

```bash
cd cf
npm install
```

### 2. 配置 Cloudflare 绑定

在 `wrangler.spa.toml` 中配置：

```toml
# 替换为你的 D1 数据库 ID
[[d1_databases]]
binding = "DB"
database_name = "pan-db"
database_id = "你的D1数据库ID"

# 替换为你的 R2 存储桶名
[[r2_buckets]]
binding = "FILE_R2"
bucket_name = "pan-files"
```

### 3. 本地开发

```bash
npx wrangler dev
```

访问 `http://localhost:8787`

### 4. 部署到 Cloudflare

**方式一：命令行部署**

```bash
npx wrangler deploy --config wrangler.spa.toml
```

**方式二：GitHub Actions 自动部署（推荐）**

1. Fork 本仓库
2. 在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需要 Workers / D1 / R2 Edit 权限，一个令牌覆盖全部）|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |

3. Push 代码到 `main` 分支，GitHub Actions 自动完成：
   - 创建 D1 数据库
   - 初始化表结构
   - 创建 R2 存储桶
   - 部署 Worker

---

## 后台管理

- 后台地址：`https://你的域名/admin`
- 默认账号：`admin`
- 默认密码：`123456`

首次登录后请在后台 **设置 → 修改管理员密码**。

---

## 目录结构

```
cf/
├─ wrangler.spa.toml          # Worker 部署配置
├─ package.json
├─ tsconfig.json
├─ schema.sql                 # D1 建表 SQL
├─ public/                    # 前端静态资源 (Worker Assets)
│  ├─ favicon.ico
│  └─ assets/
│     ├─ css/                 # style / admin / ckplayer / bootstrap-table
│     ├─ js/                  # ckplayer / custom / upload / uploadnew
│     └─ img/                 # 占位图
└─ src/
   ├─ index.ts                # Worker 入口 (Hono 路由)
   ├─ config.ts               # 配置管理 (D1 读写)
   ├─ middleware.ts            # db / stor / config 注入
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
   │  └─ green.ts             # 鉴黄服务
   ├─ utils/
   │  ├─ crypto.ts            # AES-GCM / SHA-256
   │  ├─ mime.ts              # MIME / 图标 / 大小格式化
   │  └─ response.ts          # HTTP 响应工具
   └─ routes/
      ├─ frontend.ts          # 页面渲染 (首页 / 文件查看 / 后台)
      ├─ ajax.ts              # 上传 (预检 / 分片 / 删除)
      ├─ api.ts               # 第三方上传 API
      ├─ download.ts          # 下载代理 (Range 断点续传)
      ├─ view.ts              # 预览代理
      └─ admin.ts             # 后台管理 API
```

---

## 存储接入

### R2（默认）

在 `wrangler.spa.toml` 中绑定 R2 存储桶即可，后台选择 `r2` 存储类型。

### S3 兼容存储

在后台 **存储类型设置** 中选择 `S3 兼容存储`，填写：

| 字段 | 说明 |
|---|---|
| Endpoint | S3 兼容地址，如 `https://oss-cn-hangzhou.aliyuncs.com` |
| Region | 区域，如 `oss-cn-hangzhou` |
| Bucket | 存储桶名称 |
| AccessKey | 访问密钥 |
| SecretKey | 访问密钥 |

---

## API 接口

### 上传 API

```
POST /api.php
Content-Type: multipart/form-data

file: 文件内容
```

回执格式支持 `json` / `jsonp` / `form` 三种，通过 `POST` 参数 `format` 指定。

### 示例请求

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

## 与原 PHP 版本的主要区别

| 项目 | PHP 版 | Workers 版 |
|---|---|---|
| 运行环境 | PHP 7.1+ / MySQL 5.5+ | Cloudflare Workers |
| 数据库 | MySQL | D1 (SQLite 兼容) |
| 存储 | 本地 / OSS / COS / OBS / Upyun / Qiniu | R2 + S3 兼容 |
| 鉴权算法 | authcode (RC4) | AES-GCM |
| 前端框架 | jQuery + Bootstrap 3 | 保留原 jQuery + Bootstrap 3 |
| 页面渲染 | PHP 模板 | Worker SSR 模板直出 |
| 鉴黄 | 阿里云 Green / 腾讯云 IMS | Cloudflare AI |
| 部署 | 上传 PHP 主机 | GitHub Actions 一键部署 |

---

## 许可证

Apache-2.0 License

---

## 相关链接

- 原 PHP 版：https://pan.cccyun.cc/
- 作者博客：https://blog.cccyun.cn/
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Cloudflare D1 文档：https://developers.cloudflare.com/d1/
- Cloudflare R2 文档：https://developers.cloudflare.com/r2/
