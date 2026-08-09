#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'NexusMark identity test requires root.'
  exit 77
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
IDENTITY="nexusmark-test-$$"
TEST_DIR="/var/lib/$IDENTITY"
OUTSIDE_DIR="/var/lib/${IDENTITY}-outside"
cleanup() {
  userdel "$IDENTITY" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIR" "$OUTSIDE_DIR"
}
trap cleanup EXIT

mkdir -m 700 "$TEST_DIR" "$OUTSIDE_DIR"
printf 'other-server-secret\n' > "$OUTSIDE_DIR/secret"
cc -std=c11 -O2 -pipe -fPIE -static-pie -DNEXUS_STATIC_BUILD=1 -DNEXUS_HARDENED_BUILD=1 \
  -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fstack-clash-protection \
  -fcf-protection=full -ftrivial-auto-var-init=zero -fvisibility=hidden -fno-plt -flto \
  -Wformat -Wformat-security -Werror=format-security \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,separate-code \
  "$SOURCE_DIR/nexusmark.c" -o "$TEST_DIR/nexusmark-native"
mkdir -m 700 "$TEST_DIR/root"
printf 'server-owned-secret\n' > "$TEST_DIR/root/existing-secret"

useradd --system --user-group --no-create-home --home-dir "$TEST_DIR/root" \
  --shell /usr/sbin/nologin --comment 'NexusMark identity test' "$IDENTITY"
passwd -l "$IDENTITY" >/dev/null
UID_VALUE="$(id -u "$IDENTITY")"
GID_VALUE="$(id -g "$IDENTITY")"
setfacl -m "u:$IDENTITY:r-x" "$TEST_DIR" "$TEST_DIR/nexusmark-native"
setfacl -R -P -m "u:$IDENTITY:rw-,g::---,o::---,m::rwx" "$TEST_DIR/root"
setfacl -m "u:$IDENTITY:rwx,g::---,o::---,m::rwx,d:u:$IDENTITY:rwx,d:g::---,d:o::---,d:m::rwx" "$TEST_DIR/root"
runuser -u "$IDENTITY" -- /bin/sh -c 'printf private > "$1/new-secret"' sh "$TEST_DIR/root"
runuser -u "$IDENTITY" -- /bin/cat "$TEST_DIR/root/existing-secret" >/dev/null
if runuser -u nobody -- /bin/cat "$TEST_DIR/root/new-secret" >/dev/null 2>&1; then
  echo 'unrelated UID could read a server file' >&2
  exit 1
fi

ACTUAL_UID="$($TEST_DIR/nexusmark-native --root "$TEST_DIR/root" --port 65535 \
  --uid "$UID_VALUE" --gid "$GID_VALUE" -- /usr/bin/id -u)"
test "$ACTUAL_UID" = "$UID_VALUE"
passwd -S "$IDENTITY" | grep -Eq "^${IDENTITY} L "

if runuser -u "$IDENTITY" -- /bin/cat "$OUTSIDE_DIR/secret" >/dev/null 2>&1; then
  echo 'dedicated UID could read another server directory' >&2
  exit 1
fi

if command -v java >/dev/null 2>&1; then
  "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 65535 \
    --uid "$UID_VALUE" --gid "$GID_VALUE" -- "$(command -v java)" -version >/dev/null
fi

if command -v systemd-run >/dev/null 2>&1 && [ "$(systemctl is-system-running 2>/dev/null || true)" != "offline" ]; then
  UNIT="nexusmark-identity-test-$$"
  systemd-run --quiet --wait --collect --unit "$UNIT" \
    --property "User=$IDENTITY" --property "Group=$IDENTITY" \
    --property NoNewPrivileges=yes --property PrivateTmp=yes \
    --property PrivateUsers=yes --property ProtectControlGroups=yes \
    "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 65535 \
    --uid "$UID_VALUE" --gid "$GID_VALUE" -- /usr/bin/test "$(id -u "$IDENTITY")" -gt 0
fi

echo "NexusMark dedicated identity test passed (UID $UID_VALUE)."
