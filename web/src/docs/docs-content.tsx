/** 文档内容。所有接口与限制都对应 src/tgdrive/asgi.py、src/tgdrive/s3/ 中的实际实现，修改后端时请同步更新。 */
import type { ComponentType } from "react";
import {
  C, Callout, Card, CardGrid, Code, CodeTabs, DocLink, Endpoint, Flow, H2, H3, Params, Step, Steps, Table, useDocsConfig,
} from "./docs-ui";
import { BRAND } from "../brand";
import type { IconName } from "../ui";

export type DocPage = { slug: string; group: string; title: string; summary: string; keywords: string; icon: IconName; Content: ComponentType };

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
      <p>{BRAND} 是一个私人云盘：上传文件、用文件夹整理，随时预览和下载，也可以生成链接分享给别人，还能用同步工具和脚本访问。文件加密保存，只有你的账号能打开。</p>
      <Flow nodes={[
        { icon: "upload", title: "上传", detail: "网页、同步工具或脚本" },
        { icon: "lock", title: "加密保存", detail: "只有你的账号能打开" },
        { icon: "globe", title: "随时取用", detail: "预览、下载或分享" },
      ]} />
      <H2>核心概念</H2>
      <Table head={["概念", "说明"]} rows={[
        ["存储桶", <>每个用户拥有一个独立的空间（存储桶），名称形如 <C>user-2</C>，互相看不到对方的文件。容量配额按存储桶计算。</>],
        ["对象与路径", <>文件以完整路径存储，例如 <C>photos/2026/trip.jpg</C>。路径区分大小写，最长 1024 字节。</>],
        ["文件夹", <>路径中 <C>/</C> 之前的部分。空文件夹以一个以 <C>/</C> 结尾的目录标记保存。</>],
        ["公开链接", "为单个文件生成的随机地址，任何拥有链接的人都可以免登录访问，可随时关闭。"],
        ["访问密钥", "让 rclone、AWS CLI 等同步工具或脚本访问你的文件的凭据，每个密钥只能访问其所有者的文件。"],
      ]} />
      <H2>访问方式</H2>
      <CardGrid>
        <Card to="files" icon="folder" title="网页文件空间">上传、整理、预览和分享文件。</Card>
        <Card to="s3" icon="key" title="同步工具（S3）">用 rclone、AWS CLI、boto3 同步与备份。</Card>
        <Card to="api-basics" icon="code" title="脚本接口（HTTP API）">用访问密钥从脚本和程序读写文件。</Card>
        <Card to="sharing" icon="globe" title="公开分享">分享页与可嵌入的直链。</Card>
      </CardGrid>
    </>
  );
}

