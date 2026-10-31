#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${NEXUSPANEL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${NEXUSPANEL_UPDATE_BACKUP_DIR:-$APP_DIR/update/backups}"
SERVICE="${NEXUSPANEL_SERVICE_NAME:-nexuspanel}"
REMOTE="${NEXUSPANEL_REMOTE:-origin}"
BRANCH="${NEXUSPANEL_BRANCH:-}"
REPO_URL="${1:-${NEXUSPANEL_REPO_URL:-}}"
EDITION="${NEXUSPANEL_EDITION:-}"
if [ -z "$EDITION" ] && [ -f "$APP_DIR/data/edition" ]; then
  EDITION="$(tr -cd '[:alnum:]-' < "$APP_DIR/data/edition")"
fi
EDITION="${EDITION:-normal}"
case "$EDITION" in
  host|host-v*) UPDATE_TAG="${NEXUSPANEL_UPDATE_TAG:-v1.0.7}" ;;
  normal|normal-v*|*) UPDATE_TAG="${NEXUSPANEL_UPDATE_TAG:-v1.0.7}" ;;
esac
case "$UPDATE_TAG" in
  *-v*) EXPECTED_VERSION="${UPDATE_TAG##*-v}" ;;
  v*) EXPECTED_VERSION="${UPDATE_TAG#v}" ;;
  *) EXPECTED_VERSION="$UPDATE_TAG" ;;
esac

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR"
PREVIOUS_COMMIT=""
TARGET_COMMIT=""
UPDATE_SWITCHED=0
TEMP_DIR=""
STAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT="$BACKUP_DIR/code-$STAMP.tar.gz"

rollback_update() {
  local code=$?
  trap - ERR
  if [ "$UPDATE_SWITCHED" = "1" ] && [ -n "$PREVIOUS_COMMIT" ] && [ -d .git ]; then
    echo "[NexusPanel] Update failed. Restoring previous commit ${PREVIOUS_COMMIT:0:12}..." >&2
    git reset --hard "$PREVIOUS_COMMIT" || true
    npm install --no-audit --no-fund || true
    if command -v systemctl >/dev/null 2>&1; then
      systemctl restart "$SERVICE" || true
    fi
  elif [ "$UPDATE_SWITCHED" = "1" ] && [ -f "$SNAPSHOT" ]; then
    echo "[NexusPanel] Update failed. Restoring the previous code snapshot..." >&2
    tar -xzf "$SNAPSHOT" -C "$APP_DIR" || echo "[NexusPanel] Code snapshot restore failed: $SNAPSHOT" >&2
    npm install --no-audit --no-fund || true
    if command -v systemctl >/dev/null 2>&1; then
      systemctl restart "$SERVICE" || true
    fi
  fi
  exit "$code"
}

trap rollback_update ERR
trap 'if [ -n "$TEMP_DIR" ]; then rm -rf -- "$TEMP_DIR"; fi' EXIT

protect_path() {
  case "$1" in
    servers|data|backups|backupfolder|software|node_modules|.git|.env|update/backups) return 0 ;;
    *) return 1 ;;
  esac
}

echo "[NexusPanel][5%] Safe updater starting in $APP_DIR"
echo "[NexusPanel] Edition: $EDITION ($UPDATE_TAG)"
echo "[NexusPanel] Preserved paths: servers/, data/, backups/, backupfolder/, software/, node_modules/, .env"

tar --exclude='./servers' --exclude='./data' --exclude='./backups' --exclude='./backupfolder' --exclude='./software' --exclude='./node_modules' --exclude='./.git' --exclude='./.env' --exclude='./update/backups' -czf "$SNAPSHOT" .
echo "[NexusPanel][20%] Code snapshot saved: $SNAPSHOT"

