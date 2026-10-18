# 注册功能实施与验证记录

## 功能

- 管理入口：`/admin/settings?tab=registration`。注册默认关闭，默认额度 500 GiB，支持 0 或不限。
- 邮箱验证码、邀请码可以单独或同时开放，同时开放时任选一种。
- `/register` 提供邮箱、登录密码、确认密码和选定验证方式的输入。注册成功后前往登录，不自动建立会话。
- 每次最多创建 100 个一次性邀请码，设置失效时间与独立额度。邀请码默认额度取创建时的注册默认额度，支持状态筛选、分页、复制链接和确认后撤销。
- 邀请链接使用 `/register#invite=…`，自动填入并固定邀请码，不向服务器访问日志或 Referer 传递凭据。
- SMTP 支持 SSL/TLS、STARTTLS，校验证书；密码加密保存且不回显。测试邮件使用已保存配置。
- 邮件提供品牌栏、验证码区、有效期及安全提示，同时包含 HTML 和纯文本正文。
- 验证码为 6 位数字、10 分钟有效，60 秒可重发，连续错误 5 次失效，另有邮箱、IP 和全局请求限制。
- 邀请码核销与账号、存储桶创建处于同一事务。SMTP 密码与邀请码原文随系统加密口令轮换重新加密。

## 本次产品文件清单

新增：

- [src/tgdrive/registration.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/registration.py)：注册、验证码、邀请码与配置服务。
- [src/tgdrive/mailer.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/mailer.py)：邮件模板和 SMTP 发送。
- [web/src/register.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/register.tsx)：访客注册页。
- [web/src/admin/registration.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/admin/registration.tsx)：注册设置、邮件配置、邀请码管理。
- [tests/test_registration.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/tests/test_registration.py)：13 项认证与邮件回归检查。

修改：

- [src/tgdrive/accounts.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/accounts.py)：更新注册验证的职责说明。
- [src/tgdrive/asgi.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/asgi.py)：注册路由、管理员鉴权、审计和缓存保护。
- [src/tgdrive/audit.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/audit.py)：新增安全动作名称。
- [src/tgdrive/keystore.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/keystore.py)：注册秘密随系统口令轮换。
- [src/tgdrive/metadata.py](/Users/yangshoulai/Development/PersonalProjects/tgdrive/src/tgdrive/metadata.py)：追加 schema v27 邀请码表迁移。
- [web/src/admin/settings.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/admin/settings.tsx)：新增「注册」标签。
- [web/src/api.ts](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/api.ts)：接口类型、请求函数和邀请链接生成。
- [web/src/shell.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/shell.tsx)：按注册开关展示登录页入口。
- [web/src/user.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/user.tsx)：注册页路由。
- [web/src/styles.css](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/styles.css)：新表单、验证码行和邀请码列表样式。
- [web/src/docs/docs-admin-content.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/docs/docs-admin-content.tsx)：配置、接口、安全及升级说明。
- [web/src/docs/docs-content.tsx](/Users/yangshoulai/Development/PersonalProjects/tgdrive/web/src/docs/docs-content.tsx)：用户注册指南。
- [AGENTS.md](/Users/yangshoulai/Development/PersonalProjects/tgdrive/AGENTS.md)：模块职责、schema 与秘密保护约定。
- [DESIGN.md](/Users/yangshoulai/Development/PersonalProjects/tgdrive/DESIGN.md)：注册页、管理列表和邮件的视觉约定。
- [UX-CONTRACT.md](/Users/yangshoulai/Development/PersonalProjects/tgdrive/UX-CONTRACT.md)：路由、验证生命周期、配额与交互契约。
- [README.md](/Users/yangshoulai/Development/PersonalProjects/tgdrive/README.md)：功能与初始化指引。

删除：无。

验证产物集中在本目录：本记录、独立本地服务脚本 `serve.py`、截图、邮件正文和 `cli-artifacts/` 浏览器快照。主应用构建输出位于 `web/dist/`。

## 验证结果

- 前端 strict 类型检查通过，应用和管理员文档 bundle 构建通过。
- Python 语法检查及 `git diff --check` 通过。
- 已按项目要求重新安装 editable 包；运行依赖未升级。
- 70 项相关回归通过（以下两组共 70 项；后续因文档调整再次运行其中 5 项同样通过，不重复计数）：

```text
tests.test_registration
tests.test_unified_auth
tests.test_account_profile
tests.test_settings
tests.test_remember_login
tests.test_admin_docs
tests.test_auth
tests.test_crypto
tests.test_docs_inventory

tests.test_audit
tests.test_maintenance
tests.test_maintenance_basic
```

覆盖注册开关、锁定、角色与 CSRF、凭据重用、并发核销、失败回滚、验证码绑定／重发／过期／错误次数、额度快照、口令轮换、邮件双格式与 TLS 校验、上游错误脱敏。

额外使用仓库 HEAD 的 v26 Metadata 实现创建独立临时数据库，再由当前 v27 实现打开：升级通过，原账号和配额保留，新邀请码表可用。所有数据库验证均在用户明确授权后使用独立临时目录执行，未读取或修改 `.local-data`。

Playwright 已验证：

- 注册关闭时登录入口隐藏，直接访问注册页显示说明；开启后登录页显示入口。
- 管理员通过界面保存注册开关、5 GiB 默认额度及 SMTP 配置，并点击发送测试邮件；测试发送仅写入本地文件。
- 一次创建 3 个邀请码，额度默认继承 5 GiB，可覆盖为 2.5 GiB。
- 邀请链接固定字段的 DOM `readOnly` 为 true，完成注册后获得 2.5 GiB。
- 邮箱验证码发送反馈与倒计时正常，完成注册后获得默认 5 GiB。
- 菜单中的撤销经过确认，列表即时变为「已撤销」，复制链接按钮禁用。
- 1440px 桌面、390px 手机、浅色和深色界面已截图检查；手机注册和管理界面未向视口外横向溢出。
- 实际生成的 HTML 邮件已在浏览器中检查排版。

本地浏览器会话和验证服务均已关闭。

## 预览

- [管理端最终截图](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/registration/admin-final.png)
- [手机端邀请码菜单](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/registration/admin-mobile-dark.png)
- [邀请码注册页](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/registration/invite-final-dark.png)
- [手机邮箱注册页](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/registration/email-register-mobile-dark.png)
- [验证码邮件](/Users/yangshoulai/Development/PersonalProjects/tgdrive/output/playwright/registration/verification-email.png)

## 上线操作与限制

1. 部署并重启服务，按现有机制升级到 schema v27；本次未对用户实际数据执行迁移。
2. 在「系统设置 → 注册」设置默认额度与验证方式。邮箱方式需填写真实 SMTP 地址、端口、账号／授权码和发件邮箱。
3. 使用「发送测试」确认真实服务的投递、收件箱／垃圾邮件分类及邮件客户端排版，再开放邮箱注册。
4. 验证码保存在进程内存，服务重启或保存注册配置后需要重新获取，沿用项目的单进程部署要求。

真实 SMTP 投递及 Gmail、Outlook 等真实邮件客户端未连接验证；SMTP 调用使用替身检查。现有邮箱修改仍沿用账号服务的密码确认流程，本次验证码用于访客注册。
