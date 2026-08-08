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
    echo "Run as root:"
    echo "sudo bash installers/nexuspanel-normal-v3.0.0-linux-installer.sh"
    exit 1
  fi
}

require_service_user() {
  if [ "$SERVICE_USER" != "root" ] &&
     ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Service user '$SERVICE_USER' does not exist."
    exit 1
  fi
}

install_packages() {
  echo "[1/7] Updating package index and installing dependencies..."

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update

    apt-get install -y \
      curl \
      ca-certificates \
      git \
      unzip \
      tar \
      xz-utils \
      build-essential \
      systemd \
      acl \
      passwd \
      util-linux

    if ! command -v node >/dev/null 2>&1 ||
       ! node -e \
       "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" \
       >/dev/null 2>&1; then

      echo "Installing Node.js 24 LTS..."

      curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
      apt-get install -y nodejs
    fi

    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf makecache

    dnf install -y \
      curl ca-certificates git unzip tar xz \
      gcc gcc-c++ make nodejs npm \
      systemd acl shadow-utils util-linux

    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum makecache

    yum install -y \
      curl ca-certificates git unzip tar xz \
      gcc gcc-c++ make nodejs npm \
      systemd acl shadow-utils util-linux

    return
  fi

  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive refresh

    zypper --non-interactive install \
      curl ca-certificates git unzip tar xz \
      gcc gcc-c++ make nodejs npm \
      systemd acl shadow util-linux

    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed \
      curl ca-certificates git unzip tar xz \
      gcc make nodejs npm systemd acl shadow util-linux

    return
  fi

  echo "Unsupported Linux distribution."
  exit 1
}

install_tunnel_tools() {
  echo "[1b/7] Installing tunnel helpers..."

  local ARCH
  ARCH="$(uname -m)"

  local NGROK_ARCH="amd64"
  local PLAYIT_ARCH="amd64"

  case "$ARCH" in
    x86_64|amd64)
      NGROK_ARCH="amd64"
      PLAYIT_ARCH="amd64"
      ;;

    aarch64|arm64)
      NGROK_ARCH="arm64"
      PLAYIT_ARCH="aarch64"
      ;;

    *)
      echo "Unknown architecture: $ARCH"
      echo "Skipping tunnel helpers."
      return 0
      ;;
  esac

  if ! command -v ngrok >/dev/null 2>&1; then
    echo "Installing ngrok..."

    if curl -fsSL \
      "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.tgz" |
      tar -xz -C /usr/local/bin ngrok; then

      chmod 755 /usr/local/bin/ngrok
    else
      echo "WARNING: ngrok installation failed."
    fi
  else
    echo "ngrok already installed."
  fi

  if ! command -v playit >/dev/null 2>&1; then
    echo "Installing playit..."

    if curl -fsSL \
      "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${PLAYIT_ARCH}" \
      -o /usr/local/bin/playit; then

      chmod 755 /usr/local/bin/playit
    else
      echo "WARNING: playit installation failed."
    fi
  else
    echo "playit already installed."
  fi
}

install_panel() {
  echo "[2/7] Installing NexusPanel ${RELEASE_TAG}..."
  echo "Install directory: ${INSTALL_DIR}"

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed."
    exit 1
  fi

  local NODE_MAJOR
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"

  if [ "$NODE_MAJOR" -lt 24 ]; then
    echo "Node.js 24 or newer is required."
    echo "Current version: $(node --version)"
    exit 1
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -d "${INSTALL_DIR}/.git" ]; then

    echo "Existing NexusPanel installation detected."
    echo "Updating repository..."

    git -C "${INSTALL_DIR}" fetch origin --tags --force

    git -C "${INSTALL_DIR}" reset --hard "${RELEASE_TAG}"

  elif [ -d "${INSTALL_DIR}" ] &&
       [ "$(find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then

    echo "${INSTALL_DIR} exists and is not empty."

    echo "Use another directory with:"
    echo "NEXUSPANEL_INSTALL_DIR=/some/path"

    exit 1

  else

    echo "Cloning NexusPanel..."

    git clone \
      --branch "${RELEASE_TAG}" \
      --single-branch \
      "${REPO_URL}" \
      "${INSTALL_DIR}"
  fi

  cd "${INSTALL_DIR}"

  NODE_PATH="$(command -v node)"

  echo "[3/7] Installing Node.js dependencies..."

  npm install \
    --omit=optional \
    --no-audit \
    --no-fund

  npm install \
    --include=optional \
    --no-audit \
    --no-fund || true

  echo "Building NexusMark..."

  npm run build:nexusmark || {
    echo "NexusMark native runtime unavailable."
    echo "Continuing with systemd sandbox."
  }

  echo "Building host agent..."

  npm run build:host-agent || {
    echo "Host agent native build deferred."
  }
}

