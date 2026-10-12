/** 管理员专属文档内容，只由受保护的管理员文档 bundle 引入。 */
import {
  C, Callout, Code, H2, Table, useDocsConfig,
} from "./docs-ui";
import { BRAND } from "../brand";
import type { DocPage } from "./docs-content";

/* ---------------------------------------------------------------- 管理员 */

function AdminDeploy() {
  return (
    <>
      <H2>启动参数</H2>
      <Code lang="bash" code={`tgdrive --data-dir /var/lib/tgdrive --port 8000 --static-dir /srv/tgdrive/web`} />
      <Table head={["参数", "环境变量", "默认值", "说明"]} rows={[
        [<C>--data-dir</C>, <C>TGDRIVE_DATA_DIR</C>, <C>./data</C>, "元数据库与本地分片目录"],
        [<C>--host</C>, <C>TGDRIVE_HOST</C>, <C>127.0.0.1</C>, "监听地址"],
        [<C>--port</C>, <C>TGDRIVE_PORT</C>, <C>8000</C>, "监听端口"],
        [<C>--static-dir</C>, <C>TGDRIVE_STATIC_DIR</C>, "无", "由 API 服务直接托管前端（Docker 镜像已内置）"],
        [<C>--public-url</C>, <C>TGDRIVE_PUBLIC_URL</C>, "无", "公开访问地址的默认值，控制台设置优先"],
        [<C>--s3-endpoint</C>, <C>TGDRIVE_S3_ENDPOINT</C>, "无", "S3 Endpoint 的默认值，控制台设置优先"],
        [<C>--s3-host</C>, <C>TGDRIVE_S3_HOST</C>, "无", "未配置 S3 Endpoint 时用于识别 S3 请求的域名"],
        [<C>--insecure-cookies</C>, <C>TGDRIVE_INSECURE_COOKIES=1</C>, "关闭", "允许通过 HTTP 发送会话 Cookie，只用于本机开发"],
        [<C>--transfer-concurrency</C>, <C>TGDRIVE_TRANSFER_CONCURRENCY</C>, "4", "全局同时进行的上传分段、下载流与校验任务数"],
        [<C>--bucket-concurrency</C>, <C>TGDRIVE_BUCKET_CONCURRENCY</C>, "2", "每个存储桶同时进行的传输数，所有接入方式共用"],
        [<C>--audit-retention-days</C>, <C>TGDRIVE_AUDIT_RETENTION_DAYS</C>, "0", "0 为永久保留；正数表示将过期日志移入加密归档"],
        [<C>--resource-mode</C>, <C>TGDRIVE_RESOURCE_MODE</C>, "auto", "auto／low／standard／custom；管理员设置优先"],
        [<C>--offline-concurrency</C>, <C>TGDRIVE_OFFLINE_CONCURRENCY</C>, "1", "自定义模式的离线任务并发，1–4；容器预算限制实际并发"],
        [<C>--offline-bandwidth-kib</C>, <C>TGDRIVE_OFFLINE_BANDWIDTH_KIB</C>, "0", "总下载限速，KiB/s；0 不限速"],
        [<C>--offline-reserve-mib</C>, <C>TGDRIVE_OFFLINE_RESERVE_MIB</C>, "512", "数据目录所在磁盘的最低保留空间，至少 128 MiB"],
        [<C>--offline-hls</C>, <C>TGDRIVE_OFFLINE_HLS=1</C>, "关闭", "允许 M3U8，仍需本地 FFmpeg；管理员设置优先"],
        [<C>--offline-x</C>, <C>TGDRIVE_OFFLINE_X=1</C>, "关闭", "允许 X 单帖的图片、视频，需本地平台组件"],
        [<C>--offline-youtube</C>, <C>TGDRIVE_OFFLINE_YOUTUBE=1</C>, "关闭", "允许 YouTube 单视频、Shorts，需平台组件、JavaScript 运行时和 FFmpeg"],
        [<C>--offline-max-mib</C>, <C>TGDRIVE_OFFLINE_MAX_MIB</C>, "512", "平台单任务文件大小与临时输入轨上限，MiB；受低资源预算限制"],
        [<C>--youtube-max-height</C>, <C>TGDRIVE_YOUTUBE_MAX_HEIGHT</C>, "720", "YouTube 清晰度上限；低资源预算最高 720p"],
        [<C>--offline-proxy</C>, <C>TGDRIVE_OFFLINE_PROXY</C>, "直连", "离线下载出站代理，http://主机:端口 或 socks5://主机:端口，可带用户名密码；管理员设置优先"],
        [<C>--trusted-proxies</C>, <C>TGDRIVE_TRUSTED_PROXIES</C>, "Uvicorn 默认", "信任 X-Forwarded-For/Proto 的代理 IP 或网段，逗号分隔"],
      ]} />
      <Callout tone="danger" title="生产环境必须使用 HTTPS">默认情况下会话 Cookie 带有 Secure 标记，浏览器只会通过 HTTPS 发送。不要在公网环境开启 --insecure-cookies。</Callout>
      <H2>站点结构与角色</H2>
      <p>「系统设置 → 下载与资源」显示检测预算、配置来源及生效参数。自动模式在 CPU 少于 2 核、内存少于 1 GiB 或无法可靠检测时使用低资源预算；低资源同时下载 1 个任务，标准预设为 2，自定义最多 4，仍受预算限制。低资源下共用的传输名额最多 2、每桶 1，并降低加密上传与下载预读并发。修改并发不终止已有传输，下一轮调度生效。磁盘不足或容器不可回收内存用量超过 90% 时暂停离线任务，释放资源后继续 GET，POST 必须手动继续。内存判断扣除同一 cgroup 的可回收闲置文件缓存，临时内存盘仍计入用量。</p>
      <p>默认镜像不含 FFmpeg。使用 <C>latest-ffmpeg</C> 或同版本 <C>-ffmpeg</C> 标签，再启用 M3U8；本地构建传入 <C>--build-arg INSTALL_FFMPEG=1</C>。只封装，不转码，最多一个 FFmpeg 进程；输入、输出通过本地管道传递，不缓存完整视频。Telegram 通道保存加密分片；本地存储仍会占用最终文件的磁盘空间。HTTP 断点及离线请求参数包含在数据库备份中，参数已加密；更换加密口令同步重新加密。</p>
      <p>直连时所有离线来源必须解析到公网 IP，并在连接时固定该地址；若服务器 DNS 返回 <C>198.18.0.0/15</C> Fake-IP，探测和下载都会被拒绝。服务器需要经代理出网时，在「系统设置 → 下载与资源」填写出站代理（支持 HTTP CONNECT 与 SOCKS5，可带用户名密码）。启用后所有离线下载、平台解析和媒体请求都经代理，域名由代理解析。</p>
      <Callout tone="warning" title="代理模式的内网防护较弱">启用代理后服务端无法核对域名的实际解析结果，只能拒绝字面内网 IP、localhost 和 .local、.lan、.internal 等内部主机名。请确认代理的直连规则不会把请求转发到内网服务。代理密码保存在服务器设置中，控制台只显示 ******；审计只记录是否启用代理。</Callout>
      <p>连接建立阶段的重置、超时会自动重试 3 次，平台解析请求在网络中断时也会整体重发。任务层面的网络中断、超时及 HTTP 408／425／429／5xx 再自动重试 3 次（10、30、90 秒），文件直链从断点续传；平台解析结果在有效期内复用，不必每次开始都启动解析子进程。自动重试计数只在进程内保存，重启后“等待恢复”的任务照常继续。</p>
      <p>X／YouTube 使用 <C>latest-platform</C> 或同版本 <C>-platform</C> 镜像，本地构建为 <C>docker build --target platform -t tgdrive:platform .</C>。平台镜像包含固定版本的 gallery-dl、yt-dlp、配套 EJS、Node.js 和 FFmpeg，各平台由管理员单独启用。解析子进程按需启动、最多一个，取消时连同 JavaScript 子进程回收。解析器只通过主进程受控 HTTP 通道访问平台域名（直连时还要求公网 IP），不使用第三方解析网站。YouTube 媒体按解析库要求的 10 MiB 分段逐段请求，避免整文件请求被限速到接近播放速度。</p>
      <p>「下载与资源」的生效配置列出 yt-dlp、yt-dlp-ejs、gallery-dl、JavaScript 运行时与 FFmpeg 的版本（启动时检测）。yt-dlp 版本号即发布日期，超过 60 天会提示更新：YouTube 经常调整接口，旧版本解析失败时请拉取最新的平台镜像。</p>
      <p>平台解析失败会区分真人验证、登录权限、地区限制、请求频率、Cookie 失效和 JavaScript 挑战失败。容器日志中的 <C>platform_extract_failed</C> 只记录平台、错误分类、异常类型和代码位置，不记录原始异常、视频地址、Cookie 或请求头；未知异常仍需结合这些信息定位，不能仅凭通用提示认定是服务器出口受限。</p>
      <p>YouTube 分离轨暂存于数据目录的受限任务缓存，FFmpeg 输出直接进入加密存储，不另存完整成品临时文件。默认 720p、单任务与输入轨缓存最多 512 MiB；低资源预算限制上限。停止、失败清理临时轨，重启清理异常退出遗留缓存。输入轨在临时目录内为明文，目录权限 0700、文件权限 0600；需同时为输入轨和最终本地加密分片保留磁盘空间。平台登录 Cookie 加密保存在任务参数中，随口令轮换重加密。站点改变接口时需要更新可选依赖并重建镜像。</p>
      <p>删除用户前会先禁用账号并停止后台下载，阻止清理期间再次创建任务；如果清理失败，账号保留禁用状态，可在修复后继续删除或重新启用。</p>
      <p>整个站点是同一个应用、同一个端口，只有一个登录页。账号的角色决定登录后能看到什么：</p>
      <Table head={["角色", "可见内容"]} rows={[
        ["管理员", "侧栏切换「我的空间」与「系统管理」：管理区提供概览、用户、全部文件、存储通道、全部密钥、安全与维护、审计日志、系统设置，还有管理员文档"],
        ["普通用户", "自己的文件空间；看不到「系统管理」菜单，直接输入 /admin/ 开头的地址只会看到「没有访问权限」"],
      ]} />
      <p>权限由服务端按会话里的角色强制校验，隐藏菜单只是体验层面的处理：管理接口（<C>/api/admin/</C>）对普通用户一律返回 403，管理员文档的代码也只会发给管理员会话。全站只有一个会话 Cookie（<C>tg_session</C>），同一个浏览器同一时间只登录一个账号。</p>
      <Table head={["路径", "内容"]} rows={[
        [<C>/</C>, "登录与文件空间（所有账号共用）"],
        [<C>/admin</C>, "系统管理（仅管理员）：/admin/users、/admin/objects 等"],
        [<C>/docs</C>, "文档：所有人共用这个地址；管理员登录后会多出「管理员」分组（部署与运维、常见问题）"],
        [<C>/s/&lt;令牌&gt;</C>, "公开分享页，无需登录"],
        [<><C>/api/</C>、<C>/p/</C></>, "接口与公开直链"],
        ["S3 Endpoint", "单独的域名，转发全部路径到同一个服务"],
      ]} />
      <p>系统锁定（刚启动或手动锁定）时，普通用户无法登录；管理员仍可登录，登录后会先看到解锁页。想让系统管理只在内网可访问，可以在反向代理里限制 <C>/admin</C> 和 <C>/api/admin/</C> 两个路径的来源。</p>
      <H2>反向代理示例</H2>
      <Code lang="nginx" title="nginx.conf" code={`
server {
  listen 443 ssl;
  server_name drive.example.com;

  location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;   # 上传以流式转发
    proxy_buffering off;           # 下载与 Range 不经代理缓冲
    client_max_body_size 0;
  }

  # 可选：控制台只允许内网访问
  location ~ ^/(admin/|api/admin/) {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 443 ssl;
  server_name s3.example.com;

  location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;   # S3 路由与签名校验依赖原始 Host
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    client_max_body_size 0;
  }
}`} />
      <p>部署完成后，在控制台「系统设置」中填写公开访问地址和 S3 Endpoint。保存后立即生效，无需重启。若反向代理不在回环地址，请把代理网段传给 <C>--trusted-proxies</C>；不要使用通配符信任未知网络。</p>
      <p>健康检查使用 <C>GET /healthz</C>，只表示进程正在响应，不代表系统已经解锁。管理员概览会显示存储用量、当前进程流量和 Telegram Bot 的限速退避状态。</p>
      <p>「全部文件」和概览中的「最近上传」会显示文件已有的缩略图，预览优先使用较清晰的封面。管理员缩略图入口 <C>GET /api/admin/v1/thumbnail?bucket_id=…&amp;path=…&amp;variant=thumb|poster</C> 只接受管理员网页会话；图片沿用加密存储，不开放给普通用户。</p>
      <p>普通缩略图与封面使用包含存储桶、文件内容版本及缩略图自身版本的地址，允许浏览器私有缓存 30 天；重新生成单个规格后只更新它自己的地址。无版本或版本过期的地址会回源验证，公开分享继续校验权限，私密空间仍使用 <C>no-store</C>。</p>
      <p>「全部文件」中的音视频预览支持右侧可收起的播放列表，只包含打开时当前页同一存储桶、同一目录的同类可播放文件，沿用页面顺序，不读取其他分页。列表展示已有缩略图、文件名和大小；提供四种限定本页的播放模式，以及固定和底部居中的最小化窗口。最小化后浏览其他页会保留原列表。管理员图片预览同样使用带内容版本的地址，允许浏览器私有缓存复用原图七天，覆盖后自动更新。</p>
      <p>图片预览复用当前页同目录的图片顺序与缩略图，窗口按原图比例调整大小。图片、音频和视频都可用左／右方向键切换；输入框、下拉框、进度条和菜单保留自身的键盘操作，列表和文件读取仍受管理员角色及存储桶边界限制。</p>
      <p>管理员预览复用相同快捷键：<C>K / 空格</C> 播放暂停，<C>J / L</C> 跳转 10 秒，<C>↑ / ↓</C> 调整音量，<C>F</C> 切换全屏，<C>I</C> 最小化或恢复。最小化后在页面非输入位置也可按 <C>I</C> 恢复；其他弹窗打开时不响应。完整按键与焦点规则见<a href="/docs/files#preview-shortcuts">预览快捷键</a>。</p>
      <H2>锁定与解锁</H2>
      <p>每个账号可以设置独立的「私密空间」访问密码。管理员自己的私密空间位于「我的空间」中，同样每次进入都要解锁；「全部文件」「最近上传」及普通文件预览不展示任何账号的私密文件。访问密钥 API 与 S3 也不能读取、复制、覆盖或删除私密内容。私密空间共用原存储桶与配额，统计用量包含私密文件及其回收站；它提供网页访问控制，继续使用现有服务端文件加密，并非客户端独立加密。具体操作见<a href="/docs/files#private-space">私密空间使用说明</a>。</p>
      <p>私密媒体与缩略图地址包含绑定登录会话的短期授权参数 <C>access</C>。程序会从 Uvicorn 访问日志中移除它；反向代理或其他 HTTP 服务器的访问日志也应只记录路径（Nginx 的 <C>$uri</C>），或关闭私密接口访问日志，不记录完整查询字符串。</p>
      <p>主密钥只存在于内存中：服务启动后系统处于锁定状态，用户无法登录，公开链接返回 503。管理员登录控制台后输入加密口令即可解锁。「安全与维护」的「安全设置」中可以锁定系统，清空内存中的密钥并注销所有会话（包括勾选了“保持登录”的），适合在离开或怀疑泄露时使用。日常维护任务和数据备份位于「维护与备份」分组。</p>
      <H2>运行方式</H2>
      <Callout tone="warning" title="只运行一个服务进程">普通登录会话、登录失败计数和 Telegram 客户端缓存都保存在进程内存中（勾选“保持登录”的会话会保存到数据库，只存令牌的哈希）。请只运行一个 {BRAND} 进程（不要给 uvicorn 设置多个 worker，也不要让多个实例共用同一个数据目录），需要高可用时在进程外做主备切换。</Callout>
      <H2>存储通道健康</H2>
      <p>「存储通道」显示每个通道的分片数量与存储大小。文件会加密后拆成分片保存，容量包含加密开销，自动使用 KB、MB、GB 等单位。统计按通道对应的 Bot 汇总已记录分片，包含上传中及回收站数据；共享同一份内容的副本不会重复计入，不统计待清理分片、本地存储和频道其他消息，也不访问 Telegram 扫描频道。</p>
      <ul className="doc-list">
        <li>添加通道后会自动检查 token、频道访问权限与发布消息权限；之后可以在「存储通道」的操作菜单中随时手动检查。</li>
        <li>上传时某个 Bot 失败（限流、网络错误、token 失效）会自动换用其他启用的 Bot 重试；连续失败 3 次的 Bot 会暂停使用 15 秒，之后每次失败加倍，最长 5 分钟，成功一次即恢复。</li>
      </ul>
      <H2>审计日志</H2>
      <p>全部文件默认每页 100 项，页脚可选择 50、100 或 200 项并记住浏览器偏好；用户和全部密钥每页最多 50 项，审计日志每页最多 30 条，使用「上一页」「下一页」浏览。筛选在服务器上执行，切换条件或每页数量会回到第一页。概览统计涵盖所有用户，空间排行和配额提醒各显示最多 8 名。</p>
      <p>「审计日志」页面（<C>/admin/audit</C>）记录登录（含失败）、系统锁定与解锁、用户与配额变更、访问密钥的创建与禁用、公开分享的开关、存储通道与系统设置的修改，以及维护任务的执行。日志只记录操作者、对象和结果，不包含任何密码、口令、token 或 Secret。来源 IP 是直接连接到 tgdrive 的地址，经过反向代理时为代理地址。</p>
      <H2>维护任务</H2>
      <Table head={["任务", "作用", "建议频率"]} rows={[
        ["垃圾回收", "从频道中删除已经没有文件引用的分片，释放空间", "大量删除后，或每周一次"],
        ["完整性校验", "下载分片并校验哈希；深度校验还会逐帧解密验证。每次检查最早的 100 个文件，会占用 Telegram 带宽", "每月一次；怀疑数据损坏时立即运行"],
      ]} />
      <H2>传输与清理</H2>
      <p>网页、访问密钥 API 与 S3 共用服务端传输名额。请求在读取上传数据前排队，等待超过 30 秒返回 503（S3 为 SlowDown），可稍后重试。默认全局 4 个名额、每桶 2 个；以 16 MiB 分片估算，上传缓冲约为每个活动分段 64 MiB，调整前请预留加密、下载和密码校验的内存。</p>
      <p>后台每轮最多清理 500 个中断上传、500 个孤立文件和 500 个已完成上传记录，回收站每轮最多处理 100 个过期条目。剩余积压在后续周期继续处理。</p>
      <H2>审计保留与导出</H2>
      <p>默认永久保留在线日志。设置审计保留天数后，每轮最多将 500 条过期记录加密归档到数据目录的 <C>audit-archives/</C>；归档可靠落盘后才从在线日志移除，归档文件不会自动删除。请将该目录一起备份，并保存归档时的加密口令。</p>
      <Code lang="bash" code={`tgdrive audit-export /var/lib/tgdrive/audit-archives/audit-1-500-123.tgdaudit --output ./audit.jsonl`} />
      <p>导出交互式输入归档时的口令，生成权限为 0600 的 JSONL 文件，拒绝覆盖已有文件，不需要访问在线数据库。</p>
      <H2>备份</H2>
      <ul className="doc-list">
        <li>数据目录中的 <C>meta.db</C> 保存了全部文件索引和加密后的密钥，丢失后频道中的分片将无法使用。请定期备份数据目录。</li>
        <li>备份包含私密文件索引、私密回收站和私密访问密码的 Argon2id 哈希；短期解锁授权不会备份，也不会在服务重启后恢复。数据库升级到 v13 时新增访问配置表，沿用升级前自动备份机制。</li>
        <li>备份固定数据库与密钥版本，创建和恢复都分块处理；保留 v2 格式，旧备份继续可恢复。同一秒创建的备份使用不同文件名。</li>
        <li>加密口令不保存在任何地方，请保存在密码管理器中。没有口令，备份也无法恢复。</li>
        <li>升级时，程序会在迁移数据库前自动生成 <C>meta.db.v&lt;旧版本&gt;.*.bak</C> 备份。</li>
        <li>缩略图用对应文件自己的密钥加密，保存在服务器本地的 <C>meta.db</C> 中，不占用 Telegram 频道，也不计入用户配额；它是可以重新生成的展示缓存，不进入备份，恢复备份后由浏览器按需补生成。从 v11 升级时，旧版的明文缩略图会在解锁后自动加密转存；升级前自动生成的 <C>meta.db.v11.*.bak</C> 里仍有旧版明文缩略图，确认升级正常后可以删除。</li>
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
        <li>AWS CLI v1 生成的预签名 URL 默认使用已淘汰的 SigV2（URL 中带 <C>AWSAccessKeyId</C>），{BRAND} 只支持 SigV4：执行 <C>aws configure set default.s3.signature_version s3v4</C> 后重新生成。</li>
        <li>较新的 AWS SDK 默认附加 CRC32C 等尾部校验和。{BRAND} 校验 CRC32、SHA-1 与 SHA-256，其他算法会被接受但不校验；如遇兼容性问题，可设置环境变量 <C>AWS_REQUEST_CHECKSUM_CALCULATION=when_required</C>。</li>
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
