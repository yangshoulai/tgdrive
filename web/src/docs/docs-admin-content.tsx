/** 管理员专属文档内容，只由受保护的管理员文档 bundle 引入。 */
import {
  C, Callout, Code, H2, Table, useDocsConfig,
} from "./docs-ui";
import type { DocPage } from "./docs-content";

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


export const ADMIN_DOC_PAGES: DocPage[] = [
  { slug: "deploy", group: "管理员", title: "部署与运维", icon: "server", Content: AdminDeploy,
    summary: "启动参数、反向代理、锁定与解锁、维护任务和备份。", keywords: "部署 nginx 反向代理 https 参数 环境变量 解锁 垃圾回收 校验 备份" },
  { slug: "faq", group: "管理员", title: "常见问题", icon: "info", Content: Faq,
    summary: "登录、S3 签名、配额、分享链接等常见问题的排查方法。", keywords: "问题 排错 锁定 口令 签名 配额 失效 视频" },
];
