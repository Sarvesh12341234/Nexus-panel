#!/usr/bin/env bash
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d /tmp/nexuspanel-needle-installer.XXXXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
export INSTALL_DIR="$test_root/panel" INSTALL_AI=yes RECORD="$test_root/commands"
mkdir -p "$INSTALL_DIR/data/needle2" "$INSTALL_DIR/backend" "$INSTALL_DIR/models" "$test_root/bin"
head -c 2048 /dev/zero > "$INSTALL_DIR/models/nexuspanel-needle2-repair.cact"
cat > "$test_root/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
set -eu
[ "$1" = '-m' ] && [ "$2" = 'venv' ]
mkdir -p "$3/bin"
cat > "$3/bin/python" <<'RUNTIME'
#!/usr/bin/env bash
if [ "${1:-}" = '-m' ]; then
  echo "pip $*" >> "$RECORD"
else
  echo '{"ready": true}'
  echo 'probe' >> "$RECORD"
fi
RUNTIME
chmod 755 "$3/bin/python"
echo 'venv' >> "$RECORD"
PYTHON
chmod 755 "$test_root/bin/python3"
export PATH="$test_root/bin:$PATH"
tr -d '\r' < "$repo/installers/nexuspanel-normal-v1.0.4-linux-installer.sh" | \
  awk '/^ask_ai\(\) \{/ || /^install_advanced_ai\(\) \{/ {copy=1} copy {print} copy && /^}$/ {copy=0}' > "$test_root/functions.sh"
info() { :; }
warn() { echo "$*" >&2; }
source "$test_root/functions.sh"
install_advanced_ai
grep -q '^venv$' "$RECORD"
grep -q '^pip -m pip install cactus-needle==2.0.15$' "$RECORD"
grep -q '^probe$' "$RECORD"
INSTALL_AI=no
: > "$RECORD"
install_advanced_ai
[ ! -s "$RECORD" ] || { echo 'Opting out must skip runtime installation.' >&2; exit 1; }
echo 'Needle installer setup, initialization probe, and opt-out tests passed.'
