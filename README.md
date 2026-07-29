# 彩虹外链网盘 - Cloudflare Workers 版

基于 [netcccyun/pan](https://github.com/netcccyun/pan) (PHP 版) 重写为 Cloudflare Workers 一体部署版本，使用 D1 数据库 + R2 对象存储，零服务器，全球 300+ 节点就近响应。

---

## GitHub Actions 一键部署（推荐）

### 第一步：Fork 本仓库

点击页面右上角 **Fork** 按钮，将仓库复制到你的 GitHub 账号下。

### 第二步：获取 Cloudflare 凭证

**1. 获取 Account ID**

登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，在首页右侧可以看到 **Account ID**，复制它。

**2. 创建 API Token**

打开 [https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)，点击 **Create Token**：

- 选择模板 **Edit Cloudflare Workers**
- 在 **Permissions** 中确认包含：
  - `Account` → `Workers` → `Edit`
  - `Account` → `D1` → `Edit`
  - `Account` → `R2` → `Edit`（如需使用 R2 存储）
- **Account Resources** 选择你的账号
- 点击 **Continue to summary** → **Create Token**
- 复制生成的 Token

### 第三步：配置 GitHub Secrets

进入你 Fork 的仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Secret 名称 | 值 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 上一步复制的 Token | Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 第一步复制的 Account ID | Cloudflare 账户 ID |

### 第四步：触发部署

进入仓库 **Actions** 页面，点击 **Deploy to Cloudflare Workers**，点击 **Run workflow**：

- 选择 `main` 分支
- 点击绿色的 **Run workflow** 按钮

等待 2-3 分钟，部署完成后会在 Actions 日志中显示你的 Workers 访问地址。

### 部署完成后

访问 `https://你的域名/install/` 进入安装向导，完成：
1. 设置管理员账号和密码
2. 选择存储后端（R2 / S3 / GitHub API）
3. 完成初始配置

---

## 安装向导

部署成功后首次访问会自动跳转到安装页面：

1. **设置管理员账号** — 设置后台登录用户名和密码
2. **选择存储类型** — 根据需要选择：
   - **R2**（推荐）— Cloudflare 原生对象存储，零流量费
   - **S3 兼容** — 支持阿里云 OSS / 腾讯云 COS / MinIO 等
   - **GitHub API** — 免费但有大小限制，适合测试
3. **配置存储参数** — 填写对应的 AccessKey、Bucket 等信息

---

## 后台管理

- 后台地址：`https://你的域名/admin`
- 默认账号：`admin`
- 默认密码：`123456`

登录后请立即修改密码。

---

## 本地开发

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（`npm install` 后自动安装）

### 启动开发服务器

```bash
npm install
npx wrangler dev --config wrangler.spa.toml --local --port 8787
```

访问 `http://localhost:8787`，首次需要通过安装向导。

### 本地数据库操作

```bash
# 查看所有表
npx wrangler d1 execute pan-db --local --config wrangler.spa.toml --command "SELECT name FROM sqlite_master WHERE type='table';"

# 清空数据库重新安装
npx wrangler d1 execute pan-db --local --config wrangler.spa.toml --command "DELETE FROM pre_config; DELETE FROM pre_file; DELETE FROM pre_user; DELETE FROM install_session;"
```

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

---

## API 接口

### 上传

```
POST /api.php
Content-Type: multipart/form-data

file: 文件内容
format: json（可选，支持 json / jsonp / form）
```

### 返回示例

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

## 与原 PHP 版本对比

| 项目 | PHP 版 | Workers 版 |
|---|---|---|
| 运行环境 | PHP 7.1+ / MySQL 5.5+ | Cloudflare Workers |
| 数据库 | MySQL | D1 (SQLite 兼容) |
| 存储 | 本地 / OSS / COS / OBS / Upyun / Qiniu | R2 + S3 兼容 + 七牛 / 又拍 / GitHub / WebDAV |
| 鉴权 | authcode (RC4) | AES-GCM |
| 前端 | jQuery + Bootstrap 3 | 保留原版前端风格 |
| 页面渲染 | PHP 模板 | Worker SSR 模板直出 |
| 部署 | 上传 PHP 主机 | GitHub Actions 一键部署 |
| 扩展名图标 | Font Awesome 4 | 与原版完全一致 |

---

## 相关链接

- **原 PHP 版仓库**：https://github.com/netcccyun/pan
- **原 PHP 版在线演示**：https://pan.cccyun.cc/
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Cloudflare D1 文档：https://developers.cloudflare.com/d1/
- Cloudflare R2 文档：https://developers.cloudflare.com/r2/

---

## 许可证

Apache-2.0 License
