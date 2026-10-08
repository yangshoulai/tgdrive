# AGENTS.md

给 AI 代理的项目说明。产品对外名称是 **Tessera**（界面、文档、标题），`tgdrive` 只是仓库、Python 包、命令行、环境变量和镜像的技术名称，不要混用；改名只需改 `web/src/brand.ts` 与 `build-apps.mjs` 里的标题/图标。人类读者请先看 `README.md`。

## 项目概览

Tessera（仓库名 tgdrive）：基于 Telegram Bot + 私有频道的加密分片对象存储。Python 3.12 后端（无 Web 框架，自写 ASGI 适配器）+ React 18/TypeScript 前端（两个独立站点：用户端、管理端）。界面文案为简体中文。

## 目录

- `src/tgdrive/`：后端（src 布局，导入名仍为 `tgdrive`；改动后需 `pip install -e .` 重新安装）。`metadata.py`（SQLite 迁移，当前 schema v7）、`objects.py`（对象/公开链接）、`api.py`（网页会话服务层，按角色校验 Cookie 会话与 CSRF）、`keyapi.py`（`/api/v1` 访问密钥 API）、`asgi.py`（HTTP 路由与流式响应）、`app.py`（应用工厂与 CLI）、`s3/`、`telegram/`。
- `web/src/`：前端源码。
  - `ui.tsx`：设计系统基元（按钮、表单、弹窗、菜单、toast、格式化）。新界面必须复用这里的组件。
  - `shell.tsx`：应用外壳、登录页、首次初始化页。
  - `files.tsx`：文件类型、预览（文本解码与 512 KB 截断、Markdown 相对路径图片解析）、分享对话框。
  - `markdown.tsx`：自带 Markdown 渲染器，直接产出 React 元素，不执行原始 HTML，链接只放行 http(s)/mailto；`highlight.ts`：正则语法高亮（每种语言一组规则，合并成一个正则扫描，规则内不得有捕获分组或后行断言）；`code.tsx`：带行号的代码块与 Markdown 围栏。新增语言只需在 `highlight.ts` 的 `RULES` 与 `ALIASES` 各加一项。
  - `user.tsx`（入口 `UserApp`，含移动对话框与拖放移动）、`admin.tsx`（入口 `AdminRoute`，含系统设置）、`share.tsx`。
  - 文档站位于 `web/src/docs/`：`docs.tsx`（外壳、`/docs/<页面>` 路由、目录、⌘K 搜索）、`docs-ui.tsx`（排版组件）、`docs-content.tsx`（用户文档内容；示例地址取自 `/api/public/v1/config`）、`docs-admin-content.tsx`（管理员文档内容）。`admin-docs.tsx` 是管理员文档独立入口。修改接口、限制或 S3 兼容性时必须同步更新对应内容文件。
  - `styles.css`：全部样式与设计令牌；只引用 CSS 变量，深色模式只覆盖令牌。
- `tests/`：按功能命名的 `unittest` 回归测试，覆盖加密、认证、对象、S3、分页、Telegram、维护任务、公开链接、审计和管理员文档权限。
- `docs/architecture-v2.md`：架构设计记录。
- `Dockerfile` / `docker-compose.yml`：多阶段镜像，用户端在根路径，管理端在 `/admin/`。`.github/workflows/docker.yml` 仅在推送 `v*` 标签时构建并发布镜像，不要添加其他触发条件。
- `DESIGN.md`：视觉规范；`UX-CONTRACT.md`：交互与路由契约。改动 UI 时同步更新。

## 常用命令

```bash
.venv-net/bin/python -m unittest discover -s tests            # 后端测试
cd web && node node_modules/typescript/bin/tsc -p tsconfig.app.json   # 前端类型检查（strict）
cd web && node build-apps.mjs                                  # 构建到 web/dist（应用 bundle 与 admin-docs.js）
.venv-net/bin/tgdrive --data-dir .local-data --port 8000 --static-dir web/dist --insecure-cookies   # 单进程单端口，同一个应用
```

验证 UI 时请使用独立数据目录（如 `/tmp/tgdrive-verify-data`）和其他端口，不要动用户的 `.local-data`（会触发 schema 迁移）。`.claude/launch.json` 的 `verify` 配置在 8100 端口同时提供用户端和控制台。

## 约定

