#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${NEXUSPANEL_REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
INSTALL_DIR="${NEXUSPANEL_INSTALL_DIR:-/opt/nexuspanel}"
SERVICE_USER="${NEXUSPANEL_SERVICE_USER:-root}"
EDITION="${NEXUSPANEL_EDITION:-host}"

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo bash installers/nexuspanel-linux-installer.sh"
    exit 1
  fi
}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl ca-certificates git unzip tar xz-utils build-essential
    if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
    fi
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates git unzip tar xz gcc gcc-c++ make nodejs npm
    return
  fi

  echo "Unsupported Linux package manager. Install Node.js 22+, git, unzip, and tar, then rerun."
  exit 1
}

install_panel() {
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch origin
    git -C "$INSTALL_DIR" reset --hard origin/main
  elif [ -d "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
    echo "$INSTALL_DIR exists and is not empty. Set NEXUSPANEL_INSTALL_DIR to a new folder."
    exit 1
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi

  cd "$INSTALL_DIR"
  mkdir -p data
  printf '%s\n' "$EDITION" > data/edition
  npm install --omit=optional
  printf '#!/usr/bin/env sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" "$INSTALL_DIR/backend/cli.js" > /usr/local/bin/nexuspanel
  chmod 755 /usr/local/bin/nexuspanel
  NEXUSPANEL_SERVICE_USER="$SERVICE_USER" nexuspanel install
}

need_root
install_packages
install_panel

echo
echo "NexusPanel installed."
echo "Use: nexuspanel status"
echo "Logs: nexuspanel logs"
echo "Open: http://YOUR_VPS_IP:3000"
