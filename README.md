<p align="center"><img src="docs/logo.svg" alt="Tessera" width="96"></p>

# Tessera

基于 Telegram Bot 与私有频道的加密分片对象存储。Tessera（仓库、命令行与环境变量仍沿用 `tgdrive` 这个技术名称）提供一个轻量 ASGI 服务、React 用户端与管理端，并兼容一组常用的 S3 操作。

## 能力概览

- **加密存储**：AES-256-GCM 分帧加密，Argon2id 派生密钥，支持本地 BlobStore 与 Telegram 私有频道。
- **对象管理**：桶、目录标记、分页列表、复制、移动、配额和 multipart 上传。
- **两类 API**：网页 API 使用 HttpOnly Cookie + CSRF；`/api/v1` 和 S3 使用访问密钥与 SigV4。
- **秒传**：同一存储桶里已有内容相同的文件时直接引用，不传输数据（网页端自动、`/api/v1/files/instant` 供脚本使用）。
- **公开分享**：`/s/<token>` 分享页与 `/p/<token>/<文件名>` 直链，支持 Range、密码和过期时间。
- **账号与私密空间**：在「用户设置」中统一管理登录密码和通行密钥，同一凭据可用于登录及私密空间解锁（通行密钥需配置 HTTPS 公开访问地址）；私密空间解锁后在当前登录会话内保留，默认闲置 30 分钟锁定，每个用户可自行调整。私密操作续期，音视频播放时保持解锁，支持移入、移出及独立回收站。
- **管理控制台**：首次初始化、用户与配额、存储通道、访问密钥、审计与维护操作。
- **文档站**：`/docs/<页面>` 提供入门、API、S3 兼容性与管理员文档。

## 使用 Docker 启动

需要 Docker 及 Docker Compose。生产配置默认保持 Secure Cookie；本机直接用 HTTP 体验时叠加开发配置：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

打开 <http://127.0.0.1:8000/> 完成首次初始化并登录；文档位于 <http://127.0.0.1:8000/docs/>。管理员和普通用户使用同一个登录页和同一个文档地址，管理员登录后会多看到「系统管理」菜单和文档里的「管理员」分组。

用户文档只包含文件使用、HTTP API 和 S3 客户端说明。部署、运维、备份和故障排查页面只在管理员会话通过校验后按需加载，普通用户访问 `/docs/deploy` 等路径不会获得这些内容。

`docker-compose.dev.yml` 才会设置 `TGDRIVE_INSECURE_COOKIES=1`，只用于本地 HTTP。生产部署应直接使用 `docker-compose.yml`，在反向代理后使用 HTTPS，并设置公开访问地址与 S3 Endpoint。容器默认监听 `8000`，数据目录为 `/data`；`/healthz` 可用于容器和反向代理健康检查。

服务进程以非 root 用户（uid 10001）运行。容器以 root 启动时，入口脚本会先把 `/data` 的所有者修正为 10001 再降权，所以旧版本留下的数据卷和 `./data:/data` 这样的宿主机目录都能直接使用。如果你在 compose 里用 `user:` 指定了其他用户，就需要自己保证 `/data` 对该用户可写，例如 `chown -R <uid> ./data`。

如果使用 GitHub Container Registry 发布的镜像，可将 Compose 中的 `build` 部分删掉，然后执行：

```bash
docker compose pull
docker compose up -d
```

镜像地址为 `ghcr.io/yangshoulai/tgdrive`。GitHub Actions 只在推送 `v*` 格式的 tag 时运行，例如：

```bash
git tag v0.1.0
git push origin v0.1.0
```

### 离线下载与资源配置

侧栏「下载任务」支持 HTTP/HTTPS 文件直链，也可粘贴浏览器复制的 bash 格式 curl 或 wget 命令。先解析、勾选文件并选择目录，再交给服务器下载。可停止、继续、重新下载、更新过期参数和删除任务；删除任务保留已保存的文件，同名文件自动改名。

「系统设置 → 下载与资源」提供自动、低资源、标准与自定义模式，管理员配置在重启后保留。自动模式参考 CPU 配额、内存限制和 CPU 亲和性；无法可靠检测时采用低资源预算。1 核／750 MB 建议低资源模式，同时只下载 1 个任务。按数据目录的实际剩余空间保护磁盘，系统盘总容量不是可用容量。未限制资源的 Docker 容器可能看到宿主机预算，可在 Compose 中设置 `cpus: 1.0` 和 `mem_limit: 750m`，或直接选择低资源模式。

