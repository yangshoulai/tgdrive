# Tessera 修复与验证记录

日期：2026-10-15。修改留在当前工作区，未提交、未部署；保留任务开始前的文件助手及资源抓取脚本等未提交改动。

## 改动

1. 原始 HTML 内置 OG / Twitter 卡片、站点说明和公开的 1200×630 PNG 封面。服务端优先使用系统公开访问地址补全绝对 URL；未设置时使用请求协议与 Host。封面不包含用户文件。title、type、image、url 等字段按 [Open Graph 协议](https://ogp.me/)设置。
2. 移除系统管理的「全部文件」和概览「最近上传」；旧管理文件列表、内容、缩略图、预览及分享修改接口拒绝访问。概览只读取数量统计；管理员自己的文件仍通过「我的空间」访问。管理 API 创建或修改密钥授权时限制为本账号存储桶；管理密钥列表隐藏他人的自定义名称、说明与目录路径。
3. 审计保留操作者账号、来源 IP、安全动作、数量和结果，不写入文件名、路径、分享保存目录或密钥自定义名称。在线旧日志读取和新归档共用脱敏逻辑。
4. 下载分页与列表面板之间增加 16px 间距，只有一页时隐藏分页。
5. 下载任务增加文件名、保存路径与来源域名搜索，300ms 防抖；搜索在 SQL 中执行，支持状态组合和键集分页。私密空间锁定时不匹配真实文件名、路径，锁定后丢弃旧轮询并重新读取。

## 文件清单

修改（后端）：

- [src/tgdrive/api.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/api.py)
- [src/tgdrive/asgi.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/asgi.py)
- [src/tgdrive/audit.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/audit.py)
- [src/tgdrive/offline/service.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/offline/service.py)
- [src/tgdrive/static.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/static.py)

修改（前端）：

- [web/build-apps.mjs](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/build-apps.mjs)
- [web/src/admin.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/admin.tsx)
- [web/src/admin/clients.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/admin/clients.tsx)
- [web/src/admin/maintenance.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/admin/maintenance.tsx)
- [web/src/admin/overview.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/admin/overview.tsx)
- [web/src/api.ts](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/api.ts)
- [web/src/styles.css](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/styles.css)
- [web/src/user/downloads.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/user/downloads.tsx)

修改（文档）：

- [DESIGN.md](/Users/yangshoulai/Development/PersonalProjects/tgdrive/DESIGN.md)
- [README.md](/Users/yangshoulai/Development/PersonalProjects/tgdrive/README.md)
- [UX-CONTRACT.md](/Users/yangshoulai/Development/PersonalProjects/tgdrive/UX-CONTRACT.md)
- [web/src/docs/docs-admin-content.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/docs/docs-admin-content.tsx)
- [web/src/docs/docs-content.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/docs/docs-content.tsx)

修改（相关回归）：

- [tests/test_admin_docs.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_admin_docs.py)
- [tests/test_audit.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_audit.py)
- [tests/test_offline.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_offline.py)
- [tests/test_pagination.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_pagination.py)
- [tests/test_public_folders.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_public_folders.py)
- [tests/test_public_links.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_public_links.py)
- [tests/test_save_share.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_save_share.py)
- [tests/test_thumbnails.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_thumbnails.py)

新增：

- [web/assets/social-card.svg](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/assets/social-card.svg)：封面矢量源文件。
- [web/assets/social-card.png](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/assets/social-card.png)：构建使用的 PNG 封面。

删除：

- `web/src/admin/objects.tsx`：移除全部文件管理页面。

验证产物：

- [downloads-desktop.png](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/privacy-downloads/downloads-desktop.png)
- [downloads-mobile.png](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/privacy-downloads/downloads-mobile.png)
- [admin-overview.png](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/privacy-downloads/admin-overview.png)

## 验证

- 140 项相关后端回归检查全部通过，包含权限、审计、离线下载、静态 HTML、公开分享、缩略图、维护归档、设置，以及文件助手与模型渠道检查。
- 后端可编辑包已按项目约定重新安装成功，未更改运行时依赖。
- TypeScript 严格类型检查通过，用户端及受保护的管理员文档构建通过。
- Playwright 使用本机静态服务与内存演示响应，验证翻页、跨页关键词搜索、状态组合、空结果恢复、来源域名搜索，以及移除管理文件入口。
- 桌面 1440px 与窄屏 390px 验证：分页间距均为 16px，无页面横向溢出；已检查截图。
- 构建 PNG 为 1200×630，HTML 指向的哈希图片存在。服务端原始 HTML 的绝对地址、匿名读取和 HEAD 长度由回归覆盖。
- git diff --check 通过。Ruff 发现 31 项原有问题，与 HEAD 同文件对照未新增；未修改无关代码来清理这些问题。

## 限制与部署事项

- 需重新部署当前源码及前端构建产物，并确保「系统设置 → 公开访问地址」指向实际 HTTPS 站点。Telegram 对生产地址的抓取尚未实测。
- 没有操作用户运行数据库、迁移或生产数据。历史在线审计仅在读取时脱敏；旧数据库原文和此前已生成的归档未改写。
- 权限隔离作用于应用界面和接口；Tessera 仍为服务端加密，服务器控制者在技术上仍可读取数据。已颁发的访问密钥授权不自动撤销。
- 文件助手源文件保持原有工作区改动，本次仅在共享路由、样式和离线下载服务中叠加必要修改。
