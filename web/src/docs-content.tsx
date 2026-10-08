/** 文档内容。所有接口与限制都对应 tgdrive/asgi.py、tgdrive/s3/ 中的实际实现，修改后端时请同步更新。 */
import type { ComponentType } from "react";
import {
  C, Callout, Card, CardGrid, Code, CodeTabs, DocLink, Endpoint, Flow, H2, H3, Params, Step, Steps, Table, useDocsConfig,
} from "./docs-ui";
import type { IconName } from "./ui";

export type DocPage = { slug: string; group: string; title: string; summary: string; keywords: string; icon: IconName; Content: ComponentType };

export const DOC_GROUPS = ["入门", "使用指南", "API 参考", "管理员"];

const OBJECT_JSON = `{
  "key": "docs/report.pdf",
  "size": 482113,
  "etag": "9b2cf535f27731c974343645a3985328",
  "content_type": "application/pdf",
  "user_meta": {},
  "modified_at": 1791367790.12,
  "public_token": null,
  "public_at": null
}`;

/* ---------------------------------------------------------------- 入门 */

function Overview() {
  return (
    <>
      <p>tgdrive 是一个自托管的私有对象存储。文件在服务器上加密并切分为分片，以消息的形式保存在你自己的 Telegram 私有频道里；服务器只保存元数据和加密后的密钥。</p>
      <Flow nodes={[
        { icon: "upload", title: "上传", detail: "浏览器或 S3 客户端" },
        { icon: "lock", title: "加密与分片", detail: "AES-256-GCM，每片 16 MiB" },
        { icon: "send", title: "私有频道", detail: "由你的 Bot 写入" },
      ]} />
      <H2>核心概念</H2>
      <Table head={["概念", "说明"]} rows={[
        ["存储桶", <>每个用户拥有一个独立的存储桶，名称形如 <C>user-2</C>。容量配额按存储桶计算。</>],
        ["对象与路径", <>文件以完整路径存储，例如 <C>photos/2026/trip.jpg</C>。路径区分大小写，最长 1024 字节。</>],
        ["文件夹", <>路径中 <C>/</C> 之前的部分。空文件夹以一个以 <C>/</C> 结尾的目录标记保存。</>],
        ["公开链接", "为单个文件生成的随机地址，任何拥有链接的人都可以免登录访问，可随时关闭。"],
        ["访问密钥", "供 rclone、AWS CLI 等工具使用的 S3 凭据，每个密钥只能访问其所有者的存储桶。"],
        ["主密钥", "由管理员的加密口令派生。服务重启后需要管理员解锁，解锁前所有文件都无法读取。"],
      ]} />
      <H2>访问方式</H2>
      <CardGrid>
        <Card to="files" icon="folder" title="网页文件空间">上传、整理、预览和分享文件。</Card>
        <Card to="s3" icon="key" title="S3 客户端">用 rclone、AWS CLI、boto3 同步与备份。</Card>
        <Card to="api-basics" icon="code" title="HTTP API">用访问密钥从脚本和程序调用的 JSON 接口。</Card>
        <Card to="sharing" icon="globe" title="公开分享">分享页与可嵌入的直链。</Card>
      </CardGrid>
    </>
  );
}

function QuickStart() {
  const { site } = useDocsConfig();
  return (
    <>
      <H2>管理员：首次部署</H2>
      <Steps>
        <Step title="初始化系统">打开控制台，设置加密口令并创建管理员账号。口令无法找回，请立即保存到密码管理器。</Step>
        <Step title="添加存储通道">在 Telegram 中向 @BotFather 创建 Bot，把它设为一个私有频道的管理员，然后在控制台「存储通道」中填写 Bot token 和频道 ID（<C>-100</C> 开头）。</Step>
        <Step title="配置访问地址">在「系统设置」中填写公开访问地址和 S3 Endpoint，分享链接与本文档的示例会使用它们。</Step>
        <Step title="创建用户">在「用户」中创建账号并设置容量上限，把用户名和初始密码交给对方。</Step>
      </Steps>
      <Callout tone="warning" title="每次重启都需要解锁">主密钥只保存在内存中。服务重启后，管理员需要在控制台输入加密口令解锁，用户才能登录，公开链接才能访问。</Callout>
      <H2>用户：开始使用</H2>
      <Steps>
        <Step title="登录">打开 <a className="doc-link" href={site}>{site}</a>，使用管理员提供的账号登录，之后在账号菜单中修改密码。</Step>
        <Step title="上传文件">点击「上传」或把文件拖进页面。勾选「上传后公开访问」可以直接生成分享链接。</Step>
        <Step title="整理与分享">用文件夹、移动和重命名整理文件；在文件菜单中选择「公开分享」获取链接。</Step>
        <Step title="连接其他工具">在「访问密钥」中创建密钥。同一个密钥既可以调用 <DocLink to="api-basics">HTTP API</DocLink>，也可以用于 <DocLink to="s3">S3 客户端</DocLink>。</Step>
      </Steps>
    </>
  );
}

/* ---------------------------------------------------------------- 使用指南 */

