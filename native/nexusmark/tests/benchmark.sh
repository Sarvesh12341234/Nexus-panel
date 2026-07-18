#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
TEST_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

COMMON_FLAGS=(-std=c11 -O2 -pipe -fPIE -static-pie -DNEXUS_STATIC_BUILD=1 -DNEXUS_HARDENED_BUILD=1 \
  -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fstack-clash-protection -fcf-protection=full \
  -ftrivial-auto-var-init=zero -fvisibility=hidden -fno-plt -flto \
  -Wformat -Wformat-security -Werror=format-security -Wall -Wextra \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,separate-code)
cc "${COMMON_FLAGS[@]}" "$SOURCE_DIR/nexusmark.c" -o "$TEST_DIR/nexusmark-native"
cc "${COMMON_FLAGS[@]}" "$SCRIPT_DIR/benchmark.c" -o "$TEST_DIR/nexusmark-benchmark"
mkdir -m 700 "$TEST_DIR/root"
cc "${COMMON_FLAGS[@]}" "$SCRIPT_DIR/workload.c" -o "$TEST_DIR/root/nexusmark-workload"

echo "BENCH_HOST kernel=$(uname -r) arch=$(uname -m) compiler=$(cc -dumpversion)"
echo 'BENCH_CASE startup=/bin/true'
"$TEST_DIR/nexusmark-benchmark" "$TEST_DIR/nexusmark-native" "$TEST_DIR/root" "${1:-1000}"
echo 'BENCH_CASE workload=8MiB-memory+8MiB-write+8MiB-read'
"$TEST_DIR/nexusmark-benchmark" "$TEST_DIR/nexusmark-native" "$TEST_DIR/root" "${2:-100}" "$TEST_DIR/root/nexusmark-workload"
