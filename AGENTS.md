# AGENTS.md

给 AI 代理的项目说明。产品对外名称是 **Tessera**（界面、文档、标题），`tgdrive` 只是仓库、Python 包、命令行、环境变量和镜像的技术名称，不要混用；改名只需改 `web/src/brand.ts` 与 `build-apps.mjs` 里的标题/图标。人类读者请先看 `README.md`。

## 项目概览

Tessera（仓库名 tgdrive）：基于 Telegram Bot + 私有频道的加密分片对象存储。Python 3.12 后端（无 Web 框架，自写 ASGI 适配器）+ React 18/TypeScript 前端（两个独立站点：用户端、管理端）。界面文案为简体中文。

## 目录

- `src/tgdrive/`：后端（src 布局，导入名仍为 `tgdrive`；改动后需 `pip install -e .` 重新安装）。`metadata.py`（SQLite 迁移，当前 schema v18）、`objects.py`（对象/公开链接）、`api.py`（网页会话服务层，按角色校验 Cookie 会话与 CSRF）、`private.py`（私密空间访问授权）、`passkeys.py`（账号登录与私密解锁共用的通行密钥挑战及验签）、`offline/`（受控来源请求、持久下载队列、资源预算与视频封装；平台解析子进程的网络经主进程转发）、`keyapi.py`（`/api/v1` 访问密钥 API）、`asgi.py`（HTTP 路由与流式响应）、`app.py`（应用工厂与 CLI）、`s3/`、`telegram/`。
- `web/src/`：前端源码。
  - `ui.tsx`：设计系统基元（按钮、表单、弹窗、菜单、toast、格式化）。新界面必须复用这里的组件。
  - `shell.tsx`：应用外壳、登录页、首次初始化页。
  - `files.tsx`：文件类型、预览入口与分享对话框。`preview-data.ts` 负责流式文本解码与 512 KB 截断；`preview-text.tsx`、`preview-media.tsx`、`preview-image.tsx` 提供文本／音视频／图片界面（音乐用原生 `Audio` 自绘界面与频谱，频谱的 `AudioContext` 只在用户操作时创建且 iOS 不启用，以免影响后台播放；上一项／下一项、播放模式与列表按钮放在各播放器自己的控制条里）；两个 `preview-*-engine.ts` 用 CodeMirror、markdown-it／DOMPurify、ArtPlayer 实现预览并按需加载。同目录 LRC／SRT／VTT 查询沿用用户、管理员和公开文件夹的权限边界。
  - `markdown.tsx`：自带 Markdown 渲染器，直接产出 React 元素，不执行原始 HTML，链接只放行 http(s)/mailto；`highlight.ts`：正则语法高亮（每种语言一组规则，合并成一个正则扫描，规则内不得有捕获分组或后行断言）；`code.tsx`：带行号的代码块与 Markdown 围栏。新增语言只需在 `highlight.ts` 的 `RULES` 与 `ALIASES` 各加一项。
  - `user.tsx`（入口 `UserApp`，含移动对话框与拖放移动）、`admin.tsx`（入口 `AdminRoute`，含系统设置）、`share.tsx`。
  - 文档站位于 `web/src/docs/`：`docs.tsx`（外壳、`/docs/<页面>` 路由、目录、⌘K 搜索）、`docs-ui.tsx`（排版组件）、`docs-content.tsx`（用户文档内容；示例地址取自 `/api/public/v1/config`）、`docs-admin-content.tsx`（管理员文档内容）。`admin-docs.tsx` 是管理员文档独立入口。修改接口、限制或 S3 兼容性时必须同步更新对应内容文件。
  - `styles.css`：全部样式与设计令牌；只引用 CSS 变量，深色模式只覆盖令牌（`:root[data-theme="dark"]`，不要再用 `prefers-color-scheme` 媒体查询）。字号用 `--text-*` 阶梯（11/12/13/14/16/20/22/28），圆角用 `--radius-xs…xl`，不写半像素或裸值；文件类型图标统一用中性的 `--glyph-mark`，不按类型配色。
  - `theme.ts`：外观偏好（跟随系统／浅色／深色），存 `localStorage` 的 `tessera-theme`；`build-apps.mjs` 生成的 head 脚本 `theme-<hash>.js` 在首帧前应用，二者的存储键与解析规则必须一致。
