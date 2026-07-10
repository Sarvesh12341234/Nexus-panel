#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${NEXUSPANEL_REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
INSTALL_DIR="${NEXUSPANEL_INSTALL_DIR:-/opt/nexuspanel}"
SERVICE_USER="${NEXUSPANEL_SERVICE_USER:-root}"
EDITION="${NEXUSPANEL_EDITION:-normal}"
SERVICE_NAME="${NEXUSPANEL_SERVICE_NAME:-nexuspanel}"
RELEASE_TAG="${NEXUSPANEL_RELEASE_TAG:-${EDITION}-v1.2.0}"
NODE_PATH=""

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo bash installers/nexuspanel-normal-v1.2.0-linux-installer.sh"
    exit 1
  fi
}

require_service_user() {
  if [ "$SERVICE_USER" != "root" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Service user '$SERVICE_USER' does not exist."
    echo "Create it first or install with: sudo NEXUSPANEL_SERVICE_USER=root bash ..."
    exit 1
  fi
}

install_packages() {
  echo "[1/7] Updating package index and installing system dependencies..."

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl ca-certificates git unzip tar xz-utils build-essential systemd
    if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >/dev/null 2>&1; then
      echo "Installing Node.js 22..."
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

  if [ -d "${INSTALL_DIR}/.git" ]; then
    echo "Updating existing installation..."
    git -C "${INSTALL_DIR}" fetch origin --tags --force
    git -C "${INSTALL_DIR}" reset --hard "${RELEASE_TAG}"
  elif [ -d "${INSTALL_DIR}" ] && [ "$(find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
    echo "${INSTALL_DIR} exists and is not empty."
    echo "Set NEXUSPANEL_INSTALL_DIR to a new folder or move the existing folder first."
    exit 1
  else
    echo "Cloning repository..."
    git clone --branch "${RELEASE_TAG}" --single-branch "${REPO_URL}" "${INSTALL_DIR}"
  fi

  cd "${INSTALL_DIR}"
  NODE_PATH="$(command -v node)"

  echo "[3/7] Installing Node.js dependencies..."
  npm install --omit=optional --no-audit --no-fund
  npm install --include=optional --no-audit --no-fund || true
}

prepare_paths() {
  echo "[4/7] Preparing data folders and permissions..."
  cd "${INSTALL_DIR}"
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
  cat > /usr/local/bin/nexuspanel << EOF
#!/usr/bin/env sh
exec "${NODE_PATH}" "${INSTALL_DIR}/backend/cli.js" "\$@"
EOF
  chmod 755 /usr/local/bin/nexuspanel
}

setup_owner() {
  echo "[6/7] Owner account setup..."
  cd "${INSTALL_DIR}"
  NEXUSPANEL_SERVICE_USER="$SERVICE_USER" "$NODE_PATH" "${INSTALL_DIR}/backend/cli.js" setup-owner
}

install_service() {
  echo "[7/7] Installing and starting systemd service..."
  cd "${INSTALL_DIR}"
  NEXUSPANEL_SERVICE_NAME="$SERVICE_NAME" NEXUSPANEL_SERVICE_USER="$SERVICE_USER" "$NODE_PATH" "${INSTALL_DIR}/backend/service.js" install
  sleep 2
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "Service failed to start. Check logs with:"
    echo "  sudo journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    exit 1
  fi
}

show_info() {
  local PUBLIC_IP
  PUBLIC_IP="$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")"
  echo
  echo "NexusPanel installed successfully."
  echo "Panel URL:   http://${PUBLIC_IP}:3000"
  echo "Service:     ${SERVICE_NAME}"
  echo "Install dir: ${INSTALL_DIR}"
  echo "Edition:     ${EDITION}"
  echo
  echo "Commands:"
  echo "  nexuspanel status"
  echo "  nexuspanel logs"
  echo "  nexuspanel start"
  echo "  nexuspanel stop"
  echo "  nexuspanel restart"
}

main() {
  echo "NexusPanel Linux Installer v1.2.0"
  echo
  need_root
  require_service_user
  install_packages
  install_panel
  prepare_paths
  install_cli
  setup_owner
  install_service
  show_info
}

main
