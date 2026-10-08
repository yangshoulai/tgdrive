import { useEffect, useState } from "react";
import { SITE } from "../brand";
import * as api from "../api";
import { FileTile, baseName, getFileKind } from "../files";

import { Badge, Button, EmptyState, Icon, PageHeader, Panel, SkeletonRows, formatBytes, formatDate, formatDateTime, toast, useDocumentTitle, type IconName } from "../ui";

import type { AdminModule } from "../admin";

/* ---------- 概览 ---------- */

export function Overview({ onNavigate, status }: { onNavigate: (module: AdminModule) => void; status: api.SystemStatus }) {
  const [data, setData] = useState<{ users: api.Account[]; objects: api.AdminObjectPage; bots: api.BotConfig[] } | null>(null);
  useDocumentTitle(`概览 · ${SITE.admin}`);
  const [settings, setSettings] = useState<api.SystemSettings | null>(null);
  useEffect(() => {
    void api.adminSettings().then(setSettings).catch(() => undefined);
    void Promise.all([api.adminUsers(), api.adminObjects({ limit: 6 }), api.adminBots()])
      .then(([users, objects, bots]) => setData({ users, objects, bots }))
      .catch(reason => toast.error(api.errorMessage(reason, "概览加载失败，请稍后重试")));
  }, []);
  if (!data) return <><PageHeader title="概览" /><Panel><SkeletonRows rows={4} /></Panel></>;
  const used = data.users.reduce((sum, user) => sum + user.used_bytes, 0);
  const files = data.objects.objects;
  const activeBots = data.bots.filter(bot => bot.status === "active");
  const nearQuota = data.users.filter(user => user.quota_bytes && user.used_bytes / user.quota_bytes >= 0.85);
  const attention: { tone: "warning" | "danger" | "accent"; icon: IconName; title: string; detail: string; action: string; module: AdminModule }[] = [];
  if (!activeBots.length) attention.push({ tone: "warning", icon: "send", title: "还没有启用的存储通道", detail: "新上传的文件现在保存在服务器本地磁盘。添加 Telegram Bot 和私有频道后，文件会保存到那里。", action: "添加通道", module: "bots" });
  if (settings && (!settings.public_base_url.effective || !settings.s3_endpoint.effective)) attention.push({ tone: "accent", icon: "globe", title: "尚未配置对外访问地址", detail: `${!settings.public_base_url.effective ? "分享链接目前使用访问者打开的地址生成。" : ""}${!settings.s3_endpoint.effective ? "用户在访问密钥页看不到同步工具要用的服务地址。" : ""}`, action: "去配置", module: "settings" });
  if (data.users.filter(user => user.role === "user").length === 0) attention.push({ tone: "accent", icon: "users", title: "还没有普通用户", detail: "创建用户后，他们可以登录文件空间上传和分享文件。", action: "创建用户", module: "users" });
  nearQuota.forEach(user => attention.push({ tone: user.used_bytes >= (user.quota_bytes ?? 0) ? "danger" : "warning", icon: "pulse", title: `${user.username} 的空间即将用完`, detail: `已使用 ${formatBytes(user.used_bytes)} / ${formatBytes(user.quota_bytes)}。`, action: "调整配额", module: "users" }));
  return (
    <>
      <PageHeader title="概览" description="存储、用户和分享的整体情况。" />
      <div className="stat-strip">
        <Stat label="用户" value={String(data.users.length)} detail={`${data.users.filter(user => user.status === "active").length} 个启用`} />
        <Stat label="文件" value={data.objects.total.toLocaleString("zh-CN")} detail="全部用户" />
        <Stat label="已用空间" value={formatBytes(used)} detail="加密前的原始大小" />
        <Stat label="公开链接" value={data.objects.public_total.toLocaleString("zh-CN")} detail="任何人可访问" tone={data.objects.public_total ? "public" : undefined} />
        <Stat label="存储通道" value={`${activeBots.length}/${data.bots.length}`} detail="启用 / 全部" />
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
              {data.users.filter(user => user.role === "user").slice().sort((a, b) => b.used_bytes - a.used_bytes).slice(0, 8).map(user => {
                const max = Math.max(1, ...data.users.map(item => item.used_bytes));
                return <div className="usage-chart-row" key={user.id}><span>{user.username}</span><div className="usage-chart-track"><i style={{ width: `${Math.max(2, user.used_bytes / max * 100)}%` }} /></div><strong>{formatBytes(user.used_bytes)}</strong></div>;
              })}
              {!data.users.some(user => user.role === "user") && <p className="muted">还没有普通用户</p>}
            </div>
          </Panel>
        </div>
        <div className="overview-column">
          <Panel title="近一小时流量" description="只统计服务启动以来的流量，重启后重新累计。">
            <TrafficChart metrics={status.traffic} />
          </Panel>
          <Panel title="最近上传" flush actions={<Button size="sm" variant="ghost" onClick={() => onNavigate("objects")}>查看全部</Button>}>
            {files.length === 0 ? <EmptyState icon="box" title="还没有文件" description="用户上传的文件会显示在这里。" /> : (
              <ul className="recent-list">
                {files.slice(0, 6).map(item => (
                  <li key={`${item.bucket_id}:${item.key}`}>
                    <FileTile kind={getFileKind(item.content_type, item.key)} />
                    <span className="recent-copy"><strong>{baseName(item.key)}</strong><small>{item.username ?? item.bucket_name}</small></span>
                    {item.public_token && <Badge tone="public" icon="globe">公开</Badge>}
                    <span className="muted recent-meta">{formatBytes(item.size)}</span>
                    <span className="muted recent-meta">{formatDate(item.modified_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function TrafficChart({ metrics }: { metrics?: api.TrafficMetrics }) {
  const points = metrics?.recent.slice(-12) ?? [];
  const max = Math.max(1, ...points.flatMap(point => [point.in_bytes, point.out_bytes]));
  return <div className="traffic-chart" aria-label="近一小时上传下载流量图表">
    <div className="traffic-legend"><span><i className="traffic-dot traffic-in" />上传 {formatBytes(metrics?.total_in_bytes ?? 0)}</span><span><i className="traffic-dot traffic-out" />下载 {formatBytes(metrics?.total_out_bytes ?? 0)}</span></div>
    <div className="traffic-bars">
      {points.map(point => <div className="traffic-bar" key={point.at} title={`${formatDateTime(point.at)}：上传 ${formatBytes(point.in_bytes)}，下载 ${formatBytes(point.out_bytes)}`}>
        <i className="traffic-in" style={{ height: `${Math.max(2, point.in_bytes / max * 100)}%` }} /><i className="traffic-out" style={{ height: `${Math.max(2, point.out_bytes / max * 100)}%` }} />
      </div>)}
      {!points.length && <p className="muted">暂无流量数据</p>}
    </div>
  </div>;
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "public" }) {
  return <div className={`stat${tone ? ` stat-${tone}` : ""}`}><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong><span className="stat-detail">{detail}</span></div>;
}

