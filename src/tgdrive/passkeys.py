"""账号与私密空间共用的通行密钥：固定来源、一次性挑战和服务端验签。"""

from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import json
import re
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from .authn import AuthenticationError, TooManyAttempts
from .errors import NotReadyError
from .settings import normalize_origin

try:
    from webauthn import (
        generate_authentication_options, generate_registration_options, options_to_json,
        verify_authentication_response, verify_registration_response,
    )
    from webauthn.helpers.structs import (
        AuthenticatorAttachment, AuthenticatorSelectionCriteria, AuthenticatorTransport,
        CredentialDeviceType, PublicKeyCredentialDescriptor, ResidentKeyRequirement,
        UserVerificationRequirement,
    )
except ImportError:
    AVAILABLE = False
else:
    AVAILABLE = True


@dataclass
class Challenge:
    kind: str
    session: str
    user_id: int | None
    value: bytes
    origin: str
    rp_id: str
    password_hash: str | None
    expires_at: float
    name: str = ""
    remember: bool = False
    used: bool = False


class Passkeys:
    MAX_CREDENTIALS = 10
    MAX_CHALLENGES = 512
    CHALLENGE_SECONDS = 120
    TRANSPORTS = {"internal", "hybrid", "usb", "nfc", "ble", "smart-card"}

    def __init__(self, user, settings, space):
        self.user, self.settings, self.space = user, settings, space
        self.accounts = user.accounts
        self.metadata = self.accounts.metadata
        self.pending: dict[str, Challenge] = {}

    @staticmethod
    def _origin(value):
        if not isinstance(value, str) or len(value) > 2048:
            raise ValueError("无法确认当前站点地址")
        origin = normalize_origin(value, "站点地址")
        if not origin:
            raise ValueError("无法确认当前站点地址")
        parts = urlsplit(origin)
        host = parts.hostname.encode("idna").decode("ascii")
        if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*", host):
            raise ValueError("通行密钥需要 HTTPS 域名；本地开发请使用 localhost")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError("通行密钥需要 HTTPS 域名；本地开发请使用 localhost")
        if parts.scheme != "https" and host != "localhost":
            raise ValueError("通行密钥需要 HTTPS；本地开发请使用 localhost")
        return f"{parts.scheme}://{host}" + (f":{parts.port}" if parts.port else ""), host

    def _site(self, origin, *, verify=False):
        configured = self.settings.get("public_base_url") if self.settings else None
        if configured:
            expected, rp_id = self._origin(configured)
        else:
            expected, rp_id = self._origin(origin)
            if rp_id != "localhost":
                raise ValueError("请管理员在系统设置中配置本站的 HTTPS 公开访问地址")
        if verify and self._origin(origin)[0] != expected:
            raise ValueError("当前地址与本站公开访问地址不同，请从已配置的站点地址使用通行密钥")
        return expected, rp_id

    def capability(self, user_id, origin):
        expected = rp_id = reason = None
        try:
            expected, rp_id = self._site(origin)
        except (ValueError, UnicodeError):
            reason = "请使用已配置的 HTTPS 公开访问地址；本地开发请使用 localhost"
        if not AVAILABLE:
            reason = "服务器缺少通行密钥组件，请更新并安装项目依赖"
        count = self.metadata.db.execute(
            "SELECT count(*) FROM account_passkeys WHERE user_id=? AND rp_id=?", (user_id, rp_id)
        ).fetchone()[0] if user_id is not None and rp_id else 0
        return {"available": reason is None, "origin": expected, "rp_id": rp_id,
                "reason": reason, "registered": count}

    def _require_site(self, origin):
        if not AVAILABLE:
            raise ValueError("服务器缺少通行密钥组件，请更新并安装项目依赖")
        try:
            return self._site(origin, verify=True)
        except UnicodeError as exc:
            raise ValueError("站点域名不合法") from exc

    def _account(self, token, csrf=None, mutation=False, *, private=False):
        session = (self.user._session(token, csrf=csrf, mutation=mutation) if private else
                   self.accounts.sessions.require(token, csrf=csrf, mutation=mutation))
        account = self.accounts.account_for_session(session)
        if not self.accounts.keystore.unlocked and account.role != "admin":
            raise NotReadyError("system is locked")
        return account

    def _user_row(self, user_id):
        return self.metadata.db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()

    def revoke(self, *, user_id=None, token=None, kind=None):
        for key, item in list(self.pending.items()):
            if kind is not None and item.kind != kind:
                continue
            if (user_id is not None and item.user_id == user_id) or (token is not None and item.session == token):
                self.pending.pop(key, None)

    def _rate(self, user_id, ip, *, private=False, failed=False, success=False):
        sessions = self.accounts.sessions
        purpose = "private" if private else "account"
        identities = [f"{purpose}-user:{user_id}"] + ([f"{purpose}-ip:{ip}"] if ip else [])
        if failed:
            for identity in identities:
                sessions.record_failure(identity)
        elif success:
            for identity in identities:
                sessions.clear_failures(identity)
        elif any(sessions.is_rate_limited(identity) for identity in identities):
            raise TooManyAttempts("验证失败次数过多，请稍后重试")

    def _login_rate(self, ip, *, begin=False, failed=False):
        identity = f"ip:{ip or '-'}"
        sessions = self.accounts.sessions
        if failed:
            sessions.record_failure(identity)
        elif sessions.is_rate_limited(identity, limit=self.accounts.MAX_FAILURES_PER_IP):
            raise TooManyAttempts("登录失败次数过多，请稍后重试")
        if begin:
            identity = f"passkey-options:{ip or '-'}"
            if sessions.is_rate_limited(identity, limit=60):
                raise TooManyAttempts("登录请求过多，请稍后重试")
            sessions.record_failure(identity)

    @staticmethod
    def _name(name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or any(ord(c) < 32 for c in name):
            raise ValueError("凭据名称需要 1 至 80 个字符")
        return name.strip()

    @staticmethod
    def _decode(value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,1366}", value):
            raise ValueError("通行密钥响应不合法")
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        if not 1 <= len(raw) <= 1024 or base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != value:
            raise ValueError("通行密钥响应不合法")
        return raw

    @classmethod
    def _credential(cls, value):
        if (not isinstance(value, dict) or value.get("type") != "public-key"
                or not isinstance(value.get("response"), dict)
                or len(json.dumps(value).encode()) > 128 * 1024):
            raise ValueError("通行密钥响应不合法")
        if cls._decode(value.get("id")) != cls._decode(value.get("rawId")):
            raise ValueError("通行密钥响应不合法")
        return value

    def _new(self, kind, token, row, origin, *, name="", remember=False):
        if kind != "login" and row is None:
            raise ValueError("账号已变化，请重新登录")
        expected, rp_id = self._require_site(origin)
        now = time.monotonic()
        for key, item in list(self.pending.items()):
            if item.expires_at <= now or (item.session == token and item.kind == kind):
                self.pending.pop(key, None)
        if len(self.pending) >= self.MAX_CHALLENGES:
            raise ValueError("通行密钥请求过多，请稍后重试")
        request_id = secrets.token_urlsafe(24)
        item = Challenge(kind=kind, session=token, user_id=row["id"] if row is not None else None,
                         value=secrets.token_bytes(32), origin=expected, rp_id=rp_id,
                         password_hash=row["password_hash"] if row is not None else None,
                         expires_at=now + self.CHALLENGE_SECONDS, name=name, remember=remember)
        self.pending[request_id] = item
        return request_id, item

    def _current(self, request_id, item, token, csrf, origin):
        if (self.pending.get(request_id) is not item or item.expires_at <= time.monotonic()
                or not self._bound(item, token)
                or self._require_site(origin) != (item.origin, item.rp_id)):
            raise ValueError("通行密钥请求已失效，请重试")
        if item.kind != "login":
            account = self._account(token, csrf, True, private=item.kind == "private")
            row = self._user_row(account.id)
            if (item.user_id != account.id or row is None or row["password_hash"] != item.password_hash):
                raise ValueError("登录凭据已变化，请重新验证")
            return row
        return None

    @staticmethod
    def _bound(item, token):
        return isinstance(token, str) and token.isascii() and hmac.compare_digest(item.session, token)

    def _take(self, kind, token, csrf, request_id, origin, ip):
        if kind == "login":
            self._login_rate(ip)
        else:
            account = self._account(token, csrf, True, private=kind == "private")
            self._rate(account.id, ip, private=kind == "private")
        item = self.pending.get(request_id) if isinstance(request_id, str) else None
        if item is None or item.kind != kind or item.used or not self._bound(item, token):
            if kind != "login":
                self._rate(account.id, ip, private=kind == "private", failed=True)
            else:
                self._login_rate(ip, failed=True)
            raise ValueError("通行密钥请求已失效，请重试")
        item.used = True
        try:
            self._current(request_id, item, token, csrf, origin)
        except Exception:
            self.pending.pop(request_id, None)
            raise
        return item

    def _rows(self, user_id, rp_id=None):
        sql, args = "SELECT * FROM account_passkeys WHERE user_id=?", [user_id]
        if rp_id is not None:
            sql += " AND rp_id=?"
            args.append(rp_id)
        return self.metadata.db.execute(sql + " ORDER BY id", args).fetchall()

    def list(self, token, origin):
        account = self._account(token)
        return {"capability": self.capability(account.id, origin),
                "passkeys": [{**{key: row[key] for key in ("id", "name", "rp_id", "created_at", "last_used_at")},
                             "login_enabled": bool(row["login_enabled"])} for row in self._rows(account.id)]}

    async def registration_options(self, token, csrf, password, name, origin, ip=None):
        self._account(token, csrf, True)
        self._require_site(origin)
        name = self._name(name)
        account, row = await self.accounts.confirm_password(token, csrf, password, ip=ip)
        self._account(token, csrf, True)
        if len(self._rows(account.id)) >= self.MAX_CREDENTIALS:
            raise ValueError("最多绑定 10 个通行密钥，请先移除旧凭据")
        with self.metadata.transaction() as db:
            current = self._user_row(account.id)
            if current is None or current["password_hash"] != row["password_hash"]:
                raise ValueError("登录密码已修改，请重新验证")
            db.execute("UPDATE users SET webauthn_user_handle=COALESCE(webauthn_user_handle,?) WHERE id=?",
                       (secrets.token_bytes(32), account.id))
            row = self._user_row(account.id)
        request_id, item = self._new("register", token, row, origin, name=name)
        options = generate_registration_options(
            rp_id=item.rp_id, rp_name="Tessera", user_name=account.username,
            user_id=row["webauthn_user_handle"], user_display_name=account.nickname or account.username,
            challenge=item.value, timeout=self.CHALLENGE_SECONDS * 1000,
            authenticator_selection=AuthenticatorSelectionCriteria(
                authenticator_attachment=AuthenticatorAttachment.PLATFORM,
                resident_key=ResidentKeyRequirement.REQUIRED,
                require_resident_key=True,
                user_verification=UserVerificationRequirement.REQUIRED),
            exclude_credentials=[PublicKeyCredentialDescriptor(id=r["credential_id"])
                                 for r in self._rows(account.id, item.rp_id)])
        return {"request_id": request_id, "options": json.loads(options_to_json(options))}

    async def register(self, token, csrf, request_id, credential, origin, ip=None):
        item = self._take("register", token, csrf, request_id, origin, ip)
        try:
            credential = self._credential(credential)
            try:
                verified = await asyncio.to_thread(
                    verify_registration_response, credential=credential, expected_challenge=item.value,
                    expected_rp_id=item.rp_id, expected_origin=item.origin, require_user_verification=True)
            except Exception as exc:
                raise ValueError("通行密钥验证失败，请完成设备验证后重试") from exc
            transports = credential["response"].get("transports", [])
            transports = [t for t in transports if isinstance(t, str) and t in self.TRANSPORTS][:6] if isinstance(transports, list) else []
            with self.metadata.transaction() as db:
                self._current(request_id, item, token, csrf, origin)
                if len(self._rows(item.user_id)) >= self.MAX_CREDENTIALS:
                    raise ValueError("最多绑定 10 个通行密钥，请先移除旧凭据")
                if db.execute("SELECT 1 FROM account_passkeys WHERE credential_id=?", (verified.credential_id,)).fetchone():
                    raise ValueError("这个通行密钥已经绑定，请使用其他凭据")
                cursor = db.execute(
                    "INSERT INTO account_passkeys(user_id,credential_id,public_key,sign_count,rp_id,name,transports,"
                    "backup_eligible,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (item.user_id, verified.credential_id, verified.credential_public_key, verified.sign_count,
                     item.rp_id, item.name, json.dumps(transports),
                     int(verified.credential_device_type == CredentialDeviceType.MULTI_DEVICE),
                     int(verified.credential_backed_up), time.time()))
            self._rate(item.user_id, ip, success=True)
            return {"id": cursor.lastrowid}
        except ValueError:
            self._rate(item.user_id, ip, failed=True)
            raise
        finally:
            self.pending.pop(request_id, None)

    def private_options(self, token, csrf, origin, ip=None):
        account = self._account(token, csrf, True, private=True)
        self._rate(account.id, ip, private=True)
        _, rp_id = self._require_site(origin)
        rows = self._rows(account.id, rp_id)
        if not rows:
            raise ValueError("本站还没有绑定通行密钥，请使用登录密码解锁，并在用户设置中添加凭据")
        request_id, item = self._new("private", token, self._user_row(account.id), origin)
        options = generate_authentication_options(
            rp_id=rp_id, challenge=item.value, timeout=self.CHALLENGE_SECONDS * 1000,
            user_verification=UserVerificationRequirement.REQUIRED,
            allow_credentials=[PublicKeyCredentialDescriptor(
                id=r["credential_id"], transports=[AuthenticatorTransport(t) for t in json.loads(r["transports"])])
                for r in rows])
        return {"request_id": request_id, "options": json.loads(options_to_json(options))}

    def login_options(self, origin, browser_token, ip=None, *, remember=False):
        self._login_rate(ip, begin=True)
        if not self.accounts.keystore.is_initialized():
            raise NotReadyError("请先完成系统初始化")
        request_id, item = self._new("login", browser_token, None, origin, remember=remember is True)
        # 登录不枚举用户名或凭据 ID；设备选择可发现凭据，验证后才确定账号。
        options = generate_authentication_options(
            rp_id=item.rp_id, challenge=item.value, timeout=self.CHALLENGE_SECONDS * 1000,
            user_verification=UserVerificationRequirement.REQUIRED)
        return {"request_id": request_id, "options": json.loads(options_to_json(options))}

    async def _authenticate(self, request_id, item, token, csrf, credential, origin, ip):
        credential = self._credential(credential)
        credential_id = self._decode(credential["id"])
        sql, args = "SELECT * FROM account_passkeys WHERE rp_id=? AND credential_id=?", [item.rp_id, credential_id]
        if item.kind == "login":
            sql += " AND login_enabled=1"
        else:
            sql += " AND user_id=?"
            args.append(item.user_id)
        stored = self.metadata.db.execute(sql, args).fetchone()
        if stored is None:
            raise ValueError("凭据不可用，请使用登录密码，并在用户设置中检查通行密钥")
        user_row = self._user_row(stored["user_id"])
        if user_row is None or user_row["status"] != "active":
            raise AuthenticationError("invalid credentials")
        if item.kind == "login":
            item.user_id = stored["user_id"]
        handle = credential["response"].get("userHandle")
        if (item.kind == "login" and handle is None) or (handle is not None and self._decode(handle) != user_row["webauthn_user_handle"]):
            raise ValueError("通行密钥不属于当前账号，请使用登录密码")
        try:
            verified = await asyncio.to_thread(
                verify_authentication_response, credential=credential, expected_challenge=item.value,
                expected_rp_id=item.rp_id, expected_origin=item.origin,
                credential_public_key=stored["public_key"], credential_current_sign_count=stored["sign_count"],
                require_user_verification=True)
        except Exception as exc:
            raise ValueError("通行密钥验证失败，请重试或使用登录密码") from exc
        with self.metadata.transaction() as db:
            self._current(request_id, item, token, csrf, origin)
            current = self._user_row(stored["user_id"])
            if current is None or current["status"] != "active" or current["password_hash"] != user_row["password_hash"]:
                raise ValueError("登录凭据已变化，请重新验证")
            if not self.accounts.keystore.unlocked and (item.kind != "login" or current["role"] != "admin"):
                raise NotReadyError("system is locked")
            if int(verified.credential_device_type == CredentialDeviceType.MULTI_DEVICE) != stored["backup_eligible"]:
                raise ValueError("通行密钥状态变化，请使用登录密码重新绑定")
            updated = db.execute(
                "UPDATE account_passkeys SET sign_count=?,backed_up=?,last_used_at=? "
                "WHERE id=? AND user_id=? AND sign_count=? AND public_key=?" +
                (" AND login_enabled=1" if item.kind == "login" else ""),
                (verified.new_sign_count, int(verified.credential_backed_up), time.time(),
                 stored["id"], stored["user_id"], stored["sign_count"], stored["public_key"]))
            if updated.rowcount != 1:
                raise ValueError("通行密钥已变更，请重试或使用登录密码")
            if item.kind == "login":
                return self.accounts._finish_login(current, True, current["username"], ip, item.remember)
            config = self.space.ensure_config(current["id"])
            return self.space._issue(token, current["id"], config["idle_seconds"],
                                     password_hash=current["password_hash"])

    async def private_unlock(self, token, csrf, request_id, credential, origin, ip=None):
        item = self._take("private", token, csrf, request_id, origin, ip)
        try:
            grant = await self._authenticate(request_id, item, token, csrf, credential, origin, ip)
            self._rate(item.user_id, ip, private=True, success=True)
            return grant
        except ValueError:
            self._rate(item.user_id, ip, private=True, failed=True)
            raise
        finally:
            self.pending.pop(request_id, None)

    async def login(self, browser_token, request_id, credential, origin, ip=None):
        item = self._take("login", browser_token, None, request_id, origin, ip)
        try:
            return await self._authenticate(request_id, item, browser_token, None, credential, origin, ip)
        except (ValueError, AuthenticationError):
            self._login_rate(ip, failed=True)
            raise
        finally:
            self.pending.pop(request_id, None)

    async def manage(self, token, csrf, password, credential_id, *, name=None, delete=False, enable_login=False, ip=None):
        self._account(token, csrf, True)
        if isinstance(credential_id, bool) or not isinstance(credential_id, int):
            raise ValueError("凭据编号不合法")
        if not delete and not enable_login:
            name = self._name(name)
        account, verified = await self.accounts.confirm_password(token, csrf, password, ip=ip)
        with self.metadata.transaction() as db:
            self._account(token, csrf, True)
            current = self._user_row(account.id)
            if current is None or current["password_hash"] != verified["password_hash"]:
                raise ValueError("登录密码已修改，请重新验证")
            if delete:
                result = db.execute("DELETE FROM account_passkeys WHERE id=? AND user_id=?", (credential_id, account.id))
            elif enable_login:
                result = db.execute("UPDATE account_passkeys SET login_enabled=1 WHERE id=? AND user_id=?", (credential_id, account.id))
            else:
                result = db.execute("UPDATE account_passkeys SET name=? WHERE id=? AND user_id=?", (name, credential_id, account.id))
            if result.rowcount != 1:
                raise ValueError("通行密钥不存在或已被移除")
        if delete:
            self.revoke(user_id=account.id)
            self.space.revoke_user(account.id)
            self.accounts.sessions.clear_user(account.id, keep=token)
        return {"id": credential_id}
