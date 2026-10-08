# tgdrive：基于 Telegram Bot 的加密分片对象存储系统

**架构设计方案 v2.0**（取代 v1.0）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-09-30 |
| 使用场景 | 自托管；管理员 1 人 + 普通用户 1–5 人；S3 风格的客户端访问；管理端与用户端两套 Web UI |
| 核心特性 | 多 Bot、分片存储、S3 兼容子集（客户端 Access Key 鉴权，SigV4）、多用户隔离、目录、常见文件预览、对 Telegram 保密（服务端加密） |
| 文档状态 | 设计完成；M0 部分验证；M1 代码草稿基于 v1.0 数据模型，**需要按本文档调整**（见附录 A） |

---

## 0. 文档说明

### 0.1 标注约定

| 标记 | 含义 |
|---|---|
| ✅ | 已验证：本项目中实际测试或运行通过 |
| 📄 | 来自官方文档 |
| ⚠️ | 推测或经验值，尚未验证；文中会写明不成立时的后果和降级方案 |

### 0.2 v1.0 → v2.0：需求变更与处理

| # | 新需求 | 本文档的处理 |
|---|---|---|
| 1 | 不考虑自建 Telegram Bot API Server | 只按云端 Bot API 设计，删除 Local Bot API 模式；分片大小受 20 MB 下载限制约束 |
| 2 | 文件系统保持轻量；接口鉴权采用客户端鉴权，类似 S3 | 对外数据接口改为 **S3 兼容子集**：管理员创建"客户端"，每个客户端持有 Access Key ID / Secret，请求用 **AWS SigV4** 签名；只做必要的 S3 能力，不做版本、ACL、生命周期等（第 8 章） |
| 3 | 管理员 UI：配置客户端、增加 Bot、修改加密密钥等 | **管理端 UI**（第 11 章）+ 管理 API（8.5 节） |
| 4 | 用户 UI：1–5 人，各自只能看到自己的文件；首期支持目录 | **用户端 UI** + 用户 API（8.6 节）；每个用户一个私有存储桶；目录用键前缀实现，重命名和移动是纯元数据操作 |
| 5 | 常见文件预览 | 预览支持矩阵与安全约束（11.4 节） |

**我对需求的理解（请确认）：**

1. "客户端鉴权"指 **Access Key + Secret Key + SigV4 签名**，这样 rclone、aws-cli、boto3 等现成工具可以直接使用。
2. **一个用户对应一个私有存储桶**；用户隔离是逻辑隔离，全系统共用一把主密钥 KEK（见 5.1 节：管理员在技术上能访问所有数据）。
3. 浏览器的上传下载走**用户 API（会话 Cookie 鉴权）**，不使用预签名 URL；S3 网关只服务外部客户端。两者都调用同一个对象服务。

### 0.3 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | Telegram 行为验证 | Range 读取 ✅；其余项转为内置诊断，不要求手工测试 |
| M1 | Blob 引擎：加密、分片、元数据、BlobStore | 草稿完成并通过冒烟测试，但基于 v1.0 模型，需要调整 |
| M2 | Telegram 后端 + Bot 池 | 未开始 |
| M3 | 对象服务：存储桶、对象、分段上传、列表、复制/移动、GC、配额 | 未开始 |
| M4 | S3 网关 + SigV4 + 客户端与授权 | 未开始 |
| M5 | 管理 API + 管理端 UI | 未开始 |
| M6 | 用户 API + 用户端 UI（目录、上传下载、基础预览） | 未开始 |
| M7 | 可靠性：加密快照、scrub、冗余副本、Bot 故障转移 | 未开始 |
| M8 | 增强：预览增强、缩略图、回收站、分享链接、用户自助访问密钥 | 未开始 |

### 0.4 设计变更与更正

v1.0 中已更正的四项继续有效：① 灾难恢复不能依赖"扫描频道"（Bot API 无法列出频道历史，⚠️ 据我所知）；② 取消每文件 manifest；③ nonce 不再确定性派生，每次加密分片都用新的随机 salt；④ KEK 轮换在数据库事务内一次性重新包裹。

v2.0 新增的变更：

| 变更 | 原因 |
|---|---|
| **分片加密不再绑定分片序号 `idx` 和"是否末片"标志** | S3 分段上传的各个 part 可能乱序、并行到达，加密发生时最终序号和末片都还不知道。安全性由"每个分片的随机 salt 以数据库为准"保证（5.4 节） |
| 数据模型拆成 **`blobs`（加密内容）+ `objects`（命名空间条目）** | 复制对象不复制数据（引用计数）；重命名和移动只改元数据 |
| 自有 HTTP 分片上传协议取消，改用 **S3 分段上传** 语义 | 对外协议统一；浏览器也调用同一个对象服务 |
| **Bot token 和客户端 secret 加密后存数据库**（用 KEK 派生的子密钥），不再放环境变量 | 管理员要在 UI 里增加 Bot、创建客户端；服务锁定时这些秘密无法解出，与"未解锁不可用"的模型一致 |
| **恢复包必须包含备份 Bot 的 token** | 快照分片的 `file_id` 绑定上传它的 Bot，新 Bot 无法直接下载（A7 未验证前不能依赖迁移）（9.4 节） |
| 去掉 Local Bot API Server 模式 | 需求 1 |

---

## 1. 目标、范围与关键决策

### 1.1 目标

- 用 Telegram 私有频道 + Bot API 的免费额度存放文件，内容对 Telegram 保密。
- 对外提供**轻量的 S3 兼容子集**，客户端用 Access Key 鉴权，可被 rclone、aws-cli、boto3 等直接使用。
- 支持 1–5 个用户，每人一个私有空间，首期支持目录。
- 管理员通过 Web 管理端配置客户端、Bot、用户、存储桶、加密密钥、备份。
- 用户通过 Web 用户端管理文件：目录、上传下载（断点续传）、常见格式在线预览。
- GB 级大文件：分片、多 Bot 并行、断点续传；元数据库可恢复；主密钥可更换。

### 1.2 非目标

- 完整的 S3 实现：版本控制、对象 ACL/桶策略 API、生命周期、标签、SSE-C/KMS、对象锁、POST 表单上传、S3 Select、虚拟主机风格寻址等**都不做**。
- **用户之间的加密隔离**：全系统共用一把 KEK，管理员和服务器能看到所有明文（可选的"每用户密钥"见第 17 章）。
- 商业 SLA；大规模多租户；浏览器端的端到端加密。
- 抵御完全攻陷的服务器、侧信道、流量分析；隐藏分片数量、大小、发送时间。

### 1.3 角色

| 角色 | 说明 | 入口 |
|---|---|---|
| 系统管理员 | 管理系统，不通过 UI 浏览用户文件；技术上可通过授权客户端或直接访问数据库 | 管理端 UI、管理 API |
| 用户 | 只能访问自己的存储桶 | 用户端 UI、用户 API |
| 客户端（Client） | 调用 S3 接口的应用或工具，由管理员创建，持有 Access Key；按存储桶和前缀授权 | S3 网关 |

### 1.4 关键决策一览

| 主题 | 决策 | 理由 | 备选 |
|---|---|---|---|
| 存储后端 | Telegram 私有频道 + 云端 Bot API | 免费；不自建服务（需求 1） | — |
| 对外数据接口 | S3 兼容子集 + SigV4 | 客户端鉴权模型现成、工具生态丰富 | 自有 REST 协议 |
| 入口 | 三个：S3 网关（客户端）、用户 API（会话）、管理 API（会话） | 鉴权方式不同，共享同一个对象服务 | 全部走 S3 |
| 用户隔离 | 每用户一个存储桶；服务层再强制 `Scope` 校验 | 简单、可审计 | 共享桶 + 前缀 |
| 目录 | 键前缀 + `/` 分隔符；空目录用零字节标记对象 | 与 S3 语义一致；重命名/移动是一条事务内的 SQL | 独立的 folders 表 |
| 数据与命名空间 | `blobs`（内容）与 `objects`（键）分离，引用计数 | 复制不复制数据 | 合一 |
| 分片/帧 | 分片 16 MiB、帧 64 KiB（每个 blob 自己记录） | 加密后 16,781,329 B < 20 MB；随机访问 | 整片加密；8 MiB 分片 |
| 加密 | AES-256-GCM；信封加密；单一 KEK；每分片独立派生密钥 | 标准、可随机访问 | 每用户 KEK |
| 元数据 | SQLite（WAL） | 用户少、零运维 | PostgreSQL |
| 后端 | Python 3.12 + FastAPI + httpx | 瓶颈在 Telegram，不在 CPU | Go |
| 前端 | React + Vite + TypeScript + Tailwind；一个工程，`/` 用户端、`/admin` 管理端 | 共享组件和预览模块 | 两个工程 |
| 读取策略 | Range + 1 MiB 预读窗口 + `file_path` 缓存 + 下一分片 `getFile` 预取 | 见 2.5 节 | 整片下载 |
| 浏览器数据通道 | 用户 API（Cookie 会话，直接支持 Range） | 预签名 URL 会过期，视频播放中途拖动会失败 | 预签名 URL |
| 部署 | Docker Compose + Caddy；S3 网关独立域名 | 路径风格 S3 需要独占根路径 | — |

---

## 2. Telegram 平台约束与实测

### 2.1 官方限制（📄，仅云端 Bot API）

| 项目 | 限制 | 对设计的影响 |
|---|---|---|
| Bot 上传单文件 | 50 MB | 分片上传远低于此限制，不构成约束 |
| Bot 下载（`getFile`）单文件 | 20 MB | **分片加密后必须小于 20 MB**：默认 16 MiB 分片加密后为 16,781,329 字节 |
| 下载链接有效期 | 至少 1 小时 | `file_path` 缓存 50 分钟 |

本方案不使用自建的 Local Bot API Server（需求 1），因此没有 2000 MB 的上传上限，也没有"本地磁盘直接读取"的路径。

### 2.2 频率限制（⚠️ 经验值，需实测）

| 范围 | 大致限制 |
|---|---|
| 同一聊天 | 约 1 条消息/秒 |
| 全局 | 约 30 条消息/秒 |
| 群组 | 约 20 条消息/分钟 |
| 超限表现 | HTTP 429，响应里带 `retry_after` 秒数 |

### 2.3 标识符语义

| 标识符 | 语义 | 对设计的影响 |
|---|---|---|
| `file_id` | **绑定到某个 Bot**，换 Bot 无效 | 每个分片必须记录它是由哪个 Bot 上传的 |
| `file_unique_id` | 跨 Bot 稳定，但不能用来下载 | 只用于诊断 |
| `message_id` | 频道内递增 | 与 `chat_id` 一起记录，用于删除 |
| `file_path` | `getFile` 返回的下载路径，有时效 | 缓存 50 分钟（低于官方保证的 1 小时） |
| 下载 URL | `https://api.telegram.org/file/bot<TOKEN>/<file_path>`，**URL 里包含 Bot token** | 任何日志、报错、页面都不能出现完整 URL |

⚠️ 据我所知，Bot API 没有列出频道历史消息的方法，所以系统必须自己完整记录每个分片的位置。

### 2.4 M0 实测数据（✅）

**测试条件：** 数据来自开发者本机网络，样本很少（每项 1–3 次）；部署服务器到 Telegram 的连接质量可能完全不同，以服务器上的数据为准。

**Range 正确性（✅）：**

- 1,338,768 字节的文件：中间 100 字节与完整下载逐字节一致；开放式范围（`1338668-`）和后缀范围（`-100`）都返回 `206`，`Content-Range` 正确。
- 16,781,329 字节的随机文件（相当于一个 16 MiB 分片加密后的大小）：7 项全部通过并逐字节比对——第 0 帧、第 100 帧、最后一帧、连续 4 帧、未对齐区间、后缀范围、开放式范围。

**耗时（16,781,329 字节文件，每行是独立的几次运行）：**

| 项目 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| 上传 | 6.7 s | 6.4 s | 5.7 s |
| `getFile` | 3.9 s | 3.7 s | 3.2 s |
| 完整下载 | 16.8 s（约 1.0 MB/s） | 22.6 s（约 0.74 MB/s） | 9.1 s（约 1.8 MB/s） |
| 单次 Range 请求 | — | — | 1.4–2.7 s（读取 100 字节与 64 KiB 耗时相近） |

**观察：**

- 响应头里 `Last-Modified` 比请求时间早约 30 秒，ETag 是 nginx 静态文件格式；两次请求相隔约 5 分钟，`ETag` 和 `Last-Modified` 都没变，链接仍然可用。
- 单次 Range 请求的耗时与读取字节数基本无关。

### 2.5 对设计的推论

1. ⚠️ 推测：`getFile` 会先把整个文件从 Telegram 数据中心拉到 Bot API 服务器的磁盘，再由 nginx 静态提供下载，所以才支持 Range。若成立，**每个分片第一次访问要先付 `getFile` 的耗时**（本例约 3–4 秒），之后同一分片内的读取只需 Range 请求。因此要缓存 `file_path`，并在顺序读取时提前对下一个分片调用 `getFile`。
2. ⚠️ 推测：单次 Range 请求的 1.4–2.7 秒主要是 `curl` 每次新建连接的开销。真实服务使用长连接，开销应小得多。**帧是校验粒度，不是请求粒度**，读取时用 1 MiB 预读窗口，不能一帧发一个请求。
3. 完整下载速度在本机样本里只有 0.74–1.8 MB/s，整片下载一个 16 MiB 分片要 9–22 秒。有了 Range，冷启动只需 `getFile` 加一次小范围读取，跳转也不必重新下载整片。
4. Range 行为是**未文档化**的，必须有降级路径：流式下载并丢弃前面的帧（见 7.5 节）。

### 2.6 假设与待验证清单

这些项目**不要求用户手工测试**：系统内置诊断模块（12.7 节）会自动收集并在 UI 的诊断页展示。

| 编号 | 假设 | 当前状态 | 不成立时的后果与对策 |
|---|---|---|---|
| A1 | 文件下载地址支持 HTTP Range | ✅ 已验证（未文档化） | 降级为流式下载并丢弃前面的帧；启动时和定期自动探测 |
| A2 | `getFile` 耗时随文件大小增长 | ⚠️ 未验证（只有 16 MiB 的数据） | 若成立，把分片降到 8 或 4 MiB |
| A3 | 长连接可显著降低 Range 请求延迟 | ⚠️ 未验证 | 预读窗口加大 |
| A4 | 多 Bot 并行能提升上传吞吐；429 阈值未知 | ⚠️ 未验证 | 按 Bot 独立限速，AIMD 自适应 |
| A5 | `file_path` 至少 1 小时有效 | 📄 官方保证 | 404 时刷新一次 `getFile` |
| A6 | `getChat` 能返回频道置顶消息，可作恢复锚点 | ⚠️ 未验证 | 改用本地和异地备份，并把"恢复包"离线保存 |
| A7 | 另一个 Bot 用 `forwardMessage` 能拿到属于自己的 `file_id`（用于 Bot 迁移） | ⚠️ 未验证 | Bot 丢失时对应分片无法读取，靠冗余副本兜底 |
| A8 | 部署服务器到 Telegram 的带宽和延迟优于开发机 | ⚠️ 未验证 | 按服务器实测调整分片大小与并发 |

---

## 3. 总体架构

### 3.1 分层与三个入口

```
外部客户端（rclone / aws-cli / boto3 …）      浏览器：用户端 UI        浏览器：管理端 UI
        │ SigV4（Access Key）                    │ 会话 Cookie              │ 会话 Cookie（管理员）
┌───────▼────────┐                     ┌────────▼────────┐        ┌────────▼────────┐
│ S3 网关         │                     │ 用户 API         │        │ 管理 API         │
│ 验签、授权      │                     │ 登录、目录、上传  │        │ 客户端、Bot、用户 │
│ XML 响应        │                     │ 下载、预览        │        │ 密钥、备份、诊断  │
└───────┬────────┘                     └────────┬────────┘        └────────┬────────┘
        └──────────────────────┬────────────────┴──────────────────────────┘
                     ┌─────────▼──────────┐
                     │ 对象服务 ObjectService │  存储桶、对象、分段上传、列表、复制/移动、
                     │ （强制 Scope 校验）     │  配额、GC、审计
                     └─────────┬──────────┘
                     ┌─────────▼──────────┐       ┌────────────────────┐
                     │ Blob 引擎            │──────►│ 元数据（SQLite）       │
                     │ 分片、分帧加密、读取   │       └────────────────────┘
                     └─────────┬──────────┘
                     ┌─────────▼──────────┐
                     │ BlobStore 接口        │
                     │ ├ TelegramBlobStore   │  Bot 池、限速、重试、file_path 缓存、Range 探测
                     │ └ LocalDiskBlobStore  │  测试用
                     └────────────────────┘
```

