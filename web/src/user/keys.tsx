import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BRAND } from "../brand";
import * as api from "../api";

import { Badge, Button, ConfirmDialog, CopyField, EmptyState, Field, Icon, KeyValue, Modal, PageHeader, Panel, Segmented, SkeletonRows, copyText, formatDate, toast, useDocumentTitle } from "../ui";

/* ---------- 访问密钥 ---------- */

export function KeysView({ bucketName }: { bucketName: string | null }) {
  const [clients, setClients] = useState<api.AdminClient[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(api.CreatedClient & { name: string }) | null>(null);
  const [disabling, setDisabling] = useState<{ client: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<{ client: string; key: string } | null>(null);
  useDocumentTitle(`访问密钥 · ${BRAND}`);
  const load = useCallback(() => { void api.userClients().then(setClients).catch(reason => { setClients([]); toast.error(api.errorMessage(reason, "访问密钥加载失败，请稍后重试")); }); }, []);
  useEffect(load, [load]);
  const endpoint = api.s3Endpoint();
  const bucket = clients?.[0]?.grants[0]?.bucket_name ?? bucketName ?? "你的存储桶";
  return (
    <>
      <PageHeader title="访问密钥" description="让同步工具（如 rclone、AWS CLI）或你自己的脚本访问你的文件。密钥只能访问你自己的文件，随时可以停用。"
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>新建访问密钥</Button>} />
      <div className="stack">
        <Panel title="连接信息" description="创建密钥后，把下面的信息填进你的工具即可。具体写法见使用文档。">
          <KeyValue items={[
            ["HTTP API", <CopyField value={`${api.userSiteOrigin()}/api/v1`} label="HTTP API 地址" />],
            ["S3 Endpoint", endpoint ? <CopyField value={endpoint} label="S3 Endpoint" /> : <span className="muted">管理员还没有设置这个地址，请联系管理员。</span>],
            ["存储桶", <CopyField value={bucket} label="存储桶名称" />],
            ["区域", <code>us-east-1</code>],
          ]} />
        </Panel>
        <Panel title="已创建的密钥" flush actions={clients && clients.length > 0 ? <Badge>{clients.length}</Badge> : undefined}>
          {clients === null ? <SkeletonRows rows={3} /> : clients.length === 0 ? (
            <EmptyState icon="key" title="还没有访问密钥" description="创建密钥后，就可以用命令行工具同步和备份文件。" action={<Button icon="plus" onClick={() => setCreating(true)}>新建访问密钥</Button>} />
          ) : (
            <div className="data-table keys-table" role="table" aria-label="访问密钥">
              <div className="data-row data-head" role="row">
                <span role="columnheader">名称</span><span role="columnheader">Access Key</span><span role="columnheader">状态</span><span role="columnheader">最近使用</span><span role="columnheader"><span className="sr-only">操作</span></span>
              </div>
              {clients.flatMap(client => client.keys.map(key => (
                <div key={key.access_key_id} role="row" className="data-row">
                  <span role="cell" className="cell-strong">{client.name}</span>
                  <span role="cell"><code className="mono">{key.access_key_id}</code></span>
                  <span role="cell">{key.status === "active" && client.status === "active" ? <Badge tone="success" dot>启用</Badge> : <Badge dot>已禁用</Badge>}</span>
                  <span role="cell" className="muted">{key.last_used_at ? formatDate(key.last_used_at) : "从未使用"}</span>
                  <span role="cell" className="cell-actions">
                    {key.status === "active" && <Button size="sm" variant="ghost" onClick={() => setDisabling({ client: client.name, key: key.access_key_id })}>禁用</Button>}
                    <Button size="sm" variant="ghost" className="btn-ghost-danger" onClick={() => setDeleting({ client: client.name, key: key.access_key_id })}>删除</Button>
                  </span>
                </div>
              )))}
            </div>
          )}
        </Panel>
      </div>
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} onCreated={value => { setCreating(false); setCreated(value); load(); }} />}
      {created && <SecretDialog created={created} endpoint={endpoint ?? "https://<S3 Endpoint>"} bucket={bucket} onClose={() => setCreated(null)} />}
      {deleting && <ConfirmDialog title={`删除“${deleting.client}”的密钥？`} description="使用该密钥的程序会立即失去访问权限，删除后无法恢复。如果只是暂时不用，可以选择“禁用”。" confirmLabel="删除密钥"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try { await api.deleteUserKey(deleting.key); toast.success("密钥已删除"); setDeleting(null); load(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作没有完成，请稍后重试")); }
        }} />}
      {disabling && <ConfirmDialog title={`禁用“${disabling.client}”的密钥？`} description="使用该密钥的程序会立即失去访问权限，禁用后无法重新启用。" confirmLabel="禁用密钥"
        onClose={() => setDisabling(null)}
        onConfirm={async () => {
          try { await api.disableUserKey(disabling.key); toast.success("密钥已禁用"); setDisabling(null); load(); }
          catch (reason) { toast.error(api.errorMessage(reason, "操作失败，请稍后重试")); }
        }} />}
    </>
  );
}

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (value: api.CreatedClient & { name: string }) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError("请输入名称，方便以后识别这个密钥"); return; }
    setBusy(true);
    try { onCreated({ ...await api.createUserClient(name.trim()), name: name.trim() }); }
    catch (reason) { setError(api.errorMessage(reason, "创建失败，请稍后重试")); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="新建访问密钥" icon="key" onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="key-form" loading={busy}>创建</Button></>}>
      <form id="key-form" className="form" onSubmit={submit} noValidate>
        <Field label="名称" htmlFor="key-name" error={error} hint="例如设备或用途：NAS 备份、笔记本 rclone">
          <input id="key-name" className="input" value={name} onChange={event => { setName(event.target.value); setError(""); }} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function SecretDialog({ created, endpoint, bucket, onClose }: { created: api.CreatedClient & { name: string }; endpoint: string; bucket: string; onClose: () => void }) {
  const [example, setExample] = useState<"http" | "rclone">("http");
  const rclone = `[tessera]\ntype = s3\nprovider = Other\naccess_key_id = ${created.access_key_id}\nsecret_access_key = ${created.secret}\nendpoint = ${endpoint}\nforce_path_style = true`;
  const curl = `curl -u ${created.access_key_id}:${created.secret} \\\n  ${api.userSiteOrigin()}/api/v1/list`;
  const snippet = example === "http" ? curl : rclone;
  return (
    <Modal title="保存你的 Secret Key" description={`“${created.name}”已创建。Secret Key 只显示这一次，关闭后无法再次查看。`} icon="alert" tone="warning" onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>我已安全保存</Button>}>
      <div className="form">
        <Field label="Access Key ID"><CopyField value={created.access_key_id} label="Access Key ID" /></Field>
        <Field label="Secret Access Key"><CopyField value={created.secret} label="Secret Access Key" secret copyMessage="Secret 已复制" /></Field>
        <Field label="使用示例" hint={example === "http" ? "列出根目录文件；更多接口见使用文档的 API 参考。" : `存储桶：${bucket}`}>
          <Segmented label="示例" value={example} onChange={setExample} options={[{ value: "http", label: "HTTP API" }, { value: "rclone", label: "rclone" }]} />
          <div className="code-block"><div className="code-block-bar"><span>{example === "http" ? "Shell" : "rclone.conf"}</span><button type="button" onClick={() => void copyText(snippet, "示例已复制")}><Icon name="copy" size={14} />复制</button></div><pre><code>{snippet.replace(created.secret, "•".repeat(12))}</code></pre></div>
        </Field>
      </div>
    </Modal>
  );
}

