# tgdrive 双 Web 应用

用户端和管理端是两个独立的前端应用，分别位于 `web/apps/user` 与 `web/apps/admin`，可使用不同域名、容器或 CDN 部署。它们只共享 `src/api.ts`、`src/shared.tsx` 和设计令牌，不共享路由入口或 HTML 产物。

```bash
cd web
node build-apps.mjs user
node build-apps.mjs admin
```

产物分别写入 `web/apps/user/dist` 和 `web/apps/admin/dist`。生产环境将两个 `dist` 目录配置到不同站点，并把 `/api` 反向代理到同一个 tgdrive API 服务即可。

本地开发使用三个独立进程：API/S3 `:8000`、用户 Web `:8001`、管理 Web `:8002`。用户 Web 和管理 Web 不再共用监听端口，也不再通过同一静态入口按路径切换。

```text
http://127.0.0.1:8000  API / S3
http://127.0.0.1:8001  用户端
http://127.0.0.1:8002  管理端
```

## 独立启动

在项目根目录运行三个终端：

```bash
.venv-net/bin/python -m tgdrive.app --data-dir .local-data --port 8000 --s3-host s3.localhost --insecure-cookies
node web/serve-app.mjs user
node web/serve-app.mjs admin
```

Web 服务仅提供静态文件和对应角色的 `/api` 流式代理，不创建后端实例。两端共享 8000 的会话和解锁状态；在管理端解锁一次即可。`PORT` 和 `API_UPSTREAM` 可覆盖监听端口及后端地址。重启 API 后需要重新登录并解锁。