- `userscripts/tessera-grabber.user.js`：Tampermonkey 资源抓取脚本（单文件、无构建步骤，界面放在封闭 Shadow DOM 中，一律用 DOM API 创建节点，不得使用 `innerHTML`／`DOMParser`／`eval`：YouTube 启用了 Trusted Types，这些调用会直接抛错导致脚本挂载失败）。只通过访问密钥调用 `/api/v1/downloads/parse` 与 `/api/v1/downloads`，不得依赖网页会话接口；生成的 curl 必须能被 `offline/request.py` 解析（bash 单引号，`'\''` 转义）。
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

- `build-apps.mjs` 的主应用仍用自写打包器，只支持相对导入和 React；预览引擎单独用 esbuild 打包 npm 依赖，生成本地 `preview-*.js/css` 与许可证清单，按需加载。其他模块不要直接导入 npm 运行时依赖。前端没有开发服务器：重新构建后刷新页面即可（API 进程直接读 `web/dist`）。
- 角色权限：整个站点是同一个应用和同一个登录页（`/api/auth/v1/login`），全站一个会话 Cookie `tg_session`（Path=/api），账号角色保存在服务端会话里。侧栏的「系统管理」分组和 `/admin/...` 页面只对 `role=admin` 显示，但这只是体验层：所有 `/api/admin/v1` 接口都必须用 `sessions.require(token, role="admin")` 校验，角色不够返回 403（不是 401，401 会让前端当成会话过期而退出）。文件空间接口（`/api/user/v1`）接受任何角色，管理员也有自己的存储桶。系统锁定时只有管理员能登录（用来解锁）。新增管理功能时：先加服务端角色校验，再在 `admin.tsx` 加页面，最后才是菜单。
- 管理员文档内容只能进入 `admin-docs.js`，不得被主应用 bundle 导入；它仅通过 `/api/admin/v1/docs-bundle.js`（需 admin 会话）下发，静态路由对 `*/admin-docs.js` 返回 404。
- 不加载外部字体或 CDN 资源。
- 弹出层（菜单、浮层）必须 portal 到 `document.body`（`ui.tsx` 的 `Menu`／`ContextMenu` 共用 `MenuList`，已如此；全屏时挂到全屏元素内）：文件列表的行设置了 `content-visibility: auto`，它会让行成为 `position: fixed` 的包含块并裁剪溢出，放在行里的浮层会被裁掉看不见。窄屏下表格靠 `.file-surface` 横向滚动，每行最后一列（操作按钮）用 `position: sticky` 固定在右侧，表格自身不要再设 `overflow`。
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
- 缩略图（`objects.py` 的 thumbnail 系列方法、`web/src/thumbnails.ts`）：按 Blob 保存在 `thumbnails` 表，规格 `thumb`（≤96 KB，约 320px）、`poster`（≤320 KB，约 960px）与 `none`（已尝试但无法生成）；用该 Blob 的 DEK 派生密钥加密（`BlobEngine.seal_thumbnail`），所以改口令无需重加密、Blob 删除时外键级联删除。不计入配额、不进入备份。生成只在浏览器完成（图片缩放、视频截帧、音频 ID3/FLAC/MP4 内嵌封面），服务端不解码用户文件；网页上传后用本地文件生成，其余文件由 `useThumbnailBackfill` 在浏览目录时补生成。列表接口用 `UserApi._objects_json` 批量附带 `thumbnails` 状态，新增返回文件列表的接口时不要逐项查询。公开分享通过 `/p/<令牌>/<路径>?thumbnail=thumb|poster` 读取，沿用分享的权限并且不计下载次数。旧版存在 `user_meta` 里的明文缩略图在 v12 迁移时移到 `thumbnail_legacy`，解锁后由维护任务或首次读取加密转存。
- 文件页（`web/src/user/files.tsx`）的键盘快捷键挂在 document 上，遇到输入控件、菜单、弹窗、托盘、侧栏或按钮上的空格／回车必须让行；右键菜单与行尾菜单共用 `fileMenu`／`folderMenu`。侧栏导航由 `AppShell` 的 `hrefFor` 渲染成真实链接，普通点击用 `isPlainClick` 判断后走应用内路由。
- 打包下载 `GET /api/user/v1/archive`（`UserApi.archive` + `stream_zip(..., nested=True)`）：只有它允许 ZIP 内带目录的相对路径，访客文件夹下载仍是扁平文件名；条目必须经 `content` 读取以保留私密空间的逐块授权校验。
- 文件移动使用 `ObjectService.move`：不以 `/` 结尾的源精确匹配单个文件，以 `/` 结尾的源移动整个文件夹；禁止移入自身子文件夹；同名目录标记合并。
- 访问密钥创建离线任务（`KeyApi.download_owner`／`download_scope` + `OfflineDownloads.create(key_scope=...)`）：只接受属于用户的密钥，任务归该用户、写入其存储桶，保存目录必须在密钥的读写授权前缀内，不能写入私密空间；审计记为 `download.create`、操作者类型 `key`。
- 离线下载的所有出站请求（直链、M3U8、平台解析子进程、媒体轨）必须经 `offline/http.py` 的 `SafeHttpClient`，不要另开 socket 或让解析库自行联网：直连时它固定公网 IP，配置出站代理（`ResourceSettings` 的 `proxy`）时改由 `proxied_host` 拦截内网字面地址与内部主机名。连接阶段的网络抖动抛 `TransientError`（可重试），内容、认证、证书错误用普通 `DownloadError`。YouTube 媒体必须按 `track["chunk"]` 分段读取（`platforms.track_stream`），否则会被 googlevideo 限速。代理密码不得出现在审计、接口回显（用 `mask_proxy`）或错误信息中。来源的 408/425/429/5xx 用 `status_error` 归为可重试，任务层由 `OfflineDownloads._run` 自动重试；不要把临时故障当成“文件已变化”清理断点。平台任务复用 `platform_source.entry`，只有 `ExpiredMedia` 时才重新解析。
- 文件预览统一由 `web/src/user/preview-host.tsx` 的 `PreviewHost`（挂在 `MainShell`）渲染，页面用 `usePreview().open(...)` 打开，不要在页面组件里直接渲染 `PreviewModal`，否则切换页面会中断播放。页面卸载时其回调（分享、补缩略图、私密活动）自动移除；私密文件预览在离开私密空间或锁定时关闭，新增预览入口不得绕过。离线下载进度托盘在 `web/src/user/download-tray.tsx`，与上传托盘一起放在 `.tray-stack` 中。
- 私密空间由 `private.py` 管理短期授权，使用账号当前登录密码或账号通行密钥，授权绑定会话、账号和密码版本，网页入口为 `/api/user/v1/private/`。闲置时间按用户保存在 `private_spaces.idle_seconds`，未设置默认 1800 秒，可选 60／300／900／1800 秒；用户设置通过普通会话与 CSRF 调整自己的时间，不允许客户端指定其他用户。保存会撤销本账号旧私密授权与待验证解锁；当前会话已有有效授权时重新签发，未解锁时不签发。不存在管理员统一策略。同一普通会话共享一个授权，`/status` 可以恢复尚未到期的授权但不会续期；前端 `user/private-session.ts` 的 Provider 挂在应用外壳，切页、刷新和新标签页不主动撤销授权，离开私密页面仍关闭私密预览并取消私密上传。手动锁定撤销该登录会话的全部私密授权与待验证解锁；退出、改密、禁用、系统锁定及重启使授权失效。凭据在用户设置中统一管理，接口为 `/api/auth/v1/passkeys`；未登录验签绑定固定来源和短期 HttpOnly Cookie，已登录敏感操作要求 CSRF 及登录密码确认。`Scope.private_access` 默认关闭，普通网页、管理文件、访问密钥和 S3 不得绕过 `.tgdrive/private/` 与 `.tgdrive/private-trash/` 的保护；内部账号删除和过期回收站维护可以显式授权。新增私密读取需禁用持久缓存，异步写入提交前及文件流逐块重新校验授权，移入必须递归取消公开链接。
