#!/usr/bin/env bash
#
# NexusPanel Linux Installer v1.0.3
# Smart Ubuntu/Linux installer
#

set -uo pipefail

VERSION="1.0.3"
REPO_URL="${NEXUSPANEL_REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
INSTALL_DIR="${NEXUSPANEL_INSTALL_DIR:-/opt/nexuspanel}"
SERVICE_USER="${NEXUSPANEL_SERVICE_USER:-root}"
SERVICE_NAME="${NEXUSPANEL_SERVICE_NAME:-nexuspanel}"
EDITION="${NEXUSPANEL_EDITION:-normal}"
REF="${NEXUSPANEL_REF:-v1.0.3}"
INSTALL_AI="${NEXUSPANEL_INSTALL_AI:-ask}"
SKIP_TUNNELS="${NEXUSPANEL_SKIP_TUNNELS:-no}"
MAX_RETRIES="${NEXUSPANEL_MAX_RETRIES:-3}"
LOG_DIR="/var/log/nexuspanel-installer"
LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d-%H%M%S).log"
NODE_PATH=""
SETUP_TOKEN=""

# Authenticate before opening privileged log files. sudo owns the password prompt;
# the installer never reads, stores, or forwards the password itself.
if [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null 2>&1; then
        echo "NexusPanel installer requires root privileges (sudo not found)." >&2
        echo "Run it as root: bash $0" >&2
        exit 1
    fi
    echo "NexusPanel needs administrator privileges for packages, service setup, and permission repair."
    echo "sudo/PAM will handle authentication; NexusPanel does not store your password."
    sudo -v || exit 1
    exec sudo -E bash "$0" "$@"
fi

mkdir -p "$LOG_DIR" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

info() { printf '\n[INFO] %s\n' "$*"; }
warn() { printf '\n[WARN] %s\n' "$*" >&2; }
err() { printf '\n[ERROR] %s\n' "$*" >&2; }
die() { err "$*"; err "Installer log: $LOG_FILE"; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }
pause_short() { sleep 1; }

retry() {
    local attempt=1 delay=2
    while true; do
        if "$@"; then return 0; fi
        if [ "$attempt" -ge "$MAX_RETRIES" ]; then return 1; fi
        warn "Command failed: $*"
        warn "Retry $((attempt + 1))/$MAX_RETRIES in ${delay}s..."
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}

optional() {
    if "$@"; then return 0; fi
    warn "Optional operation failed: $*"
    return 0
}

authenticate_root() {
    # Never collect or store the root/sudo password ourselves. sudo handles the
    # password prompt, credential caching and PAM/MFA according to host policy.
    if [ "$(id -u)" -eq 0 ]; then return 0; fi
    if ! command_exists sudo; then
        die "Root privileges are required and sudo is not installed. Run this installer as root."
    fi
    echo
    echo "=================================================="
    echo " NexusPanel privileged installation"
    echo "=================================================="
    echo "NexusPanel needs administrator access to install packages, create its service,"
    echo "repair ownership/permissions, and configure protected runtime directories."
    echo "Your password is handled by sudo/PAM and is never stored by NexusPanel."
    echo
    sudo -v || die "Administrator authentication failed or was cancelled."
    exec sudo -E bash "$0" "$@"
}

need_root() {
    authenticate_root "$@"
    if [ "$(id -u)" -ne 0 ]; then
        die "Installer could not obtain root privileges."
    fi
}

repair_install_permissions() {
    info "Running installation permission/ownership audit..."
    cd "$INSTALL_DIR" || die "Cannot enter $INSTALL_DIR."
    # Do NOT chmod 777 recursively. That would expose credentials and panel data.
    # Directories need traversal; regular files need read/write. Executable bits
    # are restored only for known launchers and native binaries.
    find "$INSTALL_DIR" -type d -exec chmod u+rwx,g+rx,o-rwx {} + 2>/dev/null || true
    find "$INSTALL_DIR" -type f -exec chmod u+rw,g+r,o-rwx {} + 2>/dev/null || true
    find "$INSTALL_DIR" -type f \( -name '*.sh' -o -name '*.bin' \) -exec chmod u+rwx,g+rx,o-rwx {} + 2>/dev/null || true
    for file in "$INSTALL_DIR/backend/cli.js" "$INSTALL_DIR/backend/index.js" "$INSTALL_DIR/backend/launcher.js" "$INSTALL_DIR/backend/service.js" "$INSTALL_DIR/backend/host_agent.js" "$INSTALL_DIR/backend/asf_native.js"; do
        [ -f "$file" ] && chmod 750 "$file" || true
    done
    chmod 600 "$INSTALL_DIR/data/setup_token" "$INSTALL_DIR/data/cookie_secret" 2>/dev/null || true
    chmod 750 /usr/local/bin/nexuspanel 2>/dev/null || true
    if [ "$SERVICE_USER" != "root" ]; then
        local group="$(id -gn "$SERVICE_USER")"
        chown -R "$SERVICE_USER:$group" "$INSTALL_DIR/data" "$INSTALL_DIR/servers" "$INSTALL_DIR/software" "$INSTALL_DIR/backups" "$INSTALL_DIR/backupfolder" "$INSTALL_DIR/update/backups" /var/lib/nexuspanel 2>/dev/null || true
    fi
    # Verify the service identity can traverse and write its mutable roots.
    if [ "$SERVICE_USER" != "root" ]; then
        if ! runuser -u "$SERVICE_USER" -- test -r "$INSTALL_DIR" -a -x "$INSTALL_DIR"; then
            warn "Service user cannot traverse the installation root after repair."
        fi
        if ! runuser -u "$SERVICE_USER" -- test -w "$INSTALL_DIR/data"; then
            warn "Service user cannot write data after permission repair."
        fi
    fi
}

detect_pm() {
    command_exists apt-get && echo "apt" && return
    command_exists dnf && echo "dnf" && return
    command_exists yum && echo "yum" && return
    command_exists zypper && echo "zypper" && return
    command_exists pacman && echo "pacman" && return
    echo "unknown"
}

show_os() {
    echo
    echo "Operating system:"
    cat /etc/os-release 2>/dev/null || true
    echo
    echo "Architecture:"
    uname -m 2>/dev/null || true
}

install_system_packages() {
    local pm="$(detect_pm)"
    info "[1/9] Installing system dependencies..."
    info "Package manager: $pm"
    case "$pm" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            info "Updating APT..."
            retry apt-get update || die "APT update failed."
            info "Installing required packages..."
            retry apt-get install -y curl ca-certificates git unzip tar xz-utils libarchive-tools build-essential systemd acl passwd util-linux procps iproute2 rsync file jq openssl python3 python3-minimal || die "Ubuntu dependency installation failed."
            ;;
        dnf)
            retry dnf makecache || true
            retry dnf install -y curl ca-certificates git unzip tar xz libarchive gcc gcc-c++ make nodejs npm systemd acl shadow-utils util-linux procps-ng iproute rsync file jq openssl python3 || die "DNF dependency installation failed."
            ;;
        yum)
            retry yum makecache || true
            retry yum install -y curl ca-certificates git unzip tar xz libarchive gcc gcc-c++ make nodejs npm systemd acl shadow-utils util-linux procps iproute rsync file jq openssl python3 || die "YUM dependency installation failed."
            ;;
        zypper)
            retry zypper --non-interactive refresh || true
            retry zypper --non-interactive install curl ca-certificates git unzip tar xz libarchive gcc gcc-c++ make nodejs npm systemd acl shadow util-linux procps iproute2 rsync file jq openssl python3 || die "Zypper dependency installation failed."
            ;;
        pacman)
            retry pacman -Sy --noconfirm --needed curl ca-certificates git unzip tar xz libarchive gcc make nodejs npm systemd acl shadow util-linux procps iproute2 rsync file jq openssl python || die "Pacman dependency installation failed."
            ;;
        *) die "Unsupported Linux distribution/package manager." ;;
    esac
}

