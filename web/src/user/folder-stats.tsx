/** 目录统计：当前文件夹（含全部子文件夹）的数量、总大小、类型构成与最大的文件。数据由服务端在索引范围内聚合，打开时读取一次。 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { FileTile, baseName, getFileKind, parentPath } from "../files";
import { Button, EmptyState, Modal, SkeletonRows, formatBytes, formatDate } from "../ui";

const KIND_LABEL: Record<api.FolderStats["kinds"][number]["kind"], string> = {
  image: "图片", video: "视频", audio: "音频", document: "文档", text: "文本", archive: "压缩包", other: "其他",
};
// 类型顺序固定，颜色跟随类型而不是排名：筛选或数量变化时同一类型始终同一颜色。
const KIND_ORDER = ["image", "video", "audio", "document", "text", "archive", "other"] as const;

export function FolderStatsDialog({ prefix, title, onClose, onOpenFolder }: { prefix: string; title: string; onClose: () => void; onOpenFolder?: (prefix: string) => void }) {
  const [stats, setStats] = useState<api.FolderStats | null>(null);
  const [error, setError] = useState("");
  const [measure, setMeasure] = useState<"bytes" | "count">("bytes");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStats(null); setError("");
    void api.folderStats(prefix, controller.signal).then(setStats).catch(reason => { if (!controller.signal.aborted) setError(api.errorMessage(reason, "统计读取失败")); });
    return () => controller.abort();
  }, [prefix, retry]);
  const kinds = stats ? KIND_ORDER.flatMap(kind => stats.kinds.filter(item => item.kind === kind)) : [];
  const total = stats ? (measure === "bytes" ? stats.bytes : stats.files) : 0;
  const share = (item: api.FolderStats["kinds"][number]) => total ? (measure === "bytes" ? item.bytes : item.count) / total : 0;
  const percent = (value: number) => value >= 0.995 ? "100%" : value < 0.001 && value > 0 ? "<0.1%" : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  return <Modal title="目录统计" description={title} icon="chart" size="md" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    {error ? <EmptyState icon="alert" title="统计读取失败" description={error} action={<Button onClick={() => setRetry(value => value + 1)}>重试</Button>} />
      : !stats ? <SkeletonRows rows={4} />
        : <div className="folder-stats">
          <div className="folder-stats-figures">
            <div><span>文件</span><strong>{stats.files.toLocaleString("zh-CN")}</strong><small>本层 {stats.direct_files.toLocaleString("zh-CN")}</small></div>
            <div><span>文件夹</span><strong>{stats.folders.toLocaleString("zh-CN")}</strong><small>本层 {stats.direct_folders.toLocaleString("zh-CN")}</small></div>
            <div><span>占用空间</span><strong>{formatBytes(stats.bytes)}</strong><small>{stats.latest_modified ? `最近更新于 ${formatDate(stats.latest_modified)}` : "包含全部子文件夹"}</small></div>
          </div>
          {stats.files === 0 ? <p className="muted">这个文件夹里还没有文件。</p> : <>
            <section className="folder-stats-section">
              <header><h3>类型构成</h3>
                <div className="folder-stats-measure" role="radiogroup" aria-label="按什么统计占比">
                  {(["bytes", "count"] as const).map(value => <button key={value} type="button" role="radio" aria-checked={measure === value} className={measure === value ? "is-active" : ""} onClick={() => setMeasure(value)}>{value === "bytes" ? "按大小" : "按数量"}</button>)}
                </div>
              </header>
              <div className="folder-stats-bar" role="img" aria-label={kinds.map(item => `${KIND_LABEL[item.kind]} ${percent(share(item))}`).join("，")}>
                {kinds.map(item => share(item) > 0 && <span key={item.kind} className={`kind-${item.kind}`} style={{ flexGrow: share(item) }}
                  title={`${KIND_LABEL[item.kind]}：${item.count.toLocaleString("zh-CN")} 个 · ${formatBytes(item.bytes)} · ${percent(share(item))}`} />)}
              </div>
              <table className="folder-stats-table">
                <thead><tr><th scope="col">类型</th><th scope="col">数量</th><th scope="col">大小</th><th scope="col">占比</th></tr></thead>
                <tbody>{kinds.map(item => <tr key={item.kind}>
                  <th scope="row"><i className={`folder-stats-swatch kind-${item.kind}`} aria-hidden="true" />{KIND_LABEL[item.kind]}</th>
                  <td>{item.count.toLocaleString("zh-CN")}</td><td>{formatBytes(item.bytes)}</td><td>{percent(share(item))}</td>
                </tr>)}</tbody>
              </table>
            </section>
            {stats.largest.length > 0 && <section className="folder-stats-section">
              <header><h3>最大的文件</h3></header>
              <ul className="folder-stats-largest">{stats.largest.map(item => {
                const folder = parentPath(item.key);
                const relative = folder.slice(prefix.length);
                return <li key={item.key}>
                  <FileTile kind={getFileKind(item.content_type, item.key)} />
                  <span className="folder-stats-name"><strong title={baseName(item.key)}>{baseName(item.key)}</strong>
                    {relative && (onOpenFolder ? <button type="button" className="link-button" onClick={() => { onOpenFolder(folder); onClose(); }}>{relative.replace(/\/$/, "")}</button> : <small>{relative.replace(/\/$/, "")}</small>)}</span>
                  <span className="folder-stats-size">{formatBytes(item.size)}</span>
                </li>;
              })}</ul>
            </section>}
          </>}
        </div>}
  </Modal>;
}