function FilesGuide() {
  return (
    <>
      <H2>上传</H2>
      <p>点击页面右上角的「上传」，或直接把文件拖到文件列表上。确认窗口中可以移除不需要的文件，并选择是否在上传后公开访问。上传托盘显示每个文件的进度，可以单独取消。</p>
      <Callout tone="info">与现有文件同名时会覆盖原文件，确认窗口会提前标出「将覆盖」。覆盖不会改变已有的公开链接。</Callout>
      <H2>整理</H2>
      <Table head={["操作", "方法", "说明"]} rows={[
        ["新建文件夹", "页面右上角「新建文件夹」", "在当前文件夹中创建"],
        ["移动", "文件菜单「移动到…」，多选后「移动」，或拖到文件夹、面包屑上", "文件夹连同其中所有内容一起移动"],
        ["重命名", "文件菜单「重命名」", "目标名称已存在时会提示，不会合并"],
        ["删除", "文件菜单「删除」或多选后删除", "删除文件夹会删除其中所有文件，无法撤销"],
        ["搜索", "工具栏搜索框，按回车", "在全部文件夹中按文件名搜索，不区分大小写"],
      ]} />
      <H3>移动时的同名冲突</H3>
      <Table head={["选项", "结果"]} rows={[
        ["保留两者（默认）", <>移动的文件自动改名为 <C>名称 (1).扩展名</C></>],
        ["跳过", "同名文件留在原处，其余文件照常移动"],
        ["覆盖", "目标位置的同名文件被替换，无法恢复"],
      ]} />
      <p>同名文件夹会自动合并。文件夹不能移动到它自己或它的子文件夹中。</p>
      <H2>预览</H2>
      <Table head={["类型", "支持的格式"]} rows={[
        ["图片", "PNG、JPEG、GIF、WebP、AVIF、BMP"],
        ["视频与音频", "MP4、WebM、MOV、MP3、M4A、OGG、WAV、FLAC，支持拖动进度条"],
        ["文档", "PDF；纯文本、Markdown、JSON、CSV、日志与源代码（预览前 512 KB）"],
      ]} />
      <p>其他类型显示下载按钮。浏览器无法解码的媒体也会回退到下载。</p>
      <H2>路径规则</H2>
      <ul className="doc-list">
        <li>路径不能以 <C>/</C> 开头，不能包含空段、<C>.</C> 或 <C>..</C>，不能包含控制字符。</li>
        <li>UTF-8 编码后最长 1024 字节。</li>
        <li><C>.tgdrive/</C> 为系统保留前缀。</li>
      </ul>
      <H2>容量</H2>
      <p>侧栏底部显示已用空间和配额。容量按文件原始大小计算，在每次上传提交时校验；超出后上传失败并提示 <C>quota_exceeded</C>，需要删除文件或联系管理员提高配额。复制文件会计入新文件的大小。</p>
    </>
  );
}

function SharingGuide() {
  const { site } = useDocsConfig();
  return (
    <>
      <p>文件默认只有自己可见。开启公开访问后，系统为文件生成一个 16 位的随机令牌，任何拥有链接的人都无需登录即可访问。</p>
      <H2>两种链接</H2>
      <Table head={["链接", "格式", "适合"]} rows={[
        ["分享页", <C>{site}/s/&lt;令牌&gt;</C>, "发给他人：带预览、文件信息和下载按钮"],
        ["直链", <C>{site}/p/&lt;令牌&gt;/&lt;文件名&gt;</C>, <>嵌入网页的 <C>&lt;img&gt;</C>、<C>&lt;video&gt;</C>，或交给下载工具；支持断点续传</>],
      ]} />
      <p>直链末尾的文件名只为便于识别，改成其他名字也能访问。加上 <C>?download=1</C> 会强制浏览器下载而不是打开。</p>
      <H2>开启与关闭</H2>
      <ul className="doc-list">
        <li>上传时开启：在上传确认窗口中打开「上传后公开访问」。</li>
        <li>之后开启：点击文件行的链接图标，或在文件菜单中选择「公开分享」。多选后可以批量公开。</li>
        <li>查看全部：侧栏「公开分享」列出所有公开文件，可以复制链接或停止分享。</li>
      </ul>
      <H2>链接什么时候会变化</H2>
      <Table head={["操作", "链接"]} rows={[
        ["覆盖上传同名文件", "保持不变，访问者看到新内容"],
        ["移动或重命名", "保持不变"],
        ["关闭公开访问", "立即失效；再次开启会生成新链接"],
        ["删除文件", "立即失效"],
        ["账号被禁用、系统锁定", "暂停访问，恢复后继续有效"],
        ["管理员撤销", "立即失效"],
      ]} />
      <Callout tone="warning" title="公开链接等同于文件本身">任何拿到链接的人都能下载文件，也可以继续转发。只分享你愿意让任何人看到的内容。文件夹不能公开。</Callout>
      <H2>访问者能看到什么</H2>
      <p>分享页只显示文件名、大小、类型和修改时间，不会显示你的用户名、文件所在的文件夹或其他文件。</p>
    </>
  );
}