默认镜像不含 FFmpeg。需要 M3U8 时使用同版本的 `-ffmpeg` 镜像（例如 `latest-ffmpeg`），或构建时传入 `--build-arg INSTALL_FFMPEG=1`，然后在管理端启用 M3U8。X／YouTube 使用 `latest-platform` 或同版本的 `-platform` 镜像，本地构建为 `docker build --target platform -t tgdrive:platform .`，再在管理端分别启用平台功能。发布工作流仍只由 `v*` 标签触发，生成轻量、FFmpeg、平台三个变体；小服务器建议拉取 CI 构建的镜像。

平台镜像在本地运行 gallery-dl、yt-dlp、配套 EJS 和 Node.js，不依赖第三方解析网站。X 支持单条帖子中的原图与视频；YouTube 支持单视频、Shorts 中实际可用的 H.264／AAC MP4 格式，按清晰度选择，也可只保存 M4A 音轨。支持粘贴 Cookie 请求头或导入 Netscape cookies.txt，只使用对应平台域名的 Cookie。Cookie 加密保存，不从服务器读取桌面浏览器的登录状态。解析时取得的媒体地址随任务加密保存，在有效期内（X 24 小时，YouTube 3 小时且早于地址自带的 expire 10 分钟）直接下载；过期或来源返回 401／403／404／410 时重新解析一次，按已选媒体编号和清晰度匹配，不自动降低清晰度。停止或失败后清理中间数据，再次开始从头下载。网络中断、超时及 HTTP 408／425／429／5xx 会自动重试 3 次，分别等待 10、30、90 秒，任务显示“等待恢复”和重试次数；文件直链从已保存的 16 MiB 分段续传，YouTube 分段读取在任务内原地续读。POST、认证失败、内容变化不自动重试。

YouTube 默认最高 720p、单任务大小与临时输入轨缓存最多 512 MiB；低资源预算会限制这两个上限。支持实际可用的 HTTPS 和 HLS 格式，登录后的客户端也尝试 Safari HLS；直连媒体被拒绝时重新解析一次，优先使用同一清晰度的 HLS，不自动降低清晰度。音视频分离时仅缓存受限的输入轨，FFmpeg 合并输出直接进入分片加密存储，不另存完整成品临时文件、不转码。缓存仍占磁盘，需要保留足够空间；磁盘压力停止任务后清理临时轨，服务重启清理上次异常退出的任务缓存。直播、频道／播放列表批量下载、DRM 和额外 PO Token 提供器暂不支持。Cookie 代表账号登录状态，不等于平台的播放证明，也不保证服务器出口被允许；解析器版本固定在 `pyproject.toml` 的 `platform` 可选依赖中，需要随平台变化更新镜像。服务器需要代理出网时，在「系统设置 → 下载与资源」填写出站代理（`http://` 或 `socks5://`，也可用 `--offline-proxy` / `TGDRIVE_OFFLINE_PROXY`）；启用后所有离线下载经代理、由代理解析域名，只能拦截字面内网地址和内部主机名。YouTube 页面、API 和 googlevideo 媒体应使用同一稳定出口，代理分流到不同出口可能导致已解析地址返回 403。直连时服务器 DNS 必须返回真实公网地址，fake-IP／保留网段会被拒绝。YouTube HTTPS 媒体按 10 MiB 分段读取以避免被限速。

M3U8 支持已结束的 H.264／AAC 点播，包括 MPEG-TS、fMP4 初始化分片、字节范围、时间线跳变、普通 AES-128 和独立音轨，可选择主列表中的清晰度。普通连续 TS 保持管道传输；复杂列表先流式缓存输入分片，受磁盘保留空间与账号剩余配额限制。分片、初始化文件、密钥均由受控 HTTP 客户端获取，再生成只含本地文件名的列表交给 FFmpeg；成品直接进入加密存储，不另存完整 MP4。临时分片和密钥为明文，停止、失败或完成后清理，重启清理遗留缓存。暂不支持直播、低延迟分片、缺失分片、DRM 或 SAMPLE-AES。停止后从头封装；HTTP 仅在强 ETag、长度及实际 Range 响应一致时续传。POST 解析不访问来源，中断后必须手动重新发送。常见平台失败的原因与修复验证见 [离线下载兼容性排查](docs/offline-reliability.md)。

来源 URL、请求头和请求体加密保存，随加密口令轮换重新加密；任务列表和审计不包含这些凭据。直连时每次连接和跳转都验证并固定公网地址，不访问本机、内网或云元数据；跨来源不转发自定义请求头。系统锁定时暂停，解锁后恢复 GET 任务；账号禁用时停止，重新启用后需手动继续。停止／失败的 HTTP 断点沿用 7 天清理期限，过期后从头下载。首版只写入普通文件空间。

