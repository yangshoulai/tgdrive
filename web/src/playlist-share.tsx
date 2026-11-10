/** 分享的歌单（/m/<令牌>）：无需登录即可查看曲目、全部播放或随机播放，播放器带同名歌词文件。
 * 歌曲只以编号和文件名出现，不暴露存放路径；分享者勾选后才提供下载单首与「保存到我的 Tessera」（登录后引用同一份数据，计入自己的空间）。 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { BRAND } from "./brand";
import * as api from "./api";
import { FileThumbnail, PreviewModal } from "./files";
import { coverTint } from "./preview-media";
import { Avatar, Brand, Button, Checkbox, EmptyState, Icon, Menu, Modal, Notice, SkeletonTracks, Toaster, copyText, formatDateTime, toast, type MenuItem } from "./ui";
import { LoginPage } from "./shell";
import { FolderPicker } from "./user/folders";
import { PasswordGate } from "./share";

type Shared = Extract<api.PublicPlaylist, { password_required: false }>;
type Item = api.PublicPlaylistItem;

const accessKey = (token: string) => `tgdrive:playlist-access:${token}`;
const clock = (seconds?: number) => seconds ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "";
const titleOf = (item: Item) => item.media?.title || item.name.replace(/\.[^.]+$/, "");
/** 播放器按 key 识别文件：用「编号/文件名」，显示名取最后一段，编号用来换取地址。 */
const asFile = (item: Item): api.FileItem => ({ ...item, key: `${item.id}/${item.name}` });
const idOf = (file: api.FileItem) => file.key.split("/", 1)[0];
function shuffled<T>(items: T[]) {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list;
}

