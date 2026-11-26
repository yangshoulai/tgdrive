#!/bin/sh
set -eu

version=26.06
archive=7z2606-src.tar.xz
sha256=a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4
bridge=$(cd "$(dirname "$0")" && pwd)/bridge.cpp
output=${1:?用法：sh native/rar/build.sh 输出目录 [7-Zip 源码归档]}
mkdir -p "$output/lib" "$output/licenses"
output=$(cd "$output" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ "$#" -ge 2 ]; then
    cp "$2" "$work/$archive"
else
    curl -fsSL --retry 3 "https://github.com/ip7z/7zip/releases/download/$version/$archive" -o "$work/$archive"
fi
cd "$work"
case "$(uname -s)" in
    Linux) printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c - ;;
    Darwin) printf '%s  %s\n' "$sha256" "$archive" | shasum -a 256 -c - ;;
    *) echo "RAR 解码库构建支持 Linux 和 macOS" >&2; exit 1 ;;
esac
mkdir sdk
tar -xf "$archive" -C sdk
sdk=$work/sdk
cd "$sdk/CPP/7zip/Bundles/Format7zF"

case "$(uname -s)" in
    Linux)
        make -f makefile.gcc -j "${RAR_BUILD_JOBS:-2}"
        cp _o/7z.so "$output/lib/"
        c++ -std=c++17 -O2 -fPIC -shared -Wl,-z,defs -Wl,-rpath,'$ORIGIN' \
            -I "$sdk" "$bridge" -L "$output/lib" -l:7z.so -o "$output/lib/libtgdrive-rar.so"
        ;;
    Darwin)
        make -f makefile.gcc -j "${RAR_BUILD_JOBS:-2}" CC=clang CXX=clang++ MACOS_MODE=1 \
            CFLAGS_WARN_WALL="-Wall -Wextra" 'LDFLAGS=-dynamiclib -Wl,-install_name,@loader_path/7z.so'
        cp _o/7z.so "$output/lib/"
        clang++ -std=c++17 -O2 -dynamiclib -I "$sdk" "$bridge" "$output/lib/7z.so" \
            -o "$output/lib/libtgdrive-rar.so"
        ;;
esac
cp "$work/$archive" "$sdk/DOC/License.txt" "$sdk/DOC/copying.txt" "$sdk/DOC/unRarLicense.txt" "$output/licenses/"