**核心原则：**

1. **BlobStore 接口**：引擎只依赖 `put / get(range) / delete`，90% 的代码可以脱离 Telegram 测试。
2. **三个入口是三个薄适配层**，鉴权方式不同，但都调用同一个对象服务；浏览器上传和 S3 客户端上传走的是同一段分段上传逻辑。
3. **对象服务的每个方法都接收一个 `Scope(bucket_id, prefix, perms)`** 并自行校验。适配层负责把"谁在请求"解析成 `Scope`，对象服务不信任调用方，这样一处适配层的鉴权疏漏不会直接变成越权。

### 3.2 组件职责

| 组件 | 职责 |
|---|---|
| `crypto` | KEK 派生、DEK 包裹、分片分帧加解密、KEK 子密钥（加密 Bot token、客户端 secret、快照）、范围计算 |
| `metadata` | SQLite 访问层、事务、迁移 |
| `keystore` | 口令初始化与校验、KEK 轮换（重新包裹所有受 KEK 保护的秘密） |
| `blobstore` | 存储后端抽象及本地磁盘实现 |
| `blob engine` | 分片与加密写入（按 part）、定稿（分配偏移）、窗口化读取、scrub、删除入队 |
| `telegram`（M2） | Bot API 客户端、Bot 池、限速、熔断、`file_path` 缓存、Range 探测与降级 |
| `objects`（M3） | 存储桶、对象、分段上传、列表、复制、移动前缀、配额、GC 队列 |
| `s3`（M4） | SigV4 验签（头部与预签名）、`aws-chunked` 解码、操作子集、XML 序列化、授权 |
| `admin api`（M5） / `user api`（M6） | JSON 接口、会话、CSRF、登录限速 |
| `maintenance`（M7） | scrub 调度、快照、GC 工作线程、诊断 |
| `web`（M5/M6） | 一个前端工程：`/` 用户端，`/admin` 管理端 |

### 3.3 部署拓扑

```
互联网 ─443─► Caddy ─┬─ drive.example.com ─► app :8000（用户端、管理端静态文件 + 用户 API + 管理 API）
                     └─ s3.example.com    ─► app :9000（S3 网关）
                          app 是同一个进程，监听两个端口；数据在 /data（meta.db、密文缓存、本地备份）
                          app ──► api.telegram.org（多个 Bot、多个频道）
```

**为什么 S3 网关要独立域名（或端口）：** 路径风格的 S3 请求是 `https://host/<bucket>/<key>`，会占用根路径；客户端的签名也包含完整路径，放在 `/s3` 之类的前缀下很容易签名对不上。

### 3.4 技术选型

| 领域 | 选型 |
|---|---|
| 运行时 | Python 3.12，asyncio |
| Web 框架 | FastAPI + uvicorn（S3 网关用底层 Starlette 路由，直接读取请求体流） |
| HTTP 客户端 | httpx（连接池、长连接） |
| 加密 | `cryptography`（AES-GCM、HKDF、Argon2id 用于 KEK） |
| 用户口令哈希 | `argon2-cffi`（标准编码串，支持参数升级） |
| 数据库 | SQLite（WAL）；`PRAGMA user_version` 手写迁移 |
| 前端 | React + Vite + TypeScript + Tailwind |
| 预览组件 | pdf.js、highlight.js、markdown-it + DOMPurify、docx-preview、SheetJS（见 11.4 节） |
| 测试 | `unittest`；互操作测试用 aws-cli、rclone、boto3 |
| 质量 | ruff、mypy |
| 部署 | Docker Compose + Caddy 2 |

---

## 4. 数据模型

### 4.1 表结构

```sql
-- ===== 系统 =====
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);     -- 管理端可改的配置

CREATE TABLE keys(                                -- 主密钥（KEK）信息，只有一行
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,                     -- 每次轮换加 1
    kdf_salt BLOB NOT NULL,
    kdf_params TEXT NOT NULL,                     -- JSON：iterations / memory_kib / lanes
    check_blob BLOB NOT NULL                      -- 用 KEK 加密的固定串，用来校验口令
);

-- ===== 用户与存储桶 =====
CREATE TABLE users(
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,                  -- Argon2id 编码串
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    status TEXT NOT NULL CHECK (status IN ('active','disabled')),
    bucket_id INTEGER REFERENCES buckets(id),     -- 个人存储桶；创建用户时同事务创建
    created_at REAL NOT NULL,
    last_login_at REAL
);

CREATE TABLE buckets(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,                    -- S3 命名规则：3–63 位小写字母、数字、连字符
    owner_user_id INTEGER REFERENCES users(id),   -- NULL 表示共享桶
    quota_bytes INTEGER,                          -- NULL 表示不限
    used_bytes INTEGER NOT NULL DEFAULT 0,        -- 对象逻辑大小之和（复制的对象各算各的）
    created_at REAL NOT NULL
);

-- ===== 对象（命名空间）与 blob（加密内容）=====
CREATE TABLE objects(
    bucket_id INTEGER NOT NULL REFERENCES buckets(id),
    key TEXT NOT NULL,                            -- UTF-8，≤ 1024 字节；以 '/' 结尾的是目录标记对象
    blob_uuid TEXT REFERENCES blobs(uuid),        -- 目录标记对象为 NULL
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,                           -- 单次上传：明文 MD5；分段上传：S3 风格的 "md5-N"
    content_type TEXT,
    user_meta TEXT,                               -- JSON：x-amz-meta-*
    modified_at REAL NOT NULL,
    PRIMARY KEY (bucket_id, key)
) WITHOUT ROWID;

CREATE TABLE blobs(
    uuid TEXT PRIMARY KEY,
    size INTEGER,                                 -- 定稿（complete）时才确定
    chunk_size INTEGER NOT NULL,                  -- 写入时使用的分片大小
    frame_size INTEGER NOT NULL,                  -- 写入时使用的帧大小
    wrapped_dek BLOB NOT NULL,                    -- 被 KEK 包裹的文件密钥
    status TEXT NOT NULL CHECK (status IN ('uploading','complete')),
    refcount INTEGER NOT NULL DEFAULT 0,          -- 被多少个对象引用（复制不复制数据）
    created_at REAL NOT NULL
);

CREATE TABLE chunks(
    blob_uuid TEXT NOT NULL REFERENCES blobs(uuid),
    part_no INTEGER NOT NULL,                     -- 单次 PutObject 恒为 1；分段上传为 S3 的 partNumber
    sub_idx INTEGER NOT NULL,                     -- part 内的分片序号，从 0 开始
    offset INTEGER,                               -- 在对象明文中的起始偏移；定稿时才分配，之前为 NULL
    plain_size INTEGER NOT NULL,
    cipher_size INTEGER NOT NULL,
    salt BLOB NOT NULL,                           -- 16 字节，解密时以此为准（分片头部里还有一份）
    cipher_sha256 TEXT NOT NULL,                  -- scrub 不需要密钥就能检查
    blob_ref TEXT NOT NULL,                       -- BlobStore 返回的不透明字符串
    PRIMARY KEY (blob_uuid, part_no, sub_idx)
);
CREATE INDEX chunks_by_offset ON chunks(blob_uuid, offset);

-- ===== 分段上传 =====
CREATE TABLE uploads(
    upload_id TEXT PRIMARY KEY,
    bucket_id INTEGER NOT NULL REFERENCES buckets(id),
    key TEXT NOT NULL,
    blob_uuid TEXT NOT NULL REFERENCES blobs(uuid),
    content_type TEXT,
    user_meta TEXT,
    created_at REAL NOT NULL,
    last_activity REAL NOT NULL,
    completed_at REAL,                            -- 已完成的上传记录保留 24 小时，使 Complete 的重试幂等
    result_etag TEXT
);
CREATE TABLE upload_parts(
    upload_id TEXT NOT NULL REFERENCES uploads(upload_id),
    part_no INTEGER NOT NULL CHECK (part_no BETWEEN 1 AND 10000),
    size INTEGER NOT NULL,
    md5 TEXT NOT NULL,                            -- 该 part 的明文 MD5（用于 ETag 校验和合成）
    uploaded_at REAL NOT NULL,
    PRIMARY KEY (upload_id, part_no)
);

-- ===== 客户端（S3 风格鉴权）=====
CREATE TABLE clients(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    owner_user_id INTEGER REFERENCES users(id),   -- 用户自助创建的密钥（M8）；NULL 表示管理员创建
    status TEXT NOT NULL CHECK (status IN ('active','disabled')),
    created_at REAL NOT NULL
);
CREATE TABLE client_keys(                         -- 每个客户端最多 2 个密钥，便于平滑轮换
    access_key_id TEXT PRIMARY KEY,               -- 20 位，前缀 'TGD'
    client_id INTEGER NOT NULL REFERENCES clients(id),
    secret_enc BLOB NOT NULL,                     -- 被 KEK 子密钥加密；SigV4 验签需要明文 secret，所以不能存哈希
    status TEXT NOT NULL CHECK (status IN ('active','disabled')),
    created_at REAL NOT NULL,
    last_used_at REAL
);
CREATE TABLE client_grants(
    client_id INTEGER NOT NULL REFERENCES clients(id),
    bucket_id INTEGER NOT NULL REFERENCES buckets(id),
    prefix TEXT NOT NULL DEFAULT '',              -- 只允许访问该前缀下的键
    perms TEXT NOT NULL CHECK (perms IN ('ro','rw')),   -- ro：List/Get/Head；rw：另加 Put/Copy/Delete/分段上传
    PRIMARY KEY (client_id, bucket_id, prefix)
);

-- ===== Telegram Bot =====
CREATE TABLE bots(
    id TEXT PRIMARY KEY,                          -- 如 'b1'；写入 blob_ref，创建后不可改
    label TEXT,
    token_enc BLOB NOT NULL,                      -- 被 KEK 子密钥加密；只写，界面永不回显
    tg_username TEXT,
    channel_id INTEGER NOT NULL,                  -- 数据频道
    backup_channel_id INTEGER,                    -- 备份频道（快照）
    state TEXT NOT NULL CHECK (state IN ('enabled','draining','disabled')),
    added_at REAL NOT NULL
);

CREATE TABLE chunk_replicas(                      -- M7：冗余副本
    blob_uuid TEXT NOT NULL, part_no INTEGER NOT NULL, sub_idx INTEGER NOT NULL, replica_no INTEGER NOT NULL,
    blob_ref TEXT NOT NULL,
    PRIMARY KEY (blob_uuid, part_no, sub_idx, replica_no)
);

-- ===== 维护 =====
CREATE TABLE gc_queue(                            -- 待从 Telegram 删除的分片
    id INTEGER PRIMARY KEY,
    blob_ref TEXT NOT NULL,
    enqueued_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE TABLE audit_log(
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    actor_type TEXT NOT NULL,                     -- admin / user / client / system
    actor TEXT,
    action TEXT NOT NULL,                         -- 如 client.create、bot.add、kek.rotate、login.fail
    target TEXT,
    ip TEXT,
    ok INTEGER NOT NULL,
    detail TEXT
);
CREATE TABLE db_snapshots(id INTEGER PRIMARY KEY, created_at REAL, manifest_ref TEXT, size INTEGER, sha256 TEXT);
CREATE TABLE shares(                              -- M8：分享链接
    token TEXT PRIMARY KEY, bucket_id INTEGER NOT NULL, key TEXT NOT NULL,
    expires_at REAL, password_hash TEXT, max_downloads INTEGER, downloads INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id), created_at REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
```

会话、登录失败计数放在内存里（服务重启即失效，符合"重启后需重新解锁"的模型）。缩略图是可再生的缓存，放在单独的 `thumbs.db`，不进入快照（M8）。

### 4.2 `blob_ref` 格式

| 后端 | 格式 |
|---|---|
| LocalDiskBlobStore | 32 位十六进制随机名；路径是 `<root>/<前2位>/<名字>` |
| TelegramBlobStore | JSON：`{"v":1,"bot":"b1","chat":-100123456,"msg":456,"fid":"<file_id>","uid":"<file_unique_id>"}` |

引擎和对象服务不解析 `blob_ref`，只原样存取。

### 4.3 目录模型

- **目录就是键前缀**，分隔符 `/`。一个键 `docs/2026/a.pdf` 隐含了目录 `docs/` 和 `docs/2026/`。
- **空目录**用零字节标记对象保存（键以 `/` 结尾，`blob_uuid` 为 NULL），做法与 S3 控制台一致。用户端"新建文件夹"就是写入一个标记对象。
- **保留前缀** `.tgdrive/`：回收站（M8）等内部用途。用户端默认隐藏；S3 客户端的列表里能看到它。
- **覆盖写**：同键再次写入会替换对象，旧 blob 的引用计数减 1；没有版本控制。

### 4.4 关键查询

**列表（ListObjectsV2，带 `prefix`、`delimiter='/'`、游标）：**

```sql
SELECT key, size, etag, modified_at FROM objects
WHERE bucket_id = :b AND key >= :prefix AND key < :prefix_upper AND key > :cursor
ORDER BY key LIMIT :n;
```

`prefix_upper` 是前缀最后一个字节加 1。应用层逐行处理：键在前缀之后还含有 `/` 时，把它归并成一个"公共前缀"（子目录）输出，并把游标设为该公共前缀的上界，**一次跳过目录下的所有键**，再继续查询。每页最多 1000 个条目，延续令牌是最后一个键的 base64。

**移动/重命名一个目录（纯元数据，单个事务）：**

```sql
UPDATE objects SET key = :new_prefix || substr(key, :old_len + 1)
WHERE bucket_id = :b AND key >= :old_prefix AND key < :old_prefix_upper;
```

执行前先检查目标前缀下是否已有同名键，冲突按调用方指定的策略处理（用户端对话框提供"跳过 / 覆盖 / 自动改名"）。10 万级对象的目录一条事务即可完成，不碰 Telegram。

**复制：** 新对象行指向同一个 `blob_uuid`，`refcount + 1`；不复制数据。

**删除：** 删对象行，`refcount - 1`；减到 0 时在同一事务里把该 blob 所有分片的 `blob_ref` 写入 `gc_queue`，再删除 `chunks` 和 `blobs` 行；GC 工作线程以受限的速率调用 `deleteMessage`。

### 4.5 不变量

1. 对每个分片：`cipher_size == 17 + plain_size + n_frames × 16`。
2. `blobs.status = complete` ⇒ 所有分片的 `offset` 已分配，且 `offset` 连续、`plain_size` 之和等于 `blobs.size`；读取一律用 `offset` 查找，不假设分片等长。
3. `blobs.refcount` 等于引用它的 `objects` 行数；与对象的增删改在同一事务里维护。
4. `buckets.used_bytes` 等于该桶内所有对象 `size` 之和，与对象变更在同一事务里维护。
5. 分片一旦写入后端就不再修改；part 重传产生新的 `salt` 和新的 `blob_ref`，旧引用进 `gc_queue`。
6. DEK、Bot token、客户端 secret 永不以明文落盘。
7. **写事务里不做任何网络请求。**
8. 解密用的 `salt` 以数据库为准。

### 4.6 迁移与容量

- 用 `PRAGMA user_version` 记录版本；启动时发现库版本高于程序支持的版本就拒绝启动；每次迁移前自动 `VACUUM INTO` 备份。
- 对象数据量决定元数据规模：约每个对象 150 字节量级，百万级对象为数百 MB；快照经过压缩。

