import { useCallback, useEffect, useState } from "react";
import { SITE } from "../brand";
import * as api from "../api";

import { Badge, Button, ConfirmDialog, EmptyState, PageHeader, SkeletonRows, toast, useDocumentTitle } from "../ui";

/* ---------- 访问密钥 ---------- */

export function Clients() {
  const [clients, setClients] = useState<api.AdminClient[] | null>(null);
  const [owners, setOwners] = useState<Map<number, string>>(new Map());
  const [disabling, setDisabling] = useState<api.AdminClient | null>(null);
  const [deleting, setDeleting] = useState<api.AdminClient | null>(null);
  useDocumentTitle(`全部访问密钥 · ${SITE.admin}`);
  const load = useCallback(() => {
    void Promise.all([api.adminClients(), api.adminUsers()])
      .then(([items, users]) => { setClients(items); setOwners(new Map(users.map(user => [user.id, user.username]))); })
      .catch(reason => { setClients([]); toast.error(api.errorMessage(reason, "访问密钥加载失败，请稍后重试")); });
  }, []);
  useEffect(load, [load]);
  async function setStatus(client: api.AdminClient, status: "active" | "disabled") {
    try { await api.setAdminClientStatus(client.id, status); toast.success(status === "active" ? `已启用 ${client.name}` : `已停用 ${client.name}`); load(); }
    catch (reason) { toast.error(api.errorMessage(reason, "状态更新失败，请稍后重试")); }
  }
  return (
    <>
      <PageHeader title="全部访问密钥" description="用户创建的访问凭据，可用于 HTTP API 和 S3。管理员可以查看归属与授权范围并停用密钥，但看不到 Secret。" />
      <section className="file-surface">
        {clients === null ? <SkeletonRows rows={3} /> : clients.length === 0 ? <EmptyState icon="key" title="还没有访问密钥" description="用户在自己的“访问密钥”页面创建后会显示在这里。" /> : (
          <div className="data-table clients-table" role="table" aria-label="访问密钥">
            <div className="data-row data-head" role="row">
              <span role="columnheader">名称</span><span role="columnheader">所有者</span><span role="columnheader">授权范围</span><span role="columnheader">状态</span><span role="columnheader"><span className="sr-only">操作</span></span>
            </div>
            {clients.map(client => {
              // 状态要同时看客户端和它的密钥：用户在自己的页面里“禁用”的是密钥本身，客户端状态不会变。
              const activeKeys = client.keys.filter(key => key.status === "active").length;
              const stopped = client.status !== "active";
              return (
              <div key={client.id} role="row" className="data-row">
                <span role="cell" className="name-stack"><strong>{client.name}</strong>
                  <small className="mono">{client.keys.map(key => key.status === "active" ? key.access_key_id : `${key.access_key_id}（已禁用）`).join("，") || "无密钥"}</small></span>
                <span role="cell" className="muted">{client.owner_user_id ? owners.get(client.owner_user_id) ?? `用户 ${client.owner_user_id}` : "管理员创建"}</span>
                <span role="cell" className="grant-list">{client.grants.length ? client.grants.map(grant => <Badge key={`${grant.bucket_id}:${grant.prefix}`} tone={grant.perms === "rw" ? "accent" : "neutral"}>{grant.bucket_name}/{grant.prefix || "*"} {grant.perms === "rw" ? "读写" : "只读"}</Badge>) : <span className="muted">无授权</span>}</span>
                <span role="cell">
                  {stopped ? <Badge dot>已停用</Badge>
                    : activeKeys === 0 ? <Badge dot>已禁用</Badge>
                      : activeKeys < client.keys.length ? <Badge tone="warning" dot>部分启用</Badge>
                        : <Badge tone="success" dot>启用</Badge>}
                </span>
                <span role="cell" className="cell-actions">
                  {stopped ? <Button size="sm" onClick={() => void setStatus(client, "active")}>启用</Button>
                    : activeKeys > 0 && <Button size="sm" variant="ghost" onClick={() => setDisabling(client)}>停用</Button>}
                  <Button size="sm" variant="ghost" className="btn-ghost-danger" onClick={() => setDeleting(client)}>删除</Button>
                </span>
              </div>
              );
            })}
          </div>
        )}
      </section>
      {deleting && <ConfirmDialog title={`删除 ${deleting.name}？`} description="它的所有密钥和授权会被永久删除，使用这些密钥的程序会立即失去访问权限，无法恢复。" confirmLabel="永久删除" onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try { await api.deleteAdminClient(deleting.id); toast.success(`已删除 ${deleting.name}`); setDeleting(null); load(); }
          catch (reason) { toast.error(api.errorMessage(reason, "删除失败，请稍后重试")); }
        }} />}
      {disabling && <ConfirmDialog title={`停用 ${disabling.name}？`} description="使用该凭据的程序会立即失去访问权限。可以随时重新启用。" confirmLabel="停用" onClose={() => setDisabling(null)}
        onConfirm={async () => { await setStatus(disabling, "disabled"); setDisabling(null); }} />}
    </>
  );
}

