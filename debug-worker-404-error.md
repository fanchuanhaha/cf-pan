# Debug Session: worker-404-error

## Status: [OPEN]

## Symptom
- ✅ Worker 部署成功
- ✅ D1 数据库初始化成功（10 queries, 94 rows written）
- ✅ R2 检查通过（已注释）
- ✅ 23 个静态资源上传成功
- ❌ 访问 `pan-worker.3098393078.workers.dev` 返回 **404**

## Hypotheses (待验证)
1. **H1**: Worker 入口没有默认路由，所有路由都返回 404（最可能 - SPA 模式下 `run_worker_first` 配置可能没生效） ❌ 否定 - `/health` 返回 200
2. **H2**: index.ts 默认 export 不正确，Wrangler 没找到 Worker 入口 ❌ 否定 - Worker 能响应
3. **H3**: `assets` 配置 + Hono 路由冲突，Hono 没拦截到请求 ✅ **已确认！** 是 navigation requests 的处理问题
4. **H4**: wrangler.spa.toml 里的 `main` 字段指向错误的文件 ❌ 否定
5. **H5**: Worker 名称 `pan-worker` 和 wrangler 部署配置对不上 ❌ 否定

## Evidence
- 部署日志显示 23 个静态资源上传成功（assets 配置生效）
- 没有看到 `[ERROR]` 标记
- 但访问返回 404

## 进一步调查
- `Invoke-WebRequest /health` → **200**（Worker 在运行）
- `Invoke-WebRequest /` → **404**（Hono 没拦截到）

## Root Cause
从 Cloudflare 官方文档（2025-04-01 之后默认行为）:
> **"navigation requests will not invoke the Worker script"**
> 浏览器带 `Sec-Fetch-Mode: navigate` header 的导航请求**不会**调用 Worker
> 导航请求会被 static assets 处理，找不到资源则返回 404

也就是 `compatibility_date >= 2025-04-01` 时：
- 直接访问 `/`（带 navigate header）→ assets 优先，找不到 → 404
- 我们的 `run_worker_first = ["/", ...]` 对 navigation requests 失效！
- 只有 fetch("/api/xxx") 这种非导航请求才会走 Worker

## Fix Applied
1. ✅ 添加 compatibility flag `assets_navigation_has_no_effect`
2. ✅ `not_found_handling`: `"404-page"` → `"single-page-application"`
3. ✅ `wrangler deploy --dry-run` 验证通过

## Verification
- 本地 `wrangler deploy --dry-run` 成功
- 所有 bindings 正常

## Next Steps
- 等用户在 GitHub Actions 重新部署
- 重新访问 `https://pan-worker.3098393078.workers.dev/` 应该能跳到 `/install/`
