<p align="center"><img src="docs/logo.svg" alt="Tessera" width="96"></p>

# Tessera

基于 Telegram Bot 与私有频道的加密分片对象存储。Tessera（仓库、命令行与环境变量仍沿用 `tgdrive` 这个技术名称）提供一个轻量 ASGI 服务、React 用户端与管理端，并兼容一组常用的 S3 操作。

## 能力概览

- **加密存储**：AES-256-GCM 分帧加密，Argon2id 派生密钥，支持本地 BlobStore 与 Telegram 私有频道。
- **对象管理**：桶、目录标记、分页列表、复制、移动、配额和 multipart 上传。
- **两类 API**：网页 API 使用 HttpOnly Cookie + CSRF；`/api/v1` 和 S3 使用访问密钥与 SigV4。
- **秒传**：同一存储桶里已有内容相同的文件时直接引用，不传输数据（网页端自动、`/api/v1/files/instant` 供脚本使用）。
- **公开分享**：`/s/<token>` 分享页与 `/p/<token>/<文件名>` 直链，支持 Range、密码和过期时间。
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
