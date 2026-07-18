#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'NexusMark security audit requires root.' >&2
  exit 77
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
IDENTITY="nexusmark-audit-$$"
TEST_DIR="/var/lib/$IDENTITY"
OUTSIDE_DIR="/var/lib/${IDENTITY}-outside"
cleanup() {
  userdel "$IDENTITY" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIR" "$OUTSIDE_DIR"
}
trap cleanup EXIT

mkdir -m 700 "$TEST_DIR" "$TEST_DIR/root" "$OUTSIDE_DIR"
printf 'cross-server-secret\n' > "$OUTSIDE_DIR/secret"

COMMON_FLAGS=(-std=c11 -O2 -pipe -fPIE -static-pie -DNEXUS_STATIC_BUILD=1 -DNEXUS_HARDENED_BUILD=1 \
  -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fstack-clash-protection -fcf-protection=full \
  -ftrivial-auto-var-init=zero -fvisibility=hidden -fno-plt -flto \
  -Wformat -Wformat-security -Werror=format-security -Wall -Wextra \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,separate-code)
cc "${COMMON_FLAGS[@]}" "$SOURCE_DIR/nexusmark.c" -o "$TEST_DIR/nexusmark-native"
cc "${COMMON_FLAGS[@]}" "$SCRIPT_DIR/audit.c" -o "$TEST_DIR/root/nexusmark-audit"

useradd --system --user-group --no-create-home --home-dir "$TEST_DIR/root" \
  --shell /usr/sbin/nologin --comment 'NexusMark audit identity' "$IDENTITY"
passwd -l "$IDENTITY" >/dev/null
UID_VALUE="$(id -u "$IDENTITY")"
GID_VALUE="$(id -g "$IDENTITY")"

setfacl -m "u:$IDENTITY:r-x" "$TEST_DIR" "$TEST_DIR/nexusmark-native"
setfacl -R -P -m "u:$IDENTITY:rw-,g::---,o::---,m::rwx" "$TEST_DIR/root"
setfacl -m "u:$IDENTITY:rwx,g::---,o::---,m::rwx,d:u:$IDENTITY:rwx,d:g::---,d:o::---,d:m::rwx" "$TEST_DIR/root"
setfacl -m "u:$IDENTITY:r-x" "$TEST_DIR/root/nexusmark-audit"

LD_PRELOAD=/does/not/exist NODE_OPTIONS=--inspect PYTHONPATH=/host-poison \
  "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 65535 \
  --uid "$UID_VALUE" --gid "$GID_VALUE" -- \
  "$TEST_DIR/root/nexusmark-audit" "$OUTSIDE_DIR/secret"

echo 'NexusMark adversarial native security audit passed.'
