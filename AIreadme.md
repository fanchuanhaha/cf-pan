# 彩虹外链网盘 (Rainbow External Link Cloud Drive) - Cloudflare Workers Edition

## 项目概述
基于 Cloudflare Workers 的外链网盘系统，原 PHP 版本的重写版。
使用 D1 数据库、R2/S3/GitHub/WebDAV/又拍云/七牛云 存储后端。

## 技术栈
- **框架**: Hono (轻量 Web 框架)
- **运行时**: Cloudflare Workers
- **数据库**: D1 (SQLite 兼容)
- **存储**: R2 / S3 / GitHub API / WebDAV / 又拍云 / 七牛云
- **构建**: TypeScript + esbuild (通过 Wrangler)
- **部署**: Wrangler CLI / GitHub Actions

## 目录结构
```
src/
├── index.ts              # 入口文件 (Hono app)
├── config.ts             # 配置管理 (D1 key-value)
├── middleware.ts         # 中间件 (注入 db/stor/config)
├── auth/
│   ├── admin.ts          # 管理员 AES-GCM 认证
│   └── user.ts           # 用户 AES-GCM 认证
├── db/
│   └── index.ts          # D1 数据库查询层
├── routes/
│   ├── install.ts        # 安装/恢复向导 (多步骤 SPA)
│   ├── frontend.ts       # 页面渲染 (首页/文件查看/管理后台)
│   ├── ajax.ts           # 前端 AJAX 上传端点
│   ├── api.ts            # 第三方上传 API
│   ├── download.ts       # 下载代理 (Range 支持)
│   ├── view.ts           # 预览代理
│   ├── admin.ts          # 管理后台 AJAX 端点
│   └── admin-api.ts      # 管理后台 API (存储迁移)
├── services/
│   ├── upload.ts         # 上传业务逻辑
│   ├── green.ts          # NSFW 检测 (Cloudflare AI)
│   ├── migrate.ts        # 存储间迁移
│   ├── restore.ts        # 从 PHP 备份恢复数据
│   ├── restoreSession.ts # 安装恢复会话管理
│   └── restorePreExtract.ts # SQL 预提取
├── storage/
│   ├── IStorage.ts       # 存储接口
│   ├── R2Storage.ts      # R2 实现
│   ├── S3Storage.ts      # S3 兼容实现
│   ├── GitHubApiStorage.ts # GitHub API 存储
│   ├── WebDavStorage.ts  # WebDAV 存储
│   ├── UpYunStorage.ts   # 又拍云存储
│   ├── QiniuStorage.ts   # 七牛云存储
│   └── factory.ts        # 存储工厂
└── utils/
    ├── crypto.ts         # AES-GCM 加密
    ├── mime.ts           # MIME 类型检测
    └── response.ts       # HTTP 响应辅助
```

## 安装向导 (install.ts)
`src/routes/install.ts` 是多步骤 SPA 安装向导，包含：
- **Step 0**: 选择安装方式 (全新安装 / 从备份恢复)
- **Step 1F**: 全新安装表单 (管理员账号 + 存储)
- **Step 1R**: 上传 SQL (从原 PHP 备份恢复)
- **Step 2R**: 勾选配置 + 选存储
- **Step 3R**: 输入原站点地址 + 文件下载进度
- **Step 4**: 完成

### Bug: 点击"从备份恢复"无响应
**症状**: 点击"从备份恢复"卡片按钮无反应，浏览器控制台报错：
```
Uncaught SyntaxError: '' string literal contains an unescaped line break install:508:87
Uncaught ReferenceError: goRestore is not defined
```

**调查结果**:
1. `goRestore` 函数定义在 `install.ts:357`，存在于内联脚本中
2. 提取出的内联 JavaScript 语法验证通过 (new Function 无报错)
3. esbuild 编译输出语法正确
4. 渲染后的 HTML 页面中，line 508 是 `function goRestore() {` (23 字符)，column 87 超出行长度
5. 当前代码中找不到明显的字符串字面量换行问题

**已应用的修复**:
- 将 `wizardPage` 函数第 105 行的嵌套模板字面量 `${errorMsg ? \`<div>...${errorMsg}</div>\` : ''}` 改为普通字符串拼接 `'<div>...' + errorMsg + '</div>'`，避免 TypeScript/esbuild 编译嵌套模板字面量时的潜在问题

**推测原因**:
- 可能为旧版代码缓存导致，当前代码已修正
- 或与嵌套模板字面量有关 (`wizardPage` 函数内部第 105 行的 `${errorMsg ? \`...\` : ''}`)
- 或为 `wrangler dev` 服务器特定问题

