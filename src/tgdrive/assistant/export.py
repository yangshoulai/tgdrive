"""对话导出：把一个对话的明文留痕整理成 Markdown（便于阅读）或 JSON（完整数据），供用户下载。

只由 `AssistantService.export_conversation` 调用：调用前已校验对话归属，涉及私密的对话已要求当前登录会话解锁。
导出内容只包含浏览器本来就能看到的字段（与对话详情一致），不含只给模型看的包装文本、图片字节与内部字段。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone, tzinfo

FORMATS = {"markdown": ("md", "text/markdown; charset=utf-8"), "json": ("json", "application/json; charset=utf-8")}
# 只给模型看的包装文本、图片与内部记账字段不进入导出。
_HIDDEN = {"model_content", "model_text", "images", "image_refs", "_run", "_slim", "prompt_estimate", "_responses"}
# Markdown 里每个工具结果最多保留的字符数；完整内容见 JSON 导出。
RESULT_LIMIT = 20_000
ROLE_TITLES = {"user": "用户", "assistant": "助手"}


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items() if key not in _HIDDEN}
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def filename(title: str | None, conversation_id: str, fmt: str) -> str:
    base = re.sub(r"[\x00-\x1f\x7f/\\:*?\"<>|]+", " ", title or "").strip(" .")[:60].strip() or f"对话-{conversation_id}"
    return f"{base}.{FORMATS[fmt][0]}"


def render_json(conversation: dict, messages: list[dict], actions: list[dict], zone: tzinfo, exported_at: float) -> bytes:
    data = {"format": "tessera.assistant.conversation", "version": 1, "exported_at": _iso(exported_at, zone),
            "conversation": {**clean(conversation), "created_at": _iso(conversation["created_at"], zone),
                             "updated_at": _iso(conversation["updated_at"], zone)},
            "messages": [{**clean(message), "created_at": _iso(message["created_at"], zone)} for message in messages],
            "actions": clean(actions)}
    return json.dumps(data, ensure_ascii=False, indent=2).encode()


def render_markdown(conversation: dict, messages: list[dict], zone: tzinfo, exported_at: float) -> bytes:
    lines = [f"# {_line(conversation.get('title') or '新对话')}", ""]
    lines.append(f"- 创建时间：{_time(conversation['created_at'], zone)}")
    lines.append(f"- 最后更新：{_time(conversation['updated_at'], zone)}")
    if conversation.get("model"):
        lines.append(f"- 模型：{_line(conversation['model'])}")
    lines.append(f"- 作用域：{'私密空间' if conversation.get('private') else conversation.get('scope') or '/'}")
    lines.append(f"- 导出时间：{_time(exported_at, zone)}")
    lines += ["", "---", ""]
    for message in messages:
        role = message["role"]
        stamp = _time(message["created_at"], zone)
        if role == "user":
            lines += [f"## 用户 · {stamp}", "", str(message.get("text") or "").strip() or "（空消息）", ""]
            for label, key in (("引用", "mentions"),):
                if message.get(key):
                    lines.append(f"{label}：" + "、".join(f"`{_code(item)}`" for item in message[key]))
            for item in message.get("attachments") or []:
                if isinstance(item, dict):
                    lines.append(f"附件：{_line(str(item.get('name') or ''))}")
            snapshot = message.get("attachment")
            if isinstance(snapshot, dict) and snapshot.get("type") == "snapshot":
                lines.append(f"网页快照：{_line(str(snapshot.get('source') or ''))}（{snapshot.get('pages', 0)} 个页面，{snapshot.get('images', 0)} 张图片）")
            lines.append("")
        elif role == "assistant":
            reasoning = str(message.get("reasoning") or "").strip()
            text = str(message.get("text") or "").strip()
            if not reasoning and not text:
                continue
            lines += [f"## 助手 · {stamp}", ""]
            if reasoning:
                lines += ["> **思考**", ">"] + [f"> {row}" if row else ">" for row in reasoning.splitlines()] + [""]
            if text:
                lines += [text, ""]
        elif role == "tool":
            label = message.get("label") or message.get("tool_name") or "工具"
            status = message.get("status") or ""
            lines.append(f"### 工具：{_line(str(label))}" + (f"（{status}）" if status else "") + f" · {stamp}")
            lines.append("")
            if message.get("summary"):
                lines += [_line(str(message["summary"])), ""]
            if message.get("arguments"):
                lines += ["参数：", "", *_fence(json.dumps(clean(message["arguments"]), ensure_ascii=False, indent=2), "json"), ""]
            result = message.get("result")
            if result not in (None, "", {}, []):
                body = result if isinstance(result, str) else json.dumps(clean(result), ensure_ascii=False, indent=2)
                cut = len(body) > RESULT_LIMIT
                lines += ["结果：", "", *_fence(body[:RESULT_LIMIT], "" if isinstance(result, str) else "json")]
                if cut:
                    lines.append(f"（结果较长，只保留前 {RESULT_LIMIT} 个字符，完整内容请导出 JSON）")
                lines.append("")
        elif role == "event":
            event = message.get("event") if isinstance(message.get("event"), dict) else message
            text = str(event.get("text") or event.get("title") or "").strip()
            if text:
                lines += [f"*{_line(text)} · {stamp}*", ""]
    return ("\n".join(lines).rstrip() + "\n").encode()


def _fence(text: str, language: str) -> list[str]:
    # 围栏比内容里最长的反引号串多一个，避免结果中的 ``` 提前结束代码块。
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return [fence + language, text, fence]


def _line(text: str) -> str:
    return " ".join(str(text).split())


def _code(text: str) -> str:
    return str(text).replace("`", "'")


def _time(moment: float, zone: tzinfo) -> str:
    return datetime.fromtimestamp(moment, zone).strftime("%Y-%m-%d %H:%M:%S")


def _iso(moment: float | None, zone: tzinfo) -> str | None:
    return None if moment is None else datetime.fromtimestamp(moment, zone).isoformat(timespec="seconds")


UTC = timezone.utc