node_major() {
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

ensure_node() {
    if command_exists node; then
        local current_major="$(node_major)"
        if [ "$current_major" -ge 24 ]; then
            NODE_PATH="$(command -v node)"
            info "Node.js $("$NODE_PATH" --version) detected."
            return 0
        fi
    fi
    local pm="$(detect_pm)"
    if [ "$pm" = "apt" ]; then
        info "Installing Node.js 24..."
        if ! retry bash -c 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash -'; then
            die "NodeSource setup failed."
        fi
        retry apt-get install -y nodejs || die "Node.js installation failed."
    elif [ "$pm" = "dnf" ]; then
        retry dnf install -y nodejs npm || die "Node.js installation failed."
    elif [ "$pm" = "yum" ]; then
        retry yum install -y nodejs npm || die "Node.js installation failed."
    elif [ "$pm" = "zypper" ]; then
        retry zypper --non-interactive install nodejs npm || die "Node.js installation failed."
    elif [ "$pm" = "pacman" ]; then
        retry pacman -S --noconfirm --needed nodejs npm || die "Node.js installation failed."
    else
        die "Cannot determine package manager for Node.js."
    fi
    command_exists node || die "Node.js was not installed."
    local major="$(node_major)"
    if [ "$major" -lt 24 ]; then
        die "Node.js 24+ is required. Detected: $(node --version)"
    fi
    NODE_PATH="$(command -v node)"
    info "Node.js installed successfully."
    info "Path: $NODE_PATH"
    info "Version: $("$NODE_PATH" --version)"
}

require_service_user() {
    if [ "$SERVICE_USER" = "root" ]; then return 0; fi
    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
        die "Service user '$SERVICE_USER' does not exist."
    fi
}

remote_branch_exists() {
    local branch="$1"
    git ls-remote --exit-code --heads "$REPO_URL" "refs/heads/$branch" >/dev/null 2>&1
}

get_default_branch() {
    local branch=""
    branch="$(git ls-remote --symref "$REPO_URL" HEAD 2>/dev/null | awk '/^ref:/ {gsub("refs/heads/", "", $2); print $2; exit}')"
    if [ -n "$branch" ]; then
        echo "$branch"
        return 0
    fi
    if remote_branch_exists "main"; then echo "main"; return 0; fi
    if remote_branch_exists "master"; then echo "master"; return 0; fi
    return 1
}

git_repair_repository() {
    info "Attempting Git repository recovery..."
    cd "$INSTALL_DIR" || return 1
    if [ ! -d ".git" ]; then
        warn ".git directory is missing."
        return 1
    fi
    git remote set-url origin "$REPO_URL" 2>/dev/null || true
    if ! git fsck --no-progress >/dev/null 2>&1; then
        warn "Git integrity check reported problems."
        rm -f .git/index.lock 2>/dev/null || true
        git reset --hard HEAD 2>/dev/null || true
    fi
    rm -f .git/index.lock 2>/dev/null || true
    retry git fetch origin --tags --prune '+refs/heads/*:refs/remotes/origin/*'
}

clone_or_update() {
    info "[2/9] Preparing NexusPanel source..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    if [ -d "$INSTALL_DIR/.git" ]; then
        info "Existing Git repository detected."
        cd "$INSTALL_DIR" || die "Cannot enter $INSTALL_DIR."
        git remote set-url origin "$REPO_URL" 2>/dev/null || true
        if ! retry git fetch origin --tags --prune '+refs/heads/*:refs/remotes/origin/*'; then
            warn "Normal Git fetch failed."
            if ! git_repair_repository; then
                warn "Git repository could not be repaired."
                local backup="${INSTALL_DIR}.broken-$(date +%Y%m%d-%H%M%S)"
                info "Moving broken installation to: $backup"
                mv "$INSTALL_DIR" "$backup" || die "Could not preserve broken installation."
                mkdir -p "$INSTALL_DIR"
                info "Trying fresh clone..."
                retry git clone "$REPO_URL" "$INSTALL_DIR" || die "Fresh Git clone failed."
                cd "$INSTALL_DIR" || die "Could not enter installation directory."
                NODE_PATH="$(command -v node)"
                return 0
            fi
        fi
        local target_ref=""
        if [ "$REF" != "auto" ]; then
            if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
                target_ref="origin/$REF"
            elif git show-ref --verify --quiet "refs/tags/$REF"; then
                target_ref="$REF"
            elif git rev-parse --verify "$REF^{commit}" >/dev/null 2>&1; then
                target_ref="$REF"
            fi
        fi
        if [ -z "$target_ref" ]; then
            local default_branch="$(get_default_branch || true)"
            if [ -n "$default_branch" ]; then
                info "Detected repository default branch: $default_branch"
                if git show-ref --verify --quiet "refs/remotes/origin/$default_branch"; then
                    target_ref="origin/$default_branch"
                fi
            fi
        fi
        if [ -z "$target_ref" ]; then
            local candidate
            for candidate in main master develop; do
                if git show-ref --verify --quiet "refs/remotes/origin/$candidate"; then
                    target_ref="origin/$candidate"
                    break
                fi
            done
        fi
        if [ -z "$target_ref" ]; then
            warn "Available branches:"
            git branch -a || true
            die "No usable Git branch was found."
        fi
        info "Using Git reference: $target_ref"
        if ! git diff --quiet || ! git diff --cached --quiet; then
            warn "Local source changes detected."
            local source_backup="${INSTALL_DIR}.local-backup-$(date +%Y%m%d-%H%M%S)"
            mkdir -p "$source_backup"
            info "Preserving local data..."
            for folder in data servers software backups backupfolder; do
                if [ -d "$INSTALL_DIR/$folder" ]; then
                    cp -a "$INSTALL_DIR/$folder" "$source_backup/" 2>/dev/null || true
                fi
            done
            info "Local backup: $source_backup"
            git reset --hard HEAD || true
            git clean -fd || true
        fi
        if ! git reset --hard "$target_ref"; then
            warn "Git reset failed."
            if ! git_repair_repository; then
                die "Git repository could not be recovered."
            fi
            git reset --hard "$target_ref" || die "Git reset still failed."
        fi
        git clean -fd -e data/ -e servers/ -e software/ -e backups/ -e backupfolder/ || true
        NODE_PATH="$(command -v node)"
        return 0
    fi
    if [ -d "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | wc -l)" -gt 0 ]; then
        warn "$INSTALL_DIR exists but is not a Git repository."
        local old_backup="${INSTALL_DIR}.backup-$(date +%Y%m%d-%H%M%S)"
        info "Preserving existing installation: $old_backup"
        mv "$INSTALL_DIR" "$old_backup" || die "Could not move existing installation."
    fi
    local branch=""
    if [ "$REF" = "auto" ]; then
        branch="$(get_default_branch || true)"
    else
        branch="$REF"
    fi
    if [ -n "$branch" ]; then
        info "Cloning branch: $branch"
        if ! retry git clone --branch "$branch" --single-branch "$REPO_URL" "$INSTALL_DIR"; then
            warn "Branch clone failed."
            warn "Trying normal repository clone..."
            retry git clone "$REPO_URL" "$INSTALL_DIR" || die "Could not clone NexusPanel."
        fi
    else
        info "Could not detect default branch."
        retry git clone "$REPO_URL" "$INSTALL_DIR" || die "Could not clone NexusPanel."
    fi
    cd "$INSTALL_DIR" || die "Could not enter installation directory."
    NODE_PATH="$(command -v node)"
    info "Repository ready."
}

install_tunnel_tools() {
    if [ "$EDITION" != "normal" ] || [ "$SKIP_TUNNELS" = "yes" ]; then
        [ "$SKIP_TUNNELS" = "yes" ] && info "Tunnel helpers disabled."
        return 0
    fi
    info "[2b/9] Installing optional tunnel helpers..."
    local arch="$(uname -m)"
    local ngrok_arch=""
    local playit_arch=""
    case "$arch" in
        x86_64|amd64) ngrok_arch="amd64"; playit_arch="amd64" ;;
        aarch64|arm64) ngrok_arch="arm64"; playit_arch="aarch64" ;;
        *) warn "Architecture $arch is not supported. Skipping tunnel helpers."; return 0 ;;
    esac
    if ! command_exists ngrok; then
        if retry bash -c "curl -fsSL 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${ngrok_arch}.tgz' | tar -xz -C /usr/local/bin ngrok"; then
            chmod 755 /usr/local/bin/ngrok
            info "ngrok installed."
        else
            warn "ngrok installation failed. Continuing without ngrok."
        fi
    else
        info "ngrok already installed."
    fi
    if ! command_exists playit; then
        if retry curl -fsSL "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${playit_arch}" -o /usr/local/bin/playit; then
            chmod 755 /usr/local/bin/playit
            info "playit installed."
        else
            warn "playit installation failed. Continuing without playit."
        fi
    else
        info "playit already installed."
    fi
}