**进一步建议**:
- 将内联 JavaScript 迁移到独立文件 (public/assets/js/)
- 添加 `defer` 或 `DOMContentLoaded` 事件确保脚本加载
- 注意 `renderStorageForms` 函数中 HTML onclick 属性的单引号嵌套

## Bug: 安装第三步「测试读写」成功后按钮仍显示「测试读写」
**症状**: F12 可见 `/install/test` 返回成功，但按钮不切到「测试成功」，仍显示「测试读写」。

**根因**: 前端 `testStorage` 判断 `json.code === 0 && json.data.ok`，后端却返回扁平结构 `{ ok, message }`（无 `code`/`data`），成功被当成失败分支，按钮被重置为「测试读写」。

**修复**: `POST /install/test` 统一为 `{ code, msg, data: { ok, message } }`，与前端约定一致。

## 最近修改
- `src/routes/install.ts` - `/install/test` 响应格式对齐前端 `json.code`/`json.data.ok`
- `AIreadme.md` - 记录「测试读写」按钮状态 bug

## Bug: 点击「确定使用」无反应
**根因**: `renderStorageForms` 为每个存储 tab 生成相同的 `confirmedBadge` 和 `testResult` ID。切换到非 R2 tab 后，`getElementById` 总是命中第一个表单中的元素，导致确认状态更新到了隐藏表单。

**修复**: `confirmStorage` 和 `testStorage` 改为在当前激活的 `.storage-form` 内查找提示、角标和按钮。

## Bug: 第四步启动下载时报 R2 未配置
**原因**: 「确定使用」之前只更新了前端状态和恢复会话，存储配置没有立即写入 D1；同时使用 R2 时，部署配置中的 `FILE_R2` 绑定必须真实存在，不能只在数据库中选择 `r2`。

**修复**: 点击「确定使用」时调用 `/install/api/storage-set`，先将存储类型和字段写入 D1，再允许进入下一步。若使用 R2，仍需在 `wrangler.spa.toml` 或 Cloudflare Dashboard 配置 `FILE_R2` 绑定。

## Bug: 恢复文件时直接显示下载完成
**原因**: 文件任务只查询 D1 中的 `pre_file`。当 SQL 回写尚未成功或当前 Worker 实例读取不到记录时，文件列表为空，原逻辑把 `0/0` 当成成功完成；同时任务只记录下载进度，没有区分上传阶段。

**修复**:
- 优先从 D1 读取 `pre_file`，为空时从当前恢复会话中的 SQL 直接解析 `pre_file` 记录。
- 使用记录中的 `hash` 拼接原站点 URL，例如 `/file/c46ba69394e7937c60538208bb887a9d`。
- 下载成功后再上传到目标存储，上传成功后总文件进度才增加。
- 增加总文件数、已完成文件数、总大小、已处理大小、当前文件下载/上传阶段和速度显示。
- `pre_file` 为空时任务明确失败，不再显示“下载完成”。

## Bug: 恢复下载显示“未知错误”并瞬间满进度
**原因**: 任务结束时原逻辑把 `processed` 直接设置为文件总数，即使下载或上传失败也会让总进度条变满；前端失败提示只读取 `errors[0]`，当服务端异常没有生成错误文本时就显示“未知错误”。

**修复**:
- `processed` 改为实际成功上传的文件数量，失败文件不会计入完成进度。
- 下载 HTTP 错误、下载异常、上传异常都会生成具体错误，并包含文件名、hash 或 URL。
- 服务端任务增加最多 100 条日志，浏览器 F12 控制台每秒输出任务状态、当前文件、下载/上传阶段、字节数、错误和服务端日志。
- 任务失败时不再被异步路由覆盖为 `completed`。

## Bug: 恢复任务显示未知错误，F12 无法定位
**修复**:
- 启动接口和状态接口现在记录原始 HTTP 状态及响应正文，非 JSON 响应也会显示具体内容。
- 状态查询失败会显示 taskId、HTTP 状态和服务端消息，不再笼统显示“未知错误”。
- 服务端每个恢复任务记录最近 100 条文件下载、HTTP 响应和目标存储上传日志，前端轮询时同步输出到 F12 控制台。
- 无响应体进度流在读取完成后也会补写当前文件字节数，避免进度信息突然跳变。

