import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { BRAND } from "../brand";
import { Button, Icon, PageHeader, useDocumentTitle } from "../ui";
import { FilesView } from "./files";
import { TrashView } from "./trash";
import type { UploadQueue } from "./uploads";
import { PrivateUnlockForm } from "./private-access";
import { usePrivateAccess, usePrivateSession } from "./private-session";

export function PrivateSpaceView({ session, prefix, onOpenFolder, onChanged, uploads, uploadRevision }: {
  session: api.Session; prefix: string; onOpenFolder: (prefix: string) => void; onChanged: () => void;
  uploads: UploadQueue; uploadRevision: number;
}) {
  useDocumentTitle(`私密空间 · ${BRAND}`);
  const access = usePrivateAccess(), grant = access.grant;
  const [trash, setTrash] = useState(false);
  const uploadsRef = useRef(uploads); uploadsRef.current = uploads;
  const unlocked = usePrivateSession(grant, () => { uploadsRef.current.cancelPrivate(); setTrash(false); },
    ".private-space, .preview-modal.is-private, .private-dialog, .private-transfer");
  useEffect(() => () => { uploadsRef.current.cancelPrivate(); }, []);
  if (!grant) return <>
    <PageHeader title="私密空间" description="使用账号登录密码或通行密钥解锁，无操作后自动锁定。" />
    <section className="private-gate" aria-label="解锁私密空间">
      <span className="locked-icon"><Icon name="lock" size={26} /></span>
      <h2>{access.restoring ? "正在检查解锁状态" : "解锁后查看私密文件"}</h2>
      {access.restoring ? <div className="private-loading" role="status"><span className="spinner" />正在检查私密空间</div> : access.error ? <div className="form"><p className="form-alert" role="alert">{access.error}</p><Button onClick={access.restore}>重试</Button></div>
        : <PrivateUnlockForm />}
    </section>
  </>;
  return <div className="private-space">
    <div className="private-toolbar">
      <span className="private-status"><Icon name="unlock" size={16} />已解锁<span className="muted">无操作 {grant.idle_seconds / 60} 分钟后锁定</span></span>
      <div className="toolbar-actions">
        <Button size="sm" icon={trash ? "folder" : "trash"} onClick={() => setTrash(value => !value)}>{trash ? "返回私密文件" : "私密回收站"}</Button>
        <Button size="sm" icon="lock" onClick={unlocked.lock}>立即锁定</Button>
      </div>
    </div>
    {trash ? <TrashView root={api.PRIVATE_PREFIX} onChanged={onChanged} onOpenFolder={path => { setTrash(false); onOpenFolder(path); }} />
      : <FilesView key={grant.access} session={session} prefix={prefix} onOpenFolder={onOpenFolder} onChanged={onChanged} uploads={uploads} uploadRevision={uploadRevision} onPlayback={unlocked.onPlayback} />}
  </div>;
}