function QuickStart() {
  const { site } = useDocsConfig();
  return (
    <>
      <H2>用户：开始使用</H2>
      <Steps>
        <Step title="登录">打开 <a className="doc-link" href={site}>{site}</a>，使用管理员提供的账号登录，之后在账号菜单中修改密码。在自己的电脑上可以勾选「30 天内保持登录」，下次打开无需重新登录；公共电脑请不要勾选。</Step>
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
      <p>文件、公开分享、访问密钥和回收站按页显示，每页最多 50 项。使用「上一页」「下一页」浏览；切换目录或筛选条件会回到第一页，多选只作用于当前页。文件列表显示类型，网格卡片保持一致高度。文件夹大小包含所有子文件夹中的文件，空文件夹显示 0 B；大小自动使用 KB、MB、GB 等单位。文件列表的列排序作用于当前页。</p>
      <p>点击页面右上角的「上传」，或直接把文件拖到文件列表上。确认窗口默认上传到当前文件夹，点击「更改位置」可展开目录选择；在其中新建子目录时，选择「创建并进入」后再确认上传。也可以移除不需要的文件，并选择是否在上传后公开访问。同名覆盖提示会检查目标位置中的全部文件。上传托盘显示每个文件的进度，可以单独取消。</p>
      <Callout tone="info">与现有文件同名时会覆盖原文件，确认窗口会提前标出「将覆盖」。覆盖不会改变已有的公开链接。</Callout>
      <H2>整理</H2>
      <Table head={["操作", "方法", "说明"]} rows={[
        ["新建文件夹", "页面右上角「新建文件夹」", "默认当前文件夹；点击「更改位置」可以选择其他创建位置"],
        ["移动", "文件菜单「移动到…」，多选后「移动」，或拖到文件夹、面包屑上", "文件夹连同其中所有内容一起移动"],
        ["重命名", "文件菜单「重命名」", "目标名称已存在时会提示，不会合并"],
        ["删除", "文件菜单「删除」或多选后删除", "文件和文件夹先进入回收站，可以还原；30 天后自动永久删除"],
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
        ["视频", "使用 ArtPlayer 播放 MP4、WebM、MOV 等常见视频，支持进度、倍速、全屏和字幕切换；可播放性取决于文件编码及浏览器解码能力"],
        ["音频", "使用 APlayer 播放 MP3、M4A、OGG、Opus、WAV、FLAC 等常见音频，可自动显示同步歌词"],
        ["PDF", "使用浏览器自带的 PDF 查看器"],
        ["Markdown", "渲染标题、列表、任务列表、表格、引用、代码块和链接，可切换到源码；同目录下的相对路径图片会直接显示"],
        ["文本与代码", "使用只读 CodeMirror，支持行号、查找、自动换行和常见语言语法高亮，包括 .java、.py、.ts 等代码文件；支持 UTF-8、带 BOM 的 UTF-16 与 GBK/GB18030"],
      ]} />
      <p>文本类文件只读取前 512 KB，超出时顶部会提示并提供完整下载。Markdown 中的原始 HTML 不会执行，外部图片和脚本不会加载，链接只允许 http(s) 与 mailto。Office 与 MPEG-TS 视频暂不支持预览；其他不支持的类型或无法解码的媒体提供下载入口。</p>
      <H3>缩略图与封面</H3>
      <p>图片、视频和音频会自动生成缩略图：图片按比例缩小，视频截取一帧画面（会跳过片头的黑屏），音频读取文件里内嵌的专辑封面（MP3、FLAC、M4A）。文件列表、网格视图和分享页都会用它展示内容；预览大图时先显示封面图，原图加载完成后再替换；视频以它作为播放前的封面，音乐预览显示专辑封面并用它渲染背景。</p>
      <p>通过网页上传的文件在上传完成后直接用本地文件生成；通过 S3、<C>/api/v1</C> 或旧版本上传的文件，在网页中打开所在文件夹时逐个补生成（图片不超过 25 MB，视频和音频只读取需要的部分）。缩略图加密保存，<strong>不占用你的存储空间</strong>，删除或覆盖文件后随之失效；没有封面的音频会显示类型图标。</p>
      <H3>同名歌词与字幕</H3>
      <p>播放 <C>歌曲.mp3</C> 时会查找同目录的 <C>歌曲.lrc</C>；播放 <C>电影.mp4</C> 时会查找 <C>电影.srt</C>、<C>电影.vtt</C>，也支持 <C>电影.zh-CN.srt</C>、<C>电影.en.vtt</C> 等多语言字幕。字幕优先选择中文，也可手动切换或关闭；点击歌词行可以跳转播放位置。</p>
      <p>每个歌词或字幕文件最多 2 MB，每次关联最多 32 个有效附件。附件加载失败不会中断播放。公开文件夹可关联分享范围内的附件；单文件分享只公开该文件，不自动公开同目录歌词和字幕。</p>
      <H2>上传与下载</H2>
      <p>打开预览时显示加载状态，等待超过 8 秒后提供重试与下载入口。视频缓冲时保留画面和播放控件，并显示「正在缓冲…」提示；歌词和字幕独立加载。</p>
      <p>超过 64 MB 的文件自动分块上传（每块 16 MB，4 块并行），某一块失败会自动重试；中断或刷新页面后重新选择同一文件即可从断点继续。多个文件同时上传时最多并行 2 个。大于 1 MB 的文件会先在本地计算内容指纹（上传列表显示“校验”进度），如果你的空间里已经有内容完全相同的文件，就直接引用它并标记“秒传”，不会传输任何数据，也不会多占一份存储（但仍计入配额）。浏览器不是 HTTPS 或 localhost 访问时无法计算指纹，会自动按普通方式上传。下载由浏览器直接发起，支持断点续传，服务端会提前取回并解密后续数据以缩短等待。</p>
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
        ["直链", <C>{site}/p/&lt;令牌&gt;/&lt;文件名&gt;</C>, <>嵌入网页的 <C>&lt;img&gt;</C>、<C>&lt;video&gt;</C>，或交给下载工具；支持断点续传（仅文件）</>],
      ]} />
      <p>文件直链末尾的文件名只为便于识别，改成其他名字也能访问。加上 <C>?download=1</C> 会强制浏览器下载而不是打开。</p>
      <p>分享窗口优先展示访问范围与「复制分享链接」。展开「访问设置」可设置有效期和访问密码，展开「直链与分享详情」可复制文件直链并查看下载次数。设置更改自动保存，点击「完成」只关闭窗口。</p>
      <H2>分享文件夹</H2>
      <p>文件夹也可以公开：在文件夹菜单中选择「公开分享」，得到一个分享页链接。访问者无需登录，可以浏览整个文件夹（含子文件夹），预览和下载其中的任意文件，但不能修改、上传或删除。</p>
      <ul className="doc-list">
        <li>内容是实时的：分享之后新增、替换或删除的文件，访问者刷新页面就能看到；他们看不到这个文件夹之外的任何内容。</li>
        <li>有效期和访问密码与分享文件时一致，整个文件夹共用一个密码；下载次数统计的是文件夹内所有文件的下载总数。</li>
        <li>文件夹里的单个文件也可以另外生成自己的链接，两者互不影响。</li>
        <li>文件夹内文件的地址是 <C>{site}/p/&lt;令牌&gt;/&lt;相对路径&gt;</C>，例如 <C>/p/abc123/2026/trip.jpg</C>，同样支持断点续传。</li>
      </ul>
      <H2>开启与关闭</H2>
      <ul className="doc-list">
        <li>上传时开启：在上传确认窗口中打开「上传后公开访问」。</li>
        <li>之后开启：点击文件行的链接图标，或在文件菜单中选择「公开分享」。多选后可以批量公开。</li>
        <li>查看全部：侧栏「公开分享」分页列出公开文件和文件夹，可以复制链接或停止分享。</li>
      </ul>
      <H2>链接什么时候会变化</H2>
      <Table head={["操作", "链接"]} rows={[
        ["覆盖上传同名文件", "保持不变，访问者看到新内容"],
        ["移动或重命名", "保持不变（文件夹也一样）"],
        ["关闭公开访问", "立即失效；再次开启会生成新链接"],
        ["删除文件或文件夹", "立即失效；放进回收站时暂时失效，还原后恢复"],
        ["账号被禁用、系统锁定", "暂停访问，恢复后继续有效"],
        ["管理员撤销", "立即失效"],
      ]} />
      <Callout tone="warning" title="公开链接等同于文件本身">任何拿到链接的人都能下载文件，也可以继续转发。只分享你愿意让任何人看到的内容。分享文件夹时，里面现有的和以后新增的所有文件都会被看到，请确认文件夹里没有不想公开的内容。</Callout>
      <H2>访问者能看到什么</H2>
      <p>分享文件时，分享页只显示文件名、大小、类型和修改时间；分享文件夹时，显示文件夹里的文件名、大小和修改时间。两种情况都不会显示你的用户名、所在的上级文件夹或其他文件。</p>
    </>
  );
}

