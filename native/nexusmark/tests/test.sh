#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

cc -std=c11 -O2 -pipe -fPIE -static-pie -DNEXUS_STATIC_BUILD=1 -DNEXUS_HARDENED_BUILD=1 \
  -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fstack-clash-protection \
  -fcf-protection=full -ftrivial-auto-var-init=zero -fvisibility=hidden -fno-plt -flto \
  -Wformat -Wformat-security -Wall -Wextra \
  -Wl,-z,relro,-z,now,-z,noexecstack,-z,separate-code \
  "$SOURCE_DIR/nexusmark.c" -o "$TEST_DIR/nexusmark-native"

"$TEST_DIR/nexusmark-native" --probe
mkdir -p "$TEST_DIR/root" "$TEST_DIR/outside"
printf 'private\n' > "$TEST_DIR/outside/secret"
HOST_PROCESS_ENV="/proc/1/environ"

"$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 25565 -- \
  /bin/sh -c 'printf "inside\n" > created.txt; test -r /etc/resolv.conf'
test "$(cat "$TEST_DIR/root/created.txt")" = inside

if "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 25565 -- \
  /bin/cat "$TEST_DIR/outside/secret" >/dev/null 2>&1; then
  echo 'filesystem escape was not blocked' >&2
  exit 1
fi

if "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 25565 -- \
  /bin/cat "$HOST_PROCESS_ENV" >/dev/null 2>&1; then
  echo 'host process metadata escape was not blocked' >&2
  exit 1
fi

if "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 25565 -- \
  /bin/chmod 777 "$TEST_DIR/outside/secret" >/dev/null 2>&1; then
  echo 'metadata syscall escape was not blocked' >&2
  exit 1
fi

if "$TEST_DIR/nexusmark-native" --root "$TEST_DIR/root" --port 25565 -- \
  /bin/mount --bind "$TEST_DIR/outside" "$TEST_DIR/root" >/dev/null 2>&1; then
  echo 'mount syscall was not blocked' >&2
  exit 1
fi

echo 'NexusMark native isolation tests passed.'
