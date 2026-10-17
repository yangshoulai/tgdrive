"""助手可见的公共使用知识；与用户文档站同步维护，不读取管理员文档或部署信息。"""

from __future__ import annotations

import re
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..settings import normalize_origin


HELP = {
    "overview": ("入门", "/docs/quickstart", "Tessera 是加密文件空间，支持上传、文件夹、预览、公开分享、私密空间、离线下载、HTTP API 与 S3。"
                 "账号资料、登录密码和通行密钥在头像菜单的「用户设置」管理，程序凭据在「用户设置 → 访问密钥」管理。"),
    "passkeys": ("通行密钥", "/docs/account#passkeys", "从头像菜单进入「用户设置」，点击「添加通行密钥」，为设备命名，输入当前登录密码，"
                "点击「验证并添加」，按设备提示完成指纹、面容或 PIN 验证。最多 10 项，可重命名、移除；敏感操作需在本站确认密码。"
                "之后可在登录页用「通行密钥登录」，也可快捷解锁私密空间。需要支持的浏览器、设备锁屏和 HTTPS；本地开发可用 localhost。"
                "普通 HTTP 内网地址不支持，更换域名需重新绑定。密码只在本站表单输入，不要发给助手。"),
    "files": ("文件与私密空间", "/docs/files", "上传可用按钮或拖放；目录连续展示全部文件夹和文件，项目筛选与图片、视频、音频等类型可组合。"
              "文件菜单支持移动、重命名、分享与删除；删除进入回收站，30 天后清除。图片、视频和音频封面可由服务器生成，网页上传优先用本地文件；浏览目录不下载原文件补图，预览复用已加载数据，后台自动任务只用已接收缓存。菜单提供生成或重新生成，手动操作才允许专门读取原文件。列表小图不占空间，网格图与预览封面计入已用空间（侧栏「已用空间」里单列）。私密空间用当前账号登录密码或账号通行密钥解锁，"
              "自动锁定时间在用户设置中选择 1、5、15、30 分钟。访问密钥和 S3 不能访问私密空间；"
              "文件助手只在私密空间页面以「私密对话」使用（需管理员开放），对话不保存，锁定后清除。详见 /docs/assistant#private。"),
    "cache": ("本机缓存", "/docs/account#local-cache", "看过的图片、音乐、视频片段和缩略图会加密缓存在当前浏览器，再次打开更快；只有登录本账号才能打开。"
              "在「用户设置 → 本机缓存」设置是否缓存、最多占用多少空间、是否自动缓存视频片段；文件菜单、右键或预览头部「缓存到本机」可完整缓存任意文件，勾选多个文件后选择栏也有「缓存到本机」；列表中手动缓存显示「✓ 本机」，自动缓存显示「自动」。"
              "私密文件需管理员允许并把设备设为信任才缓存，锁定后无法打开。右键菜单「清除本机缓存」删除单个文件的缓存，用户设置的「清理」可全部清理、清理普通缓存或清理私密缓存，也可重置所有设备的缓存；缓存不是备份，不占用账号空间。"
              "需要 HTTPS 与较新浏览器，无痕模式不可用；管理员可整体关闭。"),
    "sharing": ("公开分享", "/docs/sharing", "文件或文件夹菜单选择「公开分享」，复制分享页链接；可设置有效期与访问密码。"
                "分享页为 /s/<令牌>，文件直链为 /p/<令牌>/<文件名>，直链支持 Range；文件夹分享包含子目录、访客只读。"
                "侧栏「公开分享」管理已有链接。询问打开已有分享时调用 ui_open_share，给用户点击打开的卡片，不编造令牌。"
                "创建分享须用 propose_share 并由用户确认，密码只在确认卡片填写；停止分享后原链接失效。"),
    "api": ("对外 HTTP API", "/docs/api-basics", "脚本接口前缀 /api/v1，使用访问密钥，不使用网页 Cookie。"
            "认证为 Authorization: Bearer <AccessKeyId>:<SecretAccessKey>，也支持 HTTP Basic；不要把真实密钥发给助手。"
            "文件接口：GET /api/v1/list、GET /api/v1/folders、POST /api/v1/folders、GET/HEAD/PUT /api/v1/files?path=…、"
            "POST /api/v1/move、POST /api/v1/delete；分享接口见 /docs/api-sharing；"
            "离线下载：POST /api/v1/downloads/parse、POST /api/v1/downloads、GET /api/v1/downloads。"
            "密钥只访问所属用户、授权桶与路径的普通文件，分只读/读写，不能访问私密空间。"
            "完整文件接口见 /docs/api-files，授权说明见 /docs/api-permissions。"
            "网页 /api/user/v1 与 /api/admin/v1 使用 HttpOnly Cookie 与 CSRF，仅供本站网页使用，不用于外部脚本。"),
    "s3": ("S3 客户端", "/docs/s3", "可用 rclone、AWS CLI、boto3，使用「用户设置 → 访问密钥」创建的 AccessKeyId/SecretAccessKey。"
           "配置公开 S3 Endpoint、路径风格寻址、region=us-east-1；桶名称以账号页面实际显示为准，不猜测。"
           "支持对象上传、读取、Range、列表、复制、删除与分段上传等已文档化能力，不承诺完整 AWS S3 功能。私密空间不开放。"),
    "downloads": ("离线下载", "/docs/downloads", "在侧栏「下载任务」页点击「添加下载」提交直链或 curl/wget；按管理员开启能力可解析 M3U8、X、YouTube。"
                  "先解析、选择资源与保存目录、确认创建任务，进度在下载任务页和托盘查看。助手可先解析或请求公共 API，"
                  "再通过 propose_downloads 生成保存提议。大文件在服务端流式下载，不经聊天正文传输。"),
    "assistant": ("文件助手", "/docs/assistant", "助手在服务端运行，网页提供聊天界面及浏览器操作桥接；服务端 HTTP 请求不携带浏览器登录状态。"
                  "可以查询、整理普通文件、生成下载提议、打开已有分享与解答系统用法，具体以已启用工具为准。"
                  "审批模式需确认修改；完全访问模式下普通修改可自动执行，但公开分享、彻底删除、超过 1000 项、读取外部内容后的修改仍需确认。"
                  "打开新页、下载到本机和复制通过用户点击卡片执行。不会获取密码、密钥或管理员配置。"
                  "私密空间里打开助手是「私密对话」：只作用于私密空间、只用管理员允许的模型、对话只在内存中，锁定或闲置自动锁定后清除；"
                  "联网只访问用户在消息里给出的链接，移出私密空间要重新验证身份。普通对话可以用卡片把文件移入私密空间（目标位置由用户选择）。"
                  "支持识图的模型能看到消息里 @ 或上传的图片（以预览图发送，每条最多 6 张），也可用 view_image 查看访问范围内的图片。"
                  "输入框可用回形针、粘贴或拖入添加附件（每条最多 10 个、单个 ≤64 MB）。附件属于对话，不出现在我的文件，"
                  "计入已用空间；删除对话时一起删除，不能单独删除；需要长期保留时在附件菜单「保存到我的文件」（或让助手提议保存）。"
                  "用户设置的「助手附件」可查看统计。PDF、Office 文档助手看不到其内容。详见 /docs/assistant#images。"),
}

