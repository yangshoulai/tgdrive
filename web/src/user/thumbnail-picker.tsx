import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { baseName } from "../files";
import { Button, EmptyState, Icon, Modal, Notice } from "../ui";

const timestamp = (seconds: number) => {
  const millis = Math.round(seconds * 1000), whole = Math.floor(millis / 1000), hours = Math.floor(whole / 3600);
  const fraction = millis % 1000;
  return `${hours ? `${hours}:` : ""}${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}${fraction ? `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}` : ""}`;
};

/** 视频手动生成只准备候选图；确认后才替换，关闭窗口释放临时图片。 */
export function ThumbnailPicker({ file, onClose, onSaved }: { file: api.FileItem; onClose: () => void; onSaved: () => void }) {
  const [job, setJob] = useState<api.ThumbnailCandidates | null>(null);
  const [images, setImages] = useState<Record<number, string>>({});
  const [imageErrors, setImageErrors] = useState(new Set<number>());
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const close = useRef(onClose); close.current = onClose;
  const released = useRef(false), live = useRef(true);
  useEffect(() => {
    if (!api.isPrivatePath(file.key)) return;
    const locked = () => close.current();
    window.addEventListener("tessera:private-locked", locked);
    return () => window.removeEventListener("tessera:private-locked", locked);
  }, [file.key]);
  useEffect(() => {
    let disposed = false, timer = 0, requestId = "";
    const controller = new AbortController(), urls = new Map<number, string>(), pending = new Set<number>();
    live.current = true; released.current = false;
    setJob(null); setError(""); setImages({}); setImageErrors(new Set()); setSelected(null);
    const update = (value: api.ThumbnailCandidates) => {
      if (disposed) return;
      setJob(value);
      for (const frame of value.frames) {
        if (urls.has(frame.index) || pending.has(frame.index)) continue;
        pending.add(frame.index);
        void api.thumbnailCandidateImage(file, value.id, frame.index, controller.signal).then(image => {
          if (disposed) return;
          const url = URL.createObjectURL(image);
          urls.set(frame.index, url);
          setImages(previous => ({ ...previous, [frame.index]: url }));
        }).catch(() => { if (!disposed) setImageErrors(previous => new Set(previous).add(frame.index)); });
      }
    };
    const poll = async () => {
      try {
        const value = await api.thumbnailCandidates(file, requestId, controller.signal);
        update(value);
        if (!disposed && (value.state === "queued" || value.state === "running")) timer = window.setTimeout(poll, 1000);
      } catch (reason) { if (!disposed) setError(api.errorMessage(reason, "无法读取候选画面，请重试")); }
    };
    void api.createThumbnailCandidates(file).then(value => {
      requestId = value.id;
      if (disposed) { void api.cancelThumbnailCandidates(file, requestId).catch(() => undefined); return; }
      update(value);
      if (value.state === "queued" || value.state === "running") timer = window.setTimeout(poll, 1000);
    }).catch(reason => { if (!disposed) setError(api.errorMessage(reason, "无法准备候选画面，请重试")); });
    return () => {
      disposed = true; live.current = false; window.clearTimeout(timer); controller.abort();
      urls.forEach(url => URL.revokeObjectURL(url));
      if (requestId && !released.current) void api.cancelThumbnailCandidates(file, requestId).catch(() => undefined);
    };
  }, [file.key, file.etag, attempt]);
  async function retry() {
    if (saving || restarting) return;
    setRestarting(true);
    try {
      if (job) {
        try { await api.cancelThumbnailCandidates(file, job.id); }
        catch (reason) { if (!(reason instanceof api.ApiError && reason.status === 400)) throw reason; }
      }
      if (!live.current) return;
      released.current = true;
      setAttempt(value => value + 1);
    } catch (reason) { if (live.current) setError(api.errorMessage(reason, "暂时无法重新生成，请重试")); }
    finally { if (live.current) setRestarting(false); }
  }
  async function confirm() {
    if (!job || selected === null || saving || job.state !== "ready" || !images[selected] || imageErrors.has(selected)) return;
    setSaving(true); setError("");
    try {
      await api.selectThumbnailCandidate(file, job.id, selected);
      released.current = true;
      if (live.current) onSaved();
    } catch (reason) { if (live.current) setError(api.errorMessage(reason, "保存失败，请重新生成候选图后重试")); }
    finally { if (live.current) setSaving(false); }
  }
  const failed = Boolean(error) || job?.state === "failed";
  const working = !failed && (!job || job.state === "queued" || job.state === "running");
  return <Modal title="选择视频缩略图" icon="image" size="lg" className={`thumbnail-picker${api.isPrivatePath(file.key) ? " private-dialog" : ""}`}
    description="从视频不同段落选取画面，跳过明显的灰屏、片头文字和重复截图。" initialFocus="dialog" onClose={onClose} dismissible={!saving} closable={!saving}
    footer={<><span className="thumbnail-picker-choice" aria-live="polite">{selected === null ? "请选择一张画面" : `已选 ${timestamp(job?.frames.find(frame => frame.index === selected)?.seconds ?? 0)}`}</span><Button disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" icon="check" loading={saving} disabled={working || failed || restarting || selected === null || !images[selected] || imageErrors.has(selected)} onClick={() => void confirm()}>使用这张</Button></>}>
    <div className="thumbnail-picker-file"><Icon name="video" size={18} /><strong title={baseName(file.key)}>{baseName(file.key)}</strong></div>
    {failed ? <EmptyState compact icon="alert" title="暂时无法使用候选画面" description={error || job?.detail} action={<Button icon="refresh" loading={restarting} onClick={() => void retry()}>重新生成</Button>} /> : <>
      <div className="thumbnail-picker-status" role="status">{working ? <span className="spinner" /> : <Icon name="checkCircle" size={16} />}<span>{job?.state === "ready" ? "请选择一张作为缩略图" : job?.detail || "正在提交截图请求"}</span><small>{job?.frames.length ?? 0} / {job?.count ?? 3} 张</small></div>
      {job?.state === "ready" && job.frames.length < job.count && <Notice>{job.detail}，可直接选择。</Notice>}
      <div className="thumbnail-candidates" role="radiogroup" aria-label="视频候选画面" aria-busy={working}>
        {Array.from({ length: working ? job?.count ?? 3 : job?.frames.length ?? 0 }, (_, index) => {
          const frame = job?.frames[index], url = frame && images[frame.index], broken = frame && imageErrors.has(frame.index);
          return <label key={index} className={`thumbnail-candidate${selected === frame?.index ? " is-selected" : ""}${!url || broken ? " is-loading" : ""}`}>
            <input type="radio" name="thumbnail-frame" aria-label={frame ? `选择 ${timestamp(frame.seconds)} 的画面` : `候选画面 ${index + 1} 正在准备`} checked={Boolean(frame && selected === frame.index)} disabled={!frame || !url || broken || saving || restarting || job?.state !== "ready"} onChange={() => frame && setSelected(frame.index)} />
            <span className="thumbnail-candidate-image">{url && !broken ? <img src={url} alt={`视频在 ${timestamp(frame!.seconds)} 的画面`} onError={() => setImageErrors(previous => new Set(previous).add(frame!.index))} /> : <span>{broken ? <Icon name="alert" size={22} /> : <span className="spinner" />}<span>{broken ? "画面加载失败" : "正在截取画面"}</span></span>}</span>
            <span className="thumbnail-candidate-caption"><span>{frame ? timestamp(frame.seconds) : `候选 ${index + 1}`}</span><span>{selected === frame?.index ? <><Icon name="checkCircle" size={15} />已选择</> : ""}</span></span>
          </label>;
        })}
      </div>
      {!working && imageErrors.size > 0 && <Notice>有画面未能加载，可选择其他截图，或<Button variant="ghost" size="sm" icon="refresh" loading={restarting} onClick={() => void retry()}>重新生成</Button>。</Notice>}
    </>}
  </Modal>;
}
