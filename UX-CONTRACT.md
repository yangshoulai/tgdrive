# tgdrive 界面行为契约

## 业务来源

- `docs/architecture-v2.md`：用户隔离、S3 SigV4、Telegram 私有频道、容量和预览边界。
- `src/tgdrive/api.py` 与 `src/tgdrive/asgi.py`：会话、CSRF、对象、公开链接和维护接口契约。
- `src/tgdrive/objects.py`：桶配额在提交对象时强制校验；公开令牌随对象行移动。

## 路由与角色

| 站点 | 路径 | 内容 |
| --- | --- | --- |
| 用户站点 | `/` | 登录与文件空间（`?path=` 当前目录，`?view=shared|keys` 子页面） |
| 用户站点 | `/s/<token>` | 公开分享页，无需登录；令牌可以指向文件，也可以指向文件夹（文件夹分享页用 `?path=` 表示当前所在的相对路径，只读浏览、预览、下载） |
| 用户站点 | `/p/<token>/<文件名>` | 公开直链（由 API 服务直接响应） |
| 文档 | `/docs` | 所有人共用同一个地址：未登录和普通用户看用户文档；管理员会话改为加载受保护的管理员文档 bundle，多出「管理员」分组。`/admin/docs` 仅作旧地址跳转 |
| 系统管理 | `/admin`、`/admin/<模块>` | 仅管理员可见；模块：overview、users、objects、bots、clients、maintenance、settings。普通用户访问显示「没有访问权限」 |

全站只有一个会话 Cookie（`tg_session`），角色由服务端会话决定；登录入口只有 `/`，菜单和页面按角色显示，每个接口再按角色校验。系统锁定时只有管理员能登录（用来解锁）。登录页会记住上次的用户名，并提供“30 天内保持登录”（长期会话，服务重启后仍有效；服务锁定期间普通用户看到“服务暂时不可用”）。

## Canonical UI Map

| Capability | Canonical owner | Allowed variants | Verification |
| --- | --- | --- | --- |
| Form | `Field` + `.input` + `.form` | login / setup / create / rename | typecheck + browser |
| Toast | `toast` + `Toaster`（`web/src/ui.tsx`） | success / error / info | live region + browser |
| Dialog | `Modal`、`ConfirmDialog` | sm / md / lg / xl | focus trap + Esc |
| Row actions | `Menu` | file / folder / user / object | keyboard + browser |
| CRUD | 页面内调用 `web/src/api.ts` | list / create / status / public | API tests |
| Preview | `FilePreview`、`PreviewModal` | image / video / audio / pdf / text / fallback | browser |
| Sharing | `ShareDialog`、`SharePage` | on / off | `tests/test_m8.py` |

## 共享行为

- 表单使用 `noValidate`，在前端校验后把错误显示在字段下方，保留已输入内容。
- 所有写操作携带 `X-CSRF-Token`；成功与失败都通过 `toast` 提示，失败时不关闭当前弹窗。
- 删除、禁用、锁定、停止分享使用 `ConfirmDialog`，确认按钮写出动作本身。
- 会话失效（401）只让对应入口回到登录页；旧密码错误等业务校验返回 400，不触发登出。
- 列表加载、空状态和错误状态保持稳定高度；错误状态提供“重试”。

## 公开分享

- 文件默认私有。开启后生成 16 位随机令牌，任何人可通过分享页或直链访问。
- 上传时可勾选「上传后公开访问」（`PUT ...&public=1`），该选择会被记住。
- 覆盖上传、移动、重命名不改变令牌；关闭后令牌作废，再次开启生成新令牌。
- 文件夹不能公开。所属账号被禁用或系统锁定时，所有公开链接返回 404 / 503。
- 管理员可在「全部文件」中筛选公开文件并撤销公开访问。
- 分享页只展示文件名、大小、类型和修改时间，不暴露所有者和完整路径。

## 对外地址

- 管理员在「系统设置」中配置公开访问地址与 S3 Endpoint，保存后立即生效；系统锁定时也可修改。
- 只接受 `http(s)://主机[:端口]`，不带路径；S3 Endpoint 的域名必须与公开访问地址不同。
- 用户端的分享链接、访问密钥页、文档示例都使用配置值；未配置时按当前站点推断，S3 Endpoint 未配置时提示联系管理员。

## 核心流程

| 操作 | 成功后 | 失败恢复 |
| --- | --- | --- |
| 上传（选择或拖放） | 确认弹窗 → 右下角上传托盘逐个显示进度，可取消单个文件；完成后刷新列表与容量 | 托盘中保留失败原因，其余文件继续 |
| 分享 | 开关即时生效，显示分享页与直链 | 提示失败原因，开关回到原状态 |
| 重命名 / 新建文件夹 | 关闭弹窗并刷新 | 错误显示在输入框下方 |
| 删除文件夹 | 递归删除其中所有文件 | 提示失败，列表不变 |
| 移动（菜单、批量或拖放） | 选择目标文件夹与同名策略；完成后提示移动数量与跳过数量 | 逐项报告失败原因，其余项目继续 |
| 新建用户 / 调整配额 | 回到用户表，进度条反映新配额 | 错误显示在对应字段 |
| 创建访问密钥 | 一次性显示 Secret（默认遮罩）与 rclone 配置 | 重新提交 |
| 锁定系统 | 所有会话失效，回到登录页 | 提示原因 |

## 可访问性

目标为 WCAG 2.2 AA。所有可操作元素使用 button / link；`:focus-visible` 清晰可见；移动端触控目标不小于 30px，主要按钮 36–44px；所有图标按钮有 `aria-label`。