| 场景 | 分片数 | Telegram 消息数 | 说明 |
|---|---|---|---|
| 1 TiB，全是大文件（≥16 MiB） | 约 65,536 | 约 65,536 | 吞吐主要受带宽限制 |
| 1 TiB，平均 1 MiB 的文件 | 约 100 万 | 约 100 万 | **每个对象至少占一条消息**；受频率限制，见 6.7 节 |

---

## 5. 加密与完整性设计

### 5.1 威胁模型

| 对手 | 能力 | 结论 |
|---|---|---|
| Telegram / 存储提供方 | 读取、篡改、删除分片；看到分片数量、大小、发送时间 | **保密 ✅、完整性 ✅（AEAD）；可用性无法保证**（靠冗余与备份）；元信息无法隐藏 |
| 窃取数据库文件者 | 拿到 `meta.db` | DEK、Bot token、客户端 secret 都被 KEK 相关密钥保护；**文件名、目录结构、用户名在库里是明文**；用户口令是 Argon2id 哈希 |
| 窃取密文 + 数据库、没有 KEK 口令者 | 离线暴力破解 | Argon2id（默认 t=3、m=64 MiB、p=4）增加成本；口令强度是关键 |
| 窃取 Bot token 者 | 读写频道 | 读到的是密文；可以删除数据；撤销 token 后失效 |
| **普通用户** | 通过用户 API 或自己的客户端访问 | 只能访问自己的存储桶；越权靠 `Scope` 校验（3.1 节）防护，不靠加密 |
| 被窃取的客户端凭据 | 以该客户端的授权范围访问 | 授权最小化（按桶、前缀、只读/读写）；管理员可随时禁用 |
| 网络中间人 | 窃听 | HTTPS |
| **不在范围内** | 完全攻陷的服务器；侧信道；流量分析 | — |

**重要说明：**

1. 这是**服务端加密**：服务器在上传和读取时能看到明文，保护的是"Telegram 看不到内容"。
2. **全系统共用一把 KEK，用户之间是逻辑隔离，不是加密隔离**：管理员（持有口令、能解锁系统、能访问数据库）在技术上可以读到所有用户的数据。管理端 UI 不提供浏览用户文件的功能，管理员的敏感操作进入审计日志，但这不能替代技术上的隔离。若需要"管理员也看不到"，要用每用户独立密钥（代价见第 17 章）。

### 5.2 密钥层级

| 密钥 | 数量 | 存放 | 作用 |
|---|---|---|---|
| **KEK**（主密钥） | 全局 1 把 | **不落盘**，由口令经 Argon2id 派生，解锁后只在内存 | 包裹 DEK；派生各类子密钥 |
| **DEK**（blob 密钥） | 每个 blob 1 把，随机 32 字节 | 数据库里，被 KEK 包裹 | 派生各分片的密钥 |
| **分片密钥** | 每个分片 1 把 | **不存储**，现算 | 加密该分片内的所有帧 |
| **KEK 子密钥** | 每种用途 1 把（Bot token、客户端 secret、快照） | **不存储**，从 KEK 现算 | 加密 Bot token、客户端 secret、数据库快照 |
| 用户口令哈希 | 每用户 1 个 | 数据库（Argon2id 编码串） | 登录；**与 KEK 口令无关** |

```
口令 ──Argon2id(kdf_salt)──► KEK ──AES-GCM 包裹──► wrapped_dek（blobs 表）──解包──► DEK
                              │                                                     │ HKDF(salt=分片salt, info="tgdrive-chunk|"‖blob_uuid)
                              │                                                     ▼
                              │                                                  分片密钥 ──AES-256-GCM──► 各帧密文
                              └─HKDF(info="tgdrive-sub|bot-token" / "client-secret" / "backup")─► 子密钥
                                      └─ AES-GCM（随机 nonce，AAD=记录标识）─► token_enc / secret_enc / 快照
```

分层的理由：**换口令只需重新包裹，不用重传 Telegram 上的数据**；每个分片单独派生密钥，同一把密钥加密的数据量很小，并且避免"同密钥同 nonce 加密不同明文"；子密钥按用途隔离，一种用途的密文泄露不影响其他用途。

### 5.3 分片密文的字节布局

```
[版本 1B][salt 16B][帧0 密文+tag][帧1 密文+tag] ... [帧n-1 密文+tag]
每帧 = 密文(≤ frame_size) + tag(16B)；只有最后一帧可以不满
```

**公式：**

| 量 | 公式 |
|---|---|
| 帧数 | `n = max(1, ceil(plain_size / frame_size))` |
| 分片密文总长 | `17 + plain_size + 16 × n` |
| 除末帧外每帧密文长度（stride） | `frame_size + 16` |
| 第 k 帧的起点 | `17 + k × stride` |

**默认参数的数字（16 MiB 分片，64 KiB 帧）：** 256 帧，stride 为 65,552 字节，分片密文 16,781,329 字节，仍低于 20 MB 的下载限制。

**为什么要分帧：** AEAD 的认证 tag 覆盖整条消息，读完整条并校验通过后才能信任其中的任何字节。如果整片是一条消息，预览时必须拿到完整的 16 MiB 才能出第一帧。分帧后每帧单独校验，配合 Range 只取需要的帧。帧大小写在每个文件的元数据里，设成 ≥ 分片大小就退化为整片加密，所以这是一个配置，不是格式分叉。

### 5.4 算法细节

| 项目 | 规格 |
|---|---|
| 分片密钥 | `HKDF-SHA256(ikm=DEK, salt=分片 salt(16B 随机), info="tgdrive-chunk|" ‖ blob_uuid(16B), L=32)` |
| 帧加密 | AES-256-GCM |
| 帧 nonce（12B） | `帧序号(u64 大端, 8B) ‖ 0x000000 ‖ 末帧标志(1B)`；末帧标志为 1 表示本分片的最后一帧 |
| AAD | `struct(">BI", 格式版本, frame_size)` |
| KEK 派生 | `Argon2id(salt=kdf_salt(16B), length=32, iterations=3, memory=64 MiB, lanes=4)`，参数写在 `keys.kdf_params` |
| DEK 包裹 | `nonce(12B) ‖ AES-GCM(KEK, DEK, aad="tgdrive-dek|" ‖ blob_uuid)` |
| KEK 子密钥 | `HKDF-SHA256(ikm=KEK, salt=空, info="tgdrive-sub|" ‖ 用途, L=32)` |
| 子密钥加密 | `nonce(12B) ‖ AES-GCM(子密钥, 明文, aad=记录标识)`；记录标识：Bot 用 `bots.id`，客户端密钥用 `access_key_id` |
| 口令校验 | `check_blob = nonce ‖ AES-GCM(KEK, "tgdrive-kek-check")` |
| salt | **每次加密分片都重新随机生成** |

**为什么分片加密不再绑定分片序号和"是否末片"（相对 v1.0 的变更）：**

S3 分段上传的 part 可以乱序、并行到达，加密发生时，这个分片最终排在第几位、是不是最后一片都还不知道。绑定它们没有必要，因为分片和位置的绑定已经由**数据库里的随机 salt** 完成：

| 攻击（存储提供方的能力） | 为什么会失败 |
|---|---|
| 把分片 A 的内容放到分片 B 的位置 | B 的行里记录的是 B 的 salt，派生出的密钥与 A 的密文对不上，tag 校验失败 |
| 把另一个文件的分片换进来 | `info` 里含 `blob_uuid`，而且 salt 也不同 |
| 把同一个 part 重传前留下的旧孤儿分片换进来 | 旧孤儿分片的 salt 与数据库里的不同 |
| 删除分片或截断末尾 | `cipher_size`、`cipher_sha256` 与数据库不符；分片缺失时读取和 scrub 都会报错 |
| 帧级的乱序或截断（分片内部） | nonce 含帧序号和末帧标志，仍然有效 |

这些防护都依赖数据库的完整性；而数据库在我们自己手里，不在存储提供方手里。

### 5.5 nonce 是什么，为什么这样设计

nonce 是"只用一次的编号"。加密算法用（密钥，nonce）生成一串遮盖流来盖住明文；同一把密钥和同一个 nonce 如果加密了两份**不同的明文**，攻击者可以把两份密文对着一算，遮盖就抵消了，能得到两份明文之间的关系，对 GCM 来说甚至会暴露认证密钥。nonce 不需要保密，只需要不重复。

本设计的做法：

- 分片内所有帧共用一把分片密钥，帧之间靠帧序号区分 nonce。
- 不同分片的密钥不同，所以每个分片的帧序号都可以从 0 开始。
- 每次加密分片都用新的随机 salt，因此即使发生重试、part 重传，也绝不会出现"同密钥同 nonce 加密不同明文"。
- nonce 不存储，解密时根据帧的位置现算。

### 5.6 读取区间的映射

给定分片内明文区间 `[lo, hi]`（含）：

```python
k0, k1 = lo // frame_size, hi // frame_size          # 首帧、末帧
stride = frame_size + 16
start = 17 + k0 * stride                              # 需要读取的密文起点
end = min(17 + (k1 + 1) * stride, cipher_size)        # 终点（不含），末帧可能不满
# 取回 [start, end) 后，对 k0..k1 逐帧解密校验，再裁掉首尾多余的部分
```

因为 `salt` 存在数据库里，范围读取不需要再去取分片头部。

### 5.7 安全性质与已知限制

| 性质 | 如何保证 |
|---|---|
| 保密 | AES-256-GCM；密钥层级如 5.2 节 |
| 帧被篡改 | 每帧 tag 校验失败，抛 `IntegrityError` |
| 帧乱序、帧截断 | nonce 含帧序号和末帧标志 |
| 分片被替换、搬位置、换成旧孤儿分片 | 分片密钥由（DEK、blob_uuid、数据库里的 salt）派生（5.4 节） |
| 帧大小、格式版本被篡改 | 在 AAD 里 |
| 分片整体缺失 | `cipher_size`/`cipher_sha256` 对不上；读取与 scrub 报错 |

**已知限制：**

- 整个分片被删除，AEAD 本身发现不了，靠数据库与 scrub 发现。
- 每个分片最多 `ceil(chunk_size / frame_size)` 帧（默认 256），远低于 GCM 单密钥的安全上限。
- 帧越小，随机访问越精细、tag 开销越大（4 KiB 帧约 0.4%，64 KiB 帧约 0.024%）。默认 64 KiB 时每次跳转最多多读约 128 KiB。

### 5.8 KEK 轮换与 DEK 轮换

**KEK 轮换（管理端"修改加密密钥"，便宜）：** 进入**维护模式**（暂停写入）后，在**同一个数据库事务内**：

1. 用旧 KEK 解包并用新 KEK 重新包裹所有 `blobs.wrapped_dek`；
2. 用旧子密钥解密并用新子密钥重新加密所有 `bots.token_enc` 和 `client_keys.secret_enc`；
3. 更新 `keys` 行（新的 `kdf_salt`，`version + 1`）。

只改数据库，不碰 Telegram 上的数据。事务提交后旧 KEK 立即失效，管理员需要用新口令重新解锁；随后立即做一次新快照。百万级 blob 的重新包裹需要数十秒到数分钟，所以才进入维护模式。任何一步失败都整体回滚。

**DEK 轮换（重加密，昂贵）：** 下载并解密分片，用新 DEK 重新加密并上传，切换数据库，再删除旧消息。只有怀疑 DEK 泄露时才需要，**首版管理端不提供**。

**注意：** 更换 KEK 只能防**将来**的泄露。如果旧口令已经泄露，而对手同时持有旧的数据库快照，旧 blob 的 DEK 仍可被解出，这时必须重加密数据。

### 5.9 crypto 模块对外接口

```python
FileKey(dek: bytes, blob_uuid: bytes, frame_size: int)

n_frames(plain_size, frame_size) -> int
cipher_size(plain_size, frame_size) -> int
encrypt_chunk(fk, plain) -> (blob, salt)                           # 每次调用新 salt
cipher_range(frame_size, plain_size, lo, hi) -> (start, end, k0, k1)
decrypt_range(fk, salt, plain_size, data, lo, hi) -> bytes          # 失败抛 IntegrityError

KdfParams(iterations=3, memory_kib=65536, lanes=4)
derive_kek(passphrase, salt, params) -> bytes
new_dek() / wrap_dek(kek, dek, blob_uuid) / unwrap_dek(kek, wrapped, blob_uuid)
derive_subkey(kek, purpose) -> bytes                                # purpose: bot-token / client-secret / backup
seal(subkey, plaintext, aad) -> bytes / open_sealed(subkey, sealed, aad) -> bytes
make_check_blob(kek) / verify_check_blob(kek, blob)
```

---

## 6. 核心流程

### 6.1 PutObject（单次请求上传）

1. 适配层（S3 网关或用户 API）把请求解析成 `Scope`；检查配额（`Content-Length` 或解码后的长度）。
2. 创建 blob（状态 `uploading`）：随机 DEK，用 KEK 包裹后存入。
3. **流式处理请求体**：按 `chunk_size` 填满缓冲区 → 在线程池里加密 → `store.put(随机 key, blob)` → 立刻在短事务里写 `chunks` 行（`part_no=1`，`sub_idx=n`）。同时增量计算 MD5。每个请求最多 2 个分片在途，全局还有信号量限制（7.3 节）。
4. 请求体结束后核对：声明的长度、`Content-MD5`、`x-amz-checksum-*`（8.2 节），不符就中止并把已写入的分片送入 GC。
5. **一个事务内**：分配偏移、blob 置 `complete` 并记录 `size`、替换对象行（旧 blob 引用计数减 1，必要时入 GC 队列）、更新 `used_bytes`。
6. 返回 `ETag`（明文 MD5）。

### 6.2 分段上传（S3 Multipart）

用户端 UI 和 S3 客户端走同一套逻辑。

| 步骤 | 行为 |
|---|---|
| `CreateMultipartUpload` | 创建 blob（`uploading`）和 `uploads` 行，返回 `upload_id` |
| `UploadPart`（可并行、可乱序、可重传） | 每个 part 独立流式分片加密，写 `chunks`（`part_no`、`sub_idx`）和 `upload_parts`（大小、MD5）。**同一 `part_no` 重传：替换旧分片**，旧的 `blob_ref` 进 `gc_queue`；对同一（upload，part）加锁，后到者生效 |
| `ListParts` | 返回已上传的 part，客户端据此续传 |
| `CompleteMultipartUpload` | 校验：part 编号严格递增；客户端给出的 ETag 与 `upload_parts.md5` 一致；除最后一个外每个 part ≥ 5 MiB（`EntityTooSmall`）。**一个事务内**：按 `(part_no, sub_idx)` 顺序分配 `offset`；blob 置 `complete`；对象行写入或替换；`used_bytes` 更新；`uploads` 标记 `completed_at`。组合 ETag = `md5(各 part 的二进制 MD5 依次拼接)` + `"-" + part 数` |
| `AbortMultipartUpload` / 过期 | 删除 `uploads`、`upload_parts`、`chunks`、`blobs` 行，分片进 `gc_queue`；默认 7 天无活动自动过期 |

**幂等：** `Complete` 提交后，`uploads` 行保留 24 小时，带 `completed_at` 和 `result_etag`；客户端因网络问题重试 `Complete` 时直接返回成功，不会因为 `NoSuchUpload` 而失败。

**part 大小：** 各 part 大小可以不同，每个 part 内部按 `chunk_size` 切分，所以分片不要求等长（读取靠 `offset`）。用户端 UI 默认 part 大小 = 16 MiB。

### 6.3 崩溃点与恢复

| 崩溃或失败发生在 | 后果 | 恢复方式 |
|---|---|---|
| 加密后、`put` 之前 | 无影响 | 客户端重传该 part（或 PutObject 整体重试） |
| `put` 成功、写 `chunks` 行之前 | 后端留下**孤儿分片** | 已接受的空间浪费（Bot API 无法列出频道历史 ⚠️，无法扫描清理） |
| 分段上传中途失败 | `uploads` 与已写入的 part 保留 | 客户端用 `ListParts` 续传；超时自动过期清理 |
| `put` 超时、结果不确定 | 可能已上传成功 | 按失败处理并重试，可能产生孤儿分片 |
| PutObject 写完所有分片、定稿事务之前 | blob 停在 `uploading`，没有 `uploads` 行 | 孤儿 blob 清理：状态 `uploading`、不被 `uploads` 引用、超过 24 小时的 blob 进入 GC |
| 定稿事务期间 | 事务原子，要么全有要么全无 | — |

