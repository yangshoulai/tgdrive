/**
 * 侧栏「收藏」：固定常用文件夹（类似 Finder 的个人收藏）。列表按账号保存在服务端（GET/PUT /api/user/v1/favorites），
 * 多台设备同步；私密文件夹只在当前会话已解锁时返回，锁定时保存的顺序由服务端把它们放回原位。
 * 入口：文件夹菜单「固定到侧栏」，或把文件夹从文件列表拖到收藏区域；收藏之间拖动排序，右键可上移、下移、移除。
 * 文件夹移动或改名后服务端同步改写（图标随之保留），移入回收站后移除；已不存在的显示为灰色。
 * 每个收藏可以选一个图标（右键「更改图标…」，FAVORITE_ICONS），不选时普通文件夹用文件夹图标、私密文件夹用锁形图标。
 */
import { useEffect, useState, type DragEvent, type MouseEvent } from "react";
import * as api from "../api";
import { isPlainClick } from "../shell";
import { ContextMenu, Icon, Modal, toast, type IconName, type MenuItem } from "../ui";

export type Favorite = api.Favorite;
/** 文件列表拖动时携带的键（与 user/files.tsx 的 INTERNAL_DRAG 一致）。 */
export const FILE_DRAG = "application/x-tgdrive-keys";
const FAVORITE_DRAG = "application/x-tessera-favorite";

let items: Favorite[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
let loading: Promise<void> | null = null;

export function refreshFavorites() {
  loading ??= api.favorites().then(value => { items = value.items; loaded = true; emit(); }).catch(() => undefined).finally(() => { loading = null; });
  return loading;
}

/** 侧栏收藏可选的图标；null 为默认（文件夹，私密文件夹为锁形）。名称是 ui.tsx 的图标名，服务端只校验格式。 */
export const FAVORITE_ICONS: { icon: IconName | null; label: string }[] = [
  { icon: null, label: "默认" }, { icon: "star", label: "收藏" }, { icon: "heart", label: "喜欢" }, { icon: "audio", label: "音乐" },
  { icon: "film", label: "电影" }, { icon: "video", label: "视频" }, { icon: "image", label: "图片" }, { icon: "camera", label: "照片" },
  { icon: "book", label: "资料" }, { icon: "fileText", label: "文档" }, { icon: "briefcase", label: "工作" }, { icon: "graduation", label: "学习" },
  { icon: "code", label: "代码" }, { icon: "gamepad", label: "游戏" }, { icon: "palette", label: "设计" }, { icon: "download", label: "下载" },
  { icon: "archive", label: "归档" }, { icon: "cloud", label: "备份" }, { icon: "home", label: "家庭" }, { icon: "users", label: "共享" },
  { icon: "globe", label: "旅行" }, { icon: "bookmark", label: "书签" }, { icon: "flag", label: "重要" }, { icon: "key", label: "证件" },
  { icon: "sparkle", label: "灵感" },
];
const KNOWN_ICONS = new Set(FAVORITE_ICONS.map(item => item.icon).filter(Boolean));
export const favoriteIcon = (item: Pick<Favorite, "icon" | "private">): IconName =>
  item.icon && KNOWN_ICONS.has(item.icon as IconName) ? item.icon as IconName : item.private ? "lock" : "folder";

/** 按新顺序整体保存；icons 覆盖个别收藏的图标，其余沿用当前图标。 */
async function save(next: string[], success?: string, icons: Record<string, string | null> = {}) {
  const previous = items;
  // 先按新顺序显示，失败再还原。
  const known = new Map(items.map(item => [item.path, item]));
  const entries = next.map(path => ({ path, icon: path in icons ? icons[path] : known.get(path)?.icon ?? null }));
  items = entries.map(entry => ({ ...(known.get(entry.path) ?? { private: api.isPrivatePath(entry.path), missing: false }), ...entry }));
  emit();
  try {
    items = (await api.saveFavorites(entries)).items; emit();
    if (success) toast.success(success);
  } catch (reason) {
    items = previous; emit();
    toast.error(api.errorMessage(reason, "收藏没有保存，请稍后重试"));
  }
}

export const isFavorite = (path: string) => items.some(item => item.path === path);
export function pinFolder(path: string, index = items.length) {
  if (isFavorite(path)) return Promise.resolve();
  if (items.length >= 50) { toast.error("最多收藏 50 个文件夹"); return Promise.resolve(); }
  const next = items.map(item => item.path);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, path);
  return save(next, `已将“${folderName(path)}”固定到侧栏`);
}
export const unpinFolder = (path: string) => save(items.filter(item => item.path !== path).map(item => item.path));
export const setFavoriteIcon = (path: string, icon: string | null) => save(items.map(item => item.path), undefined, { [path]: icon });

