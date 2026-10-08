#!/bin/sh
# 容器入口：以 root 启动时先确保数据目录归运行用户所有，再降权运行服务；
# 已经用 `user:` 指定了非 root 用户时直接运行（此时数据目录权限由部署者负责）。
set -eu
UID_GID=10001
DATA_DIR="${TGDRIVE_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # 只在属主不对时才递归修正（例如旧版本用 root 创建的数据卷，或宿主机目录），避免每次启动都遍历大量分片文件。
  if [ "$(stat -c %u "$DATA_DIR")" != "$UID_GID" ]; then
    echo "正在修正数据目录 $DATA_DIR 的所有者（一次性操作）…" >&2
    chown -R "$UID_GID:$UID_GID" "$DATA_DIR" || echo "警告：无法修改 $DATA_DIR 的所有者，请在宿主机执行 chown -R $UID_GID:$UID_GID <目录>" >&2
  fi
  exec setpriv --reuid="$UID_GID" --regid="$UID_GID" --clear-groups tgdrive "$@"
fi

exec tgdrive "$@"