function S3Guide() {
  const { s3, s3Configured } = useDocsConfig();
  return (
    <>
      <p>tgdrive 提供 S3 兼容网关，可以直接使用 rclone、AWS CLI、boto3 等工具。先在网页「访问密钥」中创建密钥，Secret 只显示一次。</p>
      {!s3Configured && <Callout tone="warning" title="尚未配置 S3 Endpoint">管理员还没有在「系统设置」中配置 S3 Endpoint，下面的示例使用占位地址 <C>{s3}</C>。</Callout>}
      <H2>连接参数</H2>
      <Table head={["参数", "值"]} rows={[
        ["Endpoint", <C>{s3}</C>],
        ["访问方式", <>路径风格（path-style），即 <C>{s3}/存储桶/路径</C></>],
        ["区域", <C>us-east-1</C>],
        ["签名", "AWS Signature V4，请求头签名或预签名 URL"],
        ["存储桶", <>你的存储桶名称，形如 <C>user-2</C>，在「访问密钥」页查看</>],
      ]} />
      <H2>rclone</H2>
      <Code lang="ini" title="~/.config/rclone/rclone.conf" code={`
[tgdrive]
type = s3
provider = Other
access_key_id = <Access Key ID>
secret_access_key = <Secret Access Key>
endpoint = ${s3}
region = us-east-1
force_path_style = true`} />
      <Code lang="bash" code={`
rclone ls tgdrive:user-2
rclone copy ./photos tgdrive:user-2/photos --progress
rclone sync ./backup tgdrive:user-2/backup`} />
      <H2>AWS CLI</H2>
      <Code lang="bash" code={`
aws configure --profile tgdrive   # 填写 Access Key、Secret，区域 us-east-1
aws configure set profile.tgdrive.s3.addressing_style path
aws configure set profile.tgdrive.s3.signature_version s3v4   # AWS CLI v1 需要，v2 默认即为 SigV4

aws --profile tgdrive --endpoint-url ${s3} s3 ls s3://user-2/
aws --profile tgdrive --endpoint-url ${s3} s3 cp ./report.pdf s3://user-2/docs/report.pdf
aws --profile tgdrive --endpoint-url ${s3} s3 cp s3://user-2/docs/report.pdf ./report.pdf

# 服务端复制、移动与同步：不经过本机传输
aws --profile tgdrive --endpoint-url ${s3} s3 cp s3://user-2/docs/ s3://user-2/backup/docs/ --recursive
aws --profile tgdrive --endpoint-url ${s3} s3 mv s3://user-2/inbox/a.pdf s3://user-2/archive/a.pdf`} />
      <H2>Python（boto3）</H2>
      <Code lang="python" code={`
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="${s3}",
    aws_access_key_id="<Access Key ID>",
    aws_secret_access_key="<Secret Access Key>",
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
)

s3.upload_file("report.pdf", "user-2", "docs/report.pdf")
for item in s3.list_objects_v2(Bucket="user-2", Prefix="docs/").get("Contents", []):
    print(item["Key"], item["Size"])`} />
      <H2>预签名 URL</H2>
      <p>预签名 URL 可以在不暴露 Secret 的情况下临时授权下载或上传，有效期 1 秒到 7 天。</p>
      <Code lang="python" code={`
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "user-2", "Key": "docs/report.pdf"},
    ExpiresIn=3600,  # 1 小时
)`} />
      <Callout tone="tip">需要长期公开的文件，使用 <DocLink to="sharing">公开分享</DocLink> 更合适：链接不会过期，也可以随时关闭。</Callout>
      <H2>兼容性</H2>
      <Table head={["操作", "支持"]} rows={[
        ["ListBuckets、HeadBucket、GetBucketLocation", "支持"],
        ["ListObjectsV2（prefix、delimiter、分页）", "支持，每页最多 1000 项；不带 delimiter 时递归列出"],
        ["GetObject（含 Range）、HeadObject", "支持"],
        ["PutObject（含 aws-chunked 流式签名）", "支持"],
        ["DeleteObject", "支持"],
        ["分段上传：Create、UploadPart、Complete、Abort", "支持；除最后一段外每段至少 5 MiB，最多 10000 段"],
        ["CopyObject（服务端复制）", <>支持；支持 <C>COPY</C> / <C>REPLACE</C> 元数据指令与 <C>x-amz-copy-source-if-match</C> 等条件</>],
        ["UploadPartCopy（分段复制）", <>支持，含 <C>x-amz-copy-source-range</C></>],
        ["DeleteObjects（批量删除）", "支持；每次最多 1000 个键，逐项返回结果，支持 Quiet 模式"],
        ["版本、ACL、生命周期、对象锁、POST 表单上传", <span className="doc-no">不支持</span>],
      ]} />
      <H3>服务端复制</H3>
      <p>CopyObject 不搬运数据：副本与源文件共享同一份加密分片，任意大小的文件都能立即完成，但副本计入容量。复制需要对源路径有读取权限、对目标路径有写入权限；可以在你有权限的存储桶之间复制。</p>
      <p>超过 8 MB 的文件，AWS CLI 和 boto3 会改用分段复制（UploadPartCopy），这时数据会在服务端解密并重新加密写入，耗时与文件大小成正比。</p>
      <ul className="doc-list">
        <li>覆盖已有文件时，目标文件原有的公开链接保持不变；新建的副本默认不公开。</li>
        <li>把文件复制到自身时必须使用 <C>REPLACE</C> 指令修改元数据，否则返回 <C>InvalidRequest</C>。</li>
        <li>批量删除时，无权限或路径不合法的键在 <C>Error</C> 中逐项返回，不影响其他键；删除不存在的键视为成功。</li>
      </ul>
      <H3>大文件与请求体校验</H3>
      <ul className="doc-list">
        <li>上传和下载都以流的形式处理，内存占用与文件大小无关。单次 PutObject 与单个分段最大 5 GiB，更大的文件请使用分段上传（AWS CLI、rclone 和 boto3 会自动分段）。</li>
        <li>请求体按 <C>x-amz-content-sha256</C> 声明的方式边读边校验：完整哈希、aws-chunked 逐块签名，以及带 <C>x-amz-checksum-crc32</C>、<C>sha1</C>、<C>sha256</C> 尾部校验和的未签名分块。内容与声明不符时返回 <C>XAmzContentSHA256Mismatch</C> 或 <C>BadDigest</C>，不会保存任何内容。</li>
        <li>声明了大小的上传在开始前就检查容量，超出配额立即返回 <C>QuotaExceeded</C>，不会先占用 Telegram 存储。</li>
      </ul>
    </>
  );
}

/* ---------------------------------------------------------------- API 参考 */