## 恢复日志定位：源站返回 HTTP 404
如果 F12 或 Wrangler 日志出现：
```text
源站文件不存在 HTTP 404，hash=...，URL=https://.../file/...
```
说明恢复流程已正确读取 `pre_file` 并发起请求，但原站点对应 hash 文件不存在或源站 URL 不正确。需要确认输入的原站点地址能直接访问 `原站点/file/{hash}`，例如：
```text
https://d.802213.xyz/file/c46ba69394e7937c60538208bb887a9d
```
如果该地址本身返回 404，代码无法从该源站恢复文件；需要改用原 PHP 文件实际所在的域名或目录。

## 恢复文件跳过与上传显示
- 源站返回 HTTP 404 的文件自动计入“跳过”，不会阻止其他文件继续恢复。
- 页面显示跳过数量和文件明细，完成摘要显示上传成功、跳过和失败数量。
- 当前文件进入目标存储上传阶段时，状态区域显示“正在上传到目标存储”。
- 首页文件列表的“下载，查看”分隔符改为 `下载 | 查看`。

## 安装完成页按钮与文件处理顺序
- 恢复文件下载完成后进入“安装完成”页，显示上传成功、跳过和失败统计。
- 完成页提供“返回主页”和“进入管理后台”两个按钮。
- 文件恢复使用串行处理：当前文件从原站点下载完成后，先上传到目标存储，上传完成后才开始下一个文件。

## 恢复任务失败文件进度显示
- 已处理文件数包含成功、跳过和失败文件，因此所有文件处理结束后总进度显示 100%。
- 失败文件会显示在“下载失败”下方，并使用红色文字列出文件名和具体错误。
- 修复服务端只写入 `result.errors`、没有同步到轮询任务 `task.errors` 的问题，前端现在可以收到失败文件明细。

## 七牛大文件分片上传
- 七牛恢复文件不再把整个响应读取成 `ArrayBuffer` 或完整 `Blob`。
- 文件按 4 MiB 分片调用七牛 `mkblk`、`bput`，最后调用 `mkfile` 合并。
- 七牛最终保存的仍是一个完整的 `file/{hash}` 对象，不会留下用户可见的分片文件。
- 七牛分片上传时会边读取原站点响应边上传分片，单次请求不会超过 Worker 的 128 MiB Blob 限制。
- 七牛 v1 协议中每个不超过 4 MiB 的块独立调用 `mkblk`，所有块按顺序通过 `mkfile` 合并；不能把下一个文件块直接当作同一块调用 `bput`。

## 安装页按钮状态与恢复传输说明
- “测试读写”只修改按钮自身文字和颜色，不再在按钮下方显示重复的“测试中/测试完成”提示。
- “应用配置并完成”只修改底部按钮文字，应用过程中显示“应用中...”，失败显示“应用失败”。
- 七牛恢复使用流式传输，当前文件从原站点读取数据的同时分片上传到七牛，不是先完整缓存后再上传。

## Bug: 文件已上传但首页没有文件
- 对象存储文件和 D1 的 `pre_file` 元数据是独立数据；之前 SQL 回写失败时，只完成了对象上传，首页查询 D1 仍为空。
- `/install/api/config-apply` 现在检查 `pre_file`，如果 SQL 回写后数量为 0，会从恢复 SQL 解析记录并参数化写入 D1，确保首页文件列表与对象存储对应。
- 分片文件仍显示当前文件总进度条；仅不再区分下载蓝色和上传绿色，旁边显示“文件过大，尝试分片上传”。

## Bug: 文件详情页显示 `{sizeFormat(row.size)}`
**原因**: 文件详情 HTML 使用了普通文本 `{sizeFormat(row.size)}`，没有使用 TypeScript 模板字符串插值。

**修复**: 改为 `${sizeFormat(row.size)}`，详情页现在显示实际文件大小。

## 安装页传统风格与 IE11 兼容
- 安装页改为传统后台风格：灰色页面背景、蓝色标题栏、直角边框、经典标签页和紧凑按钮，去除渐变、卡片阴影和页面动画。
- 内联安装脚本通过 Babel Standalone 转换为 ES5，避免 IE11 解析 `async/await`、箭头函数、模板字符串和可选链时报错。
- 引入 Promise、Fetch 和 core-js polyfill，补齐 IE11 缺少的常用 JavaScript API。
- 安装页改为全屏显示，取消居中窗口、外边距和窗口边框，内容区横向铺满浏览器。
- 安装页页面背景改为黑色，保留白色内容区域和传统后台布局。
- 安装页增加 `prefers-color-scheme` 自动深色模式，深色模式下内容区、表单、表格和提示框都会同步变暗，浅色模式保持传统白色界面。

