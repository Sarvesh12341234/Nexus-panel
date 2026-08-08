#!/usr/bin/env bash
#
# NexusPanel Linux Installer v3.0.1
# Robust installer with retries, diagnostics, safe recovery and optional AI.
#
# Environment:
#   NEXUSPANEL_REPO_URL
#   NEXUSPANEL_INSTALL_DIR
#   NEXUSPANEL_SERVICE_USER
#   NEXUSPANEL_SERVICE_NAME
#   NEXUSPANEL_EDITION
#   NEXUSPANEL_REF              (default: main)
#   NEXUSPANEL_INSTALL_AI       (default: yes)
#   NEXUSPANEL_SKIP_TUNNELS     (default: no)
#
set -uo pipefail

VERSION="3.0.1"
REPO_URL="${NEXUSPANEL_REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
INSTALL_DIR="${NEXUSPANEL_INSTALL_DIR:-/opt/nexuspanel}"
SERVICE_USER="${NEXUSPANEL_SERVICE_USER:-root}"
SERVICE_NAME="${NEXUSPANEL_SERVICE_NAME:-nexuspanel}"
EDITION="${NEXUSPANEL_EDITION:-normal}"
REF="${NEXUSPANEL_REF:-main}"
INSTALL_AI="${NEXUSPANEL_INSTALL_AI:-yes}"
SKIP_TUNNELS="${NEXUSPANEL_SKIP_TUNNELS:-no}"
NODE_PATH=""
LOG_DIR="/var/log/nexuspanel-installer"
LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d-%H%M%S).log"
MAX_RETRIES=3

mkdir -p "$LOG_DIR" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

info() { printf '\n[INFO] %s\n' "$*"; }
warn() { printf '\n[WARN] %s\n' "$*" >&2; }
err()  { printf '\n[ERROR] %s\n' "$*" >&2; }
die()  { err "$*"; err "Installer log: $LOG_FILE"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

retry() {
  local attempts=0 delay=2
  while true; do
    if "$@"; then return 0; fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$MAX_RETRIES" ]; then return 1; fi
    warn "Command failed (attempt $attempts/$MAX_RETRIES): $*"
    warn "Retrying in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
  done
}

diagnostics() {
  echo "---- NexusPanel installer diagnostics ----"
  echo "date: $(date -Is)"
  echo "kernel: $(uname -a 2>/dev/null || true)"
  echo "arch: $(uname -m 2>/dev/null || true)"
  echo "os:"
  cat /etc/os-release 2>/dev/null || true
  echo "node: $(node --version 2>/dev/null || echo missing)"
  echo "npm: $(npm --version 2>/dev/null || echo missing)"
  echo "git: $(git --version 2>/dev/null || echo missing)"
  echo "disk:"
  df -h "$INSTALL_DIR" /var 2>/dev/null || true
  echo "memory:"
  free -h 2>/dev/null || true
  echo "service:"
  systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null || true
  echo "recent journal:"
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager 2>/dev/null || true
  echo "------------------------------------------"
}

trap_handler() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    err "Installer stopped with exit code $rc."
    diagnostics || true
    err "Full log: $LOG_FILE"
  fi
  exit "$rc"
}
trap trap_handler EXIT