function ApiBasics() {
  const { site } = useDocsConfig();
  return (
    <>
      <p>HTTP API 面向脚本和程序，基础地址为 <C>{site}/api/v1</C>，请求与响应都是 JSON。它和 <DocLink to="s3">S3 接口</DocLink> 使用同一套访问密钥和授权，可以按需选择：HTTP API 更容易用 curl 或任意语言直接调用，S3 适合 rclone、AWS CLI 等现成工具。</p>
      <H2>认证</H2>
      <p>先在网页「访问密钥」中创建密钥，得到 Access Key ID 和 Secret。每个请求都在 <C>Authorization</C> 头中携带两者，任选一种格式：</p>
      <Table head={["方式", "请求头"]} rows={[
        ["Bearer", <C>Authorization: Bearer &lt;AccessKeyId&gt;:&lt;Secret&gt;</C>],
        ["HTTP Basic", <>用户名为 Access Key ID、密码为 Secret，例如 <C>curl -u AK:SECRET</C></>],
      ]} />
      <CodeTabs tabs={[
        { label: "curl", lang: "bash", code: `
export TGDRIVE_KEY="TGD…:your-secret"   # AccessKeyId:Secret

curl -H "Authorization: Bearer $TGDRIVE_KEY" ${site}/api/v1/me
curl -H "Authorization: Bearer $TGDRIVE_KEY" "${site}/api/v1/list?prefix=docs/"` },
        { label: "JavaScript", lang: "js", code: `
const base = "${site}/api/v1";
const headers = { Authorization: \`Bearer \${process.env.TGDRIVE_KEY}\` };

const me = await (await fetch(\`\${base}/me\`, { headers })).json();
const page = await (await fetch(\`\${base}/list?prefix=docs/\`, { headers })).json();` },
        { label: "Python", lang: "python", code: `
import os, requests

base = "${site}/api/v1"
session = requests.Session()
session.headers["Authorization"] = f"Bearer {os.environ['TGDRIVE_KEY']}"

print(session.get(f"{base}/me").json())
print(session.get(f"{base}/list", params={"prefix": "docs/"}).json())` },
      ]} />
      <Callout tone="warning" title="像密码一样保管 Secret">请求头中直接携带 Secret，生产环境务必通过 HTTPS 访问。不要把密钥写进网页前端代码或提交到代码仓库；泄露后立即在「访问密钥」中禁用。</Callout>
      <ul className="doc-list">
        <li>密钥认证的请求不读取 Cookie，也不需要 CSRF 令牌。网页文件空间使用的 <C>/api/user/v1</C> 是内部接口，只接受浏览器会话，不能使用密钥访问。</li>
        <li>密钥被禁用、所属账号被禁用时返回 401；系统锁定时返回 503。</li>
        <li>每个请求都会更新密钥的「最近使用」时间，可在「访问密钥」页查看。</li>
      </ul>
      <H2>请求约定</H2>
      <ul className="doc-list">
        <li>JSON 请求使用 <C>Content-Type: application/json</C>，请求体不超过 1 MB。上传文件时请求体是文件本身。</li>
        <li>路径使用不以 <C>/</C> 开头的完整路径，文件夹以 <C>/</C> 结尾，例如 <C>docs/</C>。</li>
        <li>密钥只授权一个存储桶时无需指定；授权了多个存储桶时，需在查询参数或 JSON 请求体中提供 <C>bucket</C>。见 <DocLink to="api-permissions">权限与存储桶</DocLink>。</li>
        <li>时间是 Unix 秒级时间戳（浮点数），大小以字节为单位；列表接口通过 <C>next_cursor</C> 分页。</li>
      </ul>
      <H2>对象格式</H2>
      <p>文件类接口返回的对象具有以下字段：</p>
      <Code lang="json" code={OBJECT_JSON} />
      <Table compact head={["字段", "说明"]} rows={[
        [<C>key</C>, "完整路径；文件夹标记以 / 结尾"],
        [<C>etag</C>, "内容的 MD5；分段上传的对象为 “MD5-段数”"],
        [<C>content_type</C>, "上传时声明的 MIME 类型，可能为 null"],
        [<C>public_token</C>, <>公开令牌，未公开时为 null。见 <DocLink to="api-sharing">分享接口</DocLink></>],
      ]} />
      <H2>错误</H2>
      <p>出错时返回对应的 HTTP 状态码和统一的 JSON 结构：</p>
      <Code lang="json" code={`{ "error": { "code": "quota_exceeded", "message": "已超过当前用户的存储配额" } }`} />
      <Table head={["状态码", "code", "含义与处理"]} rows={[
        ["400", <C>bad_request</C>, "参数缺失、路径不合法，或多桶密钥未指定 bucket；message 中有具体原因"],
        ["401", <C>invalid_key</C>, "缺少 Authorization 头，或密钥错误、已禁用"],
        ["403", <C>forbidden</C>, "密钥没有该存储桶或路径的权限，或只读密钥尝试写入"],
        ["404", <C>not_found</C>, "文件或接口不存在"],
        ["413", <C>quota_exceeded</C>, "上传后会超出容量配额"],
        ["413", <C>body_too_large</C>, "JSON 请求体超过 1 MB"],
        ["416", <C>range_not_satisfiable</C>, <>Range 超出文件大小；响应头 <C>Content-Range</C> 给出实际大小</>],
        ["500", <C>integrity_error</C>, "分片校验失败，请联系管理员运行完整性校验"],
        ["503", <C>locked</C>, "系统已锁定，等待管理员解锁"],
      ]} />
    </>
  );
}

