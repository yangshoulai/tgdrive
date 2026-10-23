# 离线下载实现与验证

Tessera 已增加服务器离线下载。首版支持 HTTP/HTTPS 文件直链、bash 格式的 curl／wget 参数解析，以及有限范围的 M3U8 点播封装。此前手机预览的进度归零、尺寸稳定和弹窗位置修改一并保留。

后续已追加 X 与 YouTube 本地平台解析、Cookie 导入与音视频轨合并，schema 追加至 v15。新范围、文件清单与验证边界见 [平台下载说明](platform-downloads.md)；下文保留 HTTP／M3U8 首版的实现记录。

2026-10-12 已扩展常见 M3U8 点播格式并修复平台格式筛选和错误分类，当前支持范围与实际链接验证见 [离线下载兼容性排查](offline-reliability.md)。下文的首版限制仅是历史记录。

## 使用与部署

- 个人侧栏「下载任务」：粘贴并解析 → 勾选文件 → 选择普通空间目录 → 开始下载。自动识别失败的播放列表可选择「M3U8 视频」，选择「文件直链」则保留原始文件。
- 任务面板提供停止、继续、重新下载、更新参数、删除及进度、速度、预计剩余时间。同名文件自动改名，删除任务保留已入库文件；未完成分片交给现有垃圾回收维护释放。
- 管理端「系统设置 → 下载与资源」：自动／低资源／自定义（1.13 起「标准」并入「自动」，旧值读取时按自动处理；自动在硬件足够时就是标准档）。管理员配置持久保存并优先于启动默认；容器预算仍限制实际并发。1 核／750 MB 自动采用低资源，并发 1、FFmpeg 最多 1。文件读取名额（`transfer_concurrency`／`bucket_concurrency`，同样保存在这份配置里，1–16，启动参数只作默认值）与下载、预览、播放共用，保存后经 `on_change` 立即调用 `TransferSlots.set_limits`；降低名额不终止已获准的传输。
- 低资源档的日常传输上限已放宽：检测内存达到 512 MiB 时，默认读取为服务器 4 路／每账号 2 路、写入 4 个分片、网页每个文件 4 段；同时上传仍为 2 个文件，离线下载和 FFmpeg 仍最多 1 个。读取与写入继续分别受四分之一内存预算限制，低资源网页分段沿用写入内存预算；不足 512 MiB 或内存未知时保留原先的 2／1／2／2 上限。较小的管理员配置不被抬高，Bot 发送间隔与平台临时缓存预算不变。部署后使用新的生效上限，不改写已有配置；网页上传参数最长 1 分钟刷新。下文的首版容器峰值验证不代表新并发下的峰值。
- 默认 Docker 镜像不含 FFmpeg。M3U8 需要构建或发布同版本的 `-ffmpeg` 变体，然后启用 M3U8。发布工作流仅在发布关联 `v*` 标签的 GitHub Release 时触发，本轮没有发布镜像或替换部署。
- schema 从 v13 升为 v14；正常启动沿用既有迁移备份机制。验证使用 `.local-data` 下独立的 `offline-verify-*` 目录，没有重置现有账号或文件。

```bash
docker build --build-arg INSTALL_FFMPEG=1 -t tgdrive:ffmpeg .
```

小服务器可拉取 CI 发布的成品镜像，避免在服务器构建。未经限制的容器可能看到宿主机预算，建议部署时设置 `cpus: 1.0`、`mem_limit: 750m`，或手动固定低资源模式。

## 处理路径与安全边界

HTTP 接收通过 64 KiB 块与背压传递，再以 16 MiB 分段复用对象上传、分片加密、指纹和存储通道。M3U8 的 TS 数据顺序送入 FFmpeg 本地管道，`-c copy` 封装为分片 MP4，再走同一存储路径；不转码、不缓存整段 TS 或完整视频。使用本地存储时，最终加密文件仍占磁盘。

后台授权绑定账号和桶，不依赖提交时网页会话的寿命。锁定或资源压力暂停 GET，恢复后继续；禁用账号停止任务，重新启用需要手动继续。删除账号前先禁用并停止任务，清理失败时保留禁用状态以阻止继续写入。

命令不会执行，不读取本地文件。来源 URL、头值和请求体加密存储，随加密口令轮换重加密；审计只记录任务 ID、数量及资源参数。每次连接和重定向检查并固定公网 IP；禁止本机、内网、云元数据与不安全传输参数，跨来源不转发自定义头。FFmpeg 不接收用户 URL 或命令。

