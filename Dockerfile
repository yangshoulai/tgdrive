# INSTALL_FFMPEG=0（默认）为轻量镜像，1 为带 FFmpeg 的变体；其他取值找不到对应阶段，构建直接失败。
# 用在 FROM 中的构建参数必须在第一个 FROM 之前声明。
ARG INSTALL_FFMPEG=0

# 前端构建阶段：只把可复现的源码和锁文件带入镜像。
FROM node:22-alpine AS web-build

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web ./
RUN node build-apps.mjs

# 平台镜像按需携带 JavaScript 运行时，轻量镜像不包含该层。
FROM node:22-bookworm-slim AS platform-js

# FFmpeg 使用静态编译的单个可执行文件（FFmpeg 7.1，约 100 MB），代替 Debian 的 ffmpeg 包及其数百个共享库（约 420 MB）。
# 按摘要固定版本；升级时同时更新摘要与 licenses/ffmpeg 中的说明。只复制 ffmpeg，服务不使用 ffprobe。
FROM mwader/static-ffmpeg:7.1.1@sha256:11a44711684c0b9f754c047dcd64235b8b52deab251bd0e0a86f22faa160749c AS ffmpeg-static
FROM python:3.12-slim AS ffmpeg-0
RUN mkdir -p /out/bin /out/licenses
FROM python:3.12-slim AS ffmpeg-1
COPY --from=ffmpeg-static /ffmpeg /out/bin/ffmpeg
COPY --from=ffmpeg-static /versions.json /out/licenses/ffmpeg/versions.json
COPY licenses/ffmpeg/NOTICE.md /out/licenses/ffmpeg/NOTICE.md
FROM ffmpeg-${INSTALL_FFMPEG} AS ffmpeg-selected

# 运行阶段：API 服务同时托管用户端根路径和 /admin/ 管理端。
FROM python:3.12-slim AS runtime

# 默认保留轻量镜像；带 FFmpeg 的变体支持视频封装与图片／音视频缩略图后台生成。
COPY --from=ffmpeg-selected /out/bin/ /usr/local/bin/
COPY --from=ffmpeg-selected /out/licenses/ /app/licenses/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TGDRIVE_DATA_DIR=/data \
    TGDRIVE_HOST=0.0.0.0 \
    TGDRIVE_PORT=8000 \
    TGDRIVE_STATIC_DIR=/app/static \
    HOME=/home/tgdrive

WORKDIR /app
COPY pyproject.toml LICENSE ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY --from=web-build /src/web/dist /app/static/

# /app 只需可读：不再 chown -R，避免在新层里把整个程序目录再复制一份。
RUN useradd --system --uid 10001 --create-home --home-dir /home/tgdrive tgdrive \
    && mkdir -p /data \
    && chown tgdrive:tgdrive /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"
# 不在这里写 USER：入口脚本以 root 修正数据目录权限后降权为 tgdrive（uid 10001）运行服务。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["--data-dir", "/data", "--host", "0.0.0.0", "--static-dir", "/app/static"]

FROM runtime AS platform
COPY --from=platform-js /usr/local/bin/node /usr/local/bin/node
COPY --from=ffmpeg-static /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-static /versions.json /app/licenses/ffmpeg/versions.json
COPY licenses/ffmpeg/NOTICE.md /app/licenses/ffmpeg/NOTICE.md
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir '.[platform]' \
    && mkdir -p /app/licenses/platform \
    && pip download --no-cache-dir --no-deps --no-binary=:all: gallery-dl==1.32.16 -d /app/licenses/platform \
    && node --version

# 未选择 --target platform 时仍使用原有轻量／FFmpeg 变体。
FROM runtime AS final