configure_npm() {
    export npm_config_audit=false
    export npm_config_fund=false
    export npm_config_fetch_retries=5
    export npm_config_fetch_retry_mintimeout=2000
    export npm_config_fetch_retry_maxtimeout=30000
    export npm_config_maxsockets=10
    export npm_config_update_notifier=false
}

npm_install_with_recovery() {
    info "[3/9] Installing Node.js dependencies..."
    cd "$INSTALL_DIR" || die "Cannot enter $INSTALL_DIR."
    configure_npm
    if retry npm install --omit=optional --no-audit --no-fund; then
        info "npm dependencies installed."
        npm install --include=optional --no-audit --no-fund || warn "Optional npm dependencies failed."
        return 0
    fi
    warn "npm install failed."
    info "Verifying npm cache..."
    npm cache verify 2>/dev/null || true
    if retry npm install --no-audit --no-fund; then
        info "npm recovery succeeded."
        return 0
    fi
    warn "Cleaning npm cache..."
    npm cache clean --force 2>/dev/null || true
    if retry npm install --no-audit --no-fund; then
        info "npm recovered after cache cleanup."
        return 0
    fi
    if [ -f package-lock.json ]; then
        warn "Trying npm ci..."
        if retry npm ci --omit=optional --no-audit --no-fund; then
            info "npm ci recovery succeeded."
            return 0
        fi
    fi
    warn "All npm recovery attempts failed."
    echo
    echo "Node:"
    node --version || true
    echo
    echo "npm:"
    npm --version || true
    echo
    echo "package.json:"
    if [ -f package.json ]; then cat package.json; fi
    echo
    die "Node.js dependencies could not be installed."
}