install_advanced_ai() {

  echo
  echo "=============================================="
  echo " NexusPanel Advanced AI"
  echo "=============================================="
  echo
  echo "Model:"
  echo "  onnx-community/Qwen2.5-Coder-0.5B-Instruct"
  echo
  echo "Mode:"
  echo "  Local Q4 ONNX"
  echo
  echo "The AI will run locally through the NexusPanel"
  echo "advanced AI backend."
  echo
  echo "Installing advanced AI..."
  echo

  cd "${INSTALL_DIR}"

  echo "[3b/7] Installing Transformers runtime..."

  npm install \
    @huggingface/transformers@latest \
    --no-audit \
    --no-fund

  echo
  echo "[3c/7] Initializing advanced AI model..."
  echo
  echo "The first launch may download the model/cache."
  echo "This can take some time depending on your VPS connection."
  echo

  if [ ! -f "${INSTALL_DIR}/backend/advanced_ai.js" ]; then
    echo "WARNING:"
    echo "backend/advanced_ai.js was not found."
    echo "Skipping model initialization."
    return 0
  fi

  if "$NODE_PATH" \
      "${INSTALL_DIR}/backend/advanced_ai.js"; then

    echo
    echo "Advanced AI initialized successfully."

  else

    echo
    echo "WARNING: Advanced AI initialization failed."
    echo
    echo "The NexusPanel deterministic repair brain will remain available."
    echo "You can retry the AI initialization later."
    echo
  fi
}

prepare_paths() {

  echo "[4/7] Preparing data folders and permissions..."

  cd "${INSTALL_DIR}"

  mkdir -p \
    data \
    servers \
    software \
    backups \
    backupfolder \
    update/backups \
    /var/lib/nexuspanel/backups \
    /var/lib/nexuspanel/logs \
    /var/lib/nexuspanel/nexus-mark

  printf '%s\n' "$EDITION" > data/edition

  if [ -f update/update.sh ]; then
    chmod 755 update/update.sh
  fi

  chmod 750 \
    data \
    servers \
    software \
    backups \
    backupfolder \
    update/backups \
    /var/lib/nexuspanel \
    /var/lib/nexuspanel/backups \
    /var/lib/nexuspanel/logs \
    /var/lib/nexuspanel/nexus-mark

  if [ "$SERVICE_USER" != "root" ]; then

    local SERVICE_GROUP
    SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

    chown -R \
      "${SERVICE_USER}:${SERVICE_GROUP}" \
      data \
      servers \
      software \
      backups \
      backupfolder \
      update/backups \
      /var/lib/nexuspanel
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

  NEXUSPANEL_SERVICE_USER="$SERVICE_USER" \
    "$NODE_PATH" \
    "${INSTALL_DIR}/backend/cli.js" \
    setup-owner
}

install_service() {

  echo "[7/7] Installing systemd service..."

  cd "${INSTALL_DIR}"

  NEXUSPANEL_SERVICE_NAME="$SERVICE_NAME" \
  NEXUSPANEL_SERVICE_USER="$SERVICE_USER" \
    "$NODE_PATH" \
    "${INSTALL_DIR}/backend/service.js" \
    install

  echo "Waiting for service..."

  sleep 2

  if ! systemctl is-active --quiet "$SERVICE_NAME"; then

    echo
    echo "ERROR: NexusPanel service failed to start."
    echo

    echo "Recent logs:"
    journalctl \
      -u "$SERVICE_NAME" \
      -n 100 \
      --no-pager

    echo
    echo "You can inspect the service with:"
    echo "sudo systemctl status ${SERVICE_NAME}"

    exit 1
  fi
}

show_info() {

  local PUBLIC_IP

  PUBLIC_IP="$(
    curl \
      -fsS \
      --max-time 3 \
      ifconfig.me \
      2>/dev/null ||
      echo "YOUR_VPS_IP"
  )"

  echo
  echo "=============================================="
  echo " NexusPanel installation complete"
  echo "=============================================="
  echo

  echo "Panel URL:"
  echo "http://${PUBLIC_IP}:3000"

  echo
  echo "Service:"
  echo "${SERVICE_NAME}"

  echo
  echo "Install directory:"
  echo "${INSTALL_DIR}"

  echo
  echo "Edition:"
  echo "${EDITION}"

  echo
  echo "Advanced AI:"
  echo "ENABLED"

  echo
  echo "Commands:"
  echo "  nexuspanel status"
  echo "  nexuspanel logs"
  echo "  nexuspanel start"
  echo "  nexuspanel stop"
  echo "  nexuspanel restart"

  echo
  echo "Systemd:"
  echo "  systemctl status ${SERVICE_NAME}"
  echo "  journalctl -u ${SERVICE_NAME} -f"

  echo
}

main() {

  echo "=============================================="
  echo " NexusPanel Linux Installer v3.0.0"
  echo " Advanced AI Edition"
  echo "=============================================="
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

main "$@"
