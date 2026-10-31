import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { BRAND } from "../brand";
import { Notice, Button, Icon, PageHeader, formatBytes, useDocumentTitle } from "../ui";
import { FilesView } from "./files";
import { TrashView } from "./trash";
import { PRIVATE_SECTION_EVENT, setPrivateSection } from "./assistant-bridge";
import type { UploadQueue } from "./uploads";
import { PrivateUnlockDialog } from "./private-unlock";
import { usePrivateAccess, usePrivateSession } from "./private-session";
import { takeTransferRequest, useTransferReceiver, type TransferState } from "./transfer";

/** 抓取脚本转交文件时的状态条：接收进度、来源与错误。文件在解锁并确认上传前只保存在本页内存中。 */
function TransferNotice({ transfer, unlocked, onDiscard }: { transfer: TransferState; unlocked: boolean; onDiscard: () => void }) {
  const count = transfer.files.length;
  const size = transfer.files.reduce((sum, file) => sum + file.size, 0);
  const text = transfer.error ? transfer.error
    : !transfer.ended ? `正在接收文件…已收到 ${count} 个（${formatBytes(size)}）`
    : count ? unlocked ? `已收到 ${count} 个文件，请在上传对话框中确认` : `已收到 ${count} 个文件（${formatBytes(size)}），解锁后确认上传到私密空间`
    : "没有收到可上传的文件";
  return <div className={`transfer-notice${transfer.error ? " is-error" : ""}`} role="status">
    <Icon name={transfer.error ? "alert" : transfer.ended ? "upload" : "download"} size={16} />
    <span className="transfer-notice-text"><strong>来自资源抓取脚本</strong><span className="muted">{transfer.request.origin.replace(/^https?:\/\//, "")}</span>{text}
      {transfer.rejected > 0 && <span className="muted">已拒收 {transfer.rejected} 个（为空、超过 64 MB 或超出数量）</span>}</span>
    {(transfer.ended || transfer.error) && <Button size="sm" variant="ghost" onClick={onDiscard}>{count && !transfer.error ? "放弃" : "关闭"}</Button>}
  </div>;
}

export function PrivateSpaceView({ session, prefix, onOpenFolder, onChanged, uploads, uploadRevision }: {
  session: api.Session; prefix: string; onOpenFolder: (prefix: string) => void; onChanged: () => void;
  uploads: UploadQueue; uploadRevision: number;
}) {
  useDocumentTitle(`私密空间 · ${BRAND}`);
  const access = usePrivateAccess(), grant = access.grant;
  const [trash, setTrash] = useState(false);
  const [unlocking, setUnlocking] = useState(true);
  // 解锁成功时解锁框随锁定页一起卸载，来不及回调，这里收起：之后手动锁定不再自动弹出。
  useEffect(() => { if (grant) setUnlocking(false); }, [grant]);
  const [transferRequest] = useState(takeTransferRequest);
  const [transfer, discardTransfer] = useTransferReceiver(transferRequest);
  const incoming = transfer && transfer.ended && !transfer.error && transfer.files.length ? transfer.files : null;
  const uploadsRef = useRef(uploads); uploadsRef.current = uploads;
  const unlocked = usePrivateSession(grant, () => { uploadsRef.current.cancelPrivate(); setTrash(false); },
    ".private-space, .preview-modal.is-private, .private-dialog, .private-transfer");
  // 私密对话的浏览器工具读取和切换当前显示的是私密文件还是私密回收站。
  useEffect(() => { setPrivateSection(trash ? "trash" : "files"); return () => setPrivateSection("files"); }, [trash]);
  useEffect(() => {
    const listener = (event: Event) => setTrash((event as CustomEvent<string>).detail === "trash");
    window.addEventListener(PRIVATE_SECTION_EVENT, listener);
    return () => window.removeEventListener(PRIVATE_SECTION_EVENT, listener);
  }, []);
  if (!grant) return <>
    <PageHeader title="私密空间" description="使用账号登录密码或通行密钥解锁，无操作后自动锁定。" />
    {transfer && <TransferNotice transfer={transfer} unlocked={false} onDiscard={discardTransfer} />}
    <section className="private-gate" aria-label="私密空间已锁定">
      <span className="locked-icon"><Icon name="lock" size={26} /></span>
      <h2>{access.restoring ? "正在检查解锁状态" : "私密空间已锁定"}</h2>
      {access.restoring ? <div className="private-loading" role="status"><span className="spinner" />正在检查私密空间</div> : <>
        <p className="muted">解锁后查看和管理私密文件。</p>
        <Button variant="primary" icon="unlock" onClick={() => setUnlocking(true)}>解锁</Button>
      </>}
    </section>
    {/* 进入页面时直接弹出解锁框；关闭后可用上面的按钮重新打开，手动锁定后不自动弹出。 */}
    {unlocking && !access.restoring && <PrivateUnlockDialog description="解锁后查看和管理私密文件。"
      onClose={() => setUnlocking(false)} onUnlocked={() => setUnlocking(false)} />}
  </>;
  return <div className="private-space">
    <div className="private-toolbar">
      <span className="private-status"><Icon name="unlock" size={16} />已解锁<span className="muted">无操作 {grant.idle_seconds / 60} 分钟后锁定</span></span>
      <div className="toolbar-actions">
        <Button size="sm" icon={trash ? "folder" : "trash"} onClick={() => setTrash(value => !value)}>{trash ? "返回私密文件" : "私密回收站"}</Button>
        <Button size="sm" icon="lock" onClick={unlocked.lock}>立即锁定</Button>
      </div>
    </div>
    {transfer && !incoming && <TransferNotice transfer={transfer} unlocked onDiscard={discardTransfer} />}
    {trash ? <TrashView root={api.PRIVATE_PREFIX} onChanged={onChanged} onOpenFolder={path => { setTrash(false); onOpenFolder(path); }} />
      : <FilesView key={grant.access} session={session} prefix={prefix} onOpenFolder={onOpenFolder} onChanged={onChanged} uploads={uploads} uploadRevision={uploadRevision} onPlayback={unlocked.onPlayback}
          incoming={trash ? null : incoming} onIncomingTaken={discardTransfer} />}
  </div>;
}
