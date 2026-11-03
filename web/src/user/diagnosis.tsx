import { useEffect, useState, type ReactNode } from "react";
import * as api from "../api";
import { Badge, Notice, formatBytes, type Tone } from "../ui";

/** 管理员是否开放诊断（「下载与资源」→「允许查看下载与缓存诊断」，默认开启）；读取失败时不显示入口。 */
export function useDiagnosticsEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.diagnosticsEnabled().then(value => { if (alive) setEnabled(value); });
    return () => { alive = false; };
  }, []);
  return enabled;
}

/** 秒数：一位小数，超过一分钟写成「1 分 05 秒」。 */
export function seconds(value: number | null | undefined) {
  if (value == null) return "—";
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)} 秒`;
  const whole = Math.round(value);
  return `${Math.floor(whole / 60)} 分 ${String(whole % 60).padStart(2, "0")} 秒`;
}

export type DiagnosisMetric = { label: string; value: ReactNode; detail?: ReactNode; tone?: "warning" | "danger" | "success" };

export function DiagnosisMetrics({ items }: { items: DiagnosisMetric[] }) {
  return <div className="diagnosis-metrics">{items.map(item => <div key={item.label} className={`diagnosis-metric${item.tone ? ` is-${item.tone}` : ""}`}>
    <span className="diagnosis-metric-label">{item.label}</span>
    <strong className="diagnosis-metric-value">{item.value}</strong>
    {item.detail && <small>{item.detail}</small>}
  </div>)}</div>;
}

/** 按诊断数据给出的一句判断；tone 为 success 时表示没有发现异常。 */
export type DiagnosisVerdict = { tone: "success" | "info" | "warning"; title: string; detail: string };

export function DiagnosisVerdictNotice({ verdict }: { verdict: DiagnosisVerdict }) {
  return <Notice className="diagnosis-verdict" tone={verdict.tone} role="status"><strong>{verdict.title}</strong><span>{verdict.detail}</span></Notice>;
}

/** 一个连接（或分段）一行：阶段徽标、双层进度条（浅色为已收到，深色为已写入）与几项耗时。 */
export function DiagnosisRow({ title, phase, tone, size, received, stored, meta, error }: {
  title: ReactNode; phase: string; tone: Tone; size: number | null; received: number; stored?: number; meta: (string | number | false | null | undefined)[]; error?: string;
}) {
  const percent = (value: number) => size ? `${Math.min(100, value / size * 100)}%` : "0%";
  return <li className="diagnosis-row">
    <div className="diagnosis-row-head">
      <strong className="diagnosis-row-title">{title}</strong>
      <Badge tone={tone} dot>{phase}</Badge>
      <span className="diagnosis-row-bytes">{formatBytes(received)}{size ? ` / ${formatBytes(size)}` : ""}{stored != null && <> · 已写入 {formatBytes(stored)}</>}</span>
    </div>
    <div className={`diagnosis-bar${size ? "" : " is-unknown"}`} aria-hidden="true">
      <span className="diagnosis-bar-received" style={{ width: size ? percent(received) : received ? "100%" : "0%" }} />
      {stored != null && <span className="diagnosis-bar-stored" style={{ width: percent(stored) }} />}
    </div>
    <div className="diagnosis-row-meta">{meta.filter(Boolean).map((item, index) => <span key={index}>{item}</span>)}</div>
    {error && <p className="diagnosis-row-error">{error}</p>}
  </li>;
}

export function DiagnosisSection({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="diagnosis-section">
    <header><h3>{title}</h3>{hint && <span>{hint}</span>}</header>
    {children}
  </section>;
}
