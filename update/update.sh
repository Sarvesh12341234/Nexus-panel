#!/usr/bin/env bash
set -euo pipefail

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
  host|host-v*) UPDATE_TAG="${NEXUSPANEL_UPDATE_TAG:-host-v2.0.0}" ;;
  normal|normal-v*|*) UPDATE_TAG="${NEXUSPANEL_UPDATE_TAG:-normal-v2.0.0}" ;;
esac

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT="$BACKUP_DIR/code-$STAMP.tar.gz"

protect_path() {
  case "$1" in
    servers|data|backups|backupfolder|software|node_modules|.git|update/backups) return 0 ;;
    *) return 1 ;;
  esac
}

echo "[NexusPanel][5%] Safe updater starting in $APP_DIR"
echo "[NexusPanel] Edition: $EDITION ($UPDATE_TAG)"
echo "[NexusPanel] Minecraft data is protected: servers/, data/, backups/, backupfolder/, software/"

tar --exclude='./servers' --exclude='./data' --exclude='./backups' --exclude='./backupfolder' --exclude='./software' --exclude='./node_modules' --exclude='./.git' --exclude='./update/backups' -czf "$SNAPSHOT" .
echo "[NexusPanel][20%] Code snapshot saved: $SNAPSHOT"

if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  echo "[NexusPanel] Git repo detected. Pulling latest code..."
  if [ -n "$REPO_URL" ]; then
    if git remote get-url "$REMOTE" >/dev/null 2>&1; then
      git remote set-url "$REMOTE" "$REPO_URL"
    else
      git remote add "$REMOTE" "$REPO_URL"
    fi
  fi
  git fetch "$REMOTE" --tags --force
  echo "[NexusPanel][45%] Release tags refreshed."
  if git rev-parse "$UPDATE_TAG^{}" >/dev/null 2>&1; then
    git reset --hard "$UPDATE_TAG"
  else
    if [ -z "$BRANCH" ]; then
      BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    fi
    git reset --hard "$REMOTE/$BRANCH"
  fi
  echo "[NexusPanel][65%] Panel code switched to $UPDATE_TAG."
else
  echo "[NexusPanel] No git repo detected. Copy new source into this folder, then run this updater again."
fi

if [ -f package.json ]; then
  npm install
  echo "[NexusPanel][80%] Installing Live Spectate bot/viewer dependencies..."
  npm install --no-save --no-audit --no-fund \
    bedrock-protocol \
    mineflayer \
    prismarine-chunk \
    prismarine-registry \
    prismarine-viewer
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

echo "[NexusPanel][100%] Update complete. Protected data was not touched."