build_components() {
    info "[4/9] Building NexusPanel components..."
    cd "$INSTALL_DIR" || die "Cannot enter installation directory."
    if npm run build:asf; then
        info "ASF runtime build completed."
    else
        warn "ASF runtime build failed. Continuing with fallback mode."
    fi
    if npm run build:host-agent; then
        info "Host agent build completed."
    else
        warn "Host agent build failed. Continuing with available host-agent implementation."
    fi
}

ask_ai() {
    case "$INSTALL_AI" in
        yes|YES|y|Y) return 0 ;;
        no|NO|n|N) return 1 ;;
        ask|"") ;;
    esac
    echo
    echo "=================================================="
    echo " NexusPanel Advanced AI"
    echo "=================================================="
    echo
    echo "Optional local coding/diagnostic AI."
    echo "Model: Qwen2.5-Coder-0.5B-Instruct"
    echo "AI is NOT required for the normal panel."
    echo "It may require additional disk space and time."
    echo
    if [ ! -t 0 ]; then
        warn "Installer input is not interactive. Skipping AI automatically."
        return 1
    fi
    while true; do
        printf "Install Advanced AI now? [y/N]: "
        if ! read -r answer; then
            warn "Could not read input. Skipping Advanced AI."
            return 1
        fi
        case "$answer" in
            y|Y|yes|YES) echo; return 0 ;;
            n|N|no|NO|"") echo; return 1 ;;
            *) echo "Please enter y or n." ;;
        esac
    done
}