发送消息时默认不写 caption，避免 Telegram 把同一文件的分片关联起来（第 10 章）。

### 6.4 读取与预览

1. 适配层解析出 `Scope` 和键，对象服务查到 blob，用 `offset` 找出覆盖请求区间的分片。
2. 对每个分片，按 `window`（默认 1 MiB，至少一帧）分窗口：计算需要的密文范围 → 向后端请求该范围 → 解密校验 → 裁剪后交出。**帧是校验粒度，`window` 才是向后端发请求的粒度。**
3. 响应流式发送，不在内存里缓冲整个文件。

**读取优化（M2/M3）：**

| 优化 | 做法 |
|---|---|
| `file_path` 缓存 | 每个分片缓存 50 分钟；404 时刷新一次 |
| 下一分片预取 | 顺序读取进入当前分片的后 25% 时，对下一个分片提前调用 `getFile` |
| 并发合并（single-flight） | 同一分片、同一窗口的并发请求只向后端发一次 |
| 密文窗口缓存 | 本地磁盘缓存密文窗口，LRU 淘汰，有容量上限；缓存的是密文 |
| 降级 | Range 不可用时改为流式下载并丢弃前面的帧（7.5 节） |
| 浏览器缓存 | `ETag` + `Cache-Control: private`，重复预览不再访问 Telegram |

### 6.5 对象操作

列表、复制、移动、删除的 SQL 和语义见 4.4 节。要点：

- **移动/重命名目录是一条事务内的 SQL**，和目录大小无关，不碰 Telegram。
- **复制不复制数据**，只增加引用计数。
- **删除**减引用计数，减到 0 时分片入 GC 队列；GC 工作线程限速调用 `deleteMessage`（消息不存在视为已删除；失败则记录错误并重试）。
- 覆盖写同键 = 新 blob 替换旧 blob。

### 6.6 配额

- 每个存储桶可设 `quota_bytes`；`used_bytes` 与对象变更在同一事务里维护。
- 上传开始时按 `Content-Length`（或分段上传创建时的声明）预检；定稿时在事务里再检查一次，超额则回滚并让分片进 GC。
- 复制的对象各自计入逻辑大小（简单，对用户直观）；实际 Telegram 占用可能更小。

### 6.7 小文件吞吐（已知限制）

**每个对象至少占一条 Telegram 消息**，而每个聊天约 1 条/秒的限流（⚠️ A4 未验证）直接决定小文件的上传速度：

| 条件 | 估算 |
|---|---|
| 吞吐上限 | 约 `Bot 数 × (1 / 最小间隔)` 个对象/秒；例如 2 个 Bot 约 2 个对象/秒 |
| 上传 1000 个小文件 | 约 8 分钟（2 个 Bot） |

对策：

1. 多个 Bot，各自独立的频道和限速；
2. 用户端对批量上传显示预计耗时；建议把大量小文件先打包（zip）再上传；
3. 缩略图不占消息（放 `thumbs.db`）；
4. **长期方案（待决，第 17 章）：** 把多个小 blob 打包进同一个 Telegram 文件，`chunks` 增加 `pack_offset`/`pack_length`，让"一个分片"可以是消息内的一段字节区间；代价是 GC 需要压缩。数据模型已为此留好余地（读取本来就按字节区间进行）。

### 6.8 完整性检查（scrub）

| 模式 | 做法 | 需要密钥 |
|---|---|---|
| 浅层（默认） | 取整个密文分片，比对大小和 SHA-256 | 不需要 |
| 深层 | 浅层通过后再逐帧解密校验 | 需要 |

调度：每周随机抽查约 5% 的分片，每月全量浅层；有副本的自动修复（M7），没有的在管理端告警。

### 6.9 启动、解锁与锁定

1. 服务启动后处于**锁定**状态：内存里没有 KEK，也没有解密后的 Bot token。
2. 锁定期间：S3 网关返回 `503 ServiceUnavailable`；用户 API 返回 `503 locked`；管理 API 只接受 `status`、`login`、`unlock`。
3. 管理员登录管理端，输入 KEK 口令解锁（Argon2id 约 1 秒）：派生 KEK 并用 `check_blob` 校验 → 解密所有 Bot token → 启动 Bot 池、GC 线程、Range 探测、维护任务。
4. 锁定：丢弃 KEK、子密钥和 Bot token 的引用，停止后台任务，清空含敏感数据的缓存（Python 无法保证擦除内存，已知限制）。
5. 可选 keyfile 模式：从文件读取 KEK，适合无人值守重启，但安全性降一档。
6. 公平性：每个调用方（用户或客户端）同时在途的分片上传数有上限（默认 2），避免一个人占满全局并发。

---

## 7. Telegram 后端适配（M2）

**范围说明：** 只使用云端 Bot API。Bot 由管理员在管理端添加，token 加密后存数据库（5.2 节）。

### 7.1 API 调用

| 操作 | 调用 | 要点 |
|---|---|---|
| `put` | `sendDocument`（multipart） | `chat_id` = 频道；`document` 文件名用随机的 `<随机>.bin`；`disable_notification=true`；**默认不写 caption**；从响应取 `message_id`、`document.file_id`、`document.file_unique_id`，拼成 `blob_ref` |
| `get` | `getFile` 得到 `file_path`，再 `GET https://api.telegram.org/file/bot<TOKEN>/<file_path>`，带 `Range` 头 | `file_path` 缓存 50 分钟；只接受 `206` 且 `Content-Range` 合法 |
| `delete` | `deleteMessage(chat_id, message_id)` | 消息不存在视为已删除 |

**连接与超时：** 使用 httpx 长连接池（开启 keep-alive）。HTTP/2 是否被支持⚠️ 待验证，默认 HTTP/1.1。上传超时按大小估算（例如 `max(60 s, 大小 ÷ 256 KiB/s)`），读取超时约 60 秒，连接超时约 10 秒。

### 7.2 错误分类

| 现象 | 含义 | 处理 |
|---|---|---|
| HTTP 429 | 触发限流，带 `retry_after` | 该 Bot 暂停 `retry_after` 加抖动；降低其速率（AIMD），恢复要慢 |
| 5xx、超时、连接重置 | 临时故障，`put` 的结果可能不确定 | 指数退避重试；`put` 重试可能产生孤儿分片（6.2 节） |
| 400（文件过大、`wrong file_id` 等） | 请求本身有问题 | 不重试，报错；`wrong file_id` 通常表示用错了 Bot |
| 401 | token 被撤销或填错 | 该 Bot 置为 disabled 并告警 |
| 403 | Bot 被移出频道或被封 | 该 Bot 置为 disabled 并告警 |
| 下载地址 404 | `file_path` 过期 | 刷新一次 `getFile` 再试，仍失败才报错 |
| 响应 200（请求了 Range 但没得到 206） | Range 失效 | 触发降级判定（7.5 节） |

### 7.3 Bot 池与调度

**Bot 状态：** `id`、解密后的 token（仅内存）、数据频道、限速器、健康度（ok / degraded / disabled）、连续失败次数、冷却截止时间、在途请求数；管理状态 `state`：

| `state` | 含义 |
|---|---|
| `enabled` | 正常：参与新上传，也服务读取 |
| `draining` | 不再接收新上传，但继续服务读取（用于下线 Bot 前的过渡） |
| `disabled` | 完全不使用（读取也不用；引用它的分片暂时不可读） |

| 机制 | 规则 |
|---|---|
| 选择 | 只在 `enabled` 且健康、不在冷却中的 Bot 里选；选（在途请求数，近期发送字节数）最小的；同一分片的多个副本必须选不同的 Bot |
| 读取 | **必须用 `blob_ref` 里记录的那个 Bot**（`file_id` 绑定 Bot），除非走迁移流程；`draining` 的 Bot 仍可读 |
| 限速 | 每个（Bot，聊天）一个令牌桶，默认最小间隔 1 秒，可在管理端调整；收到 429 后自适应降速 |
| 熔断 | 连续 5 次 5xx 或超时 → 冷却 60 秒，再次失败指数延长；401/403 直接标为 `disabled` 并告警 |
| 全局并发 | `upload_concurrency`（默认 4），内存上限约为 并发 × 约 32 MiB ≈ 128 MiB |
| 每调用方上限 | 同一用户或客户端同时在途的分片数默认 ≤ 2 |

**增加 Bot 的校验（管理端）：** `getMe` 验证 token → `getChat` 验证频道 → `getChatMember` 验证 Bot 是管理员并有发消息和删除权限 → 向频道发一个极小的测试文件再删除。全部通过才保存。

**删除 Bot：** 只允许删除没有被任何分片引用的 Bot；否则先设为 `draining`，等待迁移或数据被删除（迁移依赖 A7，未验证）。

### 7.4 `file_path` 缓存与预取

`cache[blob_ref] = (file_path, 获取时间)`，TTL 50 分钟（低于官方保证的 1 小时）。`getFile` 调用用 single-flight 合并。顺序读取时，当读到当前分片后 25% 的位置，后台提前对下一个分片调用 `getFile`；因为 `getFile` 本身可能就要 3–4 秒（2.4 节），这样分片交界处不会卡住。

### 7.5 Range 能力探测与降级

- **探测：** 服务启动时以及每 6 小时，对最近上传的一个小分片请求 `bytes=0-15` 和 `bytes=-16`，期望得到 `206` 且 `Content-Range` 正确。
- **判定：** 连续失败 2 次 → 进入**降级模式**：读取改为流式下载整个分片，边到达边校验帧，前面不需要的帧只丢弃不解密；第一帧到达即可开始输出。
- **恢复：** 降级期间仍然定期探测，恢复后自动切回。
- **暴露：** 当前模式和降级次数写入指标和诊断页。

### 7.6 冗余副本与 Bot 迁移（M7）

- **冗余：** 关键文件的每个分片上传两份，分别由不同 Bot 发到不同频道；副本记录在 `chunk_replicas` 表。主副本不可读时自动读副本，并在后台补齐缺失的副本。
- **Bot 迁移：** ⚠️ 假设 A7 成立：Bot B 对 Bot A 上传的消息调用 `forwardMessage`（需要 B 能访问源频道），返回的 `Message` 里带有 B 自己的 `file_id`，据此更新 `blob_ref` 里的 `bot` 与 `fid`，再删除转发出来的临时消息。验证前不作为依赖。


---

## 8. 对外接口

### 8.1 三个入口

| 入口 | 地址 | 鉴权 | 使用者 |
|---|---|---|---|
| **S3 网关** | `https://s3.example.com`（独立域名或端口，路径风格） | 客户端 Access Key + SigV4 | rclone、aws-cli、boto3 等外部客户端 |
| **用户 API** | `https://drive.example.com/api/user/v1` | 会话 Cookie（用户登录） | 用户端 UI |
| **管理 API** | `https://drive.example.com/api/admin/v1` | 会话 Cookie（管理员登录） | 管理端 UI |

三者都是薄适配层，调用同一个对象服务（3.1 节）。

### 8.2 S3 网关

**寻址：** 路径风格 `https://s3.example.com/<bucket>/<key>`；region 是配置项（默认 `us-east-1`，客户端必须使用同一个值）；**不支持虚拟主机风格**。客户端配置时要打开"强制路径风格"（rclone 的 `force_path_style`、aws-cli 的 `addressing_style = path`）。

**支持的操作（够 rclone、aws-cli、boto3 日常使用的子集）：**

| 操作 | 说明 |
|---|---|
| `ListBuckets`（`GET /`） | 只返回该客户端有授权的桶 |
| `HeadBucket`、`GetBucketLocation` | 客户端常用的探测 |
| `ListObjectsV2`（兼容 `ListObjects` v1） | `prefix`、`delimiter`、`max-keys`、`continuation-token`、`start-after` |
| `PutObject` | 流式写入；`Content-MD5`、校验和头；`x-amz-meta-*`；`Content-Type` |
| `GetObject` / `HeadObject` | `Range`（单区间）；`If-Match`、`If-None-Match`、`If-Modified-Since`、`If-Unmodified-Since` |
| `DeleteObject` / `DeleteObjects` | 批量删除用 `POST /<bucket>?delete` |
| `CopyObject` | 同桶或跨桶（需对源有读权限、对目标有写权限）；只增加引用计数，不复制数据 |
| `CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`、`AbortMultipartUpload`、`ListParts` | 见 6.2 节；`ListMultipartUploads` 作为可选项 |
| 预签名 URL（GET/PUT，`X-Amz-Expires` ≤ 7 天） | 外部客户端用 `aws s3 presign` 等生成的链接 |

**不支持（返回 `501 NotImplemented`）：** 创建和删除存储桶（只能在管理端做）、版本控制、ACL 和桶策略 API、生命周期、标签、SSE-C/KMS、对象锁、`UploadPartCopy`、POST 表单上传、S3 Select、虚拟主机风格寻址。

**载荷与校验：**

| `x-amz-content-sha256` 取值 | 处理 |
|---|---|
| 十六进制 SHA-256 | 流式计算，结束时比对；不符则中止并返回 `XAmzContentSHA256Mismatch` |
| `UNSIGNED-PAYLOAD` | 只在 HTTPS 下接受（由反向代理传递 `X-Forwarded-Proto`）；不校验载荷 |
| `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` | 解码 `aws-chunked`，逐块验证签名链 |
| `STREAMING-UNSIGNED-PAYLOAD-TRAILER` | 解码 `aws-chunked`，读取尾部校验和并验证 |
| `STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER` | 同上，并验证签名链 |

- 另外验证 `Content-MD5`、`x-amz-checksum-sha256`、`x-amz-checksum-crc32`；其他算法（如 CRC32C、CRC64NVME）收到后**记录但不验证**，这是已知的兼容性折中。
- 处理 `Expect: 100-continue`。
- ⚠️ 据我所知，2025 年初起 aws-cli、boto3 等官方 SDK 默认在上传时附带 CRC32 校验和（`aws-chunked` 加尾部），不少第三方 S3 兼容服务因此出现过失败。网关要支持解码尾部；客户端侧的退路是把 `request_checksum_calculation` 设为 `when_required`（环境变量 `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`）。

**错误响应（S3 风格 XML）：**

| 场景 | HTTP | S3 错误码 |
|---|---|---|
| 签名不匹配 | 403 | `SignatureDoesNotMatch` |
| Access Key 不存在或已禁用 | 403 | `InvalidAccessKeyId` |
| 请求时间与服务器相差超过 15 分钟 | 403 | `RequestTimeTooSkewed` |
| 无权限 | 403 | `AccessDenied` |
| 存储桶不存在或客户端无任何授权 | 404 | `NoSuchBucket` |
| 键不存在 | 404 | `NoSuchKey` |
| 分段上传不存在 | 404 | `NoSuchUpload` |
| part 小于 5 MiB（非最后一个） | 400 | `EntityTooSmall` |
| part 编号或 ETag 不符 | 400 | `InvalidPart` / `InvalidPartOrder` |
| Range 越界 | 416 | `InvalidRange` |
| MD5 或校验和不符 | 400 | `BadDigest` / `InvalidDigest` |
| 请求体长度不符 | 400 | `IncompleteBody` |
| 配额超出 | 403 | `QuotaExceeded`（自定义） |
| 服务锁定或后端不可用 | 503 | `ServiceUnavailable` |
| 排队过久（Telegram 限流） | 503 | `SlowDown` |
| 内部错误、完整性校验失败 | 500 | `InternalError` |
| 不支持的操作 | 501 | `NotImplemented` |

**兼容性测试矩阵（⚠️ 适用性待实测）：** aws-cli v2、boto3、rclone（`provider = Other`）、MinIO `mc`。restic 的 S3 后端会产生大量小对象，受 6.7 节限制，不推荐。

### 8.3 客户端鉴权与授权

**客户端与密钥：** 管理员在管理端创建"客户端"，每个客户端有 1–2 个密钥（Access Key ID 以 `TGD` 开头，共 20 位；Secret 为 40 位随机字符）。**Secret 只在创建时显示一次。** 第二个密钥用于平滑轮换：先加新密钥、客户端切换、再禁用旧密钥。