need_root() {
  [ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0"
}

detect_pm() {
  if command_exists apt-get; then echo apt; return; fi
  if command_exists dnf; then echo dnf; return; fi
  if command_exists yum; then echo yum; return; fi
  if command_exists zypper; then echo zypper; return; fi
  if command_exists pacman; then echo pacman; return; fi
  echo unknown
}

install_system_packages() {
  local pm
  pm="$(detect_pm)"
  info "[1/7] Installing system dependencies using $pm..."

  case "$pm" in
    apt)
      retry apt-get update || die "apt update failed."
      retry apt-get install -y \
        curl ca-certificates git unzip tar xz-utils \
        build-essential systemd acl passwd util-linux procps iproute2
      ;;
    dnf)
      retry dnf makecache
      retry dnf install -y \
        curl ca-certificates git unzip tar xz gcc gcc-c++ make \
        nodejs npm systemd acl shadow-utils util-linux procps-ng iproute
      ;;
    yum)
      retry yum makecache
      retry yum install -y \
        curl ca-certificates git unzip tar xz gcc gcc-c++ make \
        nodejs npm systemd acl shadow-utils util-linux procps iproute
      ;;
    zypper)
      retry zypper --non-interactive refresh
      retry zypper --non-interactive install \
        curl ca-certificates git unzip tar xz gcc gcc-c++ make \
        nodejs npm systemd acl shadow util-linux procps iproute2
      ;;
    pacman)
      retry pacman -Sy --noconfirm --needed \
        curl ca-certificates git unzip tar xz gcc make \
        nodejs npm systemd acl shadow util-linux procps iproute2
      ;;
    *)
      die "Unsupported package manager. Install curl, git, Node.js 24+, npm, a compiler, systemd and iproute manually."
      ;;
  esac
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

ensure_node() {
  if command_exists node && [ "$(node_major)" -ge 24 ]; then
    NODE_PATH="$(command -v node)"
    info "Node.js $("$NODE_PATH" --version) detected."
    return
  fi

  local pm
  pm="$(detect_pm)"

  if [ "$pm" = "apt" ]; then
    info "Installing Node.js 24 LTS..."
    retry bash -c 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash -'
    retry apt-get install -y nodejs
  fi

  command_exists node || die "Node.js could not be installed."
  [ "$(node_major)" -ge 24 ] || die "Node.js 24+ is required; detected $(node --version)."
  NODE_PATH="$(command -v node)"
}

require_service_user() {
  if [ "$SERVICE_USER" = "root" ]; then return; fi
  id "$SERVICE_USER" >/dev/null 2>&1 ||
    die "Service user '$SERVICE_USER' does not exist."
}

install_tunnel_tools() {
  [ "$EDITION" = "normal" ] || return 0
  [ "$SKIP_TUNNELS" = "yes" ] && { info "Tunnel helpers disabled."; return 0; }

  info "[1b/7] Installing optional tunnel helpers..."
  local arch ngrok_arch playit_arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) ngrok_arch=amd64; playit_arch=amd64 ;;
    aarch64|arm64) ngrok_arch=arm64; playit_arch=aarch64 ;;
    *) warn "Unsupported architecture $arch; skipping tunnel helpers."; return 0 ;;
  esac

  if ! command_exists ngrok; then
    if retry bash -c \
      "curl -fsSL 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${ngrok_arch}.tgz' | tar -xz -C /usr/local/bin ngrok"
    then
      chmod 755 /usr/local/bin/ngrok
    else
      warn "ngrok installation failed; continuing."
    fi
  fi

  if ! command_exists playit; then
    if retry curl -fsSL \
      "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${playit_arch}" \
      -o /usr/local/bin/playit
    then
      chmod 755 /usr/local/bin/playit
    else
      warn "playit installation failed; continuing."
    fi
  fi
}

clone_or_update() {
  info "[2/7] Preparing NexusPanel source..."
  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Existing Git installation found."
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL" || true
    retry git -C "$INSTALL_DIR" fetch origin --tags --force ||
      die "Could not fetch repository."

    if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
      git -C "$INSTALL_DIR" reset --hard "origin/$REF" ||
        die "Could not reset to origin/$REF."
    elif git -C "$INSTALL_DIR" rev-parse --verify "$REF^{commit}" >/dev/null 2>&1; then
      git -C "$INSTALL_DIR" reset --hard "$REF" ||
        die "Could not reset to $REF."
    else
      warn "Requested ref '$REF' was not found; falling back to origin/main."
      git -C "$INSTALL_DIR" reset --hard origin/main ||
        die "Could not reset to origin/main."
    fi
  elif [ -d "$INSTALL_DIR" ] &&
       [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit | wc -l)" -gt 0 ]; then
    die "$INSTALL_DIR exists and is not empty. Set NEXUSPANEL_INSTALL_DIR to another directory."
  else
    retry git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR" ||
      retry git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" ||
      die "Could not clone NexusPanel."
  fi

  cd "$INSTALL_DIR"
  NODE_PATH="$(command -v node)"
}