## Bug: 安装页无法点击，goRestore 未定义
**原因**: 使用了不存在的 `babel-standalone@7.26.4` CDN 路径，CDN 返回 `404 text/plain`，浏览器因 `nosniff` 拒绝加载 Babel，后续 `text/babel` 内联脚本没有被转换和执行。

**修复**: 改用实际存在且返回 JavaScript MIME 类型的 `@babel/standalone@7.26.5`。

## Bug: 应用配置并完成被重复提交
**原因**: 第三步的“应用配置并完成”按钮在请求期间仍可点击，连续点击会并发执行多个 `/install/api/config-apply` 请求，重复写入配置和恢复 SQL，页面表现为一直没有响应。

**修复**: 增加 `state.applyInProgress` 请求锁，并在提交期间禁用按钮、显示“应用中...”；请求失败时恢复按钮，成功后切换步骤。

## Bug: 安装页脚本解析失败，goRestore 未定义
**原因**: 内联脚本中的 `join('\n')` 被外层 TypeScript 模板字符串解释成真实换行，浏览器报 `string literal contains an unescaped line break`，导致整个脚本停止解析，`goRestore` 等函数都没有定义。

**修复**: 改为在生成后的内联脚本中保留 JavaScript 转义字符串 `\\n`，避免模板渲染时产生真实换行。

## 最近修改
- `src/routes/install.ts` - `/install/test` 响应格式对齐前端
- `src/routes/install.ts:105` - 将嵌套模板字面量改为字符串拼接 (修复 "从备份恢复" 按钮无响应)
- `AIreadme.md` - 当前文件 (项目上下文记录)

## 诊断端点 (install api diag)
- `GET /install/api/diag?url=xxx` 用于测试 Worker 到源站的连通性。
- 返回 `{ ok, status, contentType, contentLength, elapsed, error }` 结构化诊断信息。
- Workers 上下载失败时先用此端点排查源站是否屏蔽 Cloudflare 出口 IP。
- 404 表示源站无此文件（hash 错误或文件已删除）；连接失败表示源站拒绝或屏蔽了 Worker 请求。
- 恢复源站地址支持两种模式：填写根地址时访问 `/file/{hash}`；填写以 `/down.php` 结尾的地址时访问 `/down.php/{hash}.{type}`。诊断 URL 必须使用与恢复任务相同的模式。

## Workers 下载源站文件排查
- 本地正常但 Workers 上下载为 0，通常是以下原因之一：
  1. **源站屏蔽 Cloudflare IP** — 源站防火墙拦截了 Workers 出口 IP 段。用 diag 端点验证。
  2. **响应体未透传** — 代码中对 `response.body` 做了 `await text()`/`arrayBuffer()` 再转发，超过 128MB 会 OOM。
  3. **fetch 异常被吞** — `fetch()` 抛出 `NetworkError` 时如果没有 try/catch，任务静默失败，前端只显示"未知错误"。
- `restore.ts` 已对 `fetch(downloadUrl)` 加了独立 try/catch，网络错误会记录到任务日志并显示在前端。
- 恢复文件上传改为响应流直接传给目标存储，七牛云使用分片流式上传；不再先把 100 MiB 文件合并成多个 ArrayBuffer。

## 移动端搜索穿模修复
- 首页搜索框 `searchbox` span 的 `style="float:right"` 内联样式会覆盖 CSS media query `@media (min-width:767px){.searchbox{float:right}}`，导致移动端搜索框强制右浮动与标题重叠。
- 已移除内联样式，由 CSS 媒体查询控制：桌面端右浮动，移动端正常流式布局。

## Footer 样式修复
- 暗色模式下 `.footer` 原有独立背景色 `#1e1e1e` 和边框，与页面背景不一致显得突兀。
- 改为 `background-color: transparent` 和 `border-top: none`，footer 融入页面背景。

## Observability 配置
- `wrangler.spa.toml` 添加了 `[observability.logs]` 配置节，启用 `invocation_logs` 便于在 Cloudflare Dashboard 查看请求级日志。

## 开发命令
- `npm run dev`: 本地开发 (wrangler dev)
- `npm run deploy`: 部署到 Cloudflare Workers

## 配置文件
- `wrangler.spa.toml`: Wrangler 部署配置
- `tsconfig.json`: TypeScript 配置
- `schema.sql`: D1 数据库 schema

## GitHub Actions 部署
- `.github/workflows/deploy.yml` 使用 `cloudflare/wrangler-action` 自动部署到 Workers。
- 工作流步骤名称已翻译为中文（拉取代码、安装Node.js、安装依赖、构建并部署等）。
- 注意：GitHub Token 需要 `workflow` 权限才能推送 workflow 文件变更。
