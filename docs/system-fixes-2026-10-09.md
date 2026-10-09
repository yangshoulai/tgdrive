# Tessera 系统可靠性修复记录（2026-10-09）

## 改动

- 备份在一致性锁内捕获密钥参数、内存 KEK 和 WAL 读事务，复制期间允许正常读写；口令轮换、锁定与初始化使用同一把锁。手动与定时备份串行发布，文件名不再因同秒创建而覆盖。
- 备份创建及恢复分块加解密，不再为整个数据库构造多份内存副本。保留既有 v2 格式及旧备份恢复兼容性，明文临时目录和输出权限受限，认证失败不保留部分明文。
- 上传队列由应用外壳持有，跨个人空间和管理页面保留进度、取消入口及统一文件并发；退出、锁定和会话失效时取消未完成任务。容量刷新合并短时间内的重复调用，取消任务显示取消状态。
- Telegram 所有 Bot 均在冷却时等待最早的冷却截止时间；文件下载遇到临时故障或限流执行最多三次尝试，保留 Range 与路径刷新逻辑。
- 登录、创建账号、修改/重置密码、分享密码及系统口令派生通过最多两个并发任务执行。数据库和会话变更仍在事件循环中；异步计算结束后重新验证会话、账号状态、密码或密钥版本，防止旧结果绕过撤销。取消请求不会提前归还仍在计算的名额。
- 用户、密钥、公开分享、回收站、审计及概览统计使用独立连接执行重查询。统计缓存最多 256 项、有效期 2 秒，写事务提交立即清空。schema v11 增加文件排序、公开列表、密钥关联、回收站、审计及清理所需索引。
- 上传分段、下载流和校验共用全局传输名额；默认全局 4、每桶 2，可通过启动参数或环境变量调整。等待超过 30 秒返回 503 和 Retry-After；S3 使用 SlowDown。响应结束或连接中断时显式关闭迭代器，释放预读与名额。
- 管理概览提供错误状态和原地重试，卸载取消读取；普通 JSON 请求 30 秒超时，长维护和最终提交允许 15 分钟，上传连续 5 分钟无进度或响应时结束并提示重试。
- 清理任务单轮处理量有界，分片引用通过 SQL 转交 GC，清空回收站分批处理。审计日志默认永久保留；显式启用保留天数后，先可靠写入加密 JSONL 归档，再移出在线日志。增加 audit-export 命令，拒绝覆盖既有输出文件。
- 标签发布流程在推送镜像前执行后端回归、前端类型检查及构建，仍仅由 v* 标签触发。HTTP 500 日志增加请求编号、错误类型和调用位置，不记录请求参数或异常文本。

## 验证

- 后端完整回归：157 项全部通过。新增回归覆盖备份复制期间轮换口令、分块备份与同秒命名、清理批量、归档落盘失败、Telegram 冷却及下载重试、传输限额与取消释放、密码计算期间禁用账号及取消后的名额保持。
- 前端 strict 类型检查、双入口构建、Python 编译检查和 git diff --check 通过。
- 隔离查询计划确认全部文件排序使用 objects_admin_page 覆盖索引；确认统计缓存复用及提交后失效。
- Playwright 在本机内存模拟服务验证桌面/手机跨页上传、单项取消、退出移除任务、概览请求失败重试及无响应超时重试；手机截图经目视检查。
- 重新完成本地包的 editable 安装，不升级运行时依赖。
- 所有数据库验证使用测试临时目录；未访问或迁移用户的 .local-data，也未调用真实 Telegram 服务。未执行生产部署，GitHub Actions 尚未在远端运行。

## 配置与限制

- 新增 TGDRIVE_TRANSFER_CONCURRENCY（默认 4）、TGDRIVE_BUCKET_CONCURRENCY（默认 2）和 TGDRIVE_AUDIT_RETENTION_DAYS（默认 0）。启动参数分别为 --transfer-concurrency、--bucket-concurrency 和 --audit-retention-days。
- 新版本启动时会自动建立 schema v11 的索引，索引构建耗时与现有数据量有关；本轮未对现有数据库执行升级。
- 审计归档目录为数据目录内的 audit-archives/，不会自动删除归档文件；请一并备份，并保留归档当时的加密口令。导出用 tgdrive audit-export <归档> --output <新的JSONL路径>。
- 超时或取消不能保证已开始的服务端提交被回滚；失败重试前应确认当前状态。浏览器刷新仍沿用重新选择同一大文件续传的现有契约。
- 未做生产规模压测；默认并发是保守值，应根据实际内存和 Telegram 通道能力调整。

## 文件清单

新增：

- src/tgdrive/work.py
- docs/system-fixes-2026-10-09.md

修改：

- .github/workflows/docker.yml
- AGENTS.md
- DESIGN.md
- UX-CONTRACT.md
- src/tgdrive/accounts.py
- src/tgdrive/api.py
- src/tgdrive/app.py
- src/tgdrive/asgi.py
- src/tgdrive/audit.py
- src/tgdrive/blobengine.py
- src/tgdrive/keyapi.py
- src/tgdrive/keystore.py
- src/tgdrive/maintenance.py
- src/tgdrive/metadata.py
- src/tgdrive/objects.py
- src/tgdrive/s3/auth.py
- src/tgdrive/s3/gateway.py
- src/tgdrive/telegram/pool.py
- src/tgdrive/telegram/store.py
- tests/test_auth.py
- tests/test_download_pipeline.py
- tests/test_maintenance.py
- tests/test_telegram_health.py
- web/src/admin/overview.tsx
- web/src/api.ts
- web/src/docs/docs-admin-content.tsx
- web/src/user.tsx
- web/src/user/files.tsx
- web/src/user/uploads.tsx

删除：无。