OVERVIEW = "\n".join(f"- {title}：{path}。{text}" for key, (title, path, text) in HELP.items() if key in ("overview", "passkeys", "api"))
BROWSERS = {"Chrome", "Chromium", "Edge", "Firefox", "Safari", "Opera", "其他"}
OPERATING_SYSTEMS = {"Windows", "macOS", "iOS", "Android", "Linux", "ChromeOS", "其他"}


def client_environment(value: object) -> dict[str, str]:
    """只接受低熵字段，拒绝任意文本进入提示词；客户端自报信息不参与权限判断。"""
    if not isinstance(value, dict):
        return {}
    result = {}
    for name, allowed in (("browser", BROWSERS), ("os", OPERATING_SYSTEMS)):
        if isinstance(value.get(name), str) and value[name] in allowed:
            result[name] = value[name]
    for name, pattern in (("browser_version", r"[0-9]{1,3}"), ("language", r"[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}")):
        if isinstance(value.get(name), str) and re.fullmatch(pattern, value[name]):
            result[name] = value[name]
    timezone = value.get("timezone")
    if isinstance(timezone, str) and len(timezone) <= 64:
        try:
            ZoneInfo(timezone)
            result["timezone"] = timezone
        except (ZoneInfoNotFoundError, ValueError):
            pass
    origin = value.get("origin")
    if isinstance(origin, str) and len(origin) <= 2048 and not any(char.isspace() or ord(char) < 32 for char in origin):
        try:
            normalized = normalize_origin(origin, "站点地址")
            if normalized and re.fullmatch(r"[A-Za-z0-9.:-]{1,253}", urlsplit(normalized).hostname or ""):
                result["origin"] = normalized
        except ValueError:
            pass
    return result


def public_config(settings, environment: dict) -> dict:
    config = settings.public_config() if settings is not None else {}
    site = config.get("public_base_url") or environment.get("origin")
    return {"public_base_url": site, "s3_endpoint": config.get("s3_endpoint"),
            "http_api": f"{site or ''}/api/v1", "docs": f"{site or ''}/docs/quickstart"}