- `build-apps.mjs` 是自写打包器：只支持相对导入和 `react` / `react/jsx-runtime`，不要引入其他 npm 运行时依赖。前端没有开发服务器：重新构建后刷新页面即可（API 进程直接读 `web/dist`）。
- 角色权限：整个站点是同一个应用和同一个登录页（`/api/auth/v1/login`），全站一个会话 Cookie `tg_session`（Path=/api），账号角色保存在服务端会话里。侧栏的「系统管理」分组和 `/admin/...` 页面只对 `role=admin` 显示，但这只是体验层：所有 `/api/admin/v1` 接口都必须用 `sessions.require(token, role="admin")` 校验，角色不够返回 403（不是 401，401 会让前端当成会话过期而退出）。文件空间接口（`/api/user/v1`）接受任何角色，管理员也有自己的存储桶。系统锁定时只有管理员能登录（用来解锁）。新增管理功能时：先加服务端角色校验，再在 `admin.tsx` 加页面，最后才是菜单。
- 管理员文档内容只能进入 `admin-docs.js`，不得被主应用 bundle 导入；它仅通过 `/api/admin/v1/docs-bundle.js`（需 admin 会话）下发，静态路由对 `*/admin-docs.js` 返回 404。
- 不加载外部字体或 CDN 资源。
- 弹出层（菜单、浮层）必须 portal 到 `document.body`（`ui.tsx` 的 `Menu` 已如此）：文件列表的行设置了 `content-visibility: auto`，它会让行成为 `position: fixed` 的包含块并裁剪溢出，放在行里的浮层会被裁掉看不见。窄屏下表格靠 `.file-surface` 横向滚动，每行最后一列（操作按钮）用 `position: sticky` 固定在右侧，表格自身不要再设 `overflow`。
- 文件夹也能公开：分享信息（令牌、有效期、密码、下载次数）保存在文件夹的**目录标记行**（以 `/` 结尾的对象）上，没有标记的隐式文件夹在分享时补一个。访客只读：`/s/<令牌>` 浏览（`?path=` 为相对路径），`/api/public/v1/folders/<令牌>/list` 列目录，`/p/<令牌>/<相对路径>` 读取文件；相对路径必须经 `ObjectService._public_relative` 校验，不得越出被分享的目录。重写目录标记（新建同名文件夹、移入回收站）时必须保留这些列，不能用新行覆盖。
- 公开链接令牌存放在 `objects.public_token`：覆盖写入在 `_commit_blob` 中继承，移动随行保留；禁用账号或锁定系统时 `/p/` 不可访问。新增改写对象行的代码路径时需要保持这一语义。
- 认证边界：`/api/user/v1`、`/api/admin/v1` 只供网页使用（HttpOnly Cookie + `X-CSRF-Token`）；`/api/v1` 与 S3 只接受访问密钥（`Authorization: Bearer AK:SECRET` / Basic、SigV4），不读取 Cookie。两者授权都走 `ClientAuthStore`（存储桶 + 前缀 + ro/rw），所属用户被禁用时密钥失效。新增程序可调用的能力应加在 `/api/v1`，不要让脚本依赖网页接口。
- 业务校验失败返回 `ValueError`（400），不要用 `AuthenticationError`（401 会让前端登出）。
- 新的数据库字段通过在 `Metadata._migrate` 中追加版本块添加，并提升 `SCHEMA_VERSION`。
- 对外地址（公开访问地址、S3 Endpoint）由 `tgdrive/settings.py` 的 `SystemSettings` 管理，存 `settings` 表，优先级：控制台设置 > 启动参数 > 前端推断。S3 路由主机名每个请求从它读取（带缓存）。前端统一通过 `api.userSiteOrigin()` / `api.s3Endpoint()` / `api.publicLinks()` 取地址，不要在组件里自行拼接 `window.location`。
- Docker：镜像入口是 `docker-entrypoint.sh`（以 root 启动 → 数据目录属主不是 10001 时一次性 `chown -R` → `setpriv` 降权运行 `tgdrive`），不要在 Dockerfile 里写 `USER`，否则旧数据卷和宿主机挂载目录会因为权限问题启动失败（sqlite 报 unable to open database file）。`create_app` 会在数据目录不可写时给出明确的错误提示。
- 单进程部署：普通会话、登录失败计数、Telegram 客户端池都在进程内存中，不要使用多个 uvicorn worker 或多实例共享数据目录。登录页勾选“30 天内保持登录”的会话例外：它们额外持久化在 `sessions` 表（只存令牌的 SHA-256，由 `accounts.MetadataSessionStore` 管理），服务重启后在系统解锁时恢复；退出、改密码（保留当前会话）、禁用账号、删除账号、管理员重置密码、锁定系统都必须同时清掉这张表里的对应记录（`SessionManager.revoke/clear/clear_user` 已统一处理，新增注销路径时不要绕过）。
- 大数据量：请求体与对象内容一律以流处理，不要在内存中拼接完整对象。`BlobEngine.put_part` 用片段列表攒分片，不要改回 `bytearray` + `del buf[:n]`（会让常驻内存随上传量增长到 GB 级）。列表、搜索、管理端文件列表都用 SQL 键集分页，不要先取全量再在 Python 里过滤。
- S3 请求体校验在 `tgdrive/s3/payload.py`：签名只覆盖声明的负载哈希，实际内容在读取时校验；新增读取请求体的 S3 操作必须走 `S3Gateway._body`。
- 审计日志（`tgdrive/audit.py`，路由表在 `TgDriveASGI._AUDITED`）只写入逐项挑选的字段，新增审计动作时不得记录密码、口令、token 或 Secret。
- 传输性能：前端大文件（>64 MB）按服务端给出的 16 MB 分块上传，`PART_CONCURRENCY=4` 块并行、`FILE_CONCURRENCY=2` 个文件并行（`web/src/user.tsx`）；服务端加解密放在 `asyncio.to_thread`，`BlobEngine.stream` 用 `read_ahead` 个窗口的流水线预读（`tests/test_download_pipeline.py`）。调大并行度前先估算内存：上传约 并行块数 × 2 × 16 MB，下载约 (read_ahead+1) × 读取窗口。
- 秒传（`tgdrive/fingerprint.py`、`ObjectService.instant_put`、`web/src/fingerprint.ts`）：指纹是 16 MiB 分块 SHA-256 的哈希树，算法是对外约定（见文档站 `/files/instant`），服务端和前端必须保持一致，改动会让已有指纹失效。指纹存在 `blobs.fingerprint`，写入时由 `put_part` 顺带计算（不重读数据）；分段上传只有除最后一段外每段都是 16 MiB 整数倍才有指纹。命中只在调用者自己的桶、授权前缀内查找，回收站前缀 `.tgdrive/` 不参与。新增会创建 Blob 的写入路径时要保证走 `put_part`，并在 `finalize` 后设置指纹。
- 文件移动使用 `ObjectService.move`：不以 `/` 结尾的源精确匹配单个文件，以 `/` 结尾的源移动整个文件夹；禁止移入自身子文件夹；同名目录标记合并。
