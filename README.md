内容由ai生成，请注意辨别

# 彩虹外链网盘 (Cloudflare Workers 版)

源项目地址https://github.com/netcccyun/pan
界面上相较于原站点只是适配了深色模式，其他都保持了不变

# 安装

> 如果你是想从原 PHP 站点恢复数据，请先看 [从原站点恢复](#从原站点恢复)。

## 快速开始

这里不展示本地运行的方法


GitHub Actions 自动部署（推荐）

1. Fork 本仓库
2. 在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|---|---|
| [CLOUDFLARE_API_TOKEN](https://dash.cloudflare.com/profile/api-tokens) | Cloudflare API Token（需要 Workers / D1 / R2 Edit 权限，一个令牌覆盖全部）|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |

3. Push 代码到 `main` 分支，运行GitHub Actions 自动完成：
   - 创建 D1 数据库
   - 初始化表结构
   - 创建 R2 存储桶
   - 部署 Worker

### 部署完成后

- 如果你**没有**部署过 PHP 版本，或不想从原站点恢复：
  访问 `https://你的域名/install/`，选择"全新安装"，依次：
  1. 设置管理员账号和密码
  2. 选择存储后端（R2 / S3 / 七牛 / 又拍 / GitHub / WebDAV）并测试连接
  3. 完成初始配置

---

## 从原站点恢复

本系统支持从原 PHP 版（彩虹外链网盘 PHP 版）站点一键恢复全部数据和文件，**无需重新上传文件**。

### 方式一：远程 PHP 代理直传（推荐）

在原 PHP 站点放一个代理文件，Worker 通过加密通信调用它，PHP 直接从原站服务器读取文件并直传目标存储（如七牛云），速度更快、不受 Worker 超时限制。

#### 1. 部署原站代理文件

1. 把 `remote_restore.php` 上传到原 PHP 站点根目录（与 `index.php` 同目录）
2. 打开文件，修改开头的 `REMOTE_RESTORE_SECRET`，改成一段随机字符串
3. 在 `wrangler.spa.toml` 的 `[vars]` 中把 `REMOTE_RESTORE_SECRET` 设置成**完全相同**的值

> 通信使用 AES-256-GCM 加密 + HMAC-SHA256 签名，密钥不一致会导致请求被拒绝。

#### 2. 在安装向导中恢复

1. 访问 `https://你的域名/install/`，选择 **从备份恢复**
2. 填写 **原站点地址**（如 `https://原站点.example.com`）、原站管理员账号和密码
   - 系统会自动调用原站根目录的 `remote_restore.php`
   - 系统会通过原站 PHP 自动导出数据库（也可手动上传 `.sql` 文件覆盖远程导出）
3. 勾选要从 SQL 导入的 `pre_config` 配置项（`storage` 永远不导入，必须重新选择）
4. 选择新的存储后端（如七牛云）并**测试连接**
5. 点击 **应用配置并完成**，然后点击 **开始恢复并上传**
   - Worker 逐文件调用原站 PHP，PHP 从原站本地路径读取文件，分片（4MB/块、8 路并发）直传目标存储
   - 页面实时显示每文件的进度百分比

#### 3. 大文件说明

- PHP 代理已设置 `set_time_limit(0)`、`memory_limit=2048M`，并放宽 Qiniu SDK 请求超时（连接 60s / 总 600s）
- 文件读取失败会自动顺延查找 `filepath` 配置、`/file`、`/incloud` 等目录
- 原 PHP 站点所在服务器如对响应有超时限制（如 nginx `proxy_read_timeout`），请调大（建议 ≥ 600s），或使用八路并行分片以尽快完成

## 安装向导

部署成功后首次访问会自动跳转到安装页面：

1. **设置管理员账号** — 设置后台登录用户名和密码
2. **选择存储类型** — 根据需要选择：
   - **R2**（推荐）— Cloudflare 原生对象存储，零流量费
   - **S3 兼容** — 支持阿里云 OSS / 腾讯云 COS / 华为云 OBS / MinIO 等
   - **七牛云** — Qiniu Kodo
   - **又拍云** / **WebDAV** / **GitHub API**（免费但有大小限制，适合测试）
3. **配置存储参数** — 填写对应的 AccessKey、Bucket 等信息并测试连接

---



## 支持的存储后端

| 存储类型 | 说明 |
|---|---|
| **R2** | Cloudflare 原生对象存储，零流量费 |
| **S3 兼容** | 阿里云 OSS / 腾讯云 COS / AWS S3 / MinIO / 京东云 等 |
| **七牛云** | Qiniu Kodo |
| **又拍云** | Upyun USS |
| **GitHub API** | 使用 GitHub 仓库存储，免费但有大小限制 |
| **WebDAV** | 支持坚果云等 WebDAV 服务 |

### 原站点云存储对接

原 PHP 版支持的云存储，在 Workers 版中的接入方式：

| 原站点存储 | Workers 版接入方式 | 说明 |
|---|---|---|
| 腾讯云 COS | **S3 兼容** | 填写 COS 的 Endpoint（如 `https://cos.ap-guangzhou.myqcloud.com`）、Region、Bucket、SecretId/SecretKey |
| 阿里云 OSS | **S3 兼容** | 填写 OSS 的 Endpoint（如 `https://oss-cn-hangzhou.aliyuncs.com`）、Region、Bucket、AccessKey/SecretKey |
| 华为云 OBS | **S3 兼容** | 填写 OBS 的 Endpoint、Region、Bucket、AK/SK |
| 七牛云 | **七牛云** | 直接选择七牛云，填写 AK / SK / Bucket |
| 又拍云 | **又拍云** | 直接选择又拍云，填写 Operator / 密码 / Bucket |

---

## 目录结构

```
├─ wrangler.spa.toml          # Worker 部署配置
├─ package.json
├─ tsconfig.json
├─ schema.sql                 # D1 建表 SQL
├─ remote_restore.php         # 原站 PHP 恢复代理（部署到原 PHP 站点根目录）
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
   │  ├─ remoteRestore.ts     # 远程恢复加密客户端（export / upload-stream）
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

## API 接口

### 上传 API

```
POST /api.php
Content-Type: multipart/form-data

file: 文件内容
format: json（可选，支持 json / jsonp / form）
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
| 存储 | 本地 / OSS / COS / OBS / Upyun / Qiniu | R2 + S3 兼容 + 七牛 / 又拍 / GitHub / WebDAV |
| 鉴权算法 | authcode (RC4) | AES-GCM |
| 前端框架 | jQuery + Bootstrap 3 | 保留原 jQuery + Bootstrap 3 |
| 页面渲染 | PHP 模板 | Worker SSR 模板直出 |
| 鉴黄 | 阿里云 Green / 腾讯云 IMS | Cloudflare AI |
| 部署 | 上传 PHP 主机 | GitHub Actions 一键部署 |
| 数据迁移 | - | 原站 PHP 代理自动导出 + 文件直传 |

---

## 许可证

MIT License

---

## 相关链接

- 原 PHP 版：https://github.com/netcccyun/pan
- 原 PHP 版在线演示：https://pan.cccyun.cc/
- 作者博客：https://blog.cccyun.cn/
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Cloudflare D1 文档：https://developers.cloudflare.com/d1/
- Cloudflare R2 文档：https://developers.cloudflare.com/r2/