**为什么 secret 要可逆存储：** SigV4 验签需要用 secret 计算 HMAC，服务端必须能还原明文，所以不能像口令那样只存哈希。它被 KEK 子密钥加密保存（5.2 节），服务锁定时无法验签，这与"锁定即不可用"的模型一致。

**SigV4 验签要点：**

| 项目 | 规则 |
|---|---|
| 形式 | `Authorization: AWS4-HMAC-SHA256 Credential=<AK>/<日期>/<region>/s3/aws4_request, SignedHeaders=…, Signature=…`；或预签名的 `X-Amz-Algorithm`、`X-Amz-Credential`、`X-Amz-Date`、`X-Amz-Expires`、`X-Amz-SignedHeaders`、`X-Amz-Signature` 查询参数 |
| 规范请求 | URI 只编码一次且**不做路径归一化**；查询参数排序；头部名小写、值去首尾空白；**必须签名 `host`**；S3 要求带 `x-amz-content-sha256` |
| 签名密钥 | `HMAC` 链：`"AWS4"+secret → 日期 → region → "s3" → "aws4_request"` |
| 时间 | 与服务器相差超过 15 分钟拒绝 |
| 比较 | 常量时间比较签名 |
| 反向代理 | Caddy 必须原样传递 `Host`（默认如此）；Host 带非默认端口时规范请求也要带端口 |
| 测试 | 用公开的 SigV4 测试向量（如仍可获得）和真实客户端互操作测试验证 |

**授权模型：** 客户端的授权是若干条 `client_grants`：（存储桶，前缀，`ro` 或 `rw`）。

| 操作 | 需要的权限 |
|---|---|
| `ListObjects`、`GetObject`、`HeadObject`、`ListParts` | `ro` 或 `rw`，且目标键落在授权前缀内；列表的 `prefix` 参数必须在授权前缀内（或被它包含） |
| `PutObject`、分段上传相关、`DeleteObject(s)`、`CopyObject` 的目标 | `rw`，且键落在授权前缀内 |
| `CopyObject` 的源 | 对源至少 `ro` |

没有任何匹配授权就拒绝；`ListBuckets` 只列出有授权的桶。

**防护与审计：** 对同一来源 IP 的连续鉴权失败做指数退避；失败、客户端创建/禁用、密钥增删等都写入审计日志；`last_used_at` 异步批量更新，不拖慢请求。

### 8.4 S3 请求到对象服务的映射

| S3 概念 | 对象服务 |
|---|---|
| 键 | 原样 UTF-8 字节，长度 ≤ 1024；键中的 `..`、空段等都只是普通字符串，不会触碰文件系统（分片没有本地路径） |
| 目录 | 键前缀；`PutObject` 一个以 `/` 结尾的零字节键就是创建目录标记 |
| `ETag` | 单次上传为明文 MD5（带引号）；分段上传为 `"md5-N"` |
| `Last-Modified` | `objects.modified_at` |
| `Content-Type` | 未提供时用 `binary/octet-stream` |
| `x-amz-meta-*` | 存入 `user_meta`，读取时原样返回 |
| `CopyObject` 的元数据 | 默认复制源的元数据；`x-amz-metadata-directive: REPLACE` 时使用请求里的 |
| `Range` | 单区间；多区间请求按 RFC 允许的方式忽略 `Range` 返回完整内容 |

### 8.5 管理 API（`/api/admin/v1`，除特别说明外要求管理员会话）

| 方法与路径 | 说明 | 里程碑 |
|---|---|---|
| `GET /status` | 是否已初始化、是否锁定、版本（无需登录） | M5 |
| `POST /setup` | 首次设置：KEK 口令 + 管理员账号（仅未初始化时可用） | M5 |
| `POST /login` / `POST /logout` | 管理员登录/登出 | M5 |
| `POST /unlock` / `POST /lock` | 用 KEK 口令解锁/锁定 | M5 |
| `GET /overview` | 仪表盘数据：用量、对象数、Bot 健康、最近错误、最近快照、GC 队列长度 | M5 |
| `GET /users`、`POST /users`、`PATCH /users/{id}`、`DELETE /users/{id}` | 用户管理：创建（同时创建个人桶）、重置口令、禁用、配额；删除时必须明确选择如何处理数据 | M5 |
| `GET /buckets`、`POST /buckets`、`PATCH /buckets/{id}`、`DELETE /buckets/{id}` | 共享桶的创建、配额调整；只能删除空桶 | M5 |
| `GET /clients`、`POST /clients`、`PATCH /clients/{id}`、`DELETE /clients/{id}` | 客户端管理；创建时返回首个密钥（仅此一次） | M4/M5 |
| `PUT /clients/{id}/grants` | 整体替换授权列表 | M4/M5 |
| `POST /clients/{id}/keys`、`PATCH /clients/{id}/keys/{akid}`、`DELETE /clients/{id}/keys/{akid}` | 增加（仅此一次显示 secret）、启用/禁用、删除密钥 | M4/M5 |
| `GET /endpoint-info` | S3 端点、region、路径风格、rclone 与 aws-cli 配置示例 | M5 |
| `GET /bots`、`POST /bots`、`PATCH /bots/{id}`、`DELETE /bots/{id}` | Bot 管理：添加时执行 7.3 节的校验；token 只写不回显 | M5 |
| `POST /bots/{id}/test` | 重新检查连通性与权限 | M5 |
| `GET /keys` | KEK 版本、KDF 参数、上次轮换时间 | M5 |
| `POST /keys/rotate` | 修改加密密钥（5.8 节），需要旧口令与新口令 | M5 |
| `GET /recovery-kit` | 生成恢复包（需再次输入 KEK 口令确认） | M7 |
| `POST /maintenance/scrub`、`GET /maintenance/scrub` | 触发完整性检查、查看结果 | M7 |
| `POST /maintenance/snapshot`、`GET /snapshots` | 立即快照、快照列表 | M7 |
| `GET /maintenance/gc`、`POST /maintenance/cache/clear` | GC 队列状态、清缓存 | M7 |
| `GET /diagnostics`、`POST /diagnostics/run` | 诊断结果、立即运行 | M5 |
| `GET /audit` | 审计日志，支持按操作者、动作、时间过滤 | M5 |
| `GET /settings`、`PATCH /settings` | 系统设置（12.4 节） | M5 |

**写操作都要求**：会话有效、携带 CSRF 请求头；高风险操作（轮换密钥、删除用户、生成恢复包）要求**再次输入口令**确认。

### 8.6 用户 API（`/api/user/v1`，用户会话）

**服务端始终从会话解析出用户的存储桶，不接受客户端传入的桶名。** 所有路径参数都是相对于该桶根目录的路径（用查询参数传递，因为路径含 `/`）。

| 方法与路径 | 说明 | 里程碑 |
|---|---|---|
| `POST /login`、`POST /logout`、`GET /me` | 登录；`me` 返回用户名、配额、已用空间 | M6 |
| `POST /me/password` | 修改自己的口令（需要旧口令） | M6 |
| `GET /list?prefix=&cursor=&limit=` | 列目录：返回子目录、文件、下一页游标 | M6 |
| `POST /folders` | 新建文件夹（写入目录标记对象） | M6 |
| `POST /move` | 移动/重命名文件或目录：`{from, to, conflict: skip\|overwrite\|rename}` | M6 |
| `POST /copy` | 复制文件或目录（只增加引用计数） | M6 |
| `POST /delete` | 删除：`{paths: […]}`，目录自动递归（M8 起进回收站） | M6 |
| `GET /search?q=&prefix=` | 按名称搜索 | M6 |
| `PUT /files?path=` | 小文件单次上传（请求体即文件内容） | M6 |
| `POST /uploads` | 创建大文件上传：`{path, size, content_type, conflict}` → `{upload_id, part_size, part_count}` | M6 |
| `GET /uploads/{id}` | 返回已完成的 part，用于续传 | M6 |
| `PUT /uploads/{id}/parts/{n}` | 上传一个 part（幂等；同一 `n` 重传会替换） | M6 |
| `POST /uploads/{id}/complete`、`DELETE /uploads/{id}` | 完成/取消 | M6 |
| `GET / HEAD /content?path=&download=0\|1` | 下载或预览（Range、ETag） | M6 |
| `GET /thumbnail?path=` | 缩略图 | M8 |
| `GET /trash`、`POST /trash/restore`、`DELETE /trash` | 回收站 | M8 |
| `GET /shares`、`POST /shares`、`DELETE /shares/{token}` | 分享链接（公开访问路径为 `/s/{token}`） | M8 |
| `GET /access-keys`、`POST /access-keys`、`DELETE /access-keys/{id}` | 用户自助创建仅限自己存储桶的 S3 访问密钥 | M8 |

**路径规则：** UTF-8 且长度 ≤ 1024 字节；不允许空段、`.`、`..` 和控制字符；统一做 Unicode NFC 归一化（避免 macOS 的 NFD 文件名与其他系统的重名问题）；保留前缀 `.tgdrive/` 不允许直接写入。

**上传编排：** 浏览器先 `POST /uploads` 拿到 `upload_id` 和 `part_size`（默认 16 MiB），并发 2–3 个 `PUT parts/{n}`；刷新页面后先 `GET /uploads/{id}` 看已完成的 part，再补传缺失的。part 在服务端走和 S3 网关同一条上传路径（6.2 节）。

**下载与预览：**

- 支持单区间 `Range`：`206` 带 `Content-Range`，越界 `416`，无 `Range` 返回 `200`；支持 `If-Range`、`ETag`。
- 响应头：`Accept-Ranges: bytes`、`Content-Type`、`Content-Disposition`（文件名用 `filename*=UTF-8''…`）、`Cache-Control: private`、`X-Content-Type-Options: nosniff`。
- 可预览的类型（11.4 节的白名单）用 `inline`，其余一律 `attachment`；HTML、SVG 一律 `attachment`；预览响应带 `Content-Security-Policy: sandbox`。
- 响应流式发送，数据来自 `ObjectService.get_object`，不在内存里缓冲整个文件。
- **不使用预签名 URL 的原因：** 预签名有过期时间，播放长视频时中途拖动会因链接过期而失败；会话 Cookie 没有这个问题。

### 8.7 管理与用户 API 的错误模型

统一格式 `{"error": {"code": "snake_case", "message": "…"}}`。

| HTTP | `code` | 对应场景 |
|---|---|---|
| 400 | `bad_request`、`invalid_path` | 参数或路径不合法 |
| 401 | `unauthorized`、`wrong_passphrase`、`wrong_password` | 未登录、口令错误 |
| 403 | `forbidden`、`quota_exceeded` | 角色不够、配额超出 |
| 404 | `not_found` | 对象、用户、客户端等不存在 |
| 409 | `conflict`、`not_ready` | 目标已存在且策略为失败；上传未完成 |
| 416 | `range_not_satisfiable` | Range 越界 |
| 423 | `maintenance` | 维护模式（密钥轮换中），暂停写入 |
| 429 | `too_many_attempts` | 登录失败过多 |
| 500 | `integrity_error` | 密文校验失败，数据可能被篡改或损坏 |
| 502 | `storage_missing`、`storage_unavailable` | 分片缺失、Telegram 不可用 |
| 503 | `locked` | 服务尚未解锁 |

---

## 9. 可靠性与灾难恢复

### 9.1 故障场景

| 场景 | 影响 | 对策 |
|---|---|---|
| 进程崩溃 | 上传停在某个 part | 分段上传可用 `ListParts` 续传；数据库事务保证进度不丢；超时的未完成上传自动清理 |
| 数据库损坏或丢失 | **所有分片的位置、被包裹的 DEK、用户和客户端信息丢失，数据无法定位** | WAL + 定期本地备份 + 加密快照上传并置顶 + 离线恢复包（9.2–9.5 节） |
| Bot 被封或 token 被撤销 | 该 Bot 上传的分片暂时无法读取 | 多 Bot；关键数据双副本；⚠️ Bot 迁移（7.6 节，A7 未验证） |
| 频道被删除或 Bot 被移出 | 该频道的分片全部不可读 | 副本放在不同频道；快照放在独立的备份频道 |
| Telegram 删除内容 | 部分分片丢失 | scrub 发现；有副本则自动修复 |
| 忘记 KEK 口令 | **数据永久不可恢复**（设计如此） | 密码管理器；离线恢复包；管理端的强提示 |
| 忘记管理员或用户登录口令 | 无法登录管理端或用户端 | 用户口令可由管理员重置；管理员口令可用命令行工具重置（需要服务器访问权限）；不影响 KEK |
| 服务器丢失 | 缓存丢失，服务停止 | 用快照与恢复包在新机器上重建 |

### 9.2 数据库保护

- SQLite 使用 WAL；元数据写入量很小，建议 `PRAGMA synchronous=FULL`。
- 在线备份用 SQLite 的 backup 接口或 `VACUUM INTO`（不用停服务）。
- 本地保留最近 7 份每日备份和 4 份每周备份，并建议再复制到另一台机器或存储。

### 9.3 加密快照与恢复锚点

**问题：** 解密快照需要先派生 KEK，而 KDF 参数在数据库里，所以快照头部必须带一份（不保密的）KDF 信息。

**快照格式：**

```
头部（明文）：魔数 "TGDS" ‖ 格式版本 ‖ kdf_salt ‖ kdf_params(JSON) ‖ 快照 salt
正文：整库副本（不含缩略图缓存）→ zlib 压缩 → 切成 ≤ 16 MiB 的分片
      → 每片用 KEK 的 "backup" 子密钥与快照 salt 派生的密钥，按第 5 章同样的分帧方式加密
```

**流程：**

1. 用 `VACUUM INTO` 生成一致的库副本，压缩、加密、分片，通过 Bot 上传到**专用的备份频道**（与数据频道分开）。
2. 上传一条小的**清单消息**（加密）：各分片的 `blob_ref`、快照大小、哈希、创建时间。
3. **置顶清单消息**（Bot 需要"置顶消息"权限），取消置顶旧的，删除超出保留数量（默认 3 份）的旧快照。
4. 恢复时用 `getChat(备份频道)` 读取置顶消息。⚠️ A6：频道的 `pinned_message` 能否被 Bot 可靠读取需要实测；不成立时改用"恢复包里记录清单消息位置"的办法。

**触发时机：** 有变更时每 10 分钟一次；上传完成后延迟约 60 秒（防抖）；KEK 轮换后立即。

**KEK 轮换的影响：** 轮换前的快照只能用旧口令解开。轮换完成后立即做新快照，并在恢复包里注明口令版本。

### 9.4 恢复流程（SOP）

1. 准备：**KEK 口令**、恢复包里的**备份 Bot token**、备份频道 ID。
2. 用备份 Bot 通过置顶消息找到最新的快照清单，下载、解密、校验哈希。**必须用备份 Bot 本人下载**：分片的 `file_id` 绑定上传它的 Bot，换成新 Bot 需要走迁移流程（A7，未验证）。
3. 用快照替换 `meta.db`，启动服务，用口令解锁。数据库里所有 Bot 的 token 是用 KEK 子密钥加密的，解锁后全部恢复，不需要逐个重新录入。
4. 运行一次深层 scrub，确认分片可读；检查各 Bot 状态。
5. 管理员账号、用户、客户端、存储桶都来自快照，不需要重建。

**恢复点目标（RPO）：** 最近一次快照之后新上传的文件，其分片位置不在快照里，无法定位，成为孤儿。所以快照要频繁，并配合本地备份。

### 9.5 离线恢复包

**恢复包含有 Bot token，要按密码级别保管**（密码管理器或离线保险箱）。内容：

- 数据频道 ID、备份频道 ID；
- **备份 Bot 的 token**（只需要这一个，其余 Bot 的 token 在快照里）；
- 快照清单消息的定位方式（置顶）；
- 格式版本与 KDF 参数的说明（实际参数在快照头部）；
- **不含 KEK 口令本身。**

### 9.6 冗余级别

| 级别 | 做法 | 适用 |
|---|---|---|
| 0 | 单副本 | 可再生的数据 |
| 1 | 每个分片两份，不同 Bot、不同频道 | 重要数据（可按存储桶设置，M7） |

---

