# AGENTS.md

给 AI 代理的项目说明。人类读者请先看 `README.md`。

## 项目概览

tgdrive：基于 Telegram Bot + 私有频道的加密分片对象存储。Python 3.12 后端（无 Web 框架，自写 ASGI 适配器）+ React 18/TypeScript 前端（两个独立站点：用户端、管理端）。界面文案为简体中文。

## 目录

- `src/tgdrive/`：后端（src 布局，导入名仍为 `tgdrive`；改动后需 `pip install -e .` 重新安装）。`metadata.py`（SQLite 迁移，当前 schema v7）、`objects.py`（对象/公开链接）、`api.py`（网页会话服务层，按角色校验 Cookie 会话与 CSRF）、`keyapi.py`（`/api/v1` 访问密钥 API）、`asgi.py`（HTTP 路由与流式响应）、`app.py`（应用工厂与 CLI）、`s3/`、`telegram/`。
- `web/src/`：前端源码。
  - `ui.tsx`：设计系统基元（按钮、表单、弹窗、菜单、toast、格式化）。新界面必须复用这里的组件。
  - `shell.tsx`：应用外壳、登录页、首次初始化页。
  - `files.tsx`：文件类型、预览、分享对话框。
  - `user.tsx`（入口 `UserApp`，含移动对话框与拖放移动）、`admin.tsx`（入口 `AdminRoute`，含系统设置）、`share.tsx`。
  - 文档站位于 `web/src/docs/`：`docs.tsx`（外壳、`/docs/<页面>` 路由、目录、⌘K 搜索）、`docs-ui.tsx`（排版组件）、`docs-content.tsx`（用户文档内容；示例地址取自 `/api/public/v1/config`）、`docs-admin-content.tsx`（管理员文档内容）。`admin-docs.tsx` 是管理员文档独立入口。修改接口、限制或 S3 兼容性时必须同步更新对应内容文件。
  - `styles.css`：全部样式与设计令牌；只引用 CSS 变量，深色模式只覆盖令牌。
- `tests/`：`unittest` 测试；`test_m8.py` 公开链接、配额与改密，`test_m9.py` 移动语义，`test_m10.py` 对外地址设置，`test_m11.py` S3 CopyObject、UploadPartCopy、DeleteObjects 与列表语义，`test_m12.py` 访问密钥 HTTP API，`test_m13.py` S3 请求体流式校验与配额预检，`test_m14.py` SQL 分页与按前缀删除，`test_m15.py` Telegram 缓存、退避与健康检查，`test_m16.py` 审计日志与会话上限。
- `docs/architecture-v2.md`：架构设计记录。
- `Dockerfile` / `docker-compose.yml`：多阶段镜像，用户端在根路径，管理端在 `/admin/`。`.github/workflows/docker.yml` 仅在推送 `v*` 标签时构建并发布镜像，不要添加其他触发条件。
- `DESIGN.md`：视觉规范；`UX-CONTRACT.md`：交互与路由契约。改动 UI 时同步更新。

## 常用命令

```bash
.venv-net/bin/python -m unittest discover -s tests            # 后端测试
cd web && node node_modules/typescript/bin/tsc -p tsconfig.app.json   # 前端类型检查（strict）
cd web && node build-apps.mjs user && node build-apps.mjs admin && node build-apps.mjs admin-docs   # 构建 apps/user/dist 与 apps/admin/dist（含 admin-docs.js）
.venv-net/bin/tgdrive --data-dir .local-data --port 8000 --insecure-cookies
node web/serve-app.mjs user    # :8001，代理 /api/user/、/api/v1/、/api/public/、/p/
node web/serve-app.mjs admin   # :8002，代理 /api/admin/
```

验证 UI 时请使用独立数据目录（如 `/tmp/tgdrive-verify`）和其他端口，不要动用户的 `.local-data`（会触发 schema 迁移）。`.claude/launch.json` 已提供 8100–8102 的验证配置。

## 约定

- `build-apps.mjs` 是自写打包器：只支持相对导入和 `react` / `react/jsx-runtime`，不要引入其他 npm 运行时依赖。前端没有 vite 开发服务器，调试用 `serve-app.mjs`。
- 管理员文档内容只能进入 `admin-docs.js`，不得被 `user` / `admin` 登录 bundle 导入；它仅通过 `/api/admin/v1/docs-bundle.js`（需 admin 会话）下发，静态路由对 `*/admin-docs.js` 返回 404。
- 不加载外部字体或 CDN 资源。
- 公开链接令牌存放在 `objects.public_token`：覆盖写入在 `_commit_blob` 中继承，移动随行保留；禁用账号或锁定系统时 `/p/` 不可访问。新增改写对象行的代码路径时需要保持这一语义。
- 认证边界：`/api/user/v1`、`/api/admin/v1` 只供网页使用（HttpOnly Cookie + `X-CSRF-Token`）；`/api/v1` 与 S3 只接受访问密钥（`Authorization: Bearer AK:SECRET` / Basic、SigV4），不读取 Cookie。两者授权都走 `ClientAuthStore`（存储桶 + 前缀 + ro/rw），所属用户被禁用时密钥失效。新增程序可调用的能力应加在 `/api/v1`，不要让脚本依赖网页接口。
- 业务校验失败返回 `ValueError`（400），不要用 `AuthenticationError`（401 会让前端登出）。
- 新的数据库字段通过在 `Metadata._migrate` 中追加版本块添加，并提升 `SCHEMA_VERSION`。
- 对外地址（公开访问地址、S3 Endpoint）由 `tgdrive/settings.py` 的 `SystemSettings` 管理，存 `settings` 表，优先级：控制台设置 > 启动参数 > 前端推断。S3 路由主机名每个请求从它读取（带缓存）。前端统一通过 `api.userSiteOrigin()` / `api.s3Endpoint()` / `api.publicLinks()` 取地址，不要在组件里自行拼接 `window.location`。
- 单进程部署：会话、登录失败计数、Telegram 客户端池都在进程内存中，不要使用多个 uvicorn worker 或多实例共享数据目录。
- 大数据量：请求体与对象内容一律以流处理，不要在内存中拼接完整对象。`BlobEngine.put_part` 用片段列表攒分片，不要改回 `bytearray` + `del buf[:n]`（会让常驻内存随上传量增长到 GB 级）。列表、搜索、管理端文件列表都用 SQL 键集分页，不要先取全量再在 Python 里过滤。
- S3 请求体校验在 `tgdrive/s3/payload.py`：签名只覆盖声明的负载哈希，实际内容在读取时校验；新增读取请求体的 S3 操作必须走 `S3Gateway._body`。
- 审计日志（`tgdrive/audit.py`，路由表在 `TgDriveASGI._AUDITED`）只写入逐项挑选的字段，新增审计动作时不得记录密码、口令、token 或 Secret。
- 文件移动使用 `ObjectService.move`：不以 `/` 结尾的源精确匹配单个文件，以 `/` 结尾的源移动整个文件夹；禁止移入自身子文件夹；同名目录标记合并。
