#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${NEXUSPANEL_REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
INSTALL_DIR="${NEXUSPANEL_INSTALL_DIR:-/opt/nexuspanel}"
SERVICE_USER="${NEXUSPANEL_SERVICE_USER:-root}"
EDITION="${NEXUSPANEL_EDITION:-host}"
SERVICE_NAME="${NEXUSPANEL_SERVICE_NAME:-nexuspanel}"
RELEASE_TAG="${NEXUSPANEL_RELEASE_TAG:-host-v2.0.0}"
NODE_PATH=""

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: curl -fsSL ... | sudo bash"
    exit 1
  fi
}

require_service_user() {
  if [ "$SERVICE_USER" != "root" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Service user '$SERVICE_USER' does not exist."
    exit 1
  fi
}

install_packages() {
  echo "[1/7] Updating package index and installing system dependencies..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl ca-certificates git unzip tar xz-utils build-essential systemd
    if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
    fi
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    dnf makecache
    dnf install -y curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm systemd
    return
  fi
  if command -v yum >/dev/null 2>&1; then
    yum makecache
    yum install -y curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm systemd
    return
  fi
  echo "Unsupported Linux package manager. Install Node.js 22+, git, unzip, tar, and systemd."
  exit 1
}

install_panel() {
  echo "[2/7] Installing NexusPanel ${RELEASE_TAG} to ${INSTALL_DIR}..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch origin --tags --force
    git -C "$INSTALL_DIR" reset --hard "$RELEASE_TAG"
  elif [ -d "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
    echo "$INSTALL_DIR exists and is not empty. Set NEXUSPANEL_INSTALL_DIR to a new folder."
    exit 1
  else
    git clone --branch "$RELEASE_TAG" --single-branch "$REPO_URL" "$INSTALL_DIR"
  fi

  cd "$INSTALL_DIR"
  NODE_PATH="$(command -v node)"
  echo "[3/7] Installing Node.js dependencies..."
  npm install --omit=optional --no-audit --no-fund
  npm install --include=optional --no-audit --no-fund || true
}

prepare_paths() {
  echo "[4/7] Preparing data folders and permissions..."
  cd "$INSTALL_DIR"
  mkdir -p data servers software backups backupfolder update/backups /var/lib/nexuspanel/backups /var/lib/nexuspanel/logs /var/lib/nexuspanel/nexus-mark
  printf '%s\n' "$EDITION" > data/edition
  [ -f update/update.sh ] && chmod 755 update/update.sh
  chmod 750 data servers software backups backupfolder update/backups /var/lib/nexuspanel /var/lib/nexuspanel/backups /var/lib/nexuspanel/logs /var/lib/nexuspanel/nexus-mark
  if [ "$SERVICE_USER" != "root" ]; then
    local SERVICE_GROUP
    SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
    chown -R "${SERVICE_USER}:${SERVICE_GROUP}" data servers software backups backupfolder update/backups /var/lib/nexuspanel
  fi
}

install_cli() {
  echo "[5/7] Installing nexuspanel command..."
  printf '#!/usr/bin/env sh\nexec "%s" "%s" "$@"\n' "$NODE_PATH" "$INSTALL_DIR/backend/cli.js" > /usr/local/bin/nexuspanel
  chmod 755 /usr/local/bin/nexuspanel
}

setup_owner() {
  echo "[6/7] Owner account setup..."
  cd "$INSTALL_DIR"
  NEXUSPANEL_SERVICE_USER="$SERVICE_USER" "$NODE_PATH" "$INSTALL_DIR/backend/cli.js" setup-owner
}

install_service() {
  echo "[7/7] Installing and starting systemd service..."
  cd "$INSTALL_DIR"
  NEXUSPANEL_SERVICE_NAME="$SERVICE_NAME" NEXUSPANEL_SERVICE_USER="$SERVICE_USER" "$NODE_PATH" "$INSTALL_DIR/backend/service.js" install
  sleep 2
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "Service failed to start. Check logs with:"
    echo "  sudo journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    exit 1
  fi
}

need_root
require_service_user
install_packages
install_panel
prepare_paths
install_cli
setup_owner
install_service

echo
echo "NexusPanel Host Edition installed."
echo "Use: nexuspanel status"
echo "Logs: nexuspanel logs"
echo "Open: http://YOUR_VPS_IP:3000"
