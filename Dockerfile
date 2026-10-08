# 前端构建阶段：只把可复现的源码和锁文件带入镜像。
FROM node:22-alpine AS web-build

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web ./
RUN node build-apps.mjs user \
    && TGDRIVE_ASSET_PREFIX=/admin/ node build-apps.mjs admin \
    && node build-apps.mjs admin-docs

# 运行阶段：API 服务同时托管用户端根路径和 /admin/ 管理端。
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TGDRIVE_DATA_DIR=/data \
    TGDRIVE_HOST=0.0.0.0 \
    TGDRIVE_PORT=8000 \
    TGDRIVE_STATIC_DIR=/app/static

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY --from=web-build /src/web/apps/user/dist /app/static/
COPY --from=web-build /src/web/apps/admin/dist /app/static/admin/

VOLUME ["/data"]
EXPOSE 8000
ENTRYPOINT ["tgdrive"]
CMD ["--data-dir", "/data", "--host", "0.0.0.0", "--static-dir", "/app/static"]