function ApiFiles() {
  const { site } = useDocsConfig();
  return (
    <>
      <p>以下路径都相对于 <C>{site}/api/v1</C>，所有接口都需要 <DocLink to="api-basics#认证">访问密钥</DocLink>。示例中的 <C>$TGDRIVE_KEY</C> 为 <C>AccessKeyId:Secret</C>。</p>
      <H2>列出与搜索</H2>
      <Endpoint method="GET" path="/list" auth="key" summary="列出某个文件夹的直接内容：文件在 objects 中，子文件夹在 common_prefixes 中。">
        <Params title="查询参数" rows={[
          ["prefix", "string", false, <>文件夹路径，以 <C>/</C> 结尾；省略表示根目录</>],
          ["cursor", "string", false, <>上一页返回的 <C>next_cursor</C></>],
          ["limit", "number", false, "每页数量，默认且最多 1000"],
          ["bucket", "string", false, "存储桶名称，仅多桶密钥需要"],
        ]} />
        <Code lang="json" title="响应" code={`{
  "objects": [ { "key": "docs/report.pdf", "size": 482113, "...": "..." } ],
  "common_prefixes": ["docs/drafts/"],
  "next_cursor": null
}`} />
      </Endpoint>
      <Endpoint method="GET" path="/search" auth="key" summary="在所有文件夹中按路径搜索文件，不区分大小写，不返回文件夹；只返回密钥有权读取的文件。">
        <Params title="查询参数" rows={[
          ["q", "string", true, "关键词，1 到 256 个字符"],
          ["cursor", "string", false, "分页游标"],
          ["limit", "number", false, "每页数量，默认 100，最多 200"],
        ]} />
      </Endpoint>
      <H2>上传与下载</H2>
      <Endpoint method="PUT" path="/files" auth="key" summary="上传文件。请求体是文件的原始字节，服务器以流式方式接收，不会整体读入内存。同名文件会被覆盖。需要读写权限。">
        <Params title="查询参数" rows={[
          ["path", "string", true, "目标路径"],
          ["public", "0 | 1", false, "1 表示上传后公开，0 表示关闭公开；省略时保持原文件的公开状态"],
        ]} />
        <Params title="请求头" rows={[
          ["Content-Type", "string", false, "文件的 MIME 类型，决定预览方式"],
          ["Content-Length", "number", false, "提供时会校验实际大小"],
        ]} />
        <CodeTabs tabs={[
          { label: "curl", lang: "bash", code: `
curl -X PUT "${site}/api/v1/files?path=docs/report.pdf&public=1" \\
  -H "Authorization: Bearer $TGDRIVE_KEY" -H 'Content-Type: application/pdf' \\
  --data-binary @report.pdf` },
          { label: "JavaScript", lang: "js", code: `
import { readFile } from "node:fs/promises";

const response = await fetch(\`\${base}/files?path=\${encodeURIComponent("docs/report.pdf")}&public=1\`, {
  method: "PUT",
  headers: { ...headers, "Content-Type": "application/pdf" },
  body: await readFile("report.pdf"),
});
const object = await response.json();` },
          { label: "Python", lang: "python", code: `
with open("report.pdf", "rb") as body:
    obj = session.put(f"{base}/files", params={"path": "docs/report.pdf", "public": "1"},
                      data=body, headers={"Content-Type": "application/pdf"}).json()
print(obj["public_token"])` },
        ]} />
        <p>成功时返回 <DocLink to="api-basics#对象格式">对象</DocLink>。超出配额返回 413。</p>
      </Endpoint>
      <Endpoint method="GET" path="/content" auth="key" summary="读取文件内容，也支持 HEAD。图片、音视频、PDF 和纯文本以内联方式返回，其他类型作为附件下载。">
        <Params title="查询参数" rows={[
          ["path", "string", true, "文件路径"],
          ["download", "1", false, "强制以附件形式下载"],
        ]} />
        <Params title="请求头" rows={[
          ["Range", "string", false, <>单段范围，例如 <C>bytes=0-1023</C>，返回 206</>],
          ["If-None-Match", "string", false, "ETag 未变化时返回 304"],
          ["If-Range", "string", false, "ETag 一致时才按 Range 返回"],
        ]} />
        <Code lang="bash" code={`curl -H "Authorization: Bearer $TGDRIVE_KEY" -o report.pdf "${site}/api/v1/content?path=docs/report.pdf"`} />
      </Endpoint>
      <H2>整理</H2>
      <p>以下接口都需要读写权限。</p>
      <Endpoint method="POST" path="/folders" auth="key" summary="创建文件夹（写入目录标记），返回 201 和文件夹对象。">
        <Code lang="json" title="请求体" code={`{ "path": "projects/2026" }`} />
      </Endpoint>
      <Endpoint method="POST" path="/move" auth="key" summary="移动或重命名。源路径不以 / 结尾时只移动这一个文件；以 / 结尾时移动整个文件夹及其内容。公开链接随文件移动。">
        <Params title="请求体" rows={[
          ["from", "string", true, <>源路径，例如 <C>a.txt</C> 或 <C>photos/</C></>],
          ["to", "string", true, "目标路径，类型须与源一致（文件对文件、文件夹对文件夹）"],
          ["conflict", "string", false, <><C>skip</C>（默认）跳过同名文件；<C>rename</C> 自动编号保留两者；<C>overwrite</C> 覆盖</>],
        ]} />
        <Code lang="json" title="响应" code={`{ "moved": 3, "skipped": 0 }`} />
        <p>源不存在返回 404；把文件夹移入它自己的子文件夹返回 400。源和目标必须在密钥的同一条授权范围内。</p>
      </Endpoint>
      <Endpoint method="POST" path="/copy" auth="key" summary="复制单个文件，返回 201 和新对象。副本与原文件共享加密分片，立即完成，但计入容量。">
        <Code lang="json" title="请求体" code={`{ "from": "docs/report.pdf", "to": "archive/report-v1.pdf" }`} />
      </Endpoint>
      <Endpoint method="POST" path="/delete" auth="key" summary="批量删除。所有路径都先校验权限，任一路径无权限时整个请求返回 403 且不删除任何文件。">
        <Params title="请求体" rows={[
          ["paths", "string[]", true, "要删除的路径"],
          ["recursive", "boolean", false, <>为 true 时，以 <C>/</C> 结尾的文件夹路径会连同其中所有文件一起删除（服务端分批完成）；默认只删除文件夹标记本身</>],
        ]} />
        <Code lang="json" title="请求体" code={`{ "paths": ["docs/old.pdf", "tmp/"], "recursive": true }`} />
        <Code lang="json" title="响应" code={`{ "results": [ { "path": "tmp/", "deleted": true, "count": 128 }, { "path": "docs/old.pdf", "deleted": true } ] }`} />
      </Endpoint>
    </>
  );
}

