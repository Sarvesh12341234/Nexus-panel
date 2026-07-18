#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'NexusMark systemd security analysis requires root.' >&2
  exit 77
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
UNIT="nexusmark-security-analysis-$$"
IDENTITY="nexusmark-analyze-$$"
TEST_DIR="/var/lib/$IDENTITY"
cleanup() {
  systemctl stop "$UNIT.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$UNIT.service" >/dev/null 2>&1 || true
  userdel "$IDENTITY" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

mkdir -m 700 "$TEST_DIR" "$TEST_DIR/root"
cc -std=c11 -O2 -pipe -fPIE -static-pie -DNEXUS_STATIC_BUILD=1 -DNEXUS_HARDENED_BUILD=1 \
  -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fstack-clash-protection \
  -fcf-protection=full -ftrivial-auto-var-init=zero -fvisibility=hidden -fno-plt -flto \
  -Wformat -Wformat-security -Werror=format-security \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,separate-code \
  "$SOURCE_DIR/nexusmark.c" -o "$TEST_DIR/nexusmark-native"
useradd --system --user-group --no-create-home --home-dir "$TEST_DIR/root" \
  --shell /usr/sbin/nologin --comment 'NexusMark systemd analysis' "$IDENTITY"
passwd -l "$IDENTITY" >/dev/null
UID_VALUE="$(id -u "$IDENTITY")"
GID_VALUE="$(id -g "$IDENTITY")"
setfacl -m "u:$IDENTITY:r-x" "$TEST_DIR" "$TEST_DIR/nexusmark-native"
setfacl -m "u:$IDENTITY:rwx,d:u:$IDENTITY:rwx,d:g::---,d:o::---,d:m::rwx" "$TEST_DIR/root"

systemd-run --quiet --no-ask-password --unit="$UNIT" \
  --property="User=$IDENTITY" --property="Group=$IDENTITY" \
  --property=MemoryMax=256M --property=MemoryHigh=256M --property=MemorySwapMax=64M \
  --property=CPUQuota=100% --property=CPUWeight=100 --property=IOAccounting=yes \
  --property=IOWeight=100 --property=TasksMax=512 --property="WorkingDirectory=$TEST_DIR/root" \
  --property=NoNewPrivileges=yes --property=PrivateTmp=yes --property=PrivateDevices=yes \
  --property=ProtectSystem=strict --property="ReadWritePaths=$TEST_DIR/root" \
  --property=ProtectHome=yes --property=ProtectClock=yes --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes --property=ProtectKernelLogs=yes \
  --property=ProtectControlGroups=yes --property=ProtectHostname=yes --property=ProtectProc=invisible \
  --property=RestrictSUIDSGID=yes --property=LockPersonality=yes --property=UMask=0077 \
  --property=LimitCORE=0 --property=CapabilityBoundingSet= --property=RestrictNamespaces=yes \
  --property=RestrictRealtime=yes --property=KeyringMode=private --property=PrivateIPC=yes \
  --property=RemoveIPC=yes --property=PrivateMounts=yes \
  --property=SystemCallArchitectures=native \
  --property="SystemCallFilter=~@mount @swap @reboot @raw-io @privileged" \
  --property=PrivateUsers=yes --property=MemoryKSM=no \
  --property="RestrictAddressFamilies=AF_INET AF_INET6" \
  --property=SocketBindDeny=any --property=SocketBindAllow=tcp:65535 \
  --property=SocketBindAllow=udp:65535 --property=KillMode=control-group --property=OOMPolicy=stop \
  -- "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 65535 \
  --uid "$UID_VALUE" --gid "$GID_VALUE" -- /bin/sleep 30

for _ in $(seq 1 50); do
  [ "$(systemctl is-active "$UNIT.service" 2>/dev/null || true)" = active ] && break
  sleep 0.1
done
systemd-analyze security --no-pager "$UNIT.service" | tail -n 2
