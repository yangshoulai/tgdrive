"""审计日志：记录安全相关操作的结果。

只记录显式挑选的字段，绝不写入口令、密码、Bot token 或访问密钥 Secret。
"""

from __future__ import annotations

import json
import time
import base64
import os
import secrets
from pathlib import Path

from .crypto import derive_subkey, seal

from .metadata import Metadata

# 动作名称 → 中文描述，前端直接展示。
ACTIONS = {
    "system.setup": "初始化系统", "system.unlock": "解锁系统", "system.lock": "锁定系统",
    "admin.login": "管理员登录", "admin.logout": "管理员退出", "user.login": "用户登录", "user.logout": "用户退出",
    "user.password": "修改密码", "user.create": "创建用户", "user.status": "更改用户状态", "user.quota": "调整配额",
    "key.create": "创建访问密钥", "key.disable": "禁用访问密钥", "key.delete": "删除访问密钥", "client.delete": "删除密钥客户端", "client.status": "更改密钥状态", "client.grant": "修改密钥授权",
    "bot.create": "添加存储通道", "bot.status": "更改通道状态", "bot.check": "检查存储通道",
    "object.public": "更改公开分享", "settings.update": "修改系统设置",
    "maintenance.gc": "运行垃圾回收", "maintenance.scrub": "运行完整性校验", "maintenance.cleanup": "清理未完成的上传",
    "maintenance.gc_retry": "重试回收失败的分片", "backup.create": "创建备份", "backup.download": "下载备份",
    "admin.password": "修改管理员密码", "system.passphrase": "更换加密口令", "user.password_reset": "重置用户密码",
    "user.delete": "删除用户", "trash.purge": "清空回收站",
}


class AuditLog:
    def __init__(self, metadata: Metadata) -> None:
        self.metadata = metadata

    def archive(self, directory: str | Path, keystore, *, days: int, now: float | None = None,
                limit: int = 500) -> dict[str, object]:
        """先可靠写入加密 JSONL 归档，再移出在线日志；默认保留策略不调用此方法。"""
        if days < 1 or limit < 1:
            raise ValueError("归档期限和批量大小必须为正数")
        cutoff = (time.time() if now is None else now) - days * 86400
        rows = self.metadata.db.execute(
            "SELECT * FROM audit_log WHERE ts<? ORDER BY ts,id LIMIT ?", (cutoff, limit)).fetchall()
        if not rows:
            return {"archived": 0}
        # 头部 KDF 参数与加密密钥必须来自同一版本。
        with keystore.consistency_lock:
            key = self.metadata.get_key_row()
            kek = keystore.require_kek()
            header = json.dumps({"kdf_salt": base64.b64encode(key["kdf_salt"]).decode(),
                                 "kdf_params": json.loads(key["kdf_params"]), "key_version": key["version"],
                                 "kind": "audit-jsonl", "created_at": time.time()}, separators=(",", ":")).encode()
        from .maintenance import EncryptedSnapshotStore
        data = b"".join(json.dumps(dict(row), ensure_ascii=False, separators=(",", ":")).encode() + b"\n" for row in rows)
        payload = EncryptedSnapshotStore.MAGIC_V2 + len(header).to_bytes(4, "big") + header
        payload += seal(derive_subkey(kek, "snapshot"), data, EncryptedSnapshotStore.AAD + header)
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        name = f"audit-{rows[0]['id']}-{rows[-1]['id']}-{time.time_ns()}.tgdaudit"
        destination = directory / name
        staging = directory / f".{name}.{secrets.token_hex(6)}.tmp"
        try:
            with os.fdopen(os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(staging, destination)
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            with self.metadata.transaction() as db:
                db.executemany("DELETE FROM audit_log WHERE id=? AND ts<?", ((row["id"], cutoff) for row in rows))
        finally:
            staging.unlink(missing_ok=True)
        return {"archived": len(rows), "name": name}

    def record(self, action: str, *, actor_type: str, actor: str | None, ok: bool, target: str | None = None,
               detail: dict[str, object] | None = None, ip: str | None = None) -> None:
        with self.metadata.transaction() as db:
            db.execute("INSERT INTO audit_log(ts,actor_type,actor,action,target,ip,ok,detail) VALUES(?,?,?,?,?,?,?,?)",
                       (time.time(), actor_type, actor, action, target, ip, int(ok),
                        json.dumps(detail, ensure_ascii=False, separators=(",", ":")) if detail else None))

    def list(self, *, before: int | None = None, limit: int = 50, action: str | None = None,
             failed_only: bool = False) -> dict[str, object]:
        limit = max(1, min(limit, 200))
        where, args = [], []
        if before is not None:
            where.append("id < ?")
            args.append(before)
        if action:
            where.append("action LIKE ?")
            args.append(action.rstrip("*") + "%")
        if failed_only:
            where.append("ok = 0")
        rows = self.metadata.db.execute(
            "SELECT * FROM audit_log" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC LIMIT ?",
            (*args, limit + 1)).fetchall()
        items = [{"id": row["id"], "ts": row["ts"], "actor_type": row["actor_type"], "actor": row["actor"],
                  "action": row["action"], "label": ACTIONS.get(row["action"], row["action"]), "target": row["target"],
                  "ip": row["ip"], "ok": bool(row["ok"]), "detail": json.loads(row["detail"]) if row["detail"] else None}
                 for row in rows[:limit]]
        return {"events": items, "next_cursor": items[-1]["id"] if len(rows) > limit else None}
