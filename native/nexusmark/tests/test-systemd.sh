#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
if [ "$(id -u)" -ne 0 ]; then
  echo 'NexusMark systemd policy test requires root; native tests remain unprivileged.'
  exit 77
fi
TEST_DIR="/var/lib/nexusmark-policy-test-$$"
mkdir -m 700 "$TEST_DIR"
UNIT="nexusmark-policy-test-$$"
trap 'systemctl reset-failed "$UNIT.service" >/dev/null 2>&1 || true; rm -rf "$TEST_DIR"' EXIT

cc -std=c11 -O2 -pipe -fPIE -static-pie -DNEXUS_STATIC_BUILD=1 -DNEXUS_HARDENED_BUILD=1 \
  -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fstack-clash-protection \
  -fcf-protection=full -ftrivial-auto-var-init=zero -fvisibility=hidden -fno-plt -flto \
  -Wformat -Wformat-security -Werror=format-security \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,separate-code \
  "$SOURCE_DIR/nexusmark.c" -o "$TEST_DIR/nexusmark-native"
mkdir -p "$TEST_DIR/root"

PAYLOAD=(/bin/true)
if command -v java >/dev/null 2>&1; then PAYLOAD=("$(command -v java)" -version); fi

systemd-run --pipe --wait --collect --no-ask-password --unit="$UNIT" \
  --property=MemoryMax=256M \
  --property=MemoryHigh=256M \
  --property=MemorySwapMax=64M \
  --property=CPUQuota=100% \
  --property=CPUWeight=100 \
  --property=IOAccounting=yes \
  --property=IOWeight=100 \
  --property=TasksMax=512 \
  --property="WorkingDirectory=$TEST_DIR/root" \
  --property=NoNewPrivileges=yes \
  --property=PrivateTmp=yes \
  --property=ProtectSystem=strict \
  --property="ReadWritePaths=$TEST_DIR/root" \
  --property=RestrictSUIDSGID=yes \
  --property=LockPersonality=yes \
  --property=UMask=0077 \
  --property=LimitCORE=0 \
  --property=CapabilityBoundingSet= \
  --property=KillMode=control-group \
  --property=OOMScoreAdjust=500 \
  --property=OOMPolicy=stop \
  --property=PrivateDevices=yes \
  --property=ProtectHome=yes \
  --property=ProtectClock=yes \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectKernelLogs=yes \
  --property=ProtectControlGroups=yes \
  --property=ProtectHostname=yes \
  --property=RestrictNamespaces=yes \
  --property=RestrictRealtime=yes \
  --property=KeyringMode=private \
  --property=PrivateIPC=yes \
  --property=RemoveIPC=yes \
  --property=PrivateMounts=yes \
  --property=ProtectProc=invisible \
  --property="RestrictAddressFamilies=AF_INET AF_INET6" \
  --property=SocketBindDeny=any \
  --property=SocketBindAllow=tcp:65535 \
  --property=SocketBindAllow=udp:65535 \
  --property=SystemCallArchitectures=native \
  --property="SystemCallFilter=~@mount @swap @reboot @raw-io @privileged" \
  --property=PrivateUsers=yes \
  --property=MemoryKSM=no \
  -- "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 65535 -- "${PAYLOAD[@]}"

echo 'NexusMark maximum systemd policy test passed.'
