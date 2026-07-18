#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${NEXUSPANEL_REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
INSTALL_DIR="${NEXUSPANEL_INSTALL_DIR:-/opt/nexuspanel}"
SERVICE_USER="${NEXUSPANEL_SERVICE_USER:-root}"
EDITION="${NEXUSPANEL_EDITION:-normal}"
SERVICE_NAME="${NEXUSPANEL_SERVICE_NAME:-nexuspanel}"
RELEASE_TAG="${NEXUSPANEL_RELEASE_TAG:-${EDITION}-v3.0.0}"
NODE_PATH=""

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo bash installers/nexuspanel-normal-v3.0.0-linux-installer.sh"
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
    apt-get install -y curl ca-certificates git unzip tar xz-utils build-essential systemd acl passwd util-linux
    if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >/dev/null 2>&1; then
      echo "Installing Node.js 24 LTS..."
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
      apt-get install -y nodejs
    fi
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf makecache
    dnf install -y curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm systemd acl shadow-utils util-linux
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum makecache
    yum install -y curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm systemd acl shadow-utils util-linux
    return
  fi

  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive refresh
    zypper --non-interactive install curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm systemd acl shadow util-linux
    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed curl ca-certificates git unzip tar xz gcc make nodejs npm systemd acl shadow util-linux
    return
  fi

  echo "Unsupported Linux package manager. Install Node.js 24+, a C compiler, git, ACL tools, account tools, and systemd when available."
  exit 1
}

install_tunnel_tools() {
  echo "[1b/7] Installing optional normal-edition tunnel helpers..."
  local ARCH
  ARCH="$(uname -m)"
  local NGROK_ARCH="amd64"
  local PLAYIT_ARCH="amd64"
  case "$ARCH" in
    x86_64|amd64) NGROK_ARCH="amd64"; PLAYIT_ARCH="amd64" ;;
    aarch64|arm64) NGROK_ARCH="arm64"; PLAYIT_ARCH="aarch64" ;;
    *) echo "Unknown architecture ${ARCH}; skipping ngrok/playit helper download."; return 0 ;;
  esac

  if ! command -v ngrok >/dev/null 2>&1; then
    curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.tgz" \
      | tar -xz -C /usr/local/bin ngrok || echo "ngrok helper install skipped."
    [ -x /usr/local/bin/ngrok ] && chmod 755 /usr/local/bin/ngrok || true
  fi

  if ! command -v playit >/dev/null 2>&1; then
    curl -fsSL "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${PLAYIT_ARCH}" \
      -o /usr/local/bin/playit && chmod 755 /usr/local/bin/playit || echo "playit helper install skipped."
  fi
}

install_panel() {
  echo "[2/7] Installing NexusPanel ${RELEASE_TAG} to ${INSTALL_DIR}..."

  if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"; then
    echo "Node.js 24 LTS or newer is required. Install it from your distribution or NodeSource, then rerun this installer."
    exit 1
  fi

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
  npm run build:nexusmark || echo "NexusMark native runtime is unavailable; the systemd kernel sandbox remains enabled."
  npm run build:host-agent || echo "Native host agent build deferred to service installation."
}

install_advanced_ai() {
  cd "${INSTALL_DIR}"
  local WANT_AI="${NEXUSPANEL_INSTALL_ADVANCED_AI:-ask}"
  if [ "$WANT_AI" = "ask" ]; then
    echo
    echo "Advanced AI reasoning is optional."
    echo "Model: onnx-community/Qwen2.5-Coder-0.5B-Instruct (q4 local ONNX). First setup downloads the quantized model/cache."
    echo "The coding model proposes diagnoses and typed tools; policy checks and owner approval control mutations."
    read -r -p "Install advanced AI now? [y/N]: " WANT_AI
  fi
  case "${WANT_AI}" in
    y|Y|yes|YES|1|true|TRUE)
      echo "[3b/7] Installing advanced AI package and model cache..."
      npm install @huggingface/transformers@latest --no-audit --no-fund
      "$NODE_PATH" "${INSTALL_DIR}/backend/advanced_ai.js" || echo "Advanced AI install skipped after model download error. You can retry from Settings."
      ;;
    *)
      echo "Advanced AI skipped. The panel will use the built-in deterministic repair brain."
      ;;
  esac
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
  echo "NexusPanel Linux Installer v3.0.0"
  echo
  need_root
  require_service_user
  install_packages
  if [ "$EDITION" = "normal" ]; then
    install_tunnel_tools
  fi
  install_panel
  install_advanced_ai
  prepare_paths
  install_cli
  setup_owner
  install_service
  show_info
}

main