install_advanced_ai() {
    # Advanced AI was removed in NexusPanel 1.0.0. Kept as a no-op so the
    # install step numbering stays stable for existing scripts.
    info "[5/9] Advanced AI setup skipped (removed in 1.0.0)."
    return 0
}

prepare_paths() {
    info "[6/9] Preparing directories..."
    cd "$INSTALL_DIR" || die "Cannot enter installation directory."
    mkdir -p data servers software backups backupfolder update/backups data/huggingface /var/lib/nexuspanel /var/lib/nexuspanel/backups /var/lib/nexuspanel/logs /var/lib/nexuspanel/asf
    printf '%s\n' "$EDITION" > "$INSTALL_DIR/data/edition"
    if [ ! -s "$INSTALL_DIR/data/setup_token" ] || ! grep -Eq '^[A-Za-z0-9_-]{43}$' "$INSTALL_DIR/data/setup_token" 2>/dev/null; then
        SETUP_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
        printf '%s\n' "$SETUP_TOKEN" > "$INSTALL_DIR/data/setup_token"
        chmod 600 "$INSTALL_DIR/data/setup_token"
    else
        SETUP_TOKEN="$(tr -d '\r\n' < "$INSTALL_DIR/data/setup_token")"
    fi
    if [ -f "$INSTALL_DIR/update/update.sh" ]; then
        chmod 755 "$INSTALL_DIR/update/update.sh" || true
    fi
    chmod 750 data servers software backups backupfolder update/backups /var/lib/nexuspanel /var/lib/nexuspanel/backups /var/lib/nexuspanel/logs /var/lib/nexuspanel/asf 2>/dev/null || true
    if [ "$SERVICE_USER" != "root" ]; then
        local group="$(id -gn "$SERVICE_USER")"
        chown -R "$SERVICE_USER:$group" "$INSTALL_DIR/data" "$INSTALL_DIR/servers" "$INSTALL_DIR/software" "$INSTALL_DIR/backups" "$INSTALL_DIR/backupfolder" "$INSTALL_DIR/update/backups" /var/lib/nexuspanel 2>/dev/null || true
    fi
    repair_install_permissions
}

