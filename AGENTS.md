# AGENTS.md

给 AI 代理的项目说明。产品对外名称是 **Tessera**（界面、文档、标题），`tgdrive` 只是仓库、Python 包、命令行、环境变量和镜像的技术名称，不要混用；改名只需改 `web/src/brand.ts`（`BRAND`、标语 `TAGLINE`、说明 `STORY`；`build-apps.mjs` 用正则从这里读取三者生成 `<title>` 与 OG／Twitter 元信息，所以必须保持 `export const 名称 = "…";` 的写法）与 `build-apps.mjs` 里的网页图标；链接预览封面是 `web/assets/social-card.svg` 渲染出的 `social-card.png`（1200×630，可用 Chrome headless 截图生成），文案变化时一起更新。人类读者请先看 `README.md`。

## 项目概览

Tessera（仓库名 tgdrive）：基于 Telegram Bot + 私有频道的加密分片对象存储。Python 3.12 后端（无 Web 框架，自写 ASGI 适配器）+ React 18/TypeScript 前端（两个独立站点：用户端、管理端）。界面文案为简体中文。

## 目录

- `src/tgdrive/`：后端（src 布局，导入名仍为 `tgdrive`；改动后需 `pip install -e .` 重新安装）。`metadata.py`（SQLite 迁移，当前 schema v41）、`objects.py`（对象/公开链接）、`api.py`（网页会话服务层，按角色校验 Cookie 会话与 CSRF）、`private.py`（私密空间访问授权）、`passkeys.py`（账号登录与私密解锁共用的通行密钥挑战及验签）、`offline/`（受控来源请求、持久下载队列、资源预算与视频封装；平台解析子进程的网络经主进程转发）、`keyapi.py`（`/api/v1` 访问密钥 API）、`asgi.py`（HTTP 路由与流式响应）、`app.py`（应用工厂与 CLI）、`assistant/`（AI 文件助手：渠道与模型、模型目录 `catalog.py`、识图 `vision.py`、Agent 循环、工具、浏览器工具 `client_tools.py`、公共 HTTP 查询 `http_tools.py`、公共使用知识与客户端环境 `knowledge.py`、秘密保护 `guard.py`、留痕与调用日志）、`media/`（媒体元数据：`tags.py` 纯 Python 解析标签与内嵌歌词／封面／字幕轨，`providers/` 提供者接口与各来源，`service.py` 统一服务、`query.py` 查询条件、`text.py` 歌词字幕规范化）、`playlists.py`（音乐歌单）、`s3/`、`telegram/`（存储通道的 Bot 客户端与配置；`bot.py` 是用户私聊用的交互机器人）。
- `web/src/`：前端源码（主应用、系统管理、文档站，界面组件与设计系统见 [前端结构](docs/agents/frontend.md)）。样式按领域拆在 `web/src/styles/`（编号决定层叠顺序，令牌在 `00-tokens.css`），构建时拼成一个样式表。
- `tests/`：按功能命名的 `unittest` 回归测试，覆盖加密、认证、对象、S3、分页、Telegram、维护任务、公开链接、审计和公开文档访问。
- `docs/architecture-v2.md`：架构设计记录。`docs/assistant-design.md`：AI 文件助手设计（P1–P5 已实现，§15.1 与 §19 记录实现与偏离；后续改动以它为准，偏离先改文档）。
- `Dockerfile` / `docker-compose.yml`：多阶段镜像，用户端在根路径，管理端在 `/admin/`。FFmpeg 不再用 apt 安装：`-ffmpeg`（`INSTALL_FFMPEG=1`，经全局 ARG 选择 `ffmpeg-0`／`ffmpeg-1` 阶段）与 `platform` 变体只复制按摘要固定的 `mwader/static-ffmpeg` 中的静态 `ffmpeg`（服务不用 ffprobe），许可说明在 `licenses/ffmpeg/`，升级时同步摘要与说明；`/app` 不做 `chown -R`（只需可读，避免复制整层）。依赖真实 FFmpeg 的测试（`test_video_thumbnails`、`test_offline_hls`）在本机没有 FFmpeg 时跳过，改动镜像或 FFmpeg 时挂载 `tests/` 进容器运行。`.github/workflows/docker.yml` 仅在发布关联 `v*` 标签的 GitHub Release 时构建并发布镜像（`release.published`，含预发布），单独推送标签或保存 Release 草稿不会构建，不要添加其他触发条件；它会校验标签与 `pyproject.toml` 版本一致，并发布 `<完整版本>`、`<主>.<次>`、`<主>`（v0 除外）与 `latest` 标签。
- 版本与发布：1.0.0 起遵循语义化版本，版本号的唯一来源是 `pyproject.toml`（运行时由 `tgdrive/version.py` 读取，`tgdrive --version`、管理员接口 `/api/admin/v1/version` 与控制台概览显示；公开接口不暴露版本）。发布时同时更新 `pyproject.toml`、`web/package.json`（含 lock）、`CHANGELOG.md`，再推送 `v<版本>` 标签并发布对应的 GitHub Release，以触发镜像构建。数据库、`/api/v1`、S3 网关、秒传指纹的不兼容变更只能进入新的主版本，并在 CHANGELOG 写明升级步骤。
- `DESIGN.md`：视觉规范；`UX-CONTRACT.md`：交互与路由契约。改动 UI 时同步更新。
- `docs/agents/`：各模块给 AI 代理的细则（见下方「模块细则」）。