## 10. 安全设计

| 主题 | 措施 |
|---|---|
| **多用户隔离** | ① 用户 API 从会话解析出用户的桶，**不接受客户端传入桶名**；② 对象服务每个方法都强制校验 `Scope(bucket_id, prefix, perms)`；③ S3 网关的 `ListBuckets` 只列出有授权的桶；④ 必须有专门的越权测试（13.3 节） |
| **登录与会话** | 用户和管理员口令是 Argon2id 哈希；会话 Cookie `HttpOnly`、`Secure`、`SameSite=Strict`；会话令牌随机 256 位，只放内存，服务重启即失效；登录失败对（用户名 + IP）做指数退避和临时锁定，并写审计；口令最短 12 位，UI 给强度提示 |
| **CSRF / CORS** | `SameSite=Strict` + 修改类请求必须带自定义请求头；默认拒绝跨域 |
| **管理端暴露面** | 建议只对内网或 VPN 开放 `/admin` 和 `/api/admin`，或在 Caddy 里加 IP 允许列表、额外的 Basic Auth 或 mTLS；高风险操作要求再次输入口令 |
| **秘密存储** | Bot token 和客户端 secret 用 KEK 子密钥加密后存库；服务锁定时无法解出；Secret 只在创建时显示一次；Bot token 只写不回显 |
| **日志脱敏** | Telegram 文件下载 URL 里含 token，所有日志、异常信息、诊断页一律脱敏；关闭 httpx 的 URL 日志或加过滤器 |
| **用户文件与预览** | 同源提供用户文件有脚本注入风险：HTML、SVG 一律附件下载；所有文件响应带 `nosniff`；预览响应带 `Content-Security-Policy: sandbox`；SVG 只用 `<img>` 加载；Markdown、Office 渲染结果用 DOMPurify 清洗；pdf.js 关闭脚本执行 |
| **S3 网关** | 请求头与请求体大小上限、读写超时（防慢速攻击）、每来源 IP 的鉴权失败退避、单对象最大尺寸（`max_object_size`）与 part 数量上限（10,000） |
| **审计日志** | 记录：登录成功/失败、解锁/锁定、客户端与密钥的增删改、授权变更、Bot 的增删改、用户的增删改、KEK 轮换、恢复包生成、快照与 scrub 触发、管理员的高风险操作；默认保留 1 年 |
| **Telegram 侧信息** | 发送时用随机文件名；默认不写 caption，避免 Telegram 把同一文件的分片关联起来；Telegram 仍能通过发送时间和顺序做推断，这是无法消除的元信息泄露 |
| **Bot 权限最小化** | 数据频道：发消息、删除消息；备份频道：另加置顶消息 |
| **容器** | 非 root 运行；根文件系统只读（数据和临时目录除外）；镜像定期更新；依赖锁定版本 |
| **Bot token 泄露应急** | 一旦出现在聊天、日志、截图里就视为已泄露：立刻在 @BotFather 用 `/revoke` 撤销换新，在管理端更新 token（或删除重加该 Bot），并检查审计日志 |

---

## 11. UI / UX 设计

### 11.1 总览

- **一个前端工程，两套界面**：`/` 是用户端，`/admin` 是管理端（只有管理员角色能进入）。共享组件库、预览模块、上传模块。
- 风格：简洁；桌面优先，手机可用；深色和浅色；中文为主。
- **登录页是同一个**：管理员登录后在顶栏看到"管理控制台"入口；管理员同样有自己的个人存储桶，可以使用用户端。
- **系统锁定时**：用户端和 S3 客户端不可用，页面显示"系统维护中（已锁定），请联系管理员"；管理员登录后在管理端解锁。

### 11.2 用户端 UI

```
┌────────────┬──────────────────────────────────────────────────┐
│ 我的文件    │ 🔍 搜索…                [上传 ▾] [新建文件夹]      │
│ 最近        ├──────────────────────────────────────────────────┤
│ 传输 (2)    │ 我的文件 / 文档 / 2026                             │
│ 回收站      │ ☐ 名称                 大小      修改时间           │
│ ────────── │ ☐ 📁 合同               —        昨天              │
│ 设置        │ ☐ 📄 报告.pdf           3.2 MB   9月28日           │
│            │ ☐ 🎞 旅行.mp4           1.4 GB   9月20日           │
│ 已用 12 GB  │                                                    │
│ ▓▓▓░░ / 50  │                                                    │
└────────────┴──────────────────────────────────────────────────┘
```

| 区域 | 内容 |
|---|---|
| **文件浏览（首期必须有目录）** | 列表和网格两种视图；面包屑导航；多选；按名称、大小、时间排序；右键菜单；点击文件夹进入，点击文件打开预览 |
| **目录操作** | 新建文件夹、重命名、**移动**（对话框里选择目标文件夹，也支持拖拽）、复制、删除（目录自动递归，删除前确认）；移动和重命名目录是纯元数据操作，瞬间完成 |
| **上传** | 选择文件或**整个文件夹**（保留相对路径）；拖拽到页面任意位置；重名时弹出"覆盖 / 跳过 / 自动改名"，并可对本次批量上传统一选择 |
| **传输面板** | 见下 |
| **搜索** | 按名称搜索（默认在当前目录及其子目录） |
| **容量** | 侧栏显示已用空间和配额 |
| 回收站（M8） | 删除先进入回收站（保留期可配置），支持恢复和彻底删除 |
| 分享（M8） | 为文件生成链接：可设过期时间、访问口令、下载次数上限，可随时撤销 |
| 设置 | 修改口令；个人 S3 访问密钥（M8）；界面偏好 |

**传输面板（最关键的界面）：**

- 每个任务显示进度条、速度、剩余时间，以及暂停、继续、重试、取消按钮。
- 用**分片格子图**表示大文件的进度：每个 part 一个小方块，状态为待传、上传中、完成、失败，一眼看出卡在哪。
- 刷新页面或断网后自动恢复：状态以服务端的 `GET /uploads/{id}` 为准。
- 失败任务显示具体原因（如排队等待、配额超出、源文件已变化）。
- **批量上传小文件时显示预计耗时**，并说明小文件受 Telegram 速率限制，建议先打包（6.7 节）。
- **浏览器的限制：** 页面刷新后浏览器不能再读取本地文件，需要用户重新选择同一个文件才能续传；使用 File System Access API 的浏览器（Chromium 系）可以保存文件句柄，实现无感续传。

### 11.3 管理端 UI

| 页面 | 内容与交互 |
|---|---|
| **首次设置向导** | ① 设置 KEK 口令（强度提示，并明确警告"忘记即无法恢复数据"）→ ② 创建管理员账号 → ③ 添加第一个 Bot 和数据频道（逐项校验并显示结果）→ ④ 添加备份频道（可与上一步使用同一 Bot）→ ⑤ **下载并确认保存恢复包** → ⑥ 创建第一个用户（可选） |
| **解锁页** | 服务重启后进入：输入 KEK 口令；显示解锁进度（Argon2id、启动 Bot 池） |
| **仪表盘** | 锁定状态；总用量和按用户的用量；对象数、分片数；近 24 小时上传/下载量；Bot 健康；最近错误；最近一次快照与 scrub 的时间和结果；GC 队列长度 |
| **Telegram Bot** | 列表：状态（启用/下线中/停用）、健康度、最近错误、429 次数、已上传分片数；**添加**：粘贴 token（只写，保存后不再显示）、选择数据频道和备份频道、点"检查"逐项校验（`getMe`、频道、管理员权限、测试收发）；编辑：标签、最小发送间隔；**下线**：先设为"下线中"（不再接收新上传，仍可读取）；删除仅限未被引用的 Bot |
| **客户端** | 列表：名称、授权摘要、密钥数、最近使用时间和来源 IP、状态。**创建**：名称、描述、**授权编辑器**（存储桶 + 前缀 + 只读/读写，可多条）→ 创建后**一次性显示** Access Key 和 Secret，附带复制按钮和 rclone / aws-cli 配置示例。**管理**：新增第二个密钥以便轮换、禁用/启用/删除密钥、修改授权、禁用或删除客户端；页面顶部固定显示 S3 端点、region 和"路径风格"提示 |
| **用户与存储桶** | 用户：创建（同时创建个人桶）、重置口令、禁用、设置配额、删除（必须明确选择数据如何处理）；存储桶：列表（拥有者、配额、已用）、创建共享桶、调整配额 |
| **加密与备份** | KEK 信息（版本、KDF 参数、上次轮换时间）；**修改加密密钥**：输入旧口令和新口令 → 进入维护模式 → 显示进度（重新包裹 DEK、Bot token、客户端 secret）→ 完成后要求用新口令重新解锁，并自动触发新快照；快照：状态、立即快照、保留份数、备份频道、本地备份列表；**恢复包**：再次输入口令后生成，并提示按密码级别保管；恢复流程说明 |
| **维护** | scrub 计划与结果（可手动触发浅层/深层）；GC 队列；未完成的上传会话；缓存大小与清理 |
| **诊断** | 系统自动收集的平台行为数据：Range 是否可用及当前模式、`getFile` 耗时、吞吐、429 次数；对分片大小等设置给出建议（12.7 节） |
| **审计日志** | 可按操作者、动作、时间、结果过滤；显示来源 IP |
| **系统设置** | 分片大小、帧大小（只对新文件生效）、并发度、每调用方并发上限、上传会话过期时间、会话有效期、预览限制、缓存容量、S3 端点和 region |

**管理端不提供浏览用户文件的功能**；管理员的高风险操作（轮换密钥、删除用户、生成恢复包）都要求再次输入口令并写入审计日志。

### 11.4 文件预览

**预览入口：** 用户端点击文件即打开预览窗口，带上一个/下一个切换、下载、详情；所有预览都通过 `GET /content`（Range）读取。首次打开某个文件会遇到 `getFile` 的等待（2.4 节，约 3–4 秒），界面要有加载状态；浏览器缓存（`ETag`）让重复预览不再访问 Telegram。

| 类别 | 格式 | 实现方式 | 限制与说明 | 阶段 |
|---|---|---|---|---|
| 图片 | JPEG、PNG、GIF、WebP、AVIF、BMP、ICO | `<img>` 直接加载，支持缩放和拖动 | AVIF、WebP 取决于浏览器；大图加载慢，M8 起用缩略图加速列表 | M6 |
| 图片 | SVG | **只用 `<img>` 加载**（不执行脚本），不内联 | — | M6 |
| 图片 | HEIC/HEIF | Safari 原生；其他浏览器提示下载 | 可选：浏览器端 wasm 解码 | M8 |
| 视频 | MP4（H.264）、WebM、MOV（H.264） | `<video>` + Range，可拖动进度条 | MKV、AVI、HEVC 取决于浏览器，**不做转码**；不支持时提示下载 | M6 |
| 音频 | MP3、M4A、AAC、OGG、FLAC、WAV | `<audio>` + Range | — | M6 |
| PDF | PDF | **pdf.js** 渲染，按需通过 Range 加载页面 | 关闭脚本执行 | M6 |
| 文本与代码 | TXT、LOG、JSON、XML、YAML、INI、各类源码 | 只读取前 2 MiB，文本渲染 + highlight.js 语法高亮 | 编码自动检测（UTF-8、GBK）；"加载更多"按钮继续读取 | M6 |
| Markdown | MD | markdown-it 渲染 + DOMPurify 清洗 | 外链图片默认不加载；同桶相对路径图片通过用户 API 解析 | M8 |
| 表格数据 | CSV、TSV | 表格视图，只读前 N 行 | — | M8 |
| Office | DOCX | docx-preview 在浏览器里渲染，结果经 DOMPurify 清洗 | 版式还原有限；超过大小上限只提供下载 | M8 |
| Office | XLSX、XLS | SheetJS 转成只读表格 | 大小上限（如 20 MiB）；只显示前 N 行 | M8 |
| Office | PPTX、DOC、PPT、ODT 等 | 浏览器端没有可靠方案 | 默认仅下载；可选：服务端 LibreOffice 转 PDF（重，需要额外容器，不在本期范围） | 可选 |
| 压缩包 | ZIP | 只列出条目（用 Range 读取文件末尾的中央目录） | 不解压 | M8 |
| 其他 | — | 显示文件信息和下载按钮 | — | M6 |

**预览安全：** 白名单类型才用 `inline`，其余一律 `attachment`；预览响应带 `nosniff` 和 `Content-Security-Policy: sandbox`；所有由文件内容生成的 HTML（Markdown、Office）先经 DOMPurify 清洗；pdf.js 不执行脚本；超过大小上限的文件只提供下载。

**缩略图（M8）：** 图片和视频首帧在浏览器端生成，通过用户 API 存入 `thumbs.db`（可再生的缓存，不占用 Telegram 消息，不进入快照）。S3 客户端上传的文件没有缩略图，用户端首次浏览时对小图（如小于 5 MiB）懒生成。

### 11.5 通用要求

- 空状态、加载中、错误、系统锁定、Range 降级模式都有明确的界面反馈。
- 所有破坏性操作（删除、清空回收站、删除用户、删除 Bot）需要二次确认。
- 键盘可操作；颜色不作为唯一的信息载体；深浅色切换。
- 手机端：侧栏收为抽屉，文件列表改为卡片，传输面板改为底部抽屉。

---

## 12. 工程实践

### 12.1 代码仓库结构

```
tgdrive/
├── pyproject.toml
├── tgdrive/
│   ├── errors.py          # 异常层次
│   ├── crypto.py          # 加密（M1）
│   ├── metadata.py        # SQLite 访问层、迁移（M1，随各里程碑扩展）
│   ├── keystore.py        # 口令与 KEK 轮换（M1，轮换时重新包裹各类秘密）
│   ├── blobstore.py       # BlobStore 接口 + LocalDiskBlobStore（M1）
│   ├── blobengine.py      # Blob 引擎：put_part / finalize / stream / scrub（M1）
│   ├── telegram/          # Bot 客户端、Bot 池、限速、file_path 缓存、Range 探测（M2）
│   ├── objects.py         # 对象服务：桶、对象、分段上传、列表、复制/移动、配额、GC（M3）
│   ├── s3/                # SigV4、aws-chunked、操作处理、XML、授权（M4）
│   ├── adminapi/          # 管理 API（M5）
│   ├── userapi/           # 用户 API（M6）
│   ├── maintenance/       # scrub、快照、GC 线程、诊断（M7）
│   └── config.py          # 配置加载
├── web/                   # 前端：/ 用户端，/admin 管理端
├── tests/
├── deploy/                # Dockerfile、compose、Caddyfile
└── docs/
```

### 12.2 核心接口

```python
class BlobStore(Protocol):
    async def put(self, key: str, data: bytes) -> str: ...
    async def get(self, ref: str, start: int | None = None, end: int | None = None) -> bytes: ...  # [start, end)
    async def delete(self, ref: str) -> None: ...

@dataclass(frozen=True)
class Scope:                                   # 适配层解析出来，对象服务逐方法校验
    bucket_id: int
    prefix: str = ""                           # 只允许访问该前缀下的键
    perms: str = "rw"                          # "ro" | "rw"

class BlobEngine:
    def begin_blob() -> blob_uuid
    async def put_part(blob_uuid, part_no, body: AsyncIterator[bytes]) -> PartResult   # size、md5；同一 part_no 重传会替换旧分片
    def finalize(blob_uuid, part_order: list[int]) -> int                              # 分配 offset、置 complete，在调用方的事务里执行
    async def stream(blob_uuid, start=0, end=None, *, window=1 MiB) -> AsyncIterator[bytes]
    async def scrub(blob_uuid, *, deep=False) -> list[tuple[int, int]]                 # 有问题的 (part_no, sub_idx)

class ObjectService:
    async def put_object(scope, key, body, size, content_type, user_meta, *, expect_md5=None, checksums=None) -> ObjectInfo
    async def get_object(scope, key, start=None, end=None) -> tuple[ObjectInfo, AsyncIterator[bytes]]
    def head_object(scope, key) -> ObjectInfo
    async def delete_objects(scope, keys) -> list[DeleteResult]
    def list_objects(scope, prefix, delimiter, cursor, limit) -> ListPage
    async def copy_object(src: Scope, src_key, dst: Scope, dst_key, *, metadata=None) -> ObjectInfo
    def move_prefix(scope, old, new, conflict) -> int
    async def create_multipart(scope, key, content_type, user_meta) -> upload_id
    async def upload_part(scope, upload_id, part_no, body, size) -> PartInfo
    def list_parts(scope, upload_id) -> list[PartInfo]
    async def complete_multipart(scope, upload_id, parts: list[tuple[int, str]]) -> ObjectInfo
    async def abort_multipart(scope, upload_id)

class KeyStore:
    is_initialized() / initialize(passphrase, *, kdf=None)
    unlock(passphrase) -> kek                  # 口令错误抛 WrongPassphrase
    rotate(old, new, *, kdf=None) -> RotationReport   # 同一事务内重新包裹 DEK、Bot token、客户端 secret
```