install_cli() {
    info "[7/9] Installing nexuspanel CLI..."
    if [ ! -f "$INSTALL_DIR/backend/cli.js" ]; then
        warn "backend/cli.js is missing. CLI installation skipped."
        return 0
    fi
    cat > /usr/local/bin/nexuspanel <<EOF
#!/usr/bin/env sh
NODE="$NODE_PATH"
INSTALL="$INSTALL_DIR"
exec "\$NODE" "\$INSTALL/backend/cli.js" "\$@"
EOF
    chmod 755 /usr/local/bin/nexuspanel
    info "CLI installed successfully."
    if ! command_exists nexuspanel; then
        warn "/usr/local/bin is not currently visible in PATH."
        warn "The command should work in a new terminal."
    fi
}

setup_owner() {
    info "[9/10] First-run account setup..."
    cd "$INSTALL_DIR" || die "Cannot enter installation directory."
    if [ ! -f "$INSTALL_DIR/data/setup_token" ]; then
        warn "First-run setup token is missing; generating one now..."
        SETUP_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
        printf '%s\n' "$SETUP_TOKEN" > "$INSTALL_DIR/data/setup_token"
        chmod 600 "$INSTALL_DIR/data/setup_token"
    else
        SETUP_TOKEN="$(tr -d '\r\n' < "$INSTALL_DIR/data/setup_token")"
    fi

    # Credentials supplied through the environment are the only non-web
    # setup path. Never block a remote installer waiting for stdin.
    if [ -n "${NEXUSPANEL_OWNER_EMAIL:-}" ] && [ -n "${NEXUSPANEL_OWNER_PASSWORD:-}" ]; then
        info "Using configured owner credentials."
        if NEXUSPANEL_SERVICE_USER="$SERVICE_USER" "$NODE_PATH" "$INSTALL_DIR/backend/cli.js" setup-owner; then
            info "Owner account created successfully."
            return 0
        fi
        warn "Configured owner setup failed; continuing with web setup."
    fi

    info "Web account setup is ready. The installer will not block on interactive input."
    info "Open the one-time setup URL printed at the end of installation."
}

