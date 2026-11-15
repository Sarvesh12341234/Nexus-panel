#!/usr/bin/env bash
set -eu

# Exercise the actual installer permission function against disposable paths.
# Run as root on Linux; no service, accounts, or system files are modified.
[ "$(id -u)" -eq 0 ] || { echo 'Run this isolated test as root.' >&2; exit 1; }
command -v runuser >/dev/null
id nobody >/dev/null
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d /tmp/nexuspanel-permissions-test.XXXXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
chmod 755 "$test_root"
export INSTALL_DIR="$test_root/panel" SERVICE_USER=nobody
mkdir -p "$INSTALL_DIR/backend" "$INSTALL_DIR/data" "$INSTALL_DIR/servers/isolated" \
  "$INSTALL_DIR/software" "$INSTALL_DIR/backups" "$INSTALL_DIR/backupfolder" \
  "$INSTALL_DIR/update/backups" "$test_root/varlib"
printf 'source' > "$INSTALL_DIR/backend/index.js"
printf 'secret' > "$INSTALL_DIR/data/setup_token"
printf 'isolated' > "$INSTALL_DIR/servers/isolated/game.dat"
chmod 600 "$INSTALL_DIR/servers/isolated/game.dat"
before="$(stat -c '%u:%g:%a' "$INSTALL_DIR/servers/isolated/game.dat")"

# Redirect the two host-wide paths into the fixture before sourcing the
# function, keeping the production function itself otherwise unchanged.
tr -d '\r' < "$repo/installers/nexuspanel-normal-v1.0.0-linux-installer.sh" | \
  awk '/^repair_install_permissions\(\) \{/ {copy=1} copy {print} copy && /^}$/ {exit}' | \
  sed "s|/var/lib/nexuspanel|$test_root/varlib|g; s|/usr/local/bin/nexuspanel|$test_root/cli|g" > "$test_root/function.sh"
info() { :; }
warn() { echo "$*" >&2; }
die() { echo "$*" >&2; exit 1; }
source "$test_root/function.sh"
repair_install_permissions

after="$(stat -c '%u:%g:%a' "$INSTALL_DIR/servers/isolated/game.dat")"
[ "$before" = "$after" ] || { echo 'Isolated server ownership or mode changed.' >&2; exit 1; }
runuser -u nobody -- test -r "$INSTALL_DIR/backend/index.js"
runuser -u nobody -- test -w "$INSTALL_DIR/data"
runuser -u nobody -- test -r "$INSTALL_DIR/data/setup_token"
runuser -u nobody -- test -w "$INSTALL_DIR/servers"
echo 'Installer permission fixture passed; isolated server files unchanged.'