### 12.3 并发模型

- 全程 asyncio。SQLite 调用很短；写入通过单写者锁串行化，必要时 `asyncio.to_thread`。
- 超过 1 MiB 的加密和哈希计算放进线程池，避免阻塞事件循环。
- 请求体流式读取，TCP 背压自然传递给慢速客户端；全局信号量（`upload_concurrency`）和每调用方上限共同限制内存占用（6.9 节、7.3 节）。
- **事务里不做网络请求。**

### 12.4 配置

静态配置用 TOML；**Bot、客户端、用户、授权都在数据库里**，由管理端维护。管理端可改的设置存在 `settings` 表，覆盖 TOML 里的同名项。分片大小和帧大小只对新写入的 blob 生效，每个 blob 记录自己的实际值。

```toml
[server]
ui_listen = "0.0.0.0:8000"
s3_listen = "0.0.0.0:9000"
public_ui_url = "https://drive.example.com"
s3_region = "us-east-1"
data_dir = "/data"

[storage]
chunk_size = "16MiB"
frame_size = "64KiB"
read_window = "1MiB"
max_object_size = "1TiB"

[telegram]
api_base = "https://api.telegram.org"
min_interval_per_chat = 1.0          # 秒
file_path_ttl = "50m"
range_probe_interval = "6h"

[upload]
concurrency = 4
per_principal_concurrency = 2
multipart_ttl = "7d"
orphan_blob_ttl = "24h"

[cache]
dir = "/data/cache"
max_size = "20GiB"

[auth]
session_ttl = "12h"
login_max_failures = 5

[crypto.kdf]
iterations = 3
memory_kib = 65536
lanes = 4

[preview]
text_limit = "2MiB"
office_limit = "20MiB"
```

### 12.5 日志与指标

- 结构化 JSON 日志：时间、级别、模块、调用方（用户或客户端）、`blob_uuid`、`part_no`、`bot`、耗时；**不含 token、secret 和完整下载 URL**。
- 可选指标（默认关闭 `/metrics`）：`tg_request_seconds{op}`、`tg_errors_total{code}`、Bot 状态、在途上传数、缓存命中率、`range_fallback_total`、`getfile_seconds`、`s3_requests_total{op,code}`、`gc_queue_length`。

### 12.6 代码规范

- 全量类型标注，`mypy` 检查；`ruff` 格式化与 lint。
- 所有异常继承自 `TgDriveError`；错误到 S3 错误码和 JSON 错误码的映射见 8.2 和 8.7 节。
- 不提交任何密钥；测试用假的 token 和本地 BlobStore。
- 对象服务的每个公开方法第一行校验 `Scope`，有专门的测试保证"忘记校验"会被发现。

### 12.7 内置诊断模块

**目的：** 用户不需要手工跑测试。诊断模块在解锁后以及每天自动收集 2.6 节中的假设数据，并在管理端的诊断页展示、给出建议。

| 采集项 | 方法 | 用途 |
|---|---|---|
| Range 可用性（A1） | 7.5 节的探测 | 决定是否降级 |
| `getFile` 耗时与大小的关系（A2） | 首次启用时向诊断频道上传 256 KiB、4 MiB、16 MiB 的随机探针文件，测耗时后删除 | 建议分片大小 |
| 长连接下的 Range 延迟（A3） | 在同一连接上连续请求 | 调整预读窗口 |
| 多 Bot 吞吐与 429（A4） | 运行中统计 | 调整限速；估算小文件吞吐（6.7 节） |
| 部署机的带宽与延迟（A8） | 上传与下载探针文件 | 建议并发 |

---

## 13. 测试策略

### 13.1 分层

| 层级 | 内容 | 依赖 | 运行方式 |
|---|---|---|---|
| 单元 | crypto：往返、任意区间、篡改、乱序、截断、换位置；KEK 包裹与轮换；子密钥加解密 | 无 | 每次提交 |
| Blob 引擎 | 用 LocalDiskBlobStore：多种大小、乱序 part、part 重传、读取粒度、scrub | 无网络 | 每次提交 |
| 对象服务 | 对象增删改查、列表、复制、移动、配额、分段上传规则、GC | 无网络 | 每次提交 |
| S3 网关 | SigV4 验签、`aws-chunked` 解码、授权；用真实工具做互操作 | 无网络（本地起实例，LocalDisk 后端） | 每次提交 / 发布前 |
| 隔离与权限 | 越权访问、会话、CSRF、角色检查 | 无网络 | 每次提交 |
| 故障注入 | 包装 BlobStore 在第 N 次 `put` 抛错；损坏、交换分片；`kill -9` | 无网络 | 每次提交 |
| 前端端到端 | 用 Playwright 驱动浏览器：登录、目录、上传、续传、预览 | 浏览器 | 发布前 |
| Telegram 集成 | 真实 Bot：`put`/`get`/`delete`、Range、Bot 池；限流用本地假服务器模拟 | 真实 token（环境变量开关） | 默认跳过 |
| 性能与内存 | 1 GB 文件的内存峰值不随大小增长；并发 4 时内存 < 约 200 MiB | 无网络 | 发布前 |

### 13.2 边界大小

所有读写类测试都覆盖：`0`、`1`、`frame_size−1`、`frame_size`、`frame_size+1`、`chunk_size−1`、`chunk_size`、`chunk_size+1`、多个分片加不整齐的尾部；并分别用"帧小于分片"和"帧等于分片"两种配置跑一遍。用很小的分片和帧（如 1000 字节和 96 字节，故意不整除）快速覆盖大量边界，另外保留一个真实尺寸的用例（40 MiB、16 MiB 分片、64 KiB 帧）。

### 13.3 关键用例清单

**Blob 引擎与加密**

1. 往返：各种大小，逐字节一致。
2. 随机区间：数百个随机区间与原文一致；覆盖不同预读窗口。
3. **读取粒度：** 读取一帧内的几个字节，向后端发出的请求长度恰好是 `frame_size + 16`。
4. **乱序与并行 part：** part 以任意顺序到达，定稿后 `offset` 连续、读取正确。
5. **part 重传：** 新 salt、旧 `blob_ref` 进 `gc_queue`、读取内容是新的。
6. 篡改一个字节、交换两个分片的内容、用旧孤儿分片替换：读取均抛 `IntegrityError`；scrub 报出对应分片。
7. 同一明文两次加密得到不同密文；分片文件里找不到明文特征串。

**对象服务**

8. 增删改查：覆盖写使旧 blob 引用计数减 1。
9. **复制不复制数据**：删除其中一个，另一个仍可读；全部删除后分片进 `gc_queue`。
10. **列表**：对随机生成的目录树（上万个键），`prefix`、`delimiter`、分页的结果与一个参考模型逐项一致；公共前缀跳跃正确。
11. **移动目录**：一个事务内完成；冲突策略（跳过/覆盖/改名）；中途失败整体回滚。
12. **配额**：超额拒绝；并发上传不会共同突破配额；定稿时二次检查。
13. **分段上传规则**：`EntityTooSmall`、`InvalidPart`、`InvalidPartOrder`、组合 ETag；`Complete` 重试幂等；中止与过期清理；孤儿 blob 清理。
14. GC 队列处理：消息已不存在也算成功；失败重试。

**密钥**

15. KEK 轮换：DEK、Bot token、客户端 secret 都被重新保护；后端里的分片内容完全不变；中途失败整体回滚；旧口令失效。
16. 错误口令抛 `WrongPassphrase`；重开数据库后用正确口令可读。

**S3 网关**

17. SigV4：头部签名和预签名；公开的测试向量（如可获得）；时间偏差；错误 secret；已禁用的密钥。
18. `aws-chunked` 解码：已签名、未签名、带尾部校验和三种。
19. **互操作**：aws-cli、boto3、rclone 做小文件上传、大文件分段上传、带 Range 的下载、列表、删除、复制、同步。
20. **授权**：只读客户端不能写；前缀限制生效；列表的前缀超出授权被拒；`ListBuckets` 只列出有授权的桶。

**隔离与权限**

21. **用户 A 不能列出、读取、写入、删除、移动 B 的对象**：构造 `../`、绝对路径、URL 编码、在请求里夹带桶名、使用 B 的 `upload_id`（IDOR）、搜索接口等。
22. 持有某用户桶授权的 S3 客户端不能访问其他桶。
23. 普通用户不能调用管理 API；锁定状态下各入口的行为符合 6.9 节。
24. CSRF：缺少请求头的修改类请求被拒；登录失败退避生效。
25. Bot token、客户端 secret 永远不出现在日志和响应里（创建时显示一次的除外）。

**预览与下载**

26. 响应头：`nosniff`、预览带 `sandbox` CSP、HTML 和 SVG 为 `attachment`。
27. Range 边界：后缀范围、开放式范围、越界 416、`If-Range`、`HEAD`。

**其他**

28. 故障注入：上传中途 `kill -9`，分段上传可续传；`Complete` 前后崩溃。
29. 1 GB 文件上传下载的内存峰值不随文件大小增长；公平性：一个用户的大量上传不会饿死另一个用户。

### 13.4 已有测试状态

| 内容 | 状态 |
|---|---|
| 分帧加密参考实现（固定 64 KiB 帧）：往返、随机区间、篡改、乱序、截断、搬位置 | ✅ 通过 |
| M0 验证脚本：在本地模拟服务器上，对"支持 Range"与"不支持 Range"都能给出正确结论 | ✅ 通过 |
| M1 草稿（v1.0 模型）的冒烟测试：往返与随机区间、读取粒度、续传、源文件变化检测、篡改与 scrub、KEK 轮换、重开数据库、删除、帧等于分片 | ✅ 通过；其中帧加密、范围读取、篡改检测、读取粒度的结论仍然适用，续传部分随模型调整而作废 |
| 13.3 节的完整用例清单 | 待补 |

### 13.5 持续集成

CI 在 Python 3.11 与 3.12 上运行全部不依赖网络的测试（含用真实 aws-cli、rclone、boto3 对本地实例的互操作测试）；前端端到端和 Telegram 集成测试在发布前或需要时手动触发。

---

## 14. 部署与运维

### 14.1 Docker Compose

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    environment:
      TGDRIVE_CONFIG: /config/config.toml
    volumes:
      - ./config:/config:ro
      - ./data:/data                   # meta.db、密文缓存、本地备份
    expose: ["8000", "9000"]
    user: "10001:10001"
    read_only: true
    tmpfs: ["/tmp"]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data

volumes:
  caddy_data:
