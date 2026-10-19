"""通用任务计划。只保存状态快照，沿用对话的加密／私密内存留痕。"""

from __future__ import annotations

import copy
import json
import re
import secrets

STATUSES = ("pending", "in_progress", "waiting_user", "completed", "failed", "paused", "cancelled")
META_TOOLS = frozenset(("update_plan", "get_context", "get_system_help"))


class Plan:
    def __init__(self, run_id: str = "", candidate: dict | None = None):
        self.run_id = run_id
        self.data: dict | None = None
        self.candidate = copy.deepcopy(candidate)
        self.calls: dict[str, str] = {}
        self.running: set[str] = set()
        self.published = 0
        self.recent: list[dict] = []

    def snapshot(self) -> dict | None:
        return copy.deepcopy(self.data)

    def _changed(self) -> None:
        if self.data is None:
            return
        items = self.data["items"]
        states = {item["status"] for item in items}
        self.data["status"] = ("completed" if states == {"completed"} else "in_progress" if "in_progress" in states
                               else "waiting_user" if "waiting_user" in states else "failed" if "failed" in states
                               else "paused" if "paused" in states else "cancelled" if "cancelled" in states else "pending")
        self.data["version"] += 1

    def _item(self, step_id: str) -> dict:
        item = next((item for item in self.data["items"] if item["id"] == step_id), None) if self.data else None
        if item is None:
            raise ValueError("计划步骤不存在，请使用当前计划返回的步骤编号")
        return item

    def update(self, args: dict) -> dict:
        items = args.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= 12:
            raise ValueError("计划需要 1–12 个步骤")
        plan_id = args.get("plan_id")
        original = self.data
        if plan_id and (original is None or original["id"] != plan_id):
            if original or not self.candidate or self.candidate["id"] != plan_id:
                raise ValueError("只能继续当前对话中提供的计划编号")
            original = copy.deepcopy(self.candidate)
        if original and plan_id and original["id"] != plan_id:
            raise ValueError("本轮只能更新当前计划")
        old = {item["id"]: item for item in (original or {}).get("items", [])}
        result, seen = [], set()
        for index, value in enumerate(items):
            if not isinstance(value, dict) or not isinstance(value.get("content"), str) or not value["content"].strip() \
                    or value.get("status") not in STATUSES:
                raise ValueError("每个步骤需要非空 content 与合法 status")
            step_id = value.get("id")
            if step_id is None:
                same = next((item for item in old.values() if item["content"] == value["content"].strip()[:120]), None)
                step_id = same["id"] if same else f"step{index + 1}"
                while step_id in seen or step_id in old and not same:
                    step_id = f"step{secrets.token_hex(3)}"
            if not isinstance(step_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", step_id) or step_id in seen:
                raise ValueError("步骤编号需为不重复的 1–40 位字母、数字、下划线或短横线")
            seen.add(step_id)
            previous = old.get(step_id, {})
            item = {**copy.deepcopy(previous), "id": step_id, "content": value["content"].strip()[:120],
                    "status": value["status"], "kind": value.get("kind", previous.get("kind", "tool"))}
            if item["kind"] not in ("tool", "reasoning"):
                raise ValueError("步骤 kind 只能是 tool 或 reasoning")
            if previous.get("kind") == "tool" and item["kind"] != "tool":
                raise ValueError("执行步骤不能改为纯分析步骤来跳过结果核验")
            if "detail" in value:
                if not isinstance(value["detail"], str):
                    raise ValueError("步骤 detail 需要文本")
                item["detail"] = value["detail"].strip()[:300]
            active = any(self.calls.get(call_id) == step_id for call_id in self.running)
            unresolved = item.get("action_pending", False)
            if previous.get("status") == "completed" and (item["status"] != "completed" or item["content"] != previous["content"]):
                raise ValueError("已完成的步骤不能重新执行或改写；新增步骤以安排后续工作")
            if (active or unresolved) and item["status"] not in ("in_progress", "waiting_user"):
                raise ValueError("步骤还有进行中的调用或待确认操作，不能提前结束")
            if item["status"] == "completed" and previous.get("status") != "completed":
                evidence = item.get("evidence", [])
                if item["kind"] == "reasoning":
                    if not item.get("detail"):
                        raise ValueError("纯分析步骤完成时需要 detail 说明结论")
                elif not evidence or evidence[-1]["status"] != "ok" or item.get("issue") or previous.get("status") == "failed":
                    raise ValueError("执行步骤需要成功的工具结果才能完成；失败后应先重试或保留失败状态")
            result.append(item)
        for step_id, item in old.items():
            if step_id not in seen and (item.get("action_pending") or any(self.calls.get(c) == step_id for c in self.running)):
                raise ValueError("不能移除仍在执行或等待确认的步骤")
        title = args.get("title", (original or {}).get("title", "处理计划"))
        reason = args.get("reason", "")
        if not isinstance(title, str) or not isinstance(reason, str):
            raise ValueError("计划标题和调整原因需要文本")
        structure = [(item["id"], item["content"]) for item in result]
        if original and structure != [(item["id"], item["content"]) for item in original["items"]] and not reason.strip():
            raise ValueError("增删、改写或调整步骤顺序时请提供 reason，说明计划调整原因")
        self.data = {"type": "plan", "id": (original or {}).get("id") or "plan_" + secrets.token_hex(8),
                     "run_id": (original or {}).get("run_id") or self.run_id, "title": title.strip()[:80] or "处理计划",
                     "version": (original or {}).get("version", 0), "automatic": False, "items": result}
        if reason:
            self.data["reason"] = reason.strip()[:300]
        elif (original or {}).get("reason"):
            self.data["reason"] = original["reason"]
        self._changed()
        return self.snapshot()

    def prepare(self, calls: list, labels: dict[str, str]) -> bool:
        """模型未规划时，按真实多工具调用补建基础计划，不改变工具的授权或执行次数。"""
        work = [call for call in calls if call.name not in META_TOOLS]
        if self.data is not None and not self.data.get("automatic") or not work:
            return False
        if self.data is None:
            if len(work) + len(self.recent) < 2:
                return False
            self.data = {"type": "plan", "id": "plan_" + secrets.token_hex(8), "run_id": self.run_id,
                         "version": 0, "title": "处理计划", "automatic": True, "items": []}
            for body in self.recent:
                item = self._auto_item(body["name"], labels)
                self.calls[body["call_id"]] = item["id"]
                self.observe(body)
        for call in work:
            item = self._auto_item(call.name, labels)
            if not any(self.calls.get(c) == item["id"] for c in self.running) and not item.get("action_pending"):
                item.pop("issue", None)
                item.pop("actions", None)
            self.calls[call.id] = item["id"]
            # 同一步骤可能对应多次分页或批量调用；全部返回后才能更新完成状态。
            self.running.add(call.id)
            item["status"] = "in_progress"
        self._changed()
        return True

    def _auto_item(self, name: str, labels: dict[str, str]) -> dict:
        items = self.data["items"]
        item = next((item for item in items if item.get("tool") == name), None)
        if item is None:
            item = {"id": f"step{len(items) + 1}", "content": labels.get(name, name), "kind": "tool",
                    "status": "pending", "tool": name}
            if len(items) < 12:
                items.append(item)
            else:
                item = items[-1]
                item["content"] = "其他处理步骤"
        return item

    def begin(self, call_id: str, name: str, step_id: str | None) -> None:
        if self.data is None or name == "update_plan" or name in META_TOOLS and not step_id:
            return
        if self.data.get("automatic") and call_id in self.calls:
            step_id = self.calls[call_id]
        if not step_id:
            active = [item for item in self.data["items"] if item["status"] == "in_progress"]
            if len(active) != 1:
                raise ValueError("请用 plan_step_id 指明这次调用所属的计划步骤")
            step_id = active[0]["id"]
        item = self._item(step_id)
        if item["status"] == "completed" and not self.data.get("automatic"):
            raise ValueError("这一步已经完成，请执行尚未完成的步骤")
        if item.get("action_pending"):
            raise ValueError("这一步还在等待操作结果，请等待或处理其他步骤，避免重复提交")
        if not self.data.get("automatic") and not any(self.calls.get(c) == step_id for c in self.running):
            item.pop("issue", None)
            item.pop("actions", None)
        self.calls[call_id] = step_id
        self.running.add(call_id)
        item["kind"] = "tool"
        item["status"] = "in_progress"
        item.pop("detail", None)
        self._changed()

    def wait(self, call_id: str, detail: str) -> None:
        step_id = self.calls.get(call_id)
        if step_id:
            item = self._item(step_id)
            item["status"], item["detail"] = "waiting_user", detail
            item["waiting_call"] = True
            self._changed()

    def observe(self, body: dict) -> None:
        if body["name"] == "update_plan" or body["name"] in META_TOOLS and body["call_id"] not in self.calls:
            return
        if self.data is None:
            self.recent = (self.recent + [{key: copy.deepcopy(body.get(key)) for key in
                                          ("call_id", "name", "status", "summary", "event")}
                                         | {"result": {key: value for key, value in (body.get("result") or {}).items()
                                                       if key in ("stopped", "failed", "partial")}}])[-12:]
            return
        step_id = self.calls.get(body["call_id"])
        if not step_id:
            return
        self.running.discard(body["call_id"])
        item = self._item(step_id)
        item.pop("waiting_call", None)
        evidence = {"call_id": body["call_id"], "tool": body["name"], "status": body["status"]}
        item["evidence"] = (item.get("evidence", []) + [evidence])[-16:]
        event, result = body.get("event") or {}, body.get("result") or {}
        if event.get("type") == "http_request" and event.get("decision") in ("rejected", "expired", "cancelled"):
            item["status"] = "paused" if event["decision"] == "expired" else "cancelled"
            item["detail"] = "请求未发送：" + str(body.get("summary") or "本次确认已取消")[:250]
            item["issue"] = True
        elif body["status"] != "ok":
            item["status"] = "paused" if body["status"] == "limited" else "cancelled" if body["status"] == "cancelled" else "failed"
            item["detail"] = str(body.get("summary") or "工具未完成")[:300]
            item["issue"] = True
        elif event.get("type") in ("action", "scope_request"):
            action_id = event["action_id"]
            item["actions"] = list(dict.fromkeys([*item.get("actions", []), action_id]))
            item["action_pending"] = True
            item["status"], item["detail"] = "waiting_user", "等待操作确认或执行结果"
        elif event.get("type") == "question":
            item["status"], item["detail"] = "waiting_user", event.get("question", "等待你的回复")[:300]
        elif body.get("truncated") or result.get("truncated") or result.get("body_complete") is False:
            item["status"], item["detail"] = "paused", "返回内容被截断，请检查剩余内容或缩小查询范围"
            item["issue"] = True
        elif result.get("stopped") or result.get("failed") or result.get("partial"):
            item["status"], item["detail"] = "failed", "工具仅完成部分内容，请检查结果并调整后续步骤"
            item["issue"] = True
        else:
            still_running = any(self.calls.get(c) == step_id for c in self.running)
            if self.data.get("automatic") and not still_running and not item.get("issue") and not item.get("action_pending"):
                item["status"] = "completed"
            elif not item.get("issue"):
                item["status"] = "in_progress"
            if event.get("type") == "browser":
                item["detail"] = "已提供操作卡片，实际操作需要你在卡片中执行"
        self._changed()

    def reconcile(self, actions: list[dict]) -> None:
        if self.data is None:
            return
        by_id = {action["id"]: action for action in actions}
        before = self.snapshot()
        for item in self.data["items"]:
            linked = [by_id.get(action_id) for action_id in item.get("actions", [])]
            if not linked:
                continue
            states = {"done" if action and action.get("kind") == "scope" and action["status"] == "confirmed"
                      else action["status"] if action else "expired" for action in linked}
            item["action_pending"] = bool(states & {"pending", "confirmed", "running", "undoing"})
            if states & {"running", "confirmed", "undoing"}:
                item["status"], item["detail"] = "in_progress", "操作正在执行"
            elif "pending" in states:
                item["status"], item["detail"] = "waiting_user", "请在操作卡片中确认"
            elif states <= {"done"}:
                if any(self.calls.get(c) == item["id"] for c in self.running):
                    item["status"] = "in_progress"
                elif not item.get("issue"):
                    item["status"] = "completed"
                    if any(action and action.get("kind") == "downloads" for action in linked):
                        item["detail"] = "已创建下载任务，文件下载结果以下载任务状态为准"
                    else:
                        item.pop("detail", None)
                else:
                    item["status"] = "failed"
            elif states & {"failed", "partial"}:
                item["status"], item["detail"] = "failed", "操作失败或仅完成部分内容，请检查操作结果"
            elif states & {"rejected", "cancelled", "undone"}:
                item["status"], item["detail"] = "cancelled", "操作已拒绝、取消或撤销"
            else:
                item["status"], item["detail"] = "paused", "操作已过期或中断，需要重新检查"
        if before != self.data:
            self._changed()

    @property
    def needs_check(self) -> bool:
        return bool(self.data and not self.data.get("automatic")
                    and any(item["status"] in ("pending", "in_progress") and not item.get("action_pending") for item in self.data["items"]))

    @property
    def remaining(self) -> int:
        return sum(item["status"] != "completed" for item in self.data["items"]) if self.data else 0

    @property
    def has_actions(self) -> bool:
        return bool(self.data and any(item.get("actions") for item in self.data["items"]))

    def finish(self, status: str, reason: str) -> None:
        if self.data is None or self.data["status"] == "completed":
            return
        before = self.snapshot()
        for item in self.data["items"]:
            if (item["status"] in ("pending", "in_progress") or item.get("waiting_call")) and not item.get("action_pending"):
                item["status"] = "cancelled" if reason == "stopped" else "paused"
                item.pop("waiting_call", None)
                item["detail"] = ("本轮已停止，可继续尚未完成的步骤" if reason == "stopped" else
                                  "本轮预算已用完，进度已保留" if reason == "limit" else
                                  "本轮执行失败，进度已保留" if status == "failed" else "本轮未完成此步骤，可继续处理")
        self.running.clear()
        if before != self.data:
            self._changed()

    def context(self) -> str:
        value = self.data or self.candidate
        if not value:
            return "无"
        public = {key: value[key] for key in ("id", "title", "status", "automatic", "items") if key in value}
        return json.dumps(public, ensure_ascii=False).replace("</", "<\\/")


def display_plan(event: dict, actions: list[dict], *, active: bool) -> dict:
    """读取时按真实操作状态恢复展示，不改写历史、不自动续跑。"""
    plan = Plan()
    plan.data = copy.deepcopy(event)
    plan.reconcile(actions)
    if not active:
        plan.finish("completed", "interrupted")
    return plan.snapshot()