npm_install_with_recovery() {
  info "[3/7] Installing Node.js dependencies..."

  export npm_config_audit=false
  export npm_config_fund=false
  export npm_config_fetch_retries=5
  export npm_config_fetch_retry_mintimeout=2000
  export npm_config_fetch_retry_maxtimeout=30000

  if retry npm install --omit=optional --no-audit --no-fund; then
    npm install --include=optional --no-audit --no-fund ||
      warn "Optional dependencies failed; continuing."
    return
  fi

  warn "Normal npm install failed. Clearing npm cache and retrying..."
  npm cache verify >/dev/null 2>&1 || true

  if retry npm cache clean --force &&
     retry npm install --no-audit --no-fund; then
    return
  fi

  if [ -f package-lock.json ]; then
    warn "Trying npm ci as a final dependency recovery path..."
    retry npm ci --omit=optional --no-audit --no-fund ||
      die "Node.js dependency installation failed. See $LOG_FILE."
  else
    die "Node.js dependency installation failed. See $LOG_FILE."
  fi
}

build_components() {
  info "Building optional native components..."

  if npm run build:nexusmark; then
    info "NexusMark build completed."
  else
    warn "NexusMark build failed. Continuing with the available sandbox."
  fi

  if npm run build:host-agent; then
    info "Host agent build completed."
  else
    warn "Host agent build failed. Continuing; service installation may rebuild it."
  fi
}

install_advanced_ai() {
  [ "$INSTALL_AI" != "no" ] ||
    { info "Advanced AI disabled by NEXUSPANEL_INSTALL_AI=no."; return 0; }

  info "[3b/7] Installing Advanced AI..."
  cd "$INSTALL_DIR"

  if ! retry npm install @huggingface/transformers@latest --no-audit --no-fund; then
    warn "Advanced AI package could not be installed."
    warn "Core NexusPanel installation will continue."
    return 0
  fi

  if [ ! -f "$INSTALL_DIR/backend/advanced_ai.js" ]; then
    warn "backend/advanced_ai.js is missing; skipping model initialization."
    return 0
  fi

  export HF_HOME="${HF_HOME:-$INSTALL_DIR/data/huggingface}"
  export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$HF_HOME}"
  mkdir -p "$HF_HOME"

  if "$NODE_PATH" "$INSTALL_DIR/backend/advanced_ai.js"; then
    info "Advanced AI model initialized."
  else
    warn "Advanced AI model initialization failed."
    warn "This is non-fatal; NexusPanel will continue with its deterministic repair logic."
  fi
}

prepare_paths() {
  info "[4/7] Preparing directories and permissions..."
  cd "$INSTALL_DIR"

  mkdir -p \
    data servers software backups backupfolder update/backups \
    "$INSTALL_DIR/data/huggingface" \
    /var/lib/nexuspanel/backups \
    /var/lib/nexuspanel/logs \
    /var/lib/nexuspanel/nexus-mark

  printf '%s\n' "$EDITION" > "$INSTALL_DIR/data/edition"
  chmod 755 "$INSTALL_DIR/update/update.sh" 2>/dev/null || true

  chmod 750 \
    data servers software backups backupfolder update/backups \
    /var/lib/nexuspanel \
    /var/lib/nexuspanel/backups \
    /var/lib/nexuspanel/logs \
    /var/lib/nexuspanel/nexus-mark || true

  if [ "$SERVICE_USER" != "root" ]; then
    local group
    group="$(id -gn "$SERVICE_USER")"
    chown -R "$SERVICE_USER:$group" \
      "$INSTALL_DIR/data" "$INSTALL_DIR/servers" "$INSTALL_DIR/software" \
      "$INSTALL_DIR/backups" "$INSTALL_DIR/backupfolder" "$INSTALL_DIR/update/backups" \
      /var/lib/nexuspanel
  fi
}