function ApiSharing() {
  const { site } = useDocsConfig();
  return (
    <>
      <H2>管理公开状态</H2>
      <Endpoint method="POST" path="/api/v1/public" auth="key" summary="开启或关闭一个或多个文件的公开访问，需要读写权限。重复开启返回相同的令牌；文件夹不能公开。">
        <Params title="请求体" rows={[
          ["paths", "string[]", true, <>文件路径列表；也可以用单个 <C>path</C> 字段</>],
          ["public", "boolean", true, "true 开启，false 关闭"],
        ]} />
        <CodeTabs tabs={[
          { label: "curl", lang: "bash", code: `
curl -X POST ${site}/api/v1/public \\
  -H "Authorization: Bearer $TGDRIVE_KEY" -H 'Content-Type: application/json' \\
  -d '{"paths": ["docs/report.pdf"], "public": true}'` },
          { label: "JavaScript", lang: "js", code: `
const { objects } = await (await fetch(\`\${base}/public\`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ paths: ["docs/report.pdf"], public: true }),
})).json();
const link = \`${site}/s/\${objects[0].public_token}\`;` },
          { label: "Python", lang: "python", code: `
objects = session.post(f"{base}/public", json={"paths": ["docs/report.pdf"], "public": True}).json()["objects"]
print(f"${site}/s/{objects[0]['public_token']}")` },
        ]} />
        <Code lang="json" title="响应" code={`{ "objects": [ { "key": "docs/report.pdf", "public_token": "K5NOikx6JPtrPYWB", "public_at": 1791365930.9, "...": "..." } ] }`} />
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/public" auth="key" summary="列出密钥可读范围内的所有公开文件，按开启时间倒序。返回对象数组。" />
      <H2>公开访问</H2>
      <p>以下接口无需任何凭据。系统锁定时返回 503，令牌无效、已关闭或所属账号被禁用时返回 404。</p>
      <Endpoint method="GET" path="/p/{token}/{filename}" auth="public" summary="直链：返回文件内容，支持 HEAD、Range、ETag。响应可被 CDN 或浏览器存储，但每次使用前都会回源验证，关闭分享后立即失效。文件名部分可以省略或任意填写。">
        <Params title="查询参数" rows={[["download", "1", false, "强制下载"]]} />
        <Code lang="http" code={`GET /p/K5NOikx6JPtrPYWB/report.pdf
Range: bytes=0-1048575`} />
      </Endpoint>
      <Endpoint method="GET" path="/api/public/v1/objects/{token}" auth="public" summary="分享页使用的元数据，不包含所有者和路径。">
        <Code lang="json" title="响应" code={`{
  "token": "K5NOikx6JPtrPYWB",
  "name": "report.pdf",
  "size": 482113,
  "content_type": "application/pdf",
  "etag": "9b2cf535f27731c974343645a3985328",
  "modified_at": 1791367790.12,
  "public_at": 1791365930.9
}`} />
      </Endpoint>
      <Endpoint method="GET" path="/api/public/v1/config" auth="public" summary="管理员配置的对外地址，未配置的项为 null。">
        <Code lang="json" title="响应" code={`{ "public_base_url": "https://drive.example.com", "s3_endpoint": "https://s3.example.com" }`} />
      </Endpoint>
    </>
  );
}

function ApiPermissions() {
  const { site } = useDocsConfig();
  return (
    <>
      <p>每个访问密钥带有一组授权，HTTP API 和 S3 按同样的规则检查。用户在网页中创建的密钥自动获得对自己整个存储桶的读写权限。</p>
      <H2>查看密钥信息</H2>
      <Endpoint method="GET" path="/api/v1/me" auth="key" summary="返回当前密钥、所属用户和全部授权，适合在脚本启动时检查配置是否正确。">
        <Code lang="bash" code={`curl -H "Authorization: Bearer $TGDRIVE_KEY" ${site}/api/v1/me`} />
        <Code lang="json" title="响应" code={`{
  "access_key_id": "TGD…",
  "name": "NAS 备份",
  "owner": "alice",
  "grants": [ { "bucket": "user-2", "prefix": "", "perms": "rw" } ]
}`} />
      </Endpoint>
      <H2>授权规则</H2>
      <Table head={["字段", "含义"]} rows={[
        [<C>bucket</C>, "可访问的存储桶"],
        [<C>prefix</C>, <>只能访问以此开头的路径；空字符串表示整个存储桶。例如 <C>backup/</C> 只允许访问 <C>backup/</C> 下的文件</>],
        [<C>perms</C>, <><C>ro</C> 只读：列出、搜索、下载；<C>rw</C> 读写：另外允许上传、移动、复制、删除和设置公开</>],
      ]} />
      <ul className="doc-list">
        <li>列出根目录时，如果密钥只被授权了某个子目录，接口会直接返回该子目录的内容。</li>
        <li>移动要求源和目标在同一条读写授权内；复制要求对源有读权限、对目标有写权限。</li>
        <li>所属用户被禁用后，其所有密钥立即失效；重新启用后恢复。</li>
      </ul>
      <H2>多个存储桶</H2>
      <p>管理员可以为一个密钥授权多个存储桶。这时每个请求都需要指定 <C>bucket</C>：GET 请求放在查询参数中，POST 请求可以放在查询参数或 JSON 请求体中。未指定时返回 400。</p>
      <Code lang="bash" code={`curl -H "Authorization: Bearer $TGDRIVE_KEY" "${site}/api/v1/list?bucket=user-2&prefix=docs/"`} />
      <H2>创建与禁用</H2>
      <p>访问密钥只能在网页「访问密钥」页中创建和禁用，不能通过 API 管理。Secret 只在创建时显示一次；禁用立即生效且无法撤销，需要时请创建新的密钥。</p>
    </>
  );
}

/* ---------------------------------------------------------------- 管理员 */

