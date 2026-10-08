# 前端构建阶段：只把可复现的源码和锁文件带入镜像。
FROM node:22-alpine AS web-build

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web ./
RUN node build-apps.mjs

# 运行阶段：API 服务同时托管用户端根路径和 /admin/ 管理端。
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TGDRIVE_DATA_DIR=/data \
    TGDRIVE_HOST=0.0.0.0 \
    TGDRIVE_PORT=8000 \
    TGDRIVE_STATIC_DIR=/app/static \
    HOME=/home/tgdrive

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY --from=web-build /src/web/dist /app/static/

RUN useradd --system --uid 10001 --create-home --home-dir /home/tgdrive tgdrive \
    && mkdir -p /data \
    && chown -R tgdrive:tgdrive /app /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"
# 不在这里写 USER：入口脚本以 root 修正数据目录权限后降权为 tgdrive（uid 10001）运行服务。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["--data-dir", "/data", "--host", "0.0.0.0", "--static-dir", "/app/static"]
