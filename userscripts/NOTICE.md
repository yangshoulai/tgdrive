# Tessera 资源抓取脚本：版权与许可证

`tessera-grabber.user.js` 从 0.16.0 起包含改编自 LinkSwift 的网盘取链代码，合并脚本整体以 **AGPL-3.0-or-later** 发布。完整许可证见 [LICENSE](LICENSE)。源代码以未压缩的单文件提供，不需要构建。

- Tessera 原始代码：Copyright (c) 2026 yangshoulai，原有 MIT 声明保留如下。
- LinkSwift：Copyright (c) 2022 hmjz100；作者：油小猴、hmjz100；`AGPL-3.0-or-later`。
- 来源：https://github.com/hmjz100/LinkSwift
- 基线提交：`8283da03e6c78576ebca8b1604161bcd54ade82e`，开发版 1.1.4。
- 2026-10-26 修改：抽取九个网盘的选择、签名与取链逻辑，适配 Tessera 的界面、GM 兼容层、下载确认与重试；更改百度授权交互，修复移动随机串和阿里批次结果关联。详细来源及更新方法见 [上游说明](../third_party/linkswift/README.md)。
- 同日 0.16.1 修复：增加隔离环境的只读页面选择桥接、React state 和网格选择读取；区分读取失败与未勾选，并明确分享页转存入口。
- 2026-10-30 0.17.0：取链方式与上游对齐——使用上游的客户端请求头、批量与节奏，读取错误状态下的服务商代码与说明，百度自盘展开文件夹，一次最多 1000 个文件。

脚本没有保证，包括适销性、特定用途适用性或各网盘长期兼容性。用户可以依照 AGPL 修改和再分发合并脚本。Tessera 后端与独立网页应用继续适用仓库根目录的 MIT 许可证。

## Tessera 原始代码的 MIT 声明

MIT License

Copyright (c) 2026 yangshoulai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
