# 7-Zip RAR 解码

Tessera 的容器镜像通过共享库 `7z.so` 使用 7-Zip 26.06（Igor Pavlov），用于解压 RAR4 和 RAR5。镜像中的 `/app/licenses/7zip/` 随附上游许可和与二进制对应的完整源码归档。上游许可包含 LGPL、BSD 和 unRAR 许可限制，详见随附的 `License.txt`、`copying.txt` 和 `unRarLicense.txt`。

解码桥接源码与构建脚本位于仓库的 `native/rar/`，使用构建脚本可校验上游源码并重新编译共享库。运行时从同一目录加载桥接库与 `7z.so`，两者均可重新编译后替换。

[7-Zip 26.06 发布及源码下载](https://github.com/ip7z/7zip/releases/tag/26.06)
