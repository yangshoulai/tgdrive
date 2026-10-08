# tgdrive

基于 Telegram Bot 与私有频道的加密分片对象存储。tgdrive 提供一个轻量 ASGI 服务、React 用户端与管理端，并兼容一组常用的 S3 操作。

## 能力概览

- **加密存储**：AES-256-GCM 分帧加密，Argon2id 派生密钥，支持本地 BlobStore 与 Telegram 私有频道。
- **对象管理**：桶、目录标记、分页列表、复制、移动、配额和 multipart 上传。
- **两类 API**：网页 API 使用 HttpOnly Cookie + CSRF；`/api/v1` 和 S3 使用访问密钥与 SigV4。
- **公开分享**：`/s/<token>` 分享页与 `/p/<token>/<文件名>` 直链，支持 Range、密码和过期时间。
- **管理控制台**：首次初始化、用户与配额、存储通道、访问密钥、审计与维护操作。
- **文档站**：`/docs/<页面>` 提供入门、API、S3 兼容性与管理员文档。

## 使用 Docker 启动

需要 Docker 及 Docker Compose。直接启动会构建本地镜像，并把数据持久化到 `tgdrive-data` 卷：

```bash
docker compose up -d --build
```

打开 <http://127.0.0.1:8000/> 完成首次初始化；管理端位于 <http://127.0.0.1:8000/admin/>，用户文档位于 <http://127.0.0.1:8000/docs/>。管理端登录后从「使用文档」进入管理员文档（`/admin/docs/`）。

用户文档只包含文件使用、HTTP API 和 S3 客户端说明。部署、运维、备份和故障排查页面只在管理员会话通过校验后按需加载，普通用户访问 `/docs/deploy` 等路径不会获得这些内容。

`docker-compose.yml` 为本地 HTTP 体验设置了 `TGDRIVE_INSECURE_COOKIES=1`。生产部署应删除该变量，在反向代理后使用 HTTPS，并设置公开访问地址与 S3 Endpoint。容器默认监听 `8000`，数据目录为 `/data`。

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

启用 Telegram 存储通道后，新对象会写入私有频道；没有启用 Bot 时，服务会使用本地分片目录，方便离线开发和测试。Bot token 会使用 KEK 派生子密钥加密保存，接口不会返回明文 token。

## 本地开发

项目需要 Python 3.12 和 Node.js。先安装依赖：

```bash
python -m venv .venv
.venv/bin/pip install -e .
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

本地预览可以分别启动两个静态站点：

```bash
node web/serve-app.mjs user    # http://127.0.0.1:8001
node web/serve-app.mjs admin   # http://127.0.0.1:8002
```

另开一个终端启动 API：

```bash
.venv/bin/tgdrive --data-dir /tmp/tgdrive-dev --port 8000 --insecure-cookies
```

验证 UI 时请使用独立的数据目录，避免触发工作区数据的 schema 迁移。前端构建器只支持相对导入以及 `react`、`react/jsx-runtime`，生成目录 `web/apps/{user,admin}/dist` 已被 Git 忽略。

## 项目结构

```text
tgdrive/              Python 后端、ASGI 路由、对象服务、S3 与 Telegram 适配器
web/src/               React + TypeScript 用户端、管理端和共享界面
web/src/docs/          用户文档、管理员文档和文档排版组件
web/build-apps.mjs     前端离线打包器
tests/                 unittest 回归测试
DESIGN.md              视觉规范
UX-CONTRACT.md         路由与交互契约
tgdrive-architecture-v2.md  架构设计记录
Dockerfile             多阶段镜像构建
docker-compose.yml    本地启动配置
.github/workflows/     仅 tag 推送触发的镜像发布流程
```

更多接口细节请查看内置文档站和 `tgdrive-architecture-v2.md`。生产环境建议单进程运行；会话、登录限流和 Telegram 客户端池都保存在进程内存中。
