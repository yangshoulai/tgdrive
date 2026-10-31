import { useId, useState } from "react";
import * as api from "../api";
import { Notice, Button, Field, Modal, Segmented, toast } from "../ui";
import { FolderPicker } from "./folders";
import { usePrivateAccess, usePrivateSession } from "./private-session";
import { PrivateUnlockDialog } from "./private-unlock";

/** 与服务端 PrivateSpace.IDLE_OPTIONS 一致。 */
const PRIVATE_IDLE_MINUTES = [5, 15, 30, 60, 90, 120];

export function PrivateIdleSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId();
  return <Field label="无操作后自动锁定" htmlFor={id} hint="私密操作会重新计时；播放音视频时保持解锁，切换页面不会立即锁定。">
    <select id={id} className="input" value={value} onChange={event => onChange(Number(event.target.value))}>
      {PRIVATE_IDLE_MINUTES.map(minutes => <option key={minutes} value={minutes * 60}>{minutes} 分钟</option>)}
    </select>
  </Field>;
}

export function PrivateTransferDialog({ paths, into, onClose, onDone }: { paths: string[]; into: boolean; onClose: () => void; onDone: () => void }) {
  const access = usePrivateAccess(), grant = access.grant;
  const [destination, setDestination] = useState(into ? api.PRIVATE_PREFIX : "");
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState<api.MoveConflict>("rename");
  usePrivateSession(grant, onClose, ".private-transfer");
  async function move() {
    if (!grant || !ready || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.transferPrivate(paths, destination, into, conflict);
      if (!result.moved && result.skipped) { setError("目标位置已有同名项目，未移动任何内容"); return; }
      toast.success(`${into ? "已移入私密空间" : "已移出到我的文件"}${result.skipped ? `，${result.skipped} 个同名文件已跳过` : ""}`);
      onDone(); onClose();
    } catch (reason) { setError(api.errorMessage(reason, "移动失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  // 未解锁时先只显示统一的解锁弹窗，解锁后原地换成移动对话框；关闭解锁框即取消本次移动。
  if (!grant) return <PrivateUnlockDialog className="private-transfer" title={into ? "移入私密空间" : "移出到我的文件"}
    description={into ? "解锁后选择私密空间中的目标位置。" : "解锁后把这些私密项目移出到我的文件。"} onClose={onClose} />;
  return <Modal className="private-transfer" title={into ? "移入私密空间" : "移出到我的文件"} icon="lock" onClose={onClose} dismissible={!busy}
    description={into ? "移入后取消这些项目的公开分享，文件夹中的内容一起移动。" : "移出后可以从我的文件访问，公开分享仍保持关闭。"}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button>{grant && <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void move()}>移动 {paths.length} 个项目</Button>}</>}>
    <>
      <FolderPicker value={destination} onChange={path => { setReady(false); setDestination(path); }} onReady={setReady} />
      <div className="move-conflict"><span>遇到同名文件时</span><Segmented label="同名冲突处理" value={conflict} onChange={setConflict} options={[{ value: "rename", label: "保留两者" }, { value: "skip", label: "跳过" }, { value: "overwrite", label: "覆盖" }]} /></div>
      {conflict === "overwrite" && <Notice tone="warning">目标位置的同名文件会被替换且无法恢复。</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </>
  </Modal>;
}