function AdminDeploy() {
  return (
    <>
      <H2>启动参数</H2>
      <Code lang="bash" code={`tgdrive --data-dir /var/lib/tgdrive --port 8000 --static-dir /srv/tgdrive/user`} />
      <Table head={["参数", "环境变量", "默认值", "说明"]} rows={[
        [<C>--data-dir</C>, <C>TGDRIVE_DATA_DIR</C>, <C>./data</C>, "元数据库与本地分片目录"],
        [<C>--host</C>, <C>TGDRIVE_HOST</C>, <C>127.0.0.1</C>, "监听地址"],
        [<C>--port</C>, <C>TGDRIVE_PORT</C>, <C>8000</C>, "监听端口"],
        [<C>--static-dir</C>, <C>TGDRIVE_STATIC_DIR</C>, "无", "由 API 服务直接托管用户端静态文件"],
        [<C>--public-url</C>, <C>TGDRIVE_PUBLIC_URL</C>, "无", "公开访问地址的默认值，控制台设置优先"],
        [<C>--s3-endpoint</C>, <C>TGDRIVE_S3_ENDPOINT</C>, "无", "S3 Endpoint 的默认值，控制台设置优先"],
        [<C>--s3-host</C>, <C>TGDRIVE_S3_HOST</C>, "无", "未配置 S3 Endpoint 时用于识别 S3 请求的域名"],
        [<C>--insecure-cookies</C>, <C>TGDRIVE_INSECURE_COOKIES=1</C>, "关闭", "允许通过 HTTP 发送会话 Cookie，只用于本机开发"],
      ]} />
      <Callout tone="danger" title="生产环境必须使用 HTTPS">默认情况下会话 Cookie 带有 Secure 标记，浏览器只会通过 HTTPS 发送。不要在公网环境开启 --insecure-cookies。</Callout>
      <H2>站点结构</H2>
      <p>用户端和控制台是两个独立的静态站点（<C>web/apps/user/dist</C>、<C>web/apps/admin/dist</C>），可以部署在不同域名。它们都把接口请求转发到同一个 API 服务：</p>
      <Table head={["站点", "需要转发到 API 的路径"]} rows={[
        ["用户端（公开访问地址）", <><C>/api/user/</C>、<C>/api/v1/</C>、<C>/api/public/</C>、<C>/p/</C></>],
        ["控制台", <C>/api/admin/</C>],
        ["S3 Endpoint", "全部路径"],
      ]} />
      <H2>反向代理示例</H2>
      <Code lang="nginx" title="nginx.conf" code={`
server {
  listen 443 ssl;
  server_name drive.example.com;
  root /srv/tgdrive/user;

  location / { try_files $uri /index.html; }
  location ~ ^/(api/user|api/public|api/v1|p)/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_request_buffering off;   # 上传以流式转发
    proxy_buffering off;           # 下载与 Range 不经代理缓冲
    client_max_body_size 0;
  }
}

server {
  listen 443 ssl;
  server_name s3.example.com;

  location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;   # S3 路由与签名校验依赖原始 Host
    proxy_request_buffering off;
    client_max_body_size 0;
  }
}`} />
      <p>部署完成后，在控制台「系统设置」中填写公开访问地址和 S3 Endpoint。保存后立即生效，无需重启。</p>
      <H2>锁定与解锁</H2>
      <p>主密钥只存在于内存中：服务启动后系统处于锁定状态，用户无法登录，公开链接返回 503。管理员登录控制台后输入加密口令即可解锁。「安全与维护」中的「锁定系统」会清空内存中的密钥并注销所有会话，适合在离开或怀疑泄露时使用。</p>
      <H2>运行方式</H2>
      <Callout tone="warning" title="只运行一个服务进程">登录会话、登录失败计数和 Telegram 客户端缓存都保存在进程内存中。请只运行一个 tgdrive 进程（不要给 uvicorn 设置多个 worker，也不要让多个实例共用同一个数据目录），需要高可用时在进程外做主备切换。</Callout>
      <H2>存储通道健康</H2>
      <ul className="doc-list">
        <li>添加通道后会自动检查 token、频道访问权限与发布消息权限；之后可以在「存储通道」的操作菜单中随时手动检查。</li>
        <li>上传时某个 Bot 失败（限流、网络错误、token 失效）会自动换用其他启用的 Bot 重试；连续失败 3 次的 Bot 会暂停使用 15 秒，之后每次失败加倍，最长 5 分钟，成功一次即恢复。</li>
      </ul>
      <H2>审计日志</H2>
      <p>「安全与维护」页面记录登录（含失败）、系统锁定与解锁、用户与配额变更、访问密钥的创建与禁用、公开分享的开关、存储通道与系统设置的修改，以及维护任务的执行。日志只记录操作者、对象和结果，不包含任何密码、口令、token 或 Secret。来源 IP 是直接连接到 tgdrive 的地址，经过反向代理时为代理地址。</p>
      <H2>维护任务</H2>
      <Table head={["任务", "作用", "建议频率"]} rows={[
        ["垃圾回收", "从频道中删除已经没有文件引用的分片，释放空间", "大量删除后，或每周一次"],
        ["完整性校验", "下载分片并校验哈希；深度校验还会逐帧解密验证。每次检查最早的 100 个文件，会占用 Telegram 带宽", "每月一次；怀疑数据损坏时立即运行"],
      ]} />
      <H2>备份</H2>
      <ul className="doc-list">
        <li>数据目录中的 <C>meta.db</C> 保存了全部文件索引和加密后的密钥，丢失后频道中的分片将无法使用。请定期备份数据目录。</li>
        <li>加密口令不保存在任何地方，请保存在密码管理器中。没有口令，备份也无法恢复。</li>
        <li>升级时，程序会在迁移数据库前自动生成 <C>meta.db.v&lt;旧版本&gt;.*.bak</C> 备份。</li>
      </ul>
    </>
  );
}

