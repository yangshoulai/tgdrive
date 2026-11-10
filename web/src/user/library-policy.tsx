/** 媒体库收录设置：文件与目录共用，修改偏好不触碰原文件。 */
import { useEffect, useId, useState } from "react";
import * as api from "../api";
import { baseName } from "../files";
import { Button, EmptyState, Icon, IconButton, Modal, Notice, SkeletonRows, confirmLeave, toast, useUnsavedChanges } from "../ui";
import { FolderPicker } from "./folders";

const CATEGORY = { photos: "相册", videos: "影视", music: "音乐", books: "书籍" };
const label = (path: string) => path ? `/${path.replace(/\/$/, "")}` : "我的文件（全部目录）";

export function useLibraryPolicyEditor() {
  const [paths, setPaths] = useState<string[] | null>(null);
  return { open: (given: string[]) => setPaths([...new Set(given)]),
    dialog: paths && <LibraryPolicyDialog key={paths.join("\n")} paths={paths} onClose={() => setPaths(null)} /> };
}

function LibraryPolicyDialog({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const id = useId();
  const [info, setInfo] = useState<api.LibraryPolicyInfo | null>(null);
  const [initial, setInitial] = useState<api.LibraryPolicy | "">("");
  const [policy, setPolicy] = useState<api.LibraryPolicy | "">("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const single = paths.length === 1;
  const dirty = policy !== "" && policy !== initial;
  useUnsavedChanges(dirty);
  useEffect(() => {
    if (!single) return;
    const controller = new AbortController();
    setError(""); setInfo(null);
    api.libraryPolicy(paths[0], controller.signal).then(value => {
      if (!controller.signal.aborted) { setInfo(value); setInitial(value.policy); setPolicy(value.policy); }
    }, reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取收录设置失败")); });
    return () => controller.abort();
  }, [paths, single, attempt]);
  const close = async () => { if (!busy && await confirmLeave()) onClose(); };
  const save = async () => {
    if (!policy) return;
    setBusy(true); setError("");
    try {
      await api.setLibraryPolicy(paths, policy);
      toast.success(policy === "exclude" ? "已从媒体库排除，原文件仍可正常访问" : policy === "include" ? "已设置为收录到媒体库" : "已恢复跟随目录与默认规则");
      onClose();
    } catch (reason) { setError(api.errorMessage(reason, "保存收录设置失败")); }
    finally { setBusy(false); }
  };
  const options: { value: api.LibraryPolicy; title: string; description: string }[] = [
    { value: "auto", title: "跟随目录与默认规则", description: "使用最近一级目录的明确设置；没有目录设置时按文件格式自动收录，PDF、TXT 需指定收录。" },
    { value: "include", title: "始终收录", description: "图片、视频、音频与电子书按格式进入对应分类；PDF、TXT 作为书籍收录。" },
    { value: "exclude", title: "不在媒体库展示", description: "原文件、预览、下载、分享、收藏和已有歌单照常可用。" },
  ];
  return <Modal title="媒体库收录" icon="book" description={single ? label(paths[0]) : `为所选 ${paths.length} 项统一设置收录方式`}
    onClose={() => void close()} size="md" dismissible={!busy}
    footer={<><Button disabled={busy} onClick={() => void close()}>取消</Button><Button variant="primary" loading={busy} disabled={!dirty || single && !info} onClick={() => void save()}>保存设置</Button></>}>
    {single && !info ? error
      ? <EmptyState icon="alert" title="读取收录设置失败" description={error} action={<Button onClick={() => setAttempt(value => value + 1)}>重试</Button>} />
      : <SkeletonRows rows={3} /> : <div className="library-policy-form">
      {info && <p className="library-policy-current">
        {info.directory ? `此设置适用于这个目录及全部子目录，当前包含 ${info.count ?? 0} 个文件；文件与子目录的明确设置优先。`
          : info.included ? `当前收录到「${info.category ? CATEGORY[info.category] : "媒体库"}」。` : info.requires_include && info.effective === "auto" ? "PDF、TXT 默认不作为书籍收录，可在这里指定加入。" : "当前未在媒体库展示。"}
        {info.inherited_from !== null && <span>沿用 {label(info.inherited_from)} 的{info.effective === "exclude" ? "排除" : "收录"}规则。</span>}
      </p>}
      <fieldset className="library-policy-options" disabled={busy}>
        <legend className="sr-only">收录方式</legend>
        {options.map(option => <label key={option.value} className="library-policy-option">
          <input type="radio" name={id} value={option.value} checked={policy === option.value}
            disabled={option.value === "include" && info?.directory === false && !info.category}
            onChange={() => { setPolicy(option.value); setError(""); }} />
          <span><strong>{option.title}</strong><small>{option.description}</small></span>
        </label>)}
      </fieldset>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </div>}
  </Modal>;
}

export function LibraryRulesDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.libraryRules>> | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [folder, setFolder] = useState("");
  const editor = useLibraryPolicyEditor();
  useEffect(() => {
    const changed = () => setAttempt(value => value + 1);
    window.addEventListener(api.LIBRARY_UPDATED_EVENT, changed);
    return () => window.removeEventListener(api.LIBRARY_UPDATED_EVENT, changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api.libraryRules(controller.signal).then(value => { if (!controller.signal.aborted) setState(value); },
      reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "读取收录规则失败")); });
    return () => controller.abort();
  }, [attempt]);
  const rules = state?.folders.filter(item => item.path) ?? [];
  const root = state?.folders.find(item => !item.path);
  return <Modal title="媒体库收录规则" icon="book" size="md" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    <div className="library-rules">
      <p className="library-policy-current">文件设置优先于目录规则，目录规则向全部子目录继承。未收录的文件可在各分类的「未收录」中查看、重新加入。</p>
      <div className="library-rule-row">
        <span><strong>全库默认</strong><small>{root?.policy === "exclude" ? "仅收录明确指定的文件和文件夹" : root?.policy === "include" ? "收录支持的媒体格式，PDF、TXT 也作为书籍" : "按格式自动收录；PDF、TXT 需手动指定"}</small></span>
        <Button size="sm" onClick={() => editor.open([""])}>设置</Button>
      </div>
      <div className="library-rules-heading"><strong>文件夹规则</strong><Button size="sm" icon="folderPlus" onClick={() => setChoosing(value => !value)}>添加规则</Button></div>
      {choosing && <div className="library-rule-picker">
        <FolderPicker value={folder} onChange={setFolder} creatable={false} />
        <Button variant="primary" disabled={!folder} onClick={() => { setChoosing(false); editor.open([folder]); }}>设置这个文件夹</Button>
      </div>}
      {error && <Notice tone="danger" role="alert">{error}<Button size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button></Notice>}
      {!state && !error ? <SkeletonRows rows={3} /> : rules.length ? <ul className="library-rule-list">
        {rules.map(item => <li key={item.path} className="library-rule-row">
          <Icon name="folder" size={18} />
          <span><strong title={label(item.path)}>{baseName(item.path)}</strong><small>{label(item.path)} · {item.policy === "exclude" ? "不在媒体库展示" : "始终收录"}</small></span>
          <IconButton icon="edit" label={`修改 ${label(item.path)} 的收录规则`} onClick={() => editor.open([item.path])} />
        </li>)}
      </ul> : <p className="library-policy-current">还没有单独设置文件夹规则。也可以在「我的文件」的文件夹菜单中设置。</p>}
      {state && <p className="library-policy-current">当前 {state.folders.length} / {state.limit} 条目录规则。选择「跟随目录与默认规则」可移除单独设置。</p>}
    </div>
    {editor.dialog}
  </Modal>;
}
