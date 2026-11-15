#!/usr/bin/env bash
set -eu
[ "${NEXUSPANEL_NEEDLE2_LIVE_TEST:-}" = 1 ] || { echo 'Set NEXUSPANEL_NEEDLE2_LIVE_TEST=1 to install the runtime in a disposable fixture.'; exit 0; }
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d /tmp/nexuspanel-needle-live.XXXXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
export INSTALL_DIR="$test_root/panel" INSTALL_AI=yes
mkdir -p "$INSTALL_DIR/backend" "$INSTALL_DIR/ai/needle2" "$INSTALL_DIR/models"
cp "$repo/backend/needle2_worker.py" "$INSTALL_DIR/backend/needle2_worker.py"
cp "$repo/ai/needle2/repair-tools.json" "$INSTALL_DIR/ai/needle2/repair-tools.json"
cp "$repo/models/nexuspanel-needle2-repair.cact" "$INSTALL_DIR/models/nexuspanel-needle2-repair.cact"
tr -d '\r' < "$repo/installers/nexuspanel-normal-v1.0.0-linux-installer.sh" | \
  awk '/^ask_ai\(\) \{/ || /^install_advanced_ai\(\) \{/ {copy=1} copy {print} copy && /^}$/ {copy=0}' > "$test_root/functions.sh"
info() { echo "$*"; }
warn() { echo "$*" >&2; exit 1; }
source "$test_root/functions.sh"
install_advanced_ai
test -x "$INSTALL_DIR/data/needle2/runtime-linux/bin/python"
echo 'Live Needle installer created a runtime and initialized the bundled model.'