## 模块细则

每个模块的约束、数据流与回归测试写在下面的专题文件里；改动某个模块前先读对应文件，改完同步更新它。

- [前端结构与界面组件](docs/agents/frontend.md)：web/src 的组件、预览引擎、文档站、样式与主题。
- [文件页、预览与任务中心](docs/agents/files-ui.md)：文件列表、预览宿主、快捷键、收藏、筛选、搜索、分页、文本与图片编辑、解压与压缩、更多预览格式、任务中心。
- [封面、媒体元数据与播放](docs/agents/media.md)：缩略图（封面）流水线、封面来源、自定义封面、媒体标签与歌词字幕、显示尺寸、视频旋转、缓冲速度。
- [存储、传输与资源限制](docs/agents/storage.md)：读取名额、并发上限、传输性能、秒传、内容类型识别、Telegram 分片上传、GC。
- [离线下载](docs/agents/offline.md)：队列、访问密钥创建任务、封面与保存位置、多连接、诊断、保存位置与优先级、出站请求、视频封装。
- [本机缓存](docs/agents/cache.md)：Service Worker 缓存、缓存任务与已缓存文件、缓存筛选、自动与手动缓存、读取与预览预读。
- [文件助手](docs/agents/assistant.md)：Agent 循环、工具、确认坞、长任务、识图与附件、本机缓存工具、私密对话、思考程度、P5、媒体与文本工具。
- [资源抓取脚本](docs/agents/grabber.md)：userscripts/tessera-grabber.user.js：兼容层、iframe、批次、网盘取链与网盘文件夹。
- [账号、分享与私密空间](docs/agents/accounts.md)：公开分享与转存、公开链接令牌、访客注册、账号资料、私密空间。
- [Telegram 交互机器人、星标与歌单](docs/agents/telegram-stars-playlists.md)：机器人绑定、长轮询、离线下载与文件保存、助手对话与确认按钮、下载提醒；文件星标；音乐歌单。

## 常用命令

`.venv-net` 是指向本机虚拟环境的符号链接；它失效时用任意已 `pip install -e .` 本仓库的虚拟环境（如 `.venv-operations`）运行同样的命令。

```bash
.venv-net/bin/python -m unittest discover -s tests            # 后端测试
cd web && node node_modules/typescript/bin/tsc -p tsconfig.app.json   # 前端类型检查（strict）
cd web && node build-apps.mjs                                  # 构建到 web/dist（压缩、分块并预压缩 .br/.gz）
for f in tests/*.cjs; do node --test "$f"; done              # 前端与抓取脚本的 Node 回归测试
.venv-net/bin/tgdrive --data-dir .local-data --port 8000 --static-dir web/dist --insecure-cookies   # 单进程单端口，同一个应用
```

验证 UI 时请使用独立数据目录（如 `/tmp/tgdrive-verify-data`）和其他端口，不要动用户的 `.local-data`（会触发 schema 迁移）。`.claude/launch.json` 的 `verify` 配置在 8100 端口同时提供用户端和控制台。验证截图、浏览器日志等放在 `output/`（已被 `.gitignore` 忽略，不入库）；README 等文档要长期引用的截图放在 `docs/screenshots/`。

## 约定

