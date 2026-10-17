#!/usr/bin/env bash
# ASF runtime functional test — builds the sandbox and verifies it enforces
# filesystem confinement, port locking, and the exit-code contract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/src"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ASF tests require Linux." >&2
  exit 1
fi

COMMON_FLAGS=(-std=c11 -O2 -pipe -fPIE -fstack-protector-strong -Wformat -Wformat-security -Werror=format-security -Wl,-z,relro,-z,now,-z,noexecstack)

echo "[ASF] building runtime..."
cc "${COMMON_FLAGS[@]}" "$SOURCE_DIR/asf_runtime.c" -o "$TEST_DIR/asf-runtime"

echo "[ASF] probe..."
"$TEST_DIR/asf-runtime" --probe

mkdir -p "$TEST_DIR/root"
echo "inside" > "$TEST_DIR/root/inside.txt"
echo "secret" > "$TEST_DIR/outside.txt"

echo "[ASF] test 1: payload runs inside the sandbox"
"$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 -- /bin/cat "$TEST_DIR/root/inside.txt" > "$TEST_DIR/out1.txt"
grep -q inside "$TEST_DIR/out1.txt"

echo "[ASF] test 2: reading outside the server root is denied"
if "$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 -- /bin/cat "$TEST_DIR/outside.txt" > /dev/null 2>&1; then
  echo "FAIL: sandbox allowed a read outside the server root" >&2
  exit 1
fi

echo "[ASF] test 3: writing outside the server root is denied"
if "$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 -- /bin/sh -c "echo pwn > $TEST_DIR/outside.txt" > /dev/null 2>&1; then
  echo "FAIL: sandbox allowed a write outside the server root" >&2
  exit 1
fi

echo "[ASF] test 4: writing inside the server root is allowed"
"$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 -- /bin/sh -c "echo ok > $TEST_DIR/root/written.txt"
grep -q ok "$TEST_DIR/root/written.txt"

echo "[ASF] test 5: mount is denied"
if "$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 -- /bin/mount -t tmpfs none "$TEST_DIR/root/mnt" > /dev/null 2>&1; then
  echo "FAIL: sandbox allowed mount" >&2
  exit 1
fi

echo "[ASF] test 6: invalid arguments return exit 64"
set +e
"$TEST_DIR/asf-runtime" --root relative/path -- /bin/true > /dev/null 2>&1
code=$?
set -e
if [[ "$code" -ne 64 ]]; then
  echo "FAIL: expected exit 64 for invalid root, got $code" >&2
  exit 1
fi

echo "[ASF] test 7: missing payload returns exit 127"
set +e
"$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 -- /nonexistent/binary > /dev/null 2>&1
code=$?
set -e
if [[ "$code" -ne 127 ]]; then
  echo "FAIL: expected exit 127 for missing payload, got $code" >&2
  exit 1
fi

echo "[ASF] all functional tests passed."