if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  PREVIOUS_COMMIT="$(git rev-parse HEAD)"
  echo "[NexusPanel] Git repo detected. Pulling latest code..."
  if [ -n "$REPO_URL" ]; then
    if git remote get-url "$REMOTE" >/dev/null 2>&1; then
      git remote set-url "$REMOTE" "$REPO_URL"
    else
      git remote add "$REMOTE" "$REPO_URL"
    fi
  fi
  git fetch "$REMOTE" --prune --tags --force
  echo "[NexusPanel][45%] Release tags refreshed."
  if git rev-parse "$UPDATE_TAG^{}" >/dev/null 2>&1; then
    TARGET_COMMIT="$(git rev-parse "$UPDATE_TAG^{}")"
    BRANCH="${BRANCH:-main}"
    if git rev-parse "$REMOTE/$BRANCH" >/dev/null 2>&1; then
      BRANCH_COMMIT="$(git rev-parse "$REMOTE/$BRANCH")"
      BRANCH_VERSION="$(git show "$BRANCH_COMMIT:package.json" 2>/dev/null | node -e "let value='';process.stdin.on('data',c=>value+=c).on('end',()=>{try{process.stdout.write(JSON.parse(value).version||'')}catch{}})")"
      if [ "$BRANCH_VERSION" = "$EXPECTED_VERSION" ] && git merge-base --is-ancestor "$TARGET_COMMIT" "$BRANCH_COMMIT"; then
        TARGET_COMMIT="$BRANCH_COMMIT"
        echo "[NexusPanel] A newer verified $EXPECTED_VERSION patch exists on $REMOTE/$BRANCH; selecting it."
      fi
    fi
  else
    BRANCH="${BRANCH:-main}"
    TARGET_COMMIT="$(git rev-parse "$REMOTE/$BRANCH")"
  fi
  git reset --hard "$TARGET_COMMIT"
  UPDATE_SWITCHED=1
  INSTALLED_COMMIT="$(git rev-parse HEAD)"
  if [ "$INSTALLED_COMMIT" != "$TARGET_COMMIT" ]; then
    echo "[NexusPanel] Update verification failed: expected $TARGET_COMMIT, got $INSTALLED_COMMIT." >&2
    git reset --hard "$PREVIOUS_COMMIT"
    UPDATE_SWITCHED=0
    exit 1
  fi
  if [ ! -f package.json ]; then
    echo "[NexusPanel] Version verification failed: package.json is missing after the update." >&2
    git reset --hard "$PREVIOUS_COMMIT"
    UPDATE_SWITCHED=0
    exit 1
  fi
  INSTALLED_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  if [ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]; then
    echo "[NexusPanel] Version verification failed: tag expects $EXPECTED_VERSION, code reports $INSTALLED_VERSION." >&2
    git reset --hard "$PREVIOUS_COMMIT"
    UPDATE_SWITCHED=0
    exit 1
  fi
  echo "[NexusPanel][65%] Panel code verified at ${INSTALLED_COMMIT:0:12} ($INSTALLED_VERSION)."
else
  SOURCE_REPO="${REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nexuspanel-update.XXXXXX")"
  mkdir "$TEMP_DIR/source"
  echo "[NexusPanel] No Git metadata found; downloading $UPDATE_TAG and preserving existing user files."
  git clone --quiet --depth 1 --branch "$UPDATE_TAG" "$SOURCE_REPO" "$TEMP_DIR/repository"
  SOURCE_VERSION="$(node -p "require('$TEMP_DIR/repository/package.json').version")"
  if [ "$SOURCE_VERSION" != "$EXPECTED_VERSION" ]; then
    echo "[NexusPanel] Downloaded release version $SOURCE_VERSION; expected $EXPECTED_VERSION." >&2
    exit 1
  fi
  git -C "$TEMP_DIR/repository" archive --format=tar HEAD | tar -xf - -C "$TEMP_DIR/source"
  UPDATE_SWITCHED=1
  shopt -s dotglob nullglob
  for source_path in "$TEMP_DIR/source"/*; do
    entry="${source_path##*/}"
    if protect_path "$entry"; then
      continue
    fi
    cp -a -- "$source_path" "$APP_DIR/"
  done
  shopt -u dotglob nullglob
  echo "[NexusPanel][65%] Panel code verified at release $UPDATE_TAG ($SOURCE_VERSION)."
fi

if [ -f package.json ]; then
  npm install --no-audit --no-fund
  npm run build:asf || echo "[NexusPanel] Native ASF build unavailable; keeping systemd isolation fallback."
  npm run build:host-agent || echo "[NexusPanel] Native host agent build unavailable; restart the service installer after installing a C compiler."
fi
echo "[NexusPanel][85%] Dependencies verified."

mkdir -p "$APP_DIR/data"
printf '%s\n' "$EDITION" > "$APP_DIR/data/edition"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^$SERVICE.service"; then
  if [ "${NEXUSPANEL_WEB_UPDATE:-0}" = "1" ]; then
    systemctl restart "$SERVICE" --no-block
    echo "[NexusPanel] Service restart queued."
  else
    systemctl restart "$SERVICE"
    systemctl status "$SERVICE" --no-pager || true
  fi
else
  echo "[NexusPanel] Service not installed; start with: npm start"
fi

UPDATE_SWITCHED=0
echo "[NexusPanel][100%] Update complete. Existing user data and configuration were preserved."