- 界面文案统一把用户看到的缩略图称为「封面」（「设置封面」「更新封面」「封面读取并发」等，三种尺寸叫列表小图、网格图、预览大图）；代码标识（`thumbnail_*`、`ui_generate_thumbnails`、接口路径）与注释里的「缩略图」保持不变。新增或修改用户可见的提示、错误信息（含服务端返回给网页的 ValueError、生成进度说明）时用「封面」。
- `build-apps.mjs` 的主应用仍用自写打包器，只支持相对导入和 React，依赖用队列遍历（递归遍历会在导入链较深时触发 TypeScript 输出的栈溢出）；预览引擎单独用 esbuild 打包 npm 依赖，生成本地 `preview-*.js/css` 与许可证清单，按需加载。其他模块不要直接导入 npm 运行时依赖。前端没有开发服务器：重新构建后刷新页面即可（API 进程直接读 `web/dist`）。
- 角色权限：整个站点是同一个应用和同一个登录页（`/api/auth/v1/login`），全站一个会话 Cookie `tg_session`（Path=/api），账号角色保存在服务端会话里。侧栏的「系统管理」分组和 `/admin/...` 页面只对 `role=admin` 显示，但这只是体验层：所有 `/api/admin/v1` 接口都必须用 `sessions.require(token, role="admin")` 校验，角色不够返回 403（不是 401，401 会让前端当成会话过期而退出）。文件空间接口（`/api/user/v1`）接受任何角色，管理员也有自己的存储桶。系统锁定时只有管理员能登录（用来解锁）。新增管理功能时：先加服务端角色校验，再在 `admin.tsx` 加页面，最后才是菜单。
- `/docs` 的全部使用、接口与部署管理文档均公开，目录、正文和搜索不读取登录会话或按角色筛选；`/admin/docs` 旧地址统一跳转到 `/docs`，管理功能的接口权限保持独立校验。
- 不加载外部字体或 CDN 资源。
- 弹出层（菜单、浮层）必须 portal 到 `document.body`（`ui.tsx` 的 `Menu`／`ContextMenu` 共用 `MenuList`，已如此；全屏时挂到全屏元素内）：文件列表的行设置了 `content-visibility: auto`，它会让行成为 `position: fixed` 的包含块并裁剪溢出，放在行里的浮层会被裁掉看不见。窄屏下表格靠 `.file-surface` 横向滚动，每行最后一列（操作按钮）用 `position: sticky` 固定在右侧，表格自身不要再设 `overflow`。
- 认证边界：`/api/user/v1`、`/api/admin/v1` 只供网页使用（HttpOnly Cookie + `X-CSRF-Token`）；`/api/v1` 与 S3 只接受访问密钥（`Authorization: Bearer AK:SECRET` / Basic、SigV4），不读取 Cookie。两者授权都走 `ClientAuthStore`（存储桶 + 前缀 + ro/rw），所属用户被禁用时密钥失效。新增程序可调用的能力应加在 `/api/v1`，不要让脚本依赖网页接口。
- 业务校验失败返回 `ValueError`（400），不要用 `AuthenticationError`（401 会让前端登出）。
- 新的数据库字段通过在 `Metadata._migrate` 中追加版本块添加，并提升 `SCHEMA_VERSION`。
- 对外地址（公开访问地址、S3 Endpoint）由 `tgdrive/settings.py` 的 `SystemSettings` 管理，存 `settings` 表，优先级：控制台设置 > 启动参数 > 前端推断。S3 路由主机名每个请求从它读取（带缓存）。前端统一通过 `api.userSiteOrigin()` / `api.s3Endpoint()` / `api.publicLinks()` 取地址，不要在组件里自行拼接 `window.location`。
- Docker：镜像入口是 `docker-entrypoint.sh`（以 root 启动 → 数据目录属主不是 10001 时一次性 `chown -R` → `setpriv` 降权运行 `tgdrive`），不要在 Dockerfile 里写 `USER`，否则旧数据卷和宿主机挂载目录会因为权限问题启动失败（sqlite 报 unable to open database file）。`create_app` 会在数据目录不可写时给出明确的错误提示。
- 单进程部署：普通会话、登录失败计数、Telegram 客户端池都在进程内存中，不要使用多个 uvicorn worker 或多实例共享数据目录。登录页勾选“30 天内保持登录”的会话例外：它们额外持久化在 `sessions` 表（只存令牌的 SHA-256，由 `accounts.MetadataSessionStore` 管理），服务重启后在系统解锁时恢复；退出、改密码（保留当前会话）、禁用账号、删除账号、管理员重置密码、锁定系统都必须同时清掉这张表里的对应记录（`SessionManager.revoke/clear/clear_user` 已统一处理，新增注销路径时不要绕过）。
- 大数据量：请求体与对象内容一律以流处理，不要在内存中拼接完整对象。`BlobEngine.put_part` 用片段列表攒分片，不要改回 `bytearray` + `del buf[:n]`（会让常驻内存随上传量增长到 GB 级）。列表、搜索、管理端文件列表都用 SQL 键集分页，不要先取全量再在 Python 里过滤。
- 页面查询与传输线程隔离：`Metadata.run_in_thread` 使用进程共用的 4 线程专用池，保留请求上下文与 WAL 独立连接；不要改回 `asyncio.to_thread`，否则离线下载加密或本机缓存的磁盘读写占满默认线程池时，目录、搜索与管理页会排队，虽已切页却一直加载。它不增加文件读取、写入或离线下载的并发。回归：`tests/test_request_responsiveness.py`。
- S3 请求体校验在 `tgdrive/s3/payload.py`：签名只覆盖声明的负载哈希，实际内容在读取时校验；新增读取请求体的 S3 操作必须走 `S3Gateway._body`。
- 审计日志（`tgdrive/audit.py`，路由表在 `TgDriveASGI._AUDITED`）只写入逐项挑选的字段，新增审计动作时不得记录密码、口令、token 或 Secret。
