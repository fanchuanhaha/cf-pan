# Debug Session: wrangler-node-version-error

## Status: [OPEN]

## Symptom
GitHub Actions 工作流报错:
```
Wrangler requires at least Node.js v22.0.0. You are using v20.20.2.
```

具体出现在 `npx wrangler telemetry disable` 步骤。
工作流当前配置 `node-version: "20"`，但 wrangler 4.86+ 要求 Node 22+。

## Hypotheses (待验证)
1. **H1**: actions/setup-node 的 `node-version: "20"` 装的是 20.20.2，不满足 wrangler 22+ 的硬性要求 ✅ 已确认
2. **H2**: CloudPaste 项目可能升级到了 Node 22+ 或用 wrangler 的低版本
3. **H3**: 可以通过把 `node-version` 改到 `"22"` 或固定低版本 wrangler（如 3.x）解决
4. **H4**: GitHub Actions 警告里提到 Node 24 已经是默认了，可以升级使用 22+

## Evidence
- 错误: `Wrangler requires at least Node.js v22.0.0. You are using v20.20.2`
- 错误步骤: `Disable wrangler telemetry`
- Exit code: 1
- CloudPaste 使用 `wrangler: ^4.50.0` + `node-version: "20"`，但他们有 package-lock.json 锁定了具体 wrangler 版本（4.50.x），没有升级到 4.86+

## Root Cause
1. `package.json` 中 `wrangler: "^4.50.0"` 允许安装任何 4.x.x 版本
2. 没有 `package-lock.json`，所以 `npm install` 会装最新版 wrangler 4.86+ / 4.105+
3. wrangler 4.86+ 强制要求 Node 22+，但 CI 装的是 20.20.2

## Fix Applied
1. ✅ `deploy.yml`: `node-version: "20"` → `"22"`
2. ✅ 生成 `package-lock.json` 锁定 wrangler 版本
3. ✅ `npm install` → `npm ci`（更严格，使用锁定版本）

## Verification
- 本地 Node 24 + wrangler 4.105 + npm ci 全部正常
- `wrangler deploy --dry-run` 成功，绑定正常

## Next Steps
等用户在 GitHub Actions 重新运行工作流，验证 CI 也能成功