function Faq() {
  const { s3 } = useDocsConfig();
  return (
    <>
      <H2>登录提示“系统已锁定”</H2>
      <p>服务重启后需要管理员解锁。请联系管理员在控制台输入加密口令。</p>
      <H2>忘记了加密口令</H2>
      <p>口令无法找回，也无法重置：所有文件的密钥都由它保护。唯一的办法是停止服务，把数据目录移到别处，重新启动并初始化一个新系统。旧文件将无法读取，旧频道中的分片可以手动删除。</p>
      <H2>S3 客户端报 SignatureDoesNotMatch</H2>
      <ul className="doc-list">
        <li>确认 Endpoint 是 <C>{s3}</C>，并使用路径风格访问。</li>
        <li>确认本机时间准确：与服务器相差超过 15 分钟的请求会被拒绝。</li>
        <li>经过反向代理时，代理必须保留原始 <C>Host</C> 请求头。</li>
        <li>确认密钥没有被禁用，Secret 复制完整。</li>
        <li>AWS CLI v1 生成的预签名 URL 默认使用已淘汰的 SigV2（URL 中带 <C>AWSAccessKeyId</C>），tgdrive 只支持 SigV4：执行 <C>aws configure set default.s3.signature_version s3v4</C> 后重新生成。</li>
        <li>较新的 AWS SDK 默认附加 CRC32C 等尾部校验和。tgdrive 校验 CRC32、SHA-1 与 SHA-256，其他算法会被接受但不校验；如遇兼容性问题，可设置环境变量 <C>AWS_REQUEST_CHECKSUM_CALCULATION=when_required</C>。</li>
      </ul>
      <H2>上传失败，提示超出配额</H2>
      <p>容量按文件原始大小计算，覆盖同名文件时按新旧大小之差计算。删除不需要的文件，或请管理员在「用户」中调整配额。</p>
      <H2>分享链接打不开</H2>
      <Table head={["现象", "原因"]} rows={[
        ["提示“这个链接已失效”", "分享已关闭、文件已删除、链接有误，或分享者账号被禁用"],
        ["提示“存储服务暂时不可用”", "系统已锁定，等待管理员解锁"],
        ["链接的域名不对", "管理员尚未在「系统设置」中配置公开访问地址，或修改地址前复制的旧链接"],
      ]} />
      <H2>视频无法拖动进度</H2>
      <p>网页预览、直链和 S3 都支持 Range 请求。如果经过反向代理，请确认代理没有缓冲整个响应（nginx 中设置 <C>proxy_buffering off</C>）。</p>
      <H2>删除文件后频道里的消息还在</H2>
      <p>删除只会把分片加入回收队列。管理员在「安全与维护」中运行垃圾回收后，分片才会从频道中删除。</p>
    </>
  );
}

export const DOC_PAGES: DocPage[] = [
  { slug: "overview", group: "入门", title: "概览", icon: "home", Content: Overview,
    summary: "tgdrive 是什么、如何存储文件，以及有哪些访问方式。", keywords: "介绍 架构 加密 telegram 频道 存储桶 概念" },
  { slug: "quickstart", group: "入门", title: "快速开始", icon: "checkCircle", Content: QuickStart,
    summary: "管理员完成部署与初始化，用户登录并上传第一个文件。", keywords: "初始化 部署 bot 频道 创建用户 登录" },
  { slug: "files", group: "使用指南", title: "管理文件", icon: "folder", Content: FilesGuide,
    summary: "上传、整理、预览与搜索文件，以及路径规则和容量。", keywords: "上传 移动 重命名 删除 文件夹 预览 搜索 配额 拖放" },
  { slug: "sharing", group: "使用指南", title: "公开分享", icon: "globe", Content: SharingGuide,
    summary: "用分享页和直链把文件公开给任何人，并随时收回。", keywords: "公开 分享 链接 直链 令牌 嵌入 下载" },
  { slug: "s3", group: "使用指南", title: "S3 客户端", icon: "key", Content: S3Guide,
    summary: "用 rclone、AWS CLI 和 boto3 连接 tgdrive，以及兼容性说明。", keywords: "s3 rclone aws cli boto3 python 预签名 分段上传 multipart endpoint 兼容" },
  { slug: "api-basics", group: "API 参考", title: "认证与约定", icon: "lock", Content: ApiBasics,
    summary: "使用访问密钥认证，请求格式、对象结构与错误码。", keywords: "api 认证 密钥 access key secret bearer basic authorization 错误码 401 403 413 503" },
  { slug: "api-files", group: "API 参考", title: "文件接口", icon: "code", Content: ApiFiles,
    summary: "列出、搜索、上传、下载、移动、复制与删除文件。", keywords: "list search files put content range move copy delete folders 上传 下载" },
  { slug: "api-sharing", group: "API 参考", title: "分享接口", icon: "link", Content: ApiSharing,
    summary: "设置公开状态，以及无需登录的公开访问接口。", keywords: "public 公开 分享 token config 直链 p" },
  { slug: "api-permissions", group: "API 参考", title: "权限与存储桶", icon: "shield", Content: ApiPermissions,
    summary: "查看密钥信息，理解存储桶、前缀与只读授权。", keywords: "me 权限 授权 grant 前缀 只读 存储桶 bucket 多桶 密钥" },
  { slug: "deploy", group: "管理员", title: "部署与运维", icon: "server", Content: AdminDeploy,
    summary: "启动参数、反向代理、锁定与解锁、维护任务和备份。", keywords: "部署 nginx 反向代理 https 参数 环境变量 解锁 垃圾回收 校验 备份" },
  { slug: "faq", group: "管理员", title: "常见问题", icon: "info", Content: Faq,
    summary: "登录、S3 签名、配额、分享链接等常见问题的排查方法。", keywords: "问题 排错 锁定 口令 签名 配额 失效 视频" },
];