systemd_available() {
    command_exists systemctl && [ -d /run/systemd/system ]
}

install_service() {
    info "[9/10] Installing NexusPanel service..."
    if ! systemd_available; then
        warn "systemd is not running."
        echo "Manual start: cd $INSTALL_DIR && npm start"
        return 0
    fi
    cd "$INSTALL_DIR" || die "Cannot enter installation directory."
    if [ ! -f "$INSTALL_DIR/backend/service.js" ]; then
        warn "backend/service.js is missing. Service installation skipped."
        return 0
    fi
    local attempt=1 installed=0
    while [ "$attempt" -le "$MAX_RETRIES" ]; do
        info "Service installation attempt $attempt/$MAX_RETRIES..."
        if NEXUSPANEL_SERVICE_NAME="$SERVICE_NAME" NEXUSPANEL_SERVICE_USER="$SERVICE_USER" "$NODE_PATH" "$INSTALL_DIR/backend/service.js" install; then
            installed=1
            break
        fi
        warn "Service installation failed."
        systemctl daemon-reload 2>/dev/null || true
        sleep "$((attempt * 2))"
        attempt=$((attempt + 1))
    done
    if [ "$installed" -ne 1 ]; then
        warn "Could not install systemd service automatically."
        return 0
    fi
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable "$SERVICE_NAME" 2>/dev/null || true
    info "Starting NexusPanel service..."
    if ! systemctl restart "$SERVICE_NAME" 2>/dev/null; then
        systemctl start "$SERVICE_NAME" 2>/dev/null || true
    fi
    sleep 3
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        info "NexusPanel service is running."
        return 0
    fi
    warn "Service did not start."
    echo "========== SERVICE LOG =========="
    journalctl -u "$SERVICE_NAME" -n 100 --no-pager 2>/dev/null || true
    echo "================================="
    info "Attempting service recovery..."
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
    systemctl restart "$SERVICE_NAME" 2>/dev/null || systemctl start "$SERVICE_NAME" 2>/dev/null || true
    sleep 3
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        info "Service recovered successfully."
    else
        warn "Service is still stopped. The installation itself remains intact."
    fi
}

