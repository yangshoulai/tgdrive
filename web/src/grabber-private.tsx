import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PrivateStatus } from "./api";
import { authenticatePasskey, passkeyUnavailable, type AuthenticationOptions } from "./passkeys";
import { Button, Field, Notice } from "./ui";

/** 只在 Tessera 来源的独立文档输入密码；与用户脚本通过专用 MessagePort 通信。 */
export function App() {
  const key = useRef(""), client = useRef(""), port = useRef<MessagePort | null>(null);
  const [status, setStatus] = useState<PrivateStatus | null>(null);
  const [source, setSource] = useState(""), [password, setPassword] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const operation = useRef<AbortController | null>(null);

  async function request(path: string, body?: object) {
    const response = await fetch(new URL(`../api/v1/private${path}`, location.href), {
      method: body ? "POST" : "GET", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${key.current}`, "Content-Type": "application/json", "X-Tessera-Private-Client": client.current },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error?.message || "无法解锁，请稍后重试");
    return result;
  }

  function accept(grant: object) {
    setPassword(""); setDone(true);
    port.current?.postMessage({ type: "unlocked", grant });
  }

  useEffect(() => {
    const parent = window.opener || window.parent;
    const connect = (event: MessageEvent) => {
      if (event.source !== parent || event.data?.type !== "tessera-private-connect" || !event.ports[0] || port.current) return;
      setSource(event.origin);
      const channel = event.ports[0]; port.current = channel;
      channel.onmessage = message => {
        if (message.data?.type !== "init" || key.current || typeof message.data.key !== "string" || message.data.key.length > 512
            || typeof message.data.client !== "string" || !/^[a-f0-9]{64}$/.test(message.data.client)) return;
        key.current = message.data.key;
        client.current = message.data.client;
        void request("/status").then(value => {
          setStatus(value);
          if (value.unlocked && value.access) accept(value);
        }).catch(reason => setError(reason.message));
      };
      channel.start();
    };
    window.addEventListener("message", connect);
    if (parent !== window) parent.postMessage({ type: "tessera-private-ready" }, "*");
    else setError("请从 Tessera 资源抓取脚本打开这个解锁窗口。");
    return () => { window.removeEventListener("message", connect); operation.current?.abort(); port.current?.close(); key.current = ""; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !password || !status) return;
    setBusy(true); setError("");
    try { accept(await request("/unlock", { password })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "解锁失败，请重试"); }
    finally { setBusy(false); }
  }

  async function quickUnlock() {
    if (busy) return;
    setBusy(true); setError("");
    const controller = new AbortController(); operation.current = controller;
    try {
      const challenge: { request_id: string; options: AuthenticationOptions } = await request("/passkeys/unlock/options", {});
      const credential = await authenticatePasskey(challenge.options, controller.signal);
      accept(await request("/passkeys/unlock/verify", { request_id: challenge.request_id, credential }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "当前环境不能快捷解锁，请使用登录密码"); }
    finally { setBusy(false); }
  }

  const policy = (document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean } }).permissionsPolicy;
  const quick = status && status.passkeys.registered > 0 && !passkeyUnavailable(status.passkeys)
    && (!policy || policy.allowsFeature("publickey-credentials-get"));
  return <main className="grabber-private">
    <h2>解锁私密空间</h2>
    <p className="muted">密码只发送到 {location.origin}，不会交给当前网页或脚本。</p>
    {source && <p className="muted grabber-private-origin">请求来源：{source}</p>}
    {done ? <Notice>已解锁，可以继续选择目录或发送文件。</Notice> : <form className="form" onSubmit={submit}>
      {error && <Notice tone="danger">{error}</Notice>}
      {!status ? <p role="status">{error ? "请关闭后重新打开解锁窗口。" : "正在连接私密空间…"}</p> : <>
        {quick && <Button onClick={() => void quickUnlock()} disabled={busy} loading={busy}>快捷解锁</Button>}
        <Field label="账号登录密码" htmlFor="private-password">
          <input id="private-password" className="input" type="password" autoComplete="current-password" value={password}
            disabled={busy} onChange={event => { setPassword(event.target.value); setError(""); }} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !password} loading={busy}>解锁</Button>
        <p className="muted">私密操作会延长解锁时间，无操作 {status.idle_seconds / 60} 分钟后自动锁定。密码不会被保存。</p>
      </>}
    </form>}
  </main>;
}
