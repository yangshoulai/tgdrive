import { useEffect, useState } from "react";
import { BRAND, SITE } from "../brand";
import * as api from "../api";
import { CurveChart } from "../curve-chart";

import { Button, EmptyState, Icon, PageHeader, Panel, SkeletonRows, formatBytes, formatCount, formatNumber, useDocumentTitle, type IconName } from "../ui";

import type { AdminModule } from "../admin";

/* ---------- 概览 ---------- */

export function Overview({ onNavigate, status }: { onNavigate: (module: AdminModule) => void; status: api.SystemStatus }) {
  const [data, setData] = useState<{ users: api.AccountSummary; objects: api.AdminObjectSummary; bots: api.BotConfig[] } | null>(null);
  useDocumentTitle(`概览 · ${SITE.admin}`);
  const [settings, setSettings] = useState<api.SystemSettings | null>(null);
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setError("");
    void api.adminSettings(controller.signal).then(value => { if (active) setSettings(value); }).catch(() => undefined);
    void api.adminVersion(controller.signal).then(value => { if (active) setVersion(value.version); }).catch(() => undefined);
    void Promise.all([api.adminUserSummary(controller.signal), api.adminObjectSummary(controller.signal), api.adminBots(controller.signal)])
      .then(([users, objects, bots]) => { if (active) setData({ users, objects, bots }); })
      .catch(reason => { if (active) setError(api.errorMessage(reason, "概览加载失败，请稍后重试")); });
    return () => { active = false; controller.abort(); };
  }, [attempt]);
  if (error) return <><PageHeader title="概览" /><Panel><EmptyState icon="alert" title="概览加载失败" description={error} action={<Button onClick={() => setAttempt(value => value + 1)}>重试</Button>} /></Panel></>;
  if (!data) return <><PageHeader title="概览" /><Panel><SkeletonRows rows={4} /></Panel></>;
  const used = data.users.used_bytes;
  const activeBots = data.bots.filter(bot => bot.status === "active");
  const nearQuota = data.users.near_quota;
  const attention: { tone: "warning" | "danger" | "accent"; icon: IconName; title: string; detail: string; action: string; module: AdminModule }[] = [];
  if (!activeBots.length) attention.push({ tone: "warning", icon: "send", title: "还没有启用的存储通道", detail: "新上传的文件现在保存在服务器本地磁盘。添加 Telegram Bot 和私有频道后，文件会保存到那里。", action: "添加通道", module: "bots" });
  if (settings && (!settings.public_base_url.effective || !settings.s3_endpoint.effective)) attention.push({ tone: "accent", icon: "globe", title: "尚未配置对外访问地址", detail: `${!settings.public_base_url.effective ? "分享链接目前使用访问者打开的地址生成。" : ""}${!settings.s3_endpoint.effective ? "用户在访问密钥页看不到同步工具要用的服务地址。" : ""}`, action: "去配置", module: "settings" });
  nearQuota.forEach(user => attention.push({ tone: user.used_bytes >= (user.quota_bytes ?? 0) ? "danger" : "warning", icon: "pulse", title: `${api.displayName(user)} 的空间即将用完`, detail: `已使用 ${formatBytes(user.used_bytes)} / ${formatBytes(user.quota_bytes)}。`, action: "调整配额", module: "users" }));
  return (
    <>
      <PageHeader title="概览" description={version ? `${BRAND} ${version}` : undefined} />
      <div className="stat-strip">
        <Stat label="用户" value={data.users.total} detail={`${data.users.active} 个启用`} />
        <Stat label="文件" value={data.objects.total} detail="全部用户" />
        <Stat label="已用空间" value={formatBytes(used)} detail="加密前的原始大小" />
        <Stat label="公开链接" value={data.objects.public_total} detail="任何人可访问" />
        {data.bots.length
          ? <Stat label="存储通道" value={activeBots.length} detail={activeBots.length === data.bots.length ? "全部启用" : `共 ${data.bots.length} 个，${data.bots.length - activeBots.length} 个停用`} />
          : <Stat label="存储通道" value="未配置" detail="文件暂存在本地磁盘" />}
      </div>
      <div className="overview-columns">
        <div className="overview-column">
          <Panel title="需要关注" description="配置缺失或容量吃紧时，会在这里提醒你。" flush>
            {attention.length === 0 ? <EmptyState icon="checkCircle" title="一切正常" description="没有需要处理的配置或容量问题。" /> : (
              <ul className="attention-list">
                {attention.map((item, index) => (
                  <li key={index}>
                    <span className={`attention-icon tone-${item.tone}`}><Icon name={item.icon} size={17} /></span>
                    <span className="attention-copy"><strong>{item.title}</strong><small>{item.detail}</small></span>
                    <Button size="sm" onClick={() => onNavigate(item.module)}>{item.action}</Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="用户空间使用" description="各用户已用空间（加密前的原始大小）。">
            <div className="usage-chart" aria-label="用户空间使用图表">
              {data.users.top_users.map(user => {
                const max = Math.max(1, ...data.users.top_users.map(item => item.used_bytes));
                return <div className="usage-chart-row" key={user.id}><span title={user.username}>{api.displayName(user)}</span><div className="usage-chart-track"><i style={{ width: user.used_bytes ? `${Math.max(2, user.used_bytes / max * 100)}%` : 0 }} /></div><strong>{formatBytes(user.used_bytes)}</strong></div>;
              })}
              {data.users.user_total === 0 && <EmptyState compact icon="users" title="还没有普通用户" description="创建用户后，这里会按空间使用量排列。" action={<Button size="sm" onClick={() => onNavigate("users")}>管理用户</Button>} />}
            </div>
          </Panel>
        </div>
        <div className="overview-column">
          <Panel title="近一小时流量" description="只统计服务启动以来的流量，重启后重新累计。">
            <TrafficChart metrics={status.traffic} />
          </Panel>
        </div>
      </div>
    </>
  );
}

function TrafficChart({ metrics }: { metrics?: api.TrafficMetrics }) {
  const points = metrics?.recent.slice(-12) ?? [];
  const time = (at: number) => new Date(at * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return <div className="traffic-chart" aria-label="近一小时上传下载流量图表">
    <div className="traffic-legend"><span><i className="traffic-dot traffic-in" />上传 {formatBytes(points.reduce((sum, point) => sum + point.in_bytes, 0))}</span><span><i className="traffic-dot traffic-out" />下载 {formatBytes(points.reduce((sum, point) => sum + point.out_bytes, 0))}</span></div>
    {points.length ? <CurveChart label="近一小时上传下载流量曲线" selectionLabel="选择流量时段" formatValue={formatBytes}
      colors={["var(--accent)", "var(--chart-out)"]}
      points={points.map(point => ({ id: point.at, tick: time(point.at), values: [point.in_bytes, point.out_bytes],
        description: `${time(point.at)}：上传 ${formatBytes(point.in_bytes)}，下载 ${formatBytes(point.out_bytes)}` }))} />
      : <p className="muted">暂无流量数据</p>}
  </div>;
}

/** value 是数字时按「万／亿」缩写，悬停显示精确值。 */
export function Stat({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  const text = typeof value === "number" ? formatCount(value) : value;
  const exact = typeof value === "number" && text !== formatNumber(value) ? formatNumber(value) : undefined;
  return <div className="stat"><span className="stat-label">{label}</span><strong className="stat-value" title={exact}>{text}</strong><span className="stat-detail">{detail}</span></div>;
}

