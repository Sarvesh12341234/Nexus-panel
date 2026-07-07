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

install_packages() {
  echo "📦 Installing system dependencies..."

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates git unzip tar xz-utils build-essential systemd
    if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >/dev/null 2>&1; then
      echo "📦 Installing Node.js 22..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y -qq nodejs
    fi
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm systemd
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y -q curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm systemd
    return
  fi

  echo "❌ Unsupported Linux package manager. Install Node.js 22+, git, unzip, tar, and systemd."
  exit 1
}

create_systemd_service() {
  local SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
  local USER="${SERVICE_USER}"

  echo "🔧 Creating systemd service: ${SERVICE_NAME}"

  cat > "${SERVICE_PATH}" << EOF
[Unit]
Description=NexusPanel Minecraft Server Panel (${EDITION} edition)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_PATH} ${INSTALL_DIR}/backend/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=NEXUSPANEL_SERVICE=1
Environment=NEXUSPANEL_EDITION=${EDITION}
Environment=PORT=3000
Environment=NEXUSPANEL_BACKUP_ROOT=/var/lib/nexuspanel/backups
User=${USER}
Group=${USER}
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
EOF

  if [ "${USER}" != "root" ]; then
    mkdir -p "/var/lib/nexuspanel"
    chown -R "${USER}:${USER}" "/var/lib/nexuspanel"
  fi

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  echo "✅ Service created and enabled"
}

install_cli() {
  echo "🔧 Installing CLI..."
  cat > /usr/local/bin/nexuspanel << EOF
#!/usr/bin/env sh
exec "${NODE_PATH}" "${INSTALL_DIR}/backend/cli.js" "\$@"
EOF
  chmod 755 /usr/local/bin/nexuspanel
  echo "✅ CLI installed"
}

install_panel() {
  echo "📦 Installing NexusPanel to ${INSTALL_DIR}..."

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -d "${INSTALL_DIR}/.git" ]; then
    echo "🔄 Updating existing installation..."
    git -C "${INSTALL_DIR}" fetch origin --tags --force
    git -C "${INSTALL_DIR}" reset --hard "${RELEASE_TAG}"
  elif [ -d "${INSTALL_DIR}" ] && [ "$(find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
    echo "❌ ${INSTALL_DIR} exists and is not empty."
    echo "   Set NEXUSPANEL_INSTALL_DIR to a new folder or remove it."
    exit 1
  else
    echo "🔄 Cloning repository..."
    git clone --branch "${RELEASE_TAG}" --single-branch "${REPO_URL}" "${INSTALL_DIR}"
  fi

  cd "${INSTALL_DIR}"

  echo "📦 Installing Node.js dependencies..."
  npm install --no-audit --no-fund
  chmod 755 update/update.sh

  echo "📁 Creating data directory..."
  mkdir -p data backups
  echo "${EDITION}" > data/edition
  chmod 755 data backups

  create_systemd_service
  install_cli

  echo "✅ Installation complete!"
}

start_service() {
  echo "🚀 Starting NexusPanel service..."
  systemctl start "${SERVICE_NAME}"
  sleep 2
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "✅ NexusPanel is running!"
    echo ""
    echo "📊 Service Status:"
    systemctl status "${SERVICE_NAME}" --no-pager
  else
    echo "⚠️  Service failed to start. Check logs:"
    echo "   journalctl -u ${SERVICE_NAME} -f"
    exit 1
  fi
}

show_info() {
  local PUBLIC_IP="$(curl -s ifconfig.me || echo "YOUR_VPS_IP")"
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║                    🚀 NexusPanel Installed!                  ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║                                                              ║"
  echo "║  📍 Panel URL:    http://${PUBLIC_IP}:3000                    ║"
  echo "║  📍 Service:      ${SERVICE_NAME}                             ║"
  echo "║  📍 Install Dir:  ${INSTALL_DIR}                             ║"
  echo "║  📍 Edition:      ${EDITION}                                 ║"
  echo "║                                                              ║"
  echo "║  Commands:                                                   ║"
  echo "║    nexuspanel status   - Check panel status                  ║"
  echo "║    nexuspanel logs     - View live logs                      ║"
  echo "║    nexuspanel start    - Start the panel                     ║"
  echo "║    nexuspanel stop     - Stop the panel                      ║"
  echo "║    nexuspanel restart  - Restart the panel                   ║"
  echo "║                                                              ║"
  echo "║  Systemd:                                                    ║"
  echo "║    sudo systemctl status ${SERVICE_NAME}                     ║"
  echo "║    sudo journalctl -u ${SERVICE_NAME} -f                     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
}

main() {
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║            NexusPanel Linux Installer v1.2.0                ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  need_root
  install_packages
  NODE_PATH="$(command -v node)"
  install_panel
  start_service
  show_info
}

main