```

Bot token 不在这里：它们在管理端添加后加密存库。

### 14.2 Caddyfile（示例，使用前请对照 Caddy 文档核对）

```
drive.example.com {
    @admin path /admin* /api/admin/*
    @outside not remote_ip 10.0.0.0/8 192.168.0.0/16     # 换成你的内网或 VPN 网段
    handle @admin {
        respond @outside 403
        reverse_proxy app:8000
    }
    handle {
        request_body {
            max_size 32MB                                  # 略大于一个 part 的请求体
        }
        reverse_proxy app:8000 {
            flush_interval -1                              # 视频等流式响应不缓冲
        }
    }
}

s3.example.com {
    request_body {
        max_size 5GB                                       # 单次 PutObject 的上限
    }
    reverse_proxy app:9000 {
        flush_interval -1
    }
}
```

S3 网关必须保持 `Host` 头原样传递（Caddy 默认如此），否则 SigV4 验签会失败。

### 14.3 首次启动

1. 在 @BotFather 创建 Bot，建数据频道和备份频道，把 Bot 设为管理员（数据频道：发消息、删除消息；备份频道：另加置顶消息）。
2. 写好 `config.toml`，`docker compose up -d`。
3. 访问管理端，走完"首次设置向导"（11.3 节）：设置 KEK 口令 → 创建管理员 → 添加 Bot 和频道 → **保存恢复包** → 创建用户。
4. 到诊断页查看系统自动收集的数据，必要时按建议调整分片大小。
5. 创建一个客户端，用 rclone 或 aws-cli 做一次上传下载验证（管理端"客户端"页有配置示例）。

### 14.4 升级与回滚

升级前自动做一次 `VACUUM INTO` 备份；迁移失败则保留备份并拒绝启动；回滚 = 换回旧镜像 + 还原备份。

### 14.5 日常运维

| 项目 | 频率 |
|---|---|
| 数据库快照上传 | 有变更时每 10 分钟；上传完成后约 60 秒 |
| 本地数据库备份 | 每日（保留 7 份）、每周（保留 4 份） |
| 浅层 scrub | 每周抽查约 5%；每月全量 |
| 诊断 | 解锁后与每天 |
| GC 队列 | 持续；管理端查看积压 |
| 依赖与镜像更新 | 每月 |
| 审计日志检查 | 每月；保留 1 年 |

### 14.6 资源估算

| 资源 | 估算 |
|---|---|
| 内存 | 并发 4 时约 128 MiB 的在途分片缓冲 + 应用自身，预留 512 MiB 以上 |
| 磁盘 | 密文缓存默认上限 20 GiB（可调）+ 数据库（百万级对象为数百 MB）+ 本地备份 |
| 网络 | 上传与下载都经过服务器；带宽决定吞吐 |
| Telegram 消息数 | 大文件约每 TiB 65,536 条；**小文件每个对象至少一条**（4.6、6.7 节） |

---

## 15. 开发计划

**原则：** 每个里程碑都能独立运行、独立验收；先做无网络的核心，再接 Telegram；对外先给命令行客户端能用的 S3 网关，再做两套 UI；平台行为的验证尽量由内置诊断完成，减少手工测试。

**工作方式：** 由 Claude 在沙箱里编写代码并运行不依赖网络的测试；沙箱无法访问 Telegram，所以 Telegram 相关代码通过 BlobStore 接口隔离，真实联调由用户在需要时运行一次集成测试并反馈结果。前端端到端测试需要浏览器环境，在用户机器上或使用 Claude Code 运行更合适；若需要在自己的仓库里直接跑测试、连真实 Bot 联调，可以使用 Claude Code。

| 里程碑 | 目标 | 主要交付物 | 验收标准 | 状态 |
|---|---|---|---|---|
| **M0** | 验证 Telegram 的关键行为 | Range 验证与实测数据、M0 脚本（附录 B） | Range 正确性有结论 | Range ✅；其余转入内置诊断 |
| **M1** | **Blob 引擎（无网络）** | `crypto`（含子密钥）、`metadata`（blobs/chunks）、`keystore`、`blobstore`、`blobengine`；测试套件 | 13.3 节第 1–7、15–16 条通过；乱序 part 与 part 重传正确 | 草稿基于 v1.0 模型，需按本文档调整（附录 A） |
| **M2** | Telegram 后端 | `TelegramBlobStore`、Bot 池（token 解密、限速、熔断、状态）、`file_path` 缓存与预取、Range 探测与降级；集成测试；诊断采集 | 真实 Bot 上完成往返与 Range；429 下不丢数据；降级路径有测试 | 未开始 |
| **M3** | **对象服务** | 存储桶、对象、列表、复制、移动前缀、分段上传、配额、GC 队列与工作线程；元数据迁移 | 13.3 节第 8–14 条通过；1 GB 分段上传内存不随大小增长；列表与参考模型一致 | 未开始 |
| **M4** | **S3 网关** | SigV4（头部与预签名）、`aws-chunked` 解码、操作子集、XML 序列化、客户端与授权、审计、基础快照备份 | 13.3 节第 17–20 条通过；aws-cli、boto3、rclone 互操作套件通过 | 未开始 |
| **M5** | **管理 API + 管理端 UI** | 首次设置向导、解锁、仪表盘、Bot 管理、客户端管理、用户与存储桶、加密与备份（含修改密钥）、诊断、审计日志、系统设置 | 向导 → 添加 Bot → 创建客户端 → 修改加密密钥 全流程在假 Telegram 上走通；13.3 节第 23–25 条中管理端相关项通过 | 未开始 |
| **M6** | **用户 API + 用户端 UI** | 登录、目录浏览与操作、上传（含续传、整文件夹）、下载、搜索、基础预览（图片、视频、音频、PDF、文本）、传输面板 | 13.3 节第 21–22、26–27 条通过；浏览器里能建目录、上传并续传、移动目录、预览上述类型并拖动视频 | 未开始 |
| **M7** | **可靠性** | 加密快照与置顶、恢复流程、scrub 调度、冗余副本与自动修复、Bot 故障转移、恢复包 | 删库后能用快照与恢复包在干净环境恢复；副本能自动修复损坏分片 | 未开始 |
| **M8** | **增强** | Markdown/CSV/Office/ZIP 预览、缩略图、回收站、分享链接、用户自助访问密钥、HEIC | 11.4 节 M8 项逐一验收 | 未开始 |

### 15.1 M1 任务拆分（调整现有草稿）

1. `crypto`：分片密钥的 `info` 改为 `blob_uuid`（去掉 `idx`）；AAD 去掉"末片"标志；新增 `derive_subkey`、`seal`、`open_sealed`。
2. `metadata`：`files` → `blobs`；`chunks` 主键改为 `(blob_uuid, part_no, sub_idx)`，`offset` 可空，去掉 `plain_sha256`；加入迁移骨架。
3. `blobengine`：`put_part`（替换同 `part_no`）、`finalize`（分配 `offset`）、`stream`（沿用现有的窗口化读取）、`scrub`。
4. `keystore.rotate`：做成可扩展的"重新包裹钩子"，M2、M4 加入 Bot 和客户端后自动纳入同一事务。
5. 按 13.3 节第 1–7、15–16 条写正式的 `unittest`。

### 15.2 M2 任务拆分

1. `TelegramClient`：`sendDocument`、`getFile`、Range 下载、`deleteMessage`，错误分类（7.2 节）。
2. Bot 池：令牌桶限速与 AIMD、熔断、选择、`state`（enabled/draining/disabled）、token 解密。
3. `file_path` 缓存、single-flight、下一分片预取。
4. Range 探测与降级路径。
5. 添加 Bot 的校验流程（`getMe`、频道、管理员权限、测试收发）。
6. 集成测试（环境变量开关）与诊断采集。

### 15.3 M3 任务拆分

1. 元数据迁移：`objects`、`buckets`、`uploads`、`upload_parts`、`gc_queue`；`Scope`。
2. 对象服务：put/get/head/delete/list/copy/move_prefix/配额。
3. 分段上传全流程与幂等 `Complete`、过期清理、孤儿 blob 清理。
4. GC 工作线程（限速、重试）。
5. 随机目录树与参考模型的对照测试；内存测试。

### 15.4 M4 任务拆分

1. SigV4：规范请求、头部与预签名；测试向量与真实客户端互操作。
2. `aws-chunked` 三种形态的解码与校验。
3. 操作处理器与 XML；错误映射（8.2 节）。
4. `clients`、`client_keys`、`client_grants`；secret 的加密存取；授权判定。
5. 审计日志与鉴权失败退避；基础快照备份（避免元数据丢失的最低保障）。
6. 互操作测试套件（aws-cli、boto3、rclone）。

### 15.5 M5 / M6 任务拆分

**M5：** 前端工程骨架与路由（`/admin`）；会话与 CSRF；首次设置向导；解锁页；各管理页面与对应的管理 API；"修改加密密钥"的维护模式与进度显示；诊断页；审计页。

**M6：** 用户端布局；目录浏览（列表/网格、面包屑、多选、拖拽移动）；上传模块（part 并发、续传、整文件夹、冲突策略、File System Access 句柄保存）；传输面板（分片格子图）；`/content` 的 Range 读取与预览组件（图片、视频、音频、pdf.js、文本）；搜索；越权测试。

---

## 16. 风险登记表

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Telegram 改变 Range 行为、限制或封禁 Bot | 中 | 高 | 自动探测与降级；多 Bot；关键数据双副本；正确性不依赖未文档化行为，只有性能依赖 |
| 违反 Telegram 服务条款导致封号 | 中 | 高 | 小规模使用；多频道多 Bot 分散；不存放违规内容；多份备份 |
| 数据库丢失 | 低 | 极高 | 加密快照 + 置顶锚点 + 本地与异地备份 + 恢复包；M4 就有基础快照 |
| KEK 口令遗忘 | 低 | 极高（数据永久不可恢复） | 密码管理器；恢复包；向导里的强提示 |
| **小文件吞吐受限于 Telegram 限流** | **高** | 中 | 多 Bot；批量上传显示预计耗时、建议打包；长期方案是小对象打包（17 章） |
| **S3 兼容性不完整**（SDK 默认校验和变化、`aws-chunked`、边角行为） | 中 | 中 | 明确的支持子集；互操作测试矩阵纳入 CI；文档写明客户端设置；不支持的操作返回 501 |
| **SigV4 实现错误**（规范化、编码细节） | 中 | 高 | 测试向量 + 多种真实客户端互操作；失败时只会拒绝合法请求，不会放行非法请求（验签是先决条件） |
| **多用户越权** | 低 | 高 | `Scope` 双层校验；专门的越权测试清单（13.3 节第 21–22 条） |
| 管理端暴露在公网 | 中 | 高 | 建议内网或 VPN；Caddy 层 IP 限制；高风险操作再次验证口令；审计 |
| 用户上传的文件引发脚本注入（预览） | 低 | 中 | 白名单预览、`attachment`、`nosniff`、`sandbox` CSP、DOMPurify |
| Bot token、客户端 secret 泄露 | 中 | 高 | 加密存库、一次性显示、日志脱敏、撤销流程、审计 |
| 下载速度偏低（本机样本约 0.74–1.8 MB/s） | 中 | 中 | 部署机实测；预取与预读；缓存；必要时调小分片 |
| SQLite 单写者与大事务（KEK 轮换、移动大目录） | 低 | 中 | 维护模式；分批策略；个人规模足够；数据访问层隔离，必要时换 PostgreSQL |
| 孤儿分片浪费 Telegram 空间 | 中 | 低 | 已接受 |
| `getChat` 无法读取置顶消息；Bot 迁移不可行（A6、A7） | 中 | 中 | 恢复包记录位置并包含备份 Bot token；更依赖本地与异地备份；副本 |
| 范围蔓延（S3 兼容性是个无底洞） | 中 | 中 | 严格限定在 8.2 节的子集；新增操作需要对应的真实使用场景 |

---

## 17. 待决事项

| 事项 | 说明 | 计划 |
|---|---|---|
| **每用户独立密钥** | 若需要"管理员也看不到用户文件"，每用户需要由其口令派生的 KEK。代价：用户登录前该用户的数据对 S3 客户端、后台任务不可用；忘记口令即丢数据；管理员重置口令等于丢失数据 | 当前不做（5.1 节）；先确认是否真的需要 |
| 小对象打包 | 多个小 blob 打包进同一条消息，突破"每对象一条消息"的限制；`chunks` 增加 `pack_offset`/`pack_length`；GC 需要压缩 | 数据模型已留余地；M8 之后按实际使用情况评估 |
| 整文件哈希 | S3 路径只有 MD5/ETag；是否需要 SHA-256 做去重或校验 | 暂不做 |
| 分片大小 16 MiB 还是 8 MiB | 取决于 A2 和部署机实测 | 由诊断数据决定 |
| 帧大小默认值 | 目前 64 KiB | 部署机测得长连接下的 Range 延迟后复核 |
| HTTP/2 | 云端 API 是否支持未验证 | M2 探测 |
| 浏览器端加密模式 | 让服务器也看不到明文，代价是无法服务端处理、预览需要浏览器解密 | 不在本期范围 |
| 管理员口令重置命令行工具 | 忘记管理员口令时需要在服务器上重置，不影响 KEK | M5 |
| Office 预览是否引入服务端转换 | LibreOffice 转 PDF 能覆盖 PPTX、DOC 等，但很重 | 默认不做 |
| S3 虚拟主机风格寻址 | 部分工具默认使用 | 视互操作测试结果 |
| CRC32C、CRC64NVME 校验 | 目前只记录不验证 | 视互操作测试结果 |
| Bot 迁移与 `getChat` 置顶（A6、A7） | 未验证 | M7 实现前先在集成测试里验证 |

---

## 附录 A：M1 核心库当前状态与 v2.0 的差距

### A.1 现有草稿（基于 v1.0 模型，冒烟测试通过）

| 模块 | 现状 |
|---|---|
| `errors.py` | `TgDriveError` 及子类：`IntegrityError`、`WrongPassphrase`、`NotFoundError`、`NotReadyError`、`BlobNotFound`、`SourceChangedError` |
| `crypto.py` | 分片分帧 AEAD（帧大小可配置）、范围计算、Argon2id、DEK 包裹、口令校验块 |
| `metadata.py` | `keys`/`files`/`chunks` 表、事务、`chunks_covering`、`user_version` 迁移 |
| `keystore.py` | `initialize`、`unlock`、`rotate`（事务内重新包裹所有 DEK） |
| `blobstore.py` | `BlobStore` 协议、`LocalDiskBlobStore`（原子写入、防路径穿越） |
| `engine.py` | `begin_upload`、`upload`（含续传）、`upload_progress`、`stream`/`read`（预读窗口）、`scrub`、`delete` |

**冒烟测试覆盖（✅ 通过）：** 各种大小的往返与随机区间；读取粒度（一帧内读取只请求 `帧大小+16` 字节）；续传与源文件变化检测；篡改与 scrub；KEK 轮换；重开数据库；删除；帧等于分片。

### A.2 与 v2.0 的差距

| 模块 | 需要的改动 |
|---|---|
| `crypto.py` | 分片密钥 `info` 去掉 `idx`、AAD 去掉"末片"标志（5.4 节）；`FileKey.file_uuid` 改名 `blob_uuid`；新增 `derive_subkey`、`seal`、`open_sealed` |
| `metadata.py` | `files` → `blobs`；`chunks` 主键改为 `(blob_uuid, part_no, sub_idx)`，`offset` 可空，去掉 `plain_sha256`；`objects`、`buckets` 等在 M3 加入 |
| `keystore.py` | `rotate` 需要同时重新保护 Bot token 和客户端 secret（扩展为钩子） |
| `blobstore.py` | 不变 |
| `engine.py` | `upload(source)`、`begin_upload`、`upload_progress` 被 S3 分段语义取代：拆成 `BlobEngine.put_part`/`finalize`；`stream`、`scrub` 基本可沿用；`delete` 由对象服务的引用计数与 GC 队列取代 |
| 测试 | 冒烟脚本不是正式测试套件；需要按 13.3 节重写。其中帧加密、范围读取、篡改检测、读取粒度的结论仍然适用，**续传（源文件哈希校验）部分随模型调整而作废**（part 重传是显式替换，不再有"源文件在两次上传之间被改"的问题） |

---

## 附录 B：M0 验证脚本

`m0_range_test.sh` 用于在真实 Bot 上验证大分片的 Range 行为：生成 16,781,329 字节的随机文件并上传、记录 `getFile` 耗时、完整下载并校验、测试 7 种 Range（第 0 帧、第 100 帧、最后一帧、连续 4 帧、未对齐区间、后缀范围、开放式范围）并逐字节比对，结束后自动删除测试消息。

**使用：** 设置 `BOT_TOKEN`、`CHAT_ID` 后运行 `bash m0_range_test.sh`；`SIZE` 改测试文件大小，`API_BASE` 改地址，`KEEP=1` 保留测试消息。

**经验教训（已修复）：** 变量名后直接跟全角标点（如 `$label：`）会被老版本 bash 当成变量名的一部分，需要写成 `${label}`；用 `sh` 运行时进程替换 `<(...)` 不可用，已改为临时文件比对。

**后续：** 该脚本的职责由内置诊断模块（12.7 节）接管，以后不需要手工运行。

---

## 附录 C：术语表

| 术语 | 含义 |
|---|---|
| 存储桶（bucket） | 对象的顶层容器；每个用户有一个私有桶，管理员可建共享桶 |
| 对象（object） | 存储桶内的一个键及其内容、元数据；目录是键前缀 |
| 客户端（client） | 调用 S3 接口的应用或工具，由管理员创建，持有 Access Key，按桶和前缀授权 |
| Access Key / Secret | 客户端的凭据：Access Key ID 是公开标识，Secret 用来计算签名，只在创建时显示一次 |
| SigV4 | AWS Signature Version 4，S3 的请求签名方案 |
| 授权（grant） | （存储桶，前缀，只读或读写）的组合 |
| `Scope` | 适配层解析出的访问范围，对象服务的每个方法都会校验 |
| 分段上传（multipart） | S3 的大文件上传方式：先建上传，再分 part 上传，最后合并 |
| part | 分段上传中的一段，编号 1–10000，大小可以不同 |
| ETag | 对象内容的标识；单次上传是明文 MD5，分段上传是 `"md5-N"` |
| blob | 加密后的内容，由若干分片组成；对象通过引用计数共享 blob |
| 引用计数（refcount） | 有多少个对象指向同一个 blob；减到 0 才删除数据 |
| GC 队列 | 等待从 Telegram 删除的分片 |
| 维护模式 | 暂停写入的状态，用于 KEK 轮换 |
| 分片（chunk） | 存储单位，默认 16 MiB，每片是 Telegram 消息里的一个文件 |
| 帧（frame） | 分片内部的加密与校验单位，默认 64 KiB，每帧有自己的认证 tag |
| AEAD | 带认证的加密，解密时同时校验数据是否被改动；本项目用 AES-256-GCM |
| tag | AEAD 附带的 16 字节"封条" |
| nonce | 只使用一次的编号，同一把密钥下不能重复 |
| salt | 公开的随机数，用来从同一个 DEK 派生不同的分片密钥 |
| HKDF | 标准的密钥派生函数：输入一把密钥和一个 salt，输出新密钥 |
| Argon2id | 把口令变成密钥或哈希的函数，故意很慢且占内存 |
| KEK | 主密钥，由口令派生，只在内存里；包裹 DEK 并派生子密钥 |
| DEK | blob 密钥，每个 blob 一把，被 KEK 包裹后存数据库 |
| KEK 子密钥 | 从 KEK 按用途派生，用来加密 Bot token、客户端 secret、快照 |
| AAD | 额外认证数据：不被加密，但被 tag 一起保护 |
| `blob_ref` | BlobStore 返回的、指向一个已存储分片的不透明字符串 |
| 孤儿分片 | 已写入后端但数据库里没有记录的分片 |
| Range | HTTP 的字节范围请求，视频拖动和按需读取的基础 |
| scrub | 检查所有分片是否完好的维护任务 |
| RPO | 恢复点目标：灾难后最多会丢失多久之内的数据 |

---

## 附录 D：关键公式速查

| 量 | 公式 | 默认参数下的值 |
|---|---|---|
| 分片数 | `ceil(size / chunk_size)` | 40 MiB 文件 → 3 片 |
| 帧数（每片） | `max(1, ceil(plain_size / frame_size))` | 16 MiB 分片 → 256 帧 |
| 分片密文长度 | `17 + plain_size + 16 × 帧数` | 16,781,329 字节 |
| 每帧 stride | `frame_size + 16` | 65,552 字节 |
| 第 k 帧起点 | `17 + k × stride` | — |
| tag 开销比例 | `16 / frame_size` | 约 0.024% |
| 读取区间 `[lo, hi]` 的密文范围 | `start = 17 + (lo // F) × stride`；`end = min(17 + (hi // F + 1) × stride, 密文总长)` | — |
| 每 TiB 的分片数 | `2^40 / chunk_size` | 65,536 |
