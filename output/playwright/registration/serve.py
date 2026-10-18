"""仅用于独立临时数据的本地浏览器验证；邮件写入本地预览，不联网发送。"""
import tempfile
from pathlib import Path

import uvicorn

from tgdrive.app import create_app
from tgdrive.mailer import verification_message

artifacts = Path(__file__).resolve().parent
data = Path(tempfile.mkdtemp(prefix="tgdrive-registration-ui-"))
app = create_app(data, static_dir=Path.cwd() / "web/dist", secure_cookies=False, run_scheduler=False)
app.accounts.setup("temporary verification encryption", "admin@registration.test", "temporary verification password", nickname="注册验证")


def fake_mail(config, password, message):
    (artifacts / "email.html").write_text(message.get_body(preferencelist=("html",)).get_content())
    (artifacts / "email.txt").write_text(message.get_body(preferencelist=("plain",)).get_content())


app.registration.sender = fake_mail
sample = verification_message("noreply@registration.test", "Tessera", "visitor@registration.test", "392761")
(artifacts / "email.html").write_text(sample.get_body(preferencelist=("html",)).get_content())


async def verified_app(scope, receive, send):
    if scope["type"] == "http" and scope["path"] == "/__verify_email":
        body = (artifacts / "email.html").read_bytes()
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/html; charset=utf-8")]})
        await send({"type": "http.response.body", "body": body})
    else:
        await app(scope, receive, send)


uvicorn.run(verified_app, host="127.0.0.1", port=8157, log_level="warning")