diagnostics() {
    echo
    echo "=================================================="
    echo " NexusPanel Diagnostics"
    echo "=================================================="
    echo
    echo "Date:"
    date -Is 2>/dev/null || true
    echo
    echo "OS:"
    cat /etc/os-release 2>/dev/null || true
    echo
    echo "Kernel:"
    uname -a 2>/dev/null || true
    echo
    echo "Architecture:"
    uname -m 2>/dev/null || true
    echo
    echo "Node:"
    node --version 2>/dev/null || echo "missing"
    echo
    echo "npm:"
    npm --version 2>/dev/null || echo "missing"
    echo
    echo "Git:"
    git --version 2>/dev/null || echo "missing"
    echo
    echo "Install directory:"
    echo "$INSTALL_DIR"
    echo
    echo "Disk:"
    df -h "$INSTALL_DIR" /var 2>/dev/null || true
    echo
    echo "Memory:"
    free -h 2>/dev/null || true
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo
        echo "Git remote:"
        git -C "$INSTALL_DIR" remote -v 2>/dev/null || true
        echo
        echo "Git branches:"
        git -C "$INSTALL_DIR" branch -a 2>/dev/null || true
        echo
        echo "Current commit:"
        git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || true
    fi
    if systemd_available; then
        echo
        echo "Service status:"
        systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null || true
        echo
        echo "Recent service logs:"
        journalctl -u "$SERVICE_NAME" -n 50 --no-pager 2>/dev/null || true
    fi
    echo
    echo "=================================================="
}

final_check() {
    local problems=0
    if [ ! -d "$INSTALL_DIR" ]; then
        warn "Install directory does not exist."
        problems=$((problems + 1))
    fi
    if [ ! -f "$INSTALL_DIR/package.json" ]; then
        warn "package.json is missing."
        problems=$((problems + 1))
    fi
    if [ ! -s "$INSTALL_DIR/data/setup_token" ] && [ ! -s "$INSTALL_DIR/data/nexuspanel.sqlite" ]; then
        warn "First-run setup token is missing."
        problems=$((problems + 1))
    fi
    if ! command_exists node; then
        warn "Node.js is missing."
        problems=$((problems + 1))
    fi
    if [ "$problems" -eq 0 ]; then
        info "Final installation checks passed."
        return 0
    fi
    warn "$problems installation check(s) failed."
    return 1
}

show_info() {
    local public_ip="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")"
    echo
    echo "=================================================="
    echo " NexusPanel v${VERSION}"
    echo " Installation completed"
    echo "=================================================="
    echo
    echo "Panel: http://${public_ip}:3000"
    if [ -z "$SETUP_TOKEN" ] && [ -f "$INSTALL_DIR/data/setup_token" ]; then SETUP_TOKEN="$(tr -d '\r\n' < "$INSTALL_DIR/data/setup_token")"; fi
    if [ -n "$SETUP_TOKEN" ]; then
        echo "First-run setup: http://${public_ip}:3000/setup.html?token=${SETUP_TOKEN}"
    else
        echo "First-run setup: already completed (or use sudo nexuspanel setup-owner)."
    fi
    echo
    echo "Service: $SERVICE_NAME"
    echo "Install directory: $INSTALL_DIR"
    echo "Edition: $EDITION"
    echo "Node: $("$NODE_PATH" --version 2>/dev/null || true)"
    echo "Installer log: $LOG_FILE"
    echo
    echo "Useful commands:"
    echo "  sudo nexuspanel status"
    echo "  sudo nexuspanel logs"
    echo "  sudo nexuspanel start"
    echo "  sudo nexuspanel stop"
    echo "  sudo nexuspanel restart"
    echo "  sudo nexuspanel doctor"
    echo "  sudo nexuspanel agent status"
    echo "  sudo nexuspanel asf status"
    echo
    echo "Systemd:"
    echo "  sudo systemctl status $SERVICE_NAME"
    echo "  sudo journalctl -u $SERVICE_NAME -n 100 --no-pager"
    echo
    echo "Installer log: $LOG_FILE"
    echo
    echo "=================================================="
}

on_exit() {
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        err "Installer exited with code $rc."
        diagnostics || true
        err "Full log: $LOG_FILE"
    fi
    exit "$rc"
}

trap on_exit EXIT

main() {
    echo
    echo "=================================================="
    echo " NexusPanel Linux Installer v${VERSION}"
    echo " Smart Recovery Edition"
    echo "=================================================="
    echo
    need_root
    show_os
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
    install_service
    setup_owner
    if ! final_check; then
        warn "Installation finished with warnings."
        diagnostics || true
    fi
    show_info
}

main "$@"
