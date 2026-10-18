"""注册邮件：标准库 SMTP、强制 TLS，以及兼容邮件客户端的双格式正文。"""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import format_datetime, formataddr, make_msgid
from datetime import datetime, timezone
from html import escape


def verification_message(sender: str, sender_name: str, recipient: str, code: str, *, test: bool = False) -> EmailMessage:
    message = EmailMessage()
    message["From"] = formataddr((sender_name, sender))
    message["To"] = recipient
    message["Subject"] = "Tessera 邮件发送测试" if test else "Tessera 注册验证码"
    message["Date"] = format_datetime(datetime.now(timezone.utc))
    message["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[1])
    title = "邮件服务已就绪" if test else "验证邮箱，开启你的文件空间"
    intro = "这是一封测试邮件。收到它表示 Tessera 已能通过当前邮件服务器发送邮件。" if test else "你正在注册 Tessera。请在注册页面输入下方验证码，完成邮箱验证。"
    note = "下方为验证码样式预览，不能用于注册。" if test else "验证码 10 分钟内有效，仅可使用一次。请勿向任何人透露，包括管理员。"
    message.set_content(f"{title}\n\n{intro}\n\n{'样式预览' if test else '注册验证码'}：{code}\n\n{note}\n\n如果不是你本人操作，请忽略此邮件。\nTessera · 千片成璧，唯你可合。")
    message.add_alternative(f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f7;color:#17171c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif">
<div style="display:none;max-height:0;overflow:hidden">{'Tessera 邮件服务配置成功' if test else '你的 Tessera 注册验证码，10 分钟内有效。'}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fff;border:1px solid #e4e4e8;border-radius:16px;overflow:hidden">
<tr><td style="padding:28px 32px;background:#0b0c13;color:#fff"><span style="color:#f0a22e;font-size:24px">▦</span><span style="font-size:22px;font-weight:600;padding-left:12px">Tessera</span></td></tr>
<tr><td style="padding:36px 32px 12px"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.5">{title}</h1><p style="margin:0;color:#4a4a54;font-size:14px;line-height:1.8">{intro}</p></td></tr>
<tr><td style="padding:16px 32px"><div style="padding:24px 12px;border:1px solid #dce1f5;border-radius:8px;background:#f5f7ff;text-align:center"><span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#3550d4;font-family:Consolas,monospace">{escape(code)}</span></div></td></tr>
<tr><td style="padding:8px 32px 32px"><p style="margin:0;color:#4a4a54;font-size:13px;line-height:1.8">{note}</p><p style="margin:16px 0 0;color:#6b6b76;font-size:12px;line-height:1.8">如果不是你本人操作，请忽略此邮件。无需回复。</p></td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #ededef;color:#6b6b76;font-size:12px;line-height:1.8">千片成璧，唯你可合。<br>你的文件空间，由你掌握。</td></tr>
</table></td></tr></table></body></html>""", subtype="html")
    return message


def send_mail(config: dict, password: str, message: EmailMessage) -> None:
    """服务器地址仅由管理员配置；禁止明文连接或跳过证书校验。"""
    context = ssl.create_default_context()
    client_type = smtplib.SMTP_SSL if config["security"] == "ssl" else smtplib.SMTP
    options = {"timeout": 10, "local_hostname": "tessera"}
    if config["security"] == "ssl":
        options["context"] = context
    try:
        with client_type(config["host"], config["port"], **options) as smtp:
            if config["security"] == "starttls":
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
            if config["username"]:
                smtp.login(config["username"], password)
            smtp.send_message(message, from_addr=config["sender"], to_addrs=[str(message["To"])])
    except smtplib.SMTPAuthenticationError:
        raise ValueError("邮件服务器认证失败，请管理员检查账号与授权码") from None
    except ssl.SSLError:
        raise ValueError("邮件服务器 TLS 验证失败，请管理员检查证书与加密方式") from None
    except (OSError, smtplib.SMTPException):
        # 上游异常可能带认证内容和收件地址，不向访客回显原文，也不记录到日志。
        raise ValueError("邮件发送失败，请稍后重试或联系管理员检查邮件服务器") from None