install_cli() {
  info "[5/7] Installing nexuspanel CLI..."

  cat > /usr/local/bin/nexuspanel <<EOF
#!/usr/bin/env sh
exec "$NODE_PATH" "$INSTALL_DIR/backend/cli.js" "\$@"
EOF
  chmod 755 /usr/local/bin/nexuspanel
  hash -r 2>/dev/null || true
}

setup_owner() {
  info "[6/7] Owner account setup..."
  cd "$INSTALL_DIR"

  [ -f "$INSTALL_DIR/backend/cli.js" ] ||
    { warn "backend/cli.js is missing; skipping owner setup."; return 0; }

  if [ -t 0 ] && [ -t 1 ]; then
    if NEXUSPANEL_SERVICE_USER="$SERVICE_USER" \
      "$NODE_PATH" "$INSTALL_DIR/backend/cli.js" setup-owner; then
      return 0
    fi
  else
    warn "No interactive terminal detected; owner setup skipped."
    warn "Run: nexuspanel setup-owner"
    return 0
  fi

  warn "Owner setup returned an error."
  warn "Core installation will continue. Retry later with: nexuspanel setup-owner"
}

install_service() {
  info "[7/7] Installing systemd service..."
  cd "$INSTALL_DIR"

  [ -f "$INSTALL_DIR/backend/service.js" ] ||
    die "backend/service.js is missing."

  local attempt
  for attempt in 1 2 3; do
    if NEXUSPANEL_SERVICE_NAME="$SERVICE_NAME" \
      NEXUSPANEL_SERVICE_USER="$SERVICE_USER" \
      "$NODE_PATH" "$INSTALL_DIR/backend/service.js" install
    then
      break
    fi
    warn "Service installation attempt $attempt failed."
    systemctl daemon-reload 2>/dev/null || true
    sleep $((attempt * 2))
  done

  systemctl daemon-reload 2>/dev/null || true
  systemctl enable "$SERVICE_NAME" 2>/dev/null || true
  systemctl restart "$SERVICE_NAME" 2>/dev/null ||
    systemctl start "$SERVICE_NAME" 2>/dev/null || true

  sleep 3

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    info "NexusPanel service is running."
    return 0
  fi

  warn "Service did not become active."
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager 2>/dev/null || true

  systemctl daemon-reload 2>/dev/null || true
  systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
  systemctl restart "$SERVICE_NAME" 2>/dev/null || true
  sleep 3

  systemctl is-active --quiet "$SERVICE_NAME" ||
    die "NexusPanel service could not be started. Unrelated processes were not terminated."
}

show_info() {
  local public_ip
  public_ip="$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || echo YOUR_VPS_IP)"

  info "NexusPanel installation completed."
  echo
  echo "Panel URL:      http://${public_ip}:3000"
  echo "Service:        ${SERVICE_NAME}"
  echo "Install dir:    ${INSTALL_DIR}"
  echo "Edition:        ${EDITION}"
  echo "Advanced AI:    ${INSTALL_AI}"
  echo "Installer log:  ${LOG_FILE}"
  echo
  echo "Commands:"
  echo "  nexuspanel status"
  echo "  nexuspanel logs"
  echo "  nexuspanel start"
  echo "  nexuspanel stop"
  echo "  nexuspanel restart"
  echo
  echo "Diagnostics:"
  echo "  systemctl status ${SERVICE_NAME}"
  echo "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
}

main() {
  echo "=============================================="
  echo " NexusPanel Linux Installer v${VERSION}"
  echo " Robust / Recovery Edition"
  echo "=============================================="

  need_root
  require_service_user
  install_system_packages
  ensure_node
  install_tunnel_tools
  clone_or_update
  npm_install_with_recovery
  build_components
  install_advanced_ai
  prepare_paths
  install_cli
  setup_owner
  install_service
  show_info
}

main "$@"