export function PlaylistSharePage({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null>(null);
  const [locked, setLocked] = useState(false);
  const [access, setAccess] = useState<string | null>(() => sessionStorage.getItem(accessKey(token)));
  const [error, setError] = useState<{ status: number; code: string } | null>(null);
  const [playing, setPlaying] = useState<{ file: api.FileItem; list: api.FileItem[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const load = useCallback((grant: string | null) => {
    void api.publicPlaylist(token, grant).then(value => {
      if (value.password_required) {
        sessionStorage.removeItem(accessKey(token));
        setLocked(true); setData(null);
        document.title = `需要访问密码 · ${BRAND}`;
      } else {
        setLocked(false); setData(value);
        document.title = `${value.name} · 歌单 · ${BRAND}`;
      }
    }, reason => {
      setError({ status: reason instanceof api.ApiError ? reason.status : 0, code: reason instanceof api.ApiError ? reason.code : "" });
      document.title = `链接不可用 · ${BRAND}`;
    });
  }, [token]);
  useEffect(() => load(access), [load, access]);
  // 登录的访客可以保存（分享者允许时）；自己的分享不显示保存。
  const [account, setAccount] = useState<api.Session | null | undefined>(undefined);
  const [own, setOwn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState<string[] | null | undefined>(undefined);
  const [loginFor, setLoginFor] = useState<string[] | null | undefined>(undefined);
  useEffect(() => { void api.restoreSession().then(setAccount).catch(() => setAccount(null)); }, []);
  useEffect(() => {
    setOwn(null);
    if (account && data?.save) void api.playlistShareStatus(token).then(value => setOwn(value.own)).catch(() => setOwn(false));
  }, [account, data?.save, token]);
  const canSave = Boolean(data?.save) && (account === null || (Boolean(account) && own === false));
  const requestSave = (items: string[] | null) => account ? setSaving(items) : setLoginFor(items);
  const files = useMemo(() => (data?.items ?? []).map(asFile), [data]);
  const source = useCallback((file: api.FileItem) => {
    const url = api.publicPlaylistContent(token, idOf(file), access);
    const cover = file.thumbnails?.includes("thumb");
    return { url, downloadUrl: data?.download ? api.publicPlaylistContent(token, idOf(file), access, true) : "",
      poster: cover ? api.publicThumbnail(url, "poster") : undefined, grid: cover ? api.publicThumbnail(url, "grid") : undefined,
      thumbnail: cover ? api.publicThumbnail(url) : undefined };
  }, [token, access, data?.download]);
  const play = (file: api.FileItem, list = files) => setPlaying({ file, list });
  if (loginFor !== undefined) return <LoginPage onSuccess={session => {
    const request = loginFor;
    setLoginFor(undefined); setAccount(session);
    void api.playlistShareStatus(token).then(value => {
      if (value.own) toast.info("这是你自己分享的歌单，歌曲已经在你的文件中"); else setSaving(request);
    }, reason => toast.error(api.errorMessage(reason, "无法检查分享状态，请刷新后重试")));
  }} notice={<Notice icon="folderPlus" className="share-login-note"><span>登录后把歌单里的歌曲保存到你的 {BRAND}。</span>
    <button type="button" className="link-button" onClick={() => setLoginFor(undefined)}>返回歌单</button></Notice>} />;
  const total = data?.items.length ?? 0;
  const picked = (data?.items ?? []).filter(item => selected.has(item.id)).map(item => item.id);
  const covers = (data?.items ?? []).filter(item => item.thumbnails?.includes("thumb")).slice(0, 4);
  return <div className="share-page">
    <header className="share-bar">
      <Brand tagline />
      <span className="share-bar-note"><Icon name="playlist" size={15} />分享的歌单</span>
    </header>
    <main className="share-main">
      {error ? <div className="share-card share-missing">
        <EmptyState icon={error.status === 503 ? "lock" : "link"}
          title={error.status === 503 ? "服务暂时不可用" : error.code === "share_expired" ? "这个链接已过期" : "这个链接已失效"}
          description={error.status === 503 ? "服务正在维护或尚未解锁，请稍后再试。"
            : error.code === "share_expired" ? "分享者设置的有效期已过。如仍需要，请联系分享者重新分享。" : "分享者可能已关闭分享或删除了歌单，或链接输入有误。"} />
      </div> : locked ? <PasswordGate token={token} unlock={api.unlockPublicPlaylist}
        onUnlocked={grant => { sessionStorage.setItem(accessKey(token), grant); setAccess(grant); }} />
      : !data ? <PlaylistShareSkeleton />
      : <article className="share-card playlist-share" style={{ "--cover-tint": coverTint(data.name) } as CSSProperties}>
        <header className="album-header playlist-hero">
          {/* 页头铺底：第一张封面的大幅模糊，没有封面时只用按歌单名选的色调渐变。 */}
          <span className="playlist-hero-backdrop" aria-hidden="true">
            {covers[0] && <img src={api.publicThumbnail(api.publicPlaylistContent(token, covers[0].id, access), "grid")} alt="" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />}
          </span>
          <span className={`album-cover album-cover-lg${covers.length >= 4 ? " is-mosaic" : ""}`}>
            {covers.length >= 4 ? covers.map(item => <span key={item.id}><FileThumbnail kind="audio" url={api.publicThumbnail(api.publicPlaylistContent(token, item.id, access), "grid")} /></span>)
              : covers[0] ? <FileThumbnail kind="audio" url={api.publicThumbnail(api.publicPlaylistContent(token, covers[0].id, access), "grid")} />
              : <span className="tint-cover"><Icon name="playlist" size={40} /></span>}
          </span>
          <div className="album-header-text">
            <span className="album-header-kind">歌单</span>
            <h1>{data.name}</h1>
            <p>{[`${total} 首`, data.duration ? clock(data.duration) : null, data.expires_at ? `链接有效期至 ${formatDateTime(data.expires_at)}` : null].filter(Boolean).join(" · ")}</p>
            {data.sharer && <div className="share-sharer"><Avatar name={data.sharer.nickname} src={api.publicPlaylistAvatar(token, data.sharer, access)} size={20} /><span><strong>{data.sharer.nickname}</strong> 分享</span></div>}
            <div className="album-header-actions">
              {total > 0 && <Button variant="primary" icon="play" onClick={() => play(files[0])}>全部播放</Button>}
              {total > 1 && <Button icon="shuffle" onClick={() => { const list = shuffled(files); play(list[0], list); }}>随机播放</Button>}
              <Button icon="link" onClick={() => void copyText(window.location.href.split("#")[0], "歌单链接已复制")}>复制链接</Button>
              {canSave && total > 0 && <Button icon="folderPlus" onClick={() => requestSave(null)}
                title={account ? "保存到你的文件，计入你的存储空间" : `登录后保存到你的 ${BRAND}`}>保存到我的 {BRAND}</Button>}
            </div>
          </div>
        </header>
        {canSave && selected.size > 0 && <div className="toolbar selection-bar track-selection-bar" role="toolbar" aria-label="所选歌曲的操作">
          <span className="selection-count">已选择 {selected.size} 首</span>
          <div className="toolbar-actions">
            <Button size="sm" icon="folderPlus" onClick={() => requestSave(picked)}>保存所选</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
          </div>
        </div>}
        {!total ? <EmptyState icon="playlist" title="歌单里还没有歌曲" description="分享者还没有往这个歌单里加入歌曲。" />
          : <>
          <div className="playlist-tracks-head" aria-hidden="true"><span>#</span><span>标题</span><span><Icon name="clock" size={14} /></span></div>
          <ol className={`track-list playlist-share-tracks${canSave ? " is-selectable" : ""}${selected.size ? " is-selecting" : ""}`}>
            {data.items.map((item, index) => {
              const url = api.publicPlaylistContent(token, item.id, access);
              const menu: MenuItem[] = [
                ...(data.download ? [{ label: "下载", icon: "download" as const, href: api.publicPlaylistContent(token, item.id, access, true), onSelect: () => undefined }] : []),
                ...(canSave ? [{ label: `保存到我的 ${BRAND}`, icon: "folderPlus" as const, onSelect: () => requestSave([item.id]) }] : []),
              ];
              return <li key={item.id} className={selected.has(item.id) ? "is-selected" : undefined}>
                {canSave && <span className="track-check"><Checkbox label={`选择 ${titleOf(item)}`} checked={selected.has(item.id)}
                  onChange={value => setSelected(current => { const next = new Set(current); if (value) next.add(item.id); else next.delete(item.id); return next; })} /></span>}
                <button type="button" className="track-row" onClick={() => play(files[index])}>
                  <span className="track-number"><span>{index + 1}</span><Icon name="play" size={14} /></span>
                  <span className="track-cover" style={{ "--cover-tint": coverTint(item.id) } as CSSProperties}>
                    {item.thumbnails?.includes("thumb") ? <FileThumbnail kind="audio" url={api.publicThumbnail(url)} /> : <span className="tint-cover"><Icon name="music" size={16} /></span>}
                  </span>
                  <span className="track-text"><strong>{titleOf(item)}</strong><span>{[item.media?.artist, item.media?.album].filter(Boolean).join(" · ") || item.name}</span></span>
                  <span className="track-duration">{clock(item.media?.duration)}</span>
                </button>
                {menu.length > 0 && <span className="track-menu"><Menu label={`${titleOf(item)} 的更多操作`} items={menu} /></span>}
              </li>;
            })}
          </ol>
        </>}
      </article>}
      <p className="share-footnote">这是 {BRAND} 用户分享的歌单，只有拿到链接的人才能访问。</p>
    </main>
    {playing && <PreviewModal file={playing.file} {...source(playing.file)} anyFolder playlistFiles={playing.list} sourceFor={source}
      loadAssets={(file, signal) => api.publicPlaylistAssets(token, idOf(file), access, signal)} assetUrl={path => api.publicPlaylistAsset(token, path, access)}
      onClose={() => setPlaying(null)} />}
    {saving !== undefined && data && <SavePlaylistDialog token={token} access={access} items={saving} total={total}
      onClose={() => setSaving(undefined)} onSaved={() => setSelected(new Set())} onPasswordRequired={() => { setSaving(undefined); load(access); }} />}
    <Toaster />
  </div>;
}

/** 首次打开时的骨架：与加载完成后的页头、曲目列表同形同位，内容到达时不跳动。 */
function PlaylistShareSkeleton() {
  return <div className="share-card playlist-share is-skeleton" aria-busy="true" aria-label="正在加载歌单">
    <div className="album-header playlist-hero">
      <span className="album-cover album-cover-lg skeleton" />
      <div className="album-header-text">
        <span className="skeleton skeleton-line" style={{ width: 40 }} />
        <span className="skeleton playlist-skeleton-title" />
        <span className="skeleton skeleton-line" style={{ width: 120 }} />
        <div className="album-header-actions"><span className="skeleton playlist-skeleton-button" /><span className="skeleton playlist-skeleton-button" /></div>
      </div>
    </div>
    <SkeletonTracks rows={6} />
  </div>;
}

/** 选择保存位置后把歌曲引用到自己的文件（不复制数据）；items 为 null 时保存全部。 */
function SavePlaylistDialog({ token, access, items, total, onClose, onSaved, onPasswordRequired }: { token: string; access: string | null; items: string[] | null; total: number;
  onClose: () => void; onSaved: () => void; onPasswordRequired: () => void }) {
  const [destination, setDestination] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = items?.length ?? total;
  async function save() {
    setBusy(true);
    try {
      const result = await api.savePlaylistShare(token, destination, access, items ?? undefined);
      onSaved(); onClose();
      const opened = destination ? `/?path=${encodeURIComponent(destination)}` : "/";
      toast.success(`已保存 ${result.saved} 首歌到“${destination ? destination.replace(/\/$/, "").split("/").pop() : "我的文件"}”`,
        { label: "打开", onClick: () => window.open(opened, "_blank", "noopener") });
    } catch (reason) {
      if (reason instanceof api.ApiError && reason.code === "password_required") { onPasswordRequired(); return; }
      toast.error(reason instanceof api.ApiError && reason.status === 413 ? "你的存储空间不足，无法保存" : api.errorMessage(reason, "保存失败，请稍后重试"));
    } finally { setBusy(false); }
  }
  return <Modal title={`保存 ${count} 首歌`} description="选择保存到你的哪个文件夹。歌曲直接引用分享者的数据，不需要重新上传，计入你的存储空间。" icon="folderPlus" onClose={onClose} dismissible={!busy}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>保存</Button></>}>
    <FolderPicker value={destination} onChange={setDestination} onReady={setReady} />
  </Modal>;
}
