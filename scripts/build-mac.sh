#!/usr/bin/env sh
# 华山战力查询 · Mac 交叉编译打包。可在 Windows(Git Bash) / macOS / Linux 上运行，交叉编译到 darwin。
# 与 build.bat 对应；Mac 版会读取本地微信 Web 存储，并保留手动 Token 兜底。
set -e
cd "$(dirname "$0")/.."
VER="$(cat VERSION)"
UPD=""
[ ! -f deploy-url.txt ] || UPD="$(cat deploy-url.txt)"
mkdir -p bin

build() {
  arch="$1"
  out="bin/huashan-query-v${VER}-mac-${arch}"
  echo "Compiling ${out} ..."
  GOOS=darwin GOARCH="${arch}" CGO_ENABLED=0 go build -trimpath \
    -ldflags "-s -w -X main.version=v${VER} -X main.updateURL=${UPD}" \
    -o "${out}" ./apps/desktop
  echo "  done -> ${out}"
}

build arm64      # Apple Silicon（M1/M2/M3/M4…）

echo
echo "============================================"
echo "  完成：bin/huashan-query-v${VER}-mac-arm64"
echo "  发给朋友后，其首次在「终端」里运行："
echo "    chmod +x huashan-query-v${VER}-mac-arm64"
echo "    xattr -dr com.apple.quarantine huashan-query-v${VER}-mac-arm64"
echo "    ./huashan-query-v${VER}-mac-arm64"
echo "============================================"