function S3Guide() {
  const { s3, s3Configured } = useDocsConfig();
  return (
    <>
      <p>{BRAND} 提供 S3 兼容网关，可以直接使用 rclone、AWS CLI、boto3 等工具。先在网页「访问密钥」中创建密钥，Secret 只显示一次。</p>
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
[tessera]
type = s3
provider = Other
access_key_id = <Access Key ID>
secret_access_key = <Secret Access Key>
endpoint = ${s3}
region = us-east-1
force_path_style = true`} />
      <Code lang="bash" code={`
rclone ls tessera:user-2
rclone copy ./photos tessera:user-2/photos --progress
rclone sync ./backup tessera:user-2/backup`} />
      <H2>AWS CLI</H2>
      <Code lang="bash" code={`
aws configure --profile tessera   # 填写 Access Key、Secret，区域 us-east-1
aws configure set profile.tessera.s3.addressing_style path
aws configure set profile.tessera.s3.signature_version s3v4   # AWS CLI v1 需要，v2 默认即为 SigV4

aws --profile tessera --endpoint-url ${s3} s3 ls s3://user-2/
aws --profile tessera --endpoint-url ${s3} s3 cp ./report.pdf s3://user-2/docs/report.pdf
aws --profile tessera --endpoint-url ${s3} s3 cp s3://user-2/docs/report.pdf ./report.pdf

# 服务端复制、移动与同步：不经过本机传输
aws --profile tessera --endpoint-url ${s3} s3 cp s3://user-2/docs/ s3://user-2/backup/docs/ --recursive
aws --profile tessera --endpoint-url ${s3} s3 mv s3://user-2/inbox/a.pdf s3://user-2/archive/a.pdf`} />
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
        <li>密钥被禁用或删除、所属账号被禁用时返回 401；系统锁定时返回 503。</li>
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
        ["401", <C>invalid_key</C>, "缺少 Authorization 头，或密钥错误、已禁用、已删除"],
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
      <Endpoint method="POST" path="/files/instant" auth="key" summary="秒传：同一个存储桶里已经有内容相同的文件时，直接让新路径引用它，不需要传输任何数据。未命中时返回 hit 为 false，再按普通方式上传即可。需要读写权限。">
        <Params title="请求体（JSON）" rows={[
          ["path", "string", true, "目标路径"],
          ["size", "number", true, "文件大小（字节），必须大于 0"],
          ["fingerprint", "string", true, "内容指纹，64 位小写十六进制，算法见下方"],
          ["content_type", "string", false, "省略时沿用被引用文件的类型"],
          ["public", "boolean", false, "命中后是否公开；省略时保持目标路径原有的公开状态"],
        ]} />
        <p>命中时返回文件对象并带 <C>hit: true</C>，未命中返回 <C>{"{ \"hit\": false }"}</C>。只会在你自己的存储桶、且密钥有权读取的路径范围内查找，不会暴露其他用户是否保存过某个文件。同名文件会被覆盖，配额照常计算。</p>
        <H3>指纹算法</H3>
        <p>把文件按 16 MiB 切块（最后一块可以更短），分别计算 SHA-256；再对「<C>tgdrive-fp-v1\n</C> + 文件大小（8 字节大端）+ 全部块哈希依次拼接」计算 SHA-256，取十六进制。</p>
        <Code lang="python" code={`
import hashlib

def fingerprint(path, block=16 * 1024 * 1024):
    leaves, size = [], 0
    with open(path, "rb") as f:
        while chunk := f.read(block):
            size += len(chunk)
            leaves.append(hashlib.sha256(chunk).digest())
    return hashlib.sha256(b"tgdrive-fp-v1\\n" + size.to_bytes(8, "big") + b"".join(leaves)).hexdigest()

result = session.post(f"{base}/files/instant", json={
    "path": "docs/report.pdf", "size": os.path.getsize("report.pdf"), "fingerprint": fingerprint("report.pdf"),
}).json()
if not result["hit"]:
    ...  # 未命中，用 PUT /files 上传`} />
        <Callout tone="info" title="哪些文件可以被秒传命中">
          网页端、<C>PUT /files</C> 和 S3 的单次上传都会在写入时顺带记录指纹，不需要重读数据。分段上传只有在除最后一段外每段大小都是 16 MiB 的整数倍时才有指纹（网页端和 <C>rclone --s3-chunk-size 16M</C> 这类配置满足，aws cli 默认的 8 MB 分段不满足）。升级前已有的文件没有指纹。
        </Callout>
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
      <Endpoint method="POST" path="/api/v1/public" auth="key" summary="开启或关闭一个或多个文件或文件夹的公开访问，需要读写权限。重复开启返回相同的令牌。文件夹路径以 / 结尾，开启后访问者可以浏览并下载其中的全部文件。">
        <Params title="请求体" rows={[
          ["paths", "string[]", true, <>文件或文件夹路径列表（文件夹以 <C>/</C> 结尾）；也可以用单个 <C>path</C> 字段</>],
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
        <li>在「访问密钥」页可以禁用或删除密钥：禁用后无法重新启用；删除是永久的，密钥和它的授权立即清除、无法恢复。不再使用的密钥建议直接删除。</li>
      </ul>
      <H2>多个存储桶</H2>
      <p>管理员可以为一个密钥授权多个存储桶。这时每个请求都需要指定 <C>bucket</C>：GET 请求放在查询参数中，POST 请求可以放在查询参数或 JSON 请求体中。未指定时返回 400。</p>
      <Code lang="bash" code={`curl -H "Authorization: Bearer $TGDRIVE_KEY" "${site}/api/v1/list?bucket=user-2&prefix=docs/"`} />
      <H2>创建与禁用</H2>
      <p>访问密钥只能在网页「访问密钥」页中创建和禁用，不能通过 API 管理。Secret 只在创建时显示一次；禁用立即生效且无法撤销，需要时请创建新的密钥。</p>
    </>
  );
}

export const DOC_PAGES: DocPage[] = [
  { slug: "overview", group: "入门", title: "简介", icon: "home", Content: Overview,
    summary: `${BRAND} 是什么、如何存储文件，以及有哪些访问方式。`, keywords: "介绍 架构 加密 telegram 频道 存储桶 概念" },
  { slug: "quickstart", group: "入门", title: "快速开始", icon: "checkCircle", Content: QuickStart,
    summary: "用户登录、上传文件，并连接 S3 客户端。", keywords: "登录 上传 文件夹 分享 访问密钥 s3" },
  { slug: "files", group: "使用指南", title: "管理文件", icon: "folder", Content: FilesGuide,
    summary: "上传、整理、预览与搜索文件，以及路径规则和容量。", keywords: "上传 移动 重命名 删除 文件夹 预览 搜索 配额 拖放" },
  { slug: "sharing", group: "使用指南", title: "公开分享", icon: "globe", Content: SharingGuide,
    summary: "用分享页和直链把文件公开给任何人，并随时收回。", keywords: "公开 分享 链接 直链 令牌 嵌入 下载" },
  { slug: "s3", group: "使用指南", title: "S3 客户端", icon: "key", Content: S3Guide,
    summary: `用 rclone、AWS CLI 和 boto3 连接 ${BRAND}，以及兼容性说明。`, keywords: "s3 rclone aws cli boto3 python 预签名 分段上传 multipart endpoint 兼容" },
  { slug: "api-basics", group: "API 参考", title: "认证与约定", icon: "lock", Content: ApiBasics,
    summary: "使用访问密钥认证，请求格式、对象结构与错误码。", keywords: "api 认证 密钥 access key secret bearer basic authorization 错误码 401 403 413 503" },
  { slug: "api-files", group: "API 参考", title: "文件接口", icon: "code", Content: ApiFiles,
    summary: "列出、搜索、上传、下载、移动、复制与删除文件。", keywords: "list search files put content range move copy delete folders 上传 下载" },
  { slug: "api-sharing", group: "API 参考", title: "分享接口", icon: "link", Content: ApiSharing,
    summary: "设置公开状态，以及无需登录的公开访问接口。", keywords: "public 公开 分享 token config 直链 p" },
  { slug: "api-permissions", group: "API 参考", title: "权限与存储桶", icon: "shield", Content: ApiPermissions,
    summary: "查看密钥信息，理解存储桶、前缀与只读授权。", keywords: "me 权限 授权 grant 前缀 只读 存储桶 bucket 多桶 密钥" },
];