/** 选择收藏的图标：点选即保存并关闭。 */
function FavoriteIconDialog({ item, onClose }: { item: Favorite; onClose: () => void }) {
  const current = item.icon && KNOWN_ICONS.has(item.icon as IconName) ? item.icon : null;
  return <Modal title="选择图标" description={`「${folderName(item.path)}」在侧栏收藏里显示的图标`} icon={favoriteIcon(item)} size="sm" onClose={onClose}>
    <div className="favorite-icon-grid" role="listbox" aria-label="图标">
      {FAVORITE_ICONS.map(option => {
        const selected = option.icon === current;
        const shown: IconName = option.icon ?? (item.private ? "lock" : "folder");
        return <button key={option.label} type="button" role="option" aria-selected={selected} className={`favorite-icon-option${selected ? " is-selected" : ""}`}
          title={option.icon ? option.label : item.private ? "默认（私密文件夹）" : "默认（文件夹）"}
          onClick={() => { if (!selected) void setFavoriteIcon(item.path, option.icon); onClose(); }}>
          <Icon name={shown} size={20} /><span>{option.label}</span>
        </button>;
      })}
    </div>
  </Modal>;
}

export function useFavorites() {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const listener = () => setRevision(value => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return items;
}

export const folderName = (path: string) => path.replace(/\/$/, "").split("/").at(-1) || path;
/** 文件夹菜单里的「固定到侧栏／从侧栏移除」。 */
export function favoriteMenuItem(path: string): MenuItem {
  return isFavorite(path)
    ? { label: "从侧栏移除", icon: "pin", onSelect: () => void unpinFolder(path) }
    : { label: "固定到侧栏", icon: "pin", onSelect: () => void pinFolder(path) };
}

/** 侧栏里的收藏列表。location 用于高亮当前文件夹并在切换位置时刷新（文件夹可能刚被移动或删除）。 */
export function FavoritesNav({ section, prefix, rail, onOpen, hrefFor }: {
  section: string; prefix: string; rail: boolean;
  onOpen: (path: string) => void; hrefFor: (path: string) => string;
}) {
  const list = useFavorites();
  const [drop, setDrop] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [context, setContext] = useState<{ path: string; x: number; y: number } | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  // 文件列表里开始拖动时，在收藏末尾显示放置区：已有收藏时列表只有几行高，否则松开在空白处会没有反应。
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => { if (event.dataTransfer?.types.includes(FILE_DRAG)) setArmed(true); };
    const stop = () => { setArmed(false); setDrop(null); };
    window.addEventListener("dragstart", start); window.addEventListener("dragend", stop); window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragstart", start); window.removeEventListener("dragend", stop); window.removeEventListener("drop", stop); };
  }, []);
  useEffect(() => { void refreshFavorites(); }, [section, prefix]);
  useEffect(() => {
    const refresh = () => void refreshFavorites();
    window.addEventListener("tessera:private-locked", refresh); window.addEventListener("tessera:private-unlocked", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("tessera:private-locked", refresh); window.removeEventListener("tessera:private-unlocked", refresh); window.removeEventListener("focus", refresh); };
  }, []);
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(FAVORITE_DRAG) || event.dataTransfer.types.includes(FILE_DRAG);
  // 放在第几项之前：按指针位于项目上半部还是下半部决定。
  const positionOf = (event: DragEvent<HTMLElement>, index: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
  };
  const over = (event: DragEvent<HTMLElement>, index: number) => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(FAVORITE_DRAG) ? "move" : "link";
    setDrop(index < 0 ? list.length : positionOf(event, index));
  };
  const dropAt = (event: DragEvent<HTMLElement>) => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    const target = drop ?? list.length;
    setDrop(null); setDragging(null);
    const moving = event.dataTransfer.getData(FAVORITE_DRAG);
    if (moving) {
      const paths = list.map(item => item.path), from = paths.indexOf(moving);
      if (from < 0) return;
      paths.splice(from, 1);
      paths.splice(target > from ? target - 1 : target, 0, moving);
      if (paths.join("\n") !== list.map(item => item.path).join("\n")) void save(paths);
      return;
    }
    let keys: string[] = [];
    try { keys = JSON.parse(event.dataTransfer.getData(FILE_DRAG) || "[]"); } catch { /* 忽略无法识别的拖入内容 */ }
    const folders = keys.filter(key => typeof key === "string" && key.endsWith("/") && !isFavorite(key));
    if (!folders.length) { if (keys.length) toast.info(keys.some(key => key.endsWith("/")) ? "文件夹已在收藏中" : "只能把文件夹固定到侧栏"); return; }
    const next = list.map(item => item.path);
    next.splice(target, 0, ...folders);
    void save(next.slice(0, 50), folders.length === 1 ? `已将“${folderName(folders[0])}”固定到侧栏` : `已将 ${folders.length} 个文件夹固定到侧栏`);
  };
  const open = (event: MouseEvent<HTMLAnchorElement>, item: Favorite) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    if (item.missing) {
      toast.info(`“${folderName(item.path)}”已不存在`, { label: "从侧栏移除", onClick: () => void unpinFolder(item.path) });
      return;
    }
    onOpen(item.path);
  };
  const menu = (path: string): MenuItem[] => {
    const index = list.findIndex(item => item.path === path), paths = list.map(item => item.path);
    const shift = (offset: number) => { const next = [...paths]; next.splice(index, 1); next.splice(index + offset, 0, path); void save(next); };
    return [
      { label: "打开", icon: "folder", onSelect: () => onOpen(path) },
      { label: "在新标签页中打开", icon: "external", onSelect: () => window.open(hrefFor(path), "_blank", "noopener") },
      { label: "更改图标…", icon: "palette", divider: true, onSelect: () => setChoosing(path) },
      { label: "上移", icon: "chevronUp", divider: true, disabled: index <= 0, onSelect: () => shift(-1) },
      { label: "下移", icon: "chevronDown", disabled: index < 0 || index >= list.length - 1, onSelect: () => shift(1) },
      { label: "从侧栏移除", icon: "x", divider: true, onSelect: () => void unpinFolder(path) },
    ];
  };
  const current = section === "files" || section === "private" ? prefix : null;
  return <div className={`nav-favorites${drop !== null ? " is-dropping" : ""}`}
    onDragOver={event => over(event, -1)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }} onDrop={dropAt}>
    {list.map((item, index) => {
      const name = folderName(item.path), active = current === item.path;
      return <a key={item.path} href={hrefFor(item.path)} draggable
        className={`nav-item nav-favorite${active ? " is-active" : ""}${item.missing ? " is-missing" : ""}${dragging === item.path ? " is-dragging" : ""}${drop === index ? " drop-before" : ""}${drop === index + 1 && index === list.length - 1 ? " drop-after" : ""}`}
        aria-current={active ? "page" : undefined} title={item.missing ? `${name}（已不存在）` : rail ? name : api.privatePathLabel(item.path)}
        onClick={event => open(event, item)} onContextMenu={event => { event.preventDefault(); setContext({ path: item.path, x: event.clientX, y: event.clientY }); }}
        onDragStart={event => { event.dataTransfer.setData(FAVORITE_DRAG, item.path); event.dataTransfer.effectAllowed = "move"; setDragging(item.path); }}
        onDragEnd={() => { setDragging(null); setDrop(null); }}
        onDragOver={event => over(event, index)} onDrop={dropAt}>
        <Icon name={favoriteIcon(item)} size={17} /><span className="nav-label">{name}</span>
        {item.private && favoriteIcon(item) !== "lock" && <Icon name="lock" size={12} className="nav-favorite-lock" />}
      </a>;
    })}
    {!list.length && loaded && !rail && <p className={`nav-favorites-empty${armed ? " is-armed" : ""}`}>{armed || drop !== null ? "松开即可固定到侧栏" : "把文件夹拖到这里，或在文件夹菜单中选择「固定到侧栏」"}</p>}
    {list.length > 0 && (armed || dragging) && <div className={`nav-favorites-drop${drop === list.length ? " is-over" : ""}`}
      onDragOver={event => { if (!accepts(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = dragging ? "move" : "link"; setDrop(list.length); }}
      onDrop={dropAt}>{rail ? <Icon name="pin" size={14} /> : dragging ? "移到最后" : "松开即可固定到侧栏"}</div>}
    {choosing && list.some(item => item.path === choosing) && <FavoriteIconDialog item={list.find(item => item.path === choosing)!} onClose={() => setChoosing(null)} />}
    {context && <ContextMenu x={context.x} y={context.y} label={`${folderName(context.path)} 的操作`} items={menu(context.path)} onClose={() => setContext(null)} />}
  </div>;
}
