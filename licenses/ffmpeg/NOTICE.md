# FFmpeg

带 FFmpeg 的镜像（`-ffmpeg`、`-platform`）包含静态编译的 FFmpeg 7.1.1 可执行文件 `/usr/local/bin/ffmpeg`，
取自 [mwader/static-ffmpeg](https://github.com/wader/static-ffmpeg)（镜像 `mwader/static-ffmpeg:7.1.1`，按摘要固定）。

- FFmpeg 以 `--enable-gpl --enable-version3` 编译，按 GNU GPL 第 3 版（或更高版本）发布；Tessera 只以独立进程调用它，
  Tessera 自身仍按 MIT 许可发布。
- FFmpeg 源代码：<https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz>；构建脚本与各依赖库的确切版本见上游仓库，
  以及同目录的 `versions.json`。
