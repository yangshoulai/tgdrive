"""审计日志：记录安全相关操作的结果。

只记录显式挑选的字段，绝不写入口令、密码、Bot token 或访问密钥 Secret。
"""

from __future__ import annotations

import json
import time

from .metadata import Metadata

# 动作名称 → 中文描述，前端直接展示。
ACTIONS = {
    "system.setup": "初始化系统", "system.unlock": "解锁系统", "system.lock": "锁定系统",
    "admin.login": "管理员登录", "admin.logout": "管理员退出", "user.login": "用户登录", "user.logout": "用户退出",
    "user.password": "修改密码", "user.create": "创建用户", "user.status": "更改用户状态", "user.quota": "调整配额",
    "key.create": "创建访问密钥", "key.disable": "禁用访问密钥", "client.status": "更改密钥状态", "client.grant": "修改密钥授权",
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