YouTube「解析内容」只列举格式，不提前试下载默认媒体。解析失败时区分网页、播放 API 和播放列表；容器日志记录固定请求阶段、状态码与认证头是否存在，不记录 Cookie 或签名地址。服务器解析 403 需要按该阶段检查登录状态、账号权限和出口，不能仅靠切换媒体下载格式判断原因。

## 配置

启动参数和同名环境变量都可用；控制台中的系统设置优先于启动时的默认值。

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--data-dir` | `TGDRIVE_DATA_DIR` | SQLite 元数据、本地分片和备份目录，默认 `./data` |
| `--host` | `TGDRIVE_HOST` | 监听地址，默认 `127.0.0.1` |
| `--port` | `TGDRIVE_PORT` | 监听端口，默认 `8000` |
| `--static-dir` | `TGDRIVE_STATIC_DIR` | 前端静态文件目录；Docker 镜像已内置 |
| `--public-url` | `TGDRIVE_PUBLIC_URL` | 分享链接、HTTP API 和文档示例使用的公开地址 |
| `--s3-endpoint` | `TGDRIVE_S3_ENDPOINT` | S3 客户端使用的完整 Endpoint |
| `--s3-host` | `TGDRIVE_S3_HOST` | 未配置 S3 Endpoint 时识别 S3 请求的主机名 |
| `--insecure-cookies` | `TGDRIVE_INSECURE_COOKIES=1` | 仅本地 HTTP 开发使用，生产环境保持关闭 |
| `--trusted-proxies` | `TGDRIVE_TRUSTED_PROXIES` | 信任 `X-Forwarded-For`/`Proto` 的代理 IP 或网段，逗号分隔；只填写实际代理地址 |

启用 Telegram 存储通道后，新对象会写入私有频道；没有启用 Bot 时，服务会使用本地分片目录，方便离线开发和测试。Bot token 会使用 KEK 派生子密钥加密保存，接口不会返回明文 token。

## 本地开发

项目需要 Python 3.12 和 Node.js。先安装依赖：

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
cd web
npm ci
```

运行后端测试和前端检查：

```bash
.venv/bin/python -m unittest discover -s tests -v
cd web
node node_modules/typescript/bin/tsc -p tsconfig.app.json
node build-apps.mjs
```

本地预览只需要一个进程：先构建前端，再让 API 服务直接托管它。

```bash
(cd web && node build-apps.mjs)
.venv/bin/tgdrive --data-dir /tmp/tgdrive-dev --port 8000 --static-dir web/dist --insecure-cookies
```

整个站点是同一个应用、同一个登录页（<http://127.0.0.1:8000/>）。登录后的菜单由账号角色决定：普通用户只有自己的文件空间；管理员在此基础上多出「系统管理」分组（`/admin/...`）和文档里的管理员专属页面。普通用户看不到这些入口，管理接口也会在服务端被拒绝。

改动前端后重新运行 `node build-apps.mjs` 并刷新页面即可，不需要重启服务。验证 UI 时请使用独立的数据目录，避免触发工作区数据的 schema 迁移。前端构建器只支持相对导入以及 `react`、`react/jsx-runtime`，产物目录 `web/dist` 已被 Git 忽略。

## 项目结构

```text
src/tgdrive/          Python 后端、ASGI 路由、对象服务、S3 与 Telegram 适配器
web/src/               React + TypeScript 用户端、管理端和共享界面
web/src/docs/          用户文档、管理员文档和文档排版组件
web/build-apps.mjs     前端离线打包器（产物 web/dist）
tests/                 unittest 回归测试
DESIGN.md              视觉规范
UX-CONTRACT.md         路由与交互契约
docs/architecture-v2.md  架构设计记录
Dockerfile             多阶段镜像构建
docker-compose.yml    本地启动配置
.github/workflows/     仅 tag 推送触发的镜像发布流程
```

更多接口细节请查看内置文档站和 `docs/architecture-v2.md`。生产环境建议单进程运行；普通会话、登录限流、流量统计和 Telegram 客户端池都保存在进程内存中，服务重启后会话和统计会重新开始；登录时勾选“30 天内保持登录”的会话会保存到数据库（只存令牌哈希），重启并解锁后仍然有效。反向代理示例：

```bash
.venv/bin/tgdrive --data-dir /var/lib/tgdrive --trusted-proxies 172.20.0.0/16
```

不要把 `--trusted-proxies *` 用在不受控的网络中，否则客户端可以伪造来源 IP。

本地检查：

```bash
make check
```