HTTP 只有在强 ETag、来源、总长度和实际 Range 响应一致时追加断点。来源变化或忽略 Range 时清理断点并报错，过期断点从头下载。停止／失败断点沿用 7 天清理期限，运行及等待恢复的任务不被闲置清理。POST 解析不发请求，重定向不自动重发，异常取消或重启后需手动继续。

## 首版限制

- 不支持磁力、种子、第三方解析服务及网页文件扫描；只写入普通文件空间。
- M3U8：已经结束、未加密、连续的 MPEG-TS，H.264／AAC；支持主列表清晰度，停止后从头封装。直播、DRM、AES 加密、独立媒体轨、fMP4 输入、字节范围和实际时间线跳变不支持。
- 一次最多 32 个候选文件，未完成任务最多 500 个／账号；输入最多 256 KiB，文本请求体 64 KiB、请求头 32 KiB。播放列表最多 2 MiB、32 个清晰度、20000 个分片。网页 JSON 请求上限沿用 1 MiB，参数很大时需分批提交。
- 浏览器请求中的 Range 和缓存条件由下载器管理，压缩优先采用未压缩表示；解析结果会说明变化。代理、本地参数文件、变量、管道、关闭 TLS 验证及未知选项拒绝；不支持 Windows CMD／PowerShell 专用命令语法。

## 验证证据

- Python 3.12 完整回归：211 项通过；前端 strict 类型检查、完整构建、`git diff --check` 通过。
- 两种 Docker 镜像构建、Compose 配置验证通过。arm64 本地未压缩大小：默认约 165 MiB，FFmpeg 约 557 MiB；其他架构或版本可能不同。
- 1 核、750 MiB、禁用交换空间、uid 10001、只读根文件系统的临时容器：自动识别 low／并发 1，19 项下载回归通过，真实 M3U8 封装与 MP4 完整解码通过。两次验证峰值分别约 325／334 MiB（340570112／350298112 字节），包含测试内存盘；这是受控样本，不能作为所有大文件、长视频或并行网页操作的峰值保证。
- Chrome 实际粘贴 curl／Cookie → 解析 → 勾选 → 提交，显示真实进度和速度；资源配置保存并刷新保留。390×844 手机任务页、360×640 资源页没有横向溢出。生成的 MP4 时长约 6.037 秒，播放与跳转到第 4 秒成功。Safari 真机未验证。
- 验证截图：`output/playwright/offline/downloads-desktop.png`、`downloads-mobile.png`、`resources-desktop.png`（本地验证产物，未纳入版本库）。临时工具与详细日志位于 `/private/tmp/tessera-offline-verify/`，测试容器运行后自动移除，验证镜像未推送。

## 文件清单

### 新增

- `docs/offline-downloads.md`
- `src/tgdrive/offline/__init__.py`
- `src/tgdrive/offline/hls.py`
- `src/tgdrive/offline/http.py`
- `src/tgdrive/offline/request.py`
- `src/tgdrive/offline/resources.py`
- `src/tgdrive/offline/service.py`
- `tests/test_offline.py`
- `tests/test_offline_http.py`
- `web/src/admin/resources.tsx`
- `web/src/user/downloads.tsx`

### 修改

- `.github/workflows/docker.yml`
- `AGENTS.md`
- `DESIGN.md`
- `Dockerfile`
- `README.md`
- `UX-CONTRACT.md`
- `docker-compose.yml`
- `src/tgdrive/accounts.py`
- `src/tgdrive/api.py`
- `src/tgdrive/app.py`
- `src/tgdrive/asgi.py`
- `src/tgdrive/audit.py`
- `src/tgdrive/keystore.py`
- `src/tgdrive/maintenance.py`
- `src/tgdrive/metadata.py`
- `src/tgdrive/work.py`
- `web/src/admin/settings.tsx`
- `web/src/api.ts`
- `web/src/aplayer.d.ts`
- `web/src/docs/docs-admin-content.tsx`
- `web/src/docs/docs-content.tsx`
- `web/src/files.tsx`
- `web/src/preview-media-engine.ts`
- `web/src/preview-media.tsx`
- `web/src/styles.css`
- `web/src/user.tsx`

### 删除

无。
