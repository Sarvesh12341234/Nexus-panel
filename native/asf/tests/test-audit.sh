#!/usr/bin/env bash
# ASF adversarial audit — requires root. Runs the sandbox as a dedicated
# unprivileged identity and proves it cannot read a root-owned secret outside
# the server root, cannot escalate, and cannot re-enter namespaces.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'ASF security audit requires root.' >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/src"
TEST_DIR="$(mktemp -d)"
IDENTITY="asf-audit-$$"
OUTSIDE_DIR="$(mktemp -d)"
trap 'userdel "$IDENTITY" 2>/dev/null || true; rm -rf "$TEST_DIR" "$OUTSIDE_DIR"' EXIT

COMMON_FLAGS=(-std=c11 -O2 -pipe -fPIE -fstack-protector-strong -Wformat -Wformat-security -Werror=format-security -Wl,-z,relro,-z,now,-z,noexecstack)

echo "[ASF] building runtime and audit payload..."
cc "${COMMON_FLAGS[@]}" "$SOURCE_DIR/asf_runtime.c" -o "$TEST_DIR/asf-runtime"
cc "${COMMON_FLAGS[@]}" "$SCRIPT_DIR/audit.c" -o "$TEST_DIR/root/asf-audit" 2>/dev/null || {
  mkdir -p "$TEST_DIR/root"
  cc "${COMMON_FLAGS[@]}" "$SCRIPT_DIR/audit.c" -o "$TEST_DIR/root/asf-audit"
}

useradd --system --no-create-home --shell /usr/sbin/nologin --comment 'ASF audit identity' "$IDENTITY"
UID_TARGET="$(id -u "$IDENTITY")"
GID_TARGET="$(id -g "$IDENTITY")"

mkdir -p "$TEST_DIR/root"
echo "top-secret" > "$OUTSIDE_DIR/secret"
chmod 600 "$OUTSIDE_DIR/secret"

setfacl -m "u:$IDENTITY:r-x" "$TEST_DIR" "$TEST_DIR/asf-runtime" 2>/dev/null || true
setfacl -R -m "u:$IDENTITY:rwx" "$TEST_DIR/root" 2>/dev/null || true

echo "[ASF] adversarial run as $IDENTITY (uid $UID_TARGET)..."
"$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 \
  --uid "$UID_TARGET" --gid "$GID_TARGET" \
  -- "$TEST_DIR/root/asf-audit" "$OUTSIDE_DIR/secret"

echo 'ASF adversarial native security audit passed.'
