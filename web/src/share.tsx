/** 公开分享页：无需登录，只暴露文件名、大小和内容。带密码的分享先验证密码。 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "./api";
import { FilePreview, FileTile, canPreview, getFileKind, kindLabel } from "./files";
import { Brand, Button, EmptyState, Field, Icon, SkeletonRows, Toaster, copyText, formatBytes, formatDateTime } from "./ui";

type Shared = Extract<api.PublicObject, { password_required: false }>;

/** 验证密码后获得的访问凭证按分享令牌保存在本标签页，刷新页面无需重新输入。 */
const accessKey = (token: string) => `tgdrive:share-access:${token}`;

export function SharePage({ token }: { token: string }) {
  const [file, setFile] = useState<Shared | null>(null);
  const [locked, setLocked] = useState(false);
  const [access, setAccess] = useState<string | null>(() => sessionStorage.getItem(accessKey(token)));
  const [error, setError] = useState<{ status: number; code: string } | null>(null);
  const load = useCallback((grant: string | null) => {
    void api.publicObject(token, grant)
      .then(value => {
        if (value.password_required) {
          sessionStorage.removeItem(accessKey(token));
          setLocked(true); setFile(null);
          document.title = "需要访问密码 · tgdrive";
        } else {
          setLocked(false); setFile(value);
          document.title = `${value.name} · tgdrive`;
        }
      })
      .catch(reason => {
        setError({ status: reason instanceof api.ApiError ? reason.status : 0, code: reason instanceof api.ApiError ? reason.code : "" });
        document.title = "链接不可用 · tgdrive";
      });
  }, [token]);
  useEffect(() => load(access), [load, access]);
  const kind = file ? getFileKind(file.content_type, file.name) : "other";
  const url = file ? api.publicPath(token, file.name, false, access) : "";
  const downloadUrl = file ? api.publicPath(token, file.name, true, access) : "";
  return (
    <div className="share-page">
      <header className="share-bar">
        <Brand />
        <span className="share-bar-note"><Icon name="globe" size={15} />公开分享</span>
      </header>
      <main className="share-main">
        {error ? (
          <div className="share-card share-missing">
            <EmptyState icon={error.status === 503 ? "lock" : "link"}
              title={error.status === 503 ? "存储服务暂时不可用" : error.code === "share_expired" ? "这个链接已过期" : "这个链接已失效"}
              description={error.status === 503 ? "服务正在维护或尚未解锁，请稍后再试。"
                : error.code === "share_expired" ? "分享者设置的有效期已过。如仍需要，请联系分享者重新分享。"
                  : "分享者可能已关闭公开访问、删除了文件，或链接输入有误。"} />
          </div>
        ) : locked ? (
          <PasswordGate token={token} onUnlocked={grant => { sessionStorage.setItem(accessKey(token), grant); setAccess(grant); }} />
        ) : !file ? (
          <div className="share-card"><SkeletonRows rows={3} /></div>
        ) : (
          <article className="share-card">
            <header className="share-head">
              <FileTile kind={kind} size="lg" />
              <div className="share-title">
                <h1>{file.name}</h1>
                <p>
                  <span>{formatBytes(file.size)}</span><span>{kindLabel(kind)}</span><span>更新于 {formatDateTime(file.modified_at)}</span>
                  {file.expires_at && <span>链接有效期至 {formatDateTime(file.expires_at)}</span>}
                </p>
              </div>
              <div className="share-actions">
                <Button icon="link" onClick={() => void copyText(`${window.location.origin}${window.location.pathname}`, "分享链接已复制")}>复制链接</Button>
                <a className="btn btn-primary btn-md" href={downloadUrl}><Icon name="download" size={17} /><span>下载</span></a>
              </div>
            </header>
            {canPreview(kind) && <div className="share-preview"><FilePreview kind={kind} url={url} name={file.name} downloadUrl={downloadUrl} /></div>}
          </article>
        )}
        <p className="share-footnote">文件由 tgdrive 用户公开分享。内容在服务端加密存储，仅通过此链接对外提供。</p>
      </main>
      <Toaster />
    </div>
  );
}

function PasswordGate({ token, onUnlocked }: { token: string; onUnlocked: (grant: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) { setError("请输入访问密码"); return; }
    setBusy(true); setError("");
    try { onUnlocked((await api.unlockShare(token, password)).access); }
    catch (reason) {
      setError(reason instanceof api.ApiError && reason.status === 429 ? "尝试次数过多，请 15 分钟后再试" : api.errorMessage(reason, "验证失败"));
    } finally { setBusy(false); }
  }
  return (
    <div className="share-card share-gate">
      <span className="empty-icon"><Icon name="lock" size={22} /></span>
      <h1>需要访问密码</h1>
      <p>分享者为这个文件设置了访问密码。</p>
      <form className="form" onSubmit={submit} noValidate>
        <Field label="访问密码" htmlFor="share-password" error={error}>
          <input id="share-password" className="input" type="password" autoComplete="off" value={password} autoFocus
            onChange={event => { setPassword(event.target.value); setError(""); }} />
        </Field>
        <Button type="submit" variant="primary" block loading={busy}>查看文件</Button>
      </form>
    </div>
  );
}
