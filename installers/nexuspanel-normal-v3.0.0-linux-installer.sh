#!/usr/bin/env bash
#
# NexusPanel Linux Installer v3.0.2
# Robust Ubuntu/Linux installer with Git recovery, npm recovery,
# optional AI, native builds, systemd service setup and diagnostics.
#

set -uo pipefail

VERSION="3.0.2"

REPO_URL="${NEXUSPANEL_REPO_URL:-https://github.com/Sarvesh12341234/Nexus-panel.git}"
INSTALL_DIR="${NEXUSPANEL_INSTALL_DIR:-/opt/nexuspanel}"

SERVICE_USER="${NEXUSPANEL_SERVICE_USER:-root}"
SERVICE_NAME="${NEXUSPANEL_SERVICE_NAME:-nexuspanel}"
EDITION="${NEXUSPANEL_EDITION:-normal}"

# "auto" = automatically use repository default branch
# Otherwise specify a branch/tag.
REF="${NEXUSPANEL_REF:-auto}"

# ask = ask Y/N
# yes = install automatically
# no = don't install
INSTALL_AI="${NEXUSPANEL_INSTALL_AI:-ask}"

SKIP_TUNNELS="${NEXUSPANEL_SKIP_TUNNELS:-no}"

MAX_RETRIES="${NEXUSPANEL_MAX_RETRIES:-3}"

LOG_DIR="/var/log/nexuspanel-installer"
LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d-%H%M%S).log"

NODE_PATH=""

mkdir -p "$LOG_DIR" 2>/dev/null || true

exec > >(tee -a "$LOG_FILE") 2>&1


# ============================================================
# Logging
# ============================================================

info() {
    printf '\n[INFO] %s\n' "$*"
}

warn() {
    printf '\n[WARN] %s\n' "$*" >&2
}

err() {
    printf '\n[ERROR] %s\n' "$*" >&2
}

die() {
    err "$*"
    err "Installer log: $LOG_FILE"
    exit 1
}


# ============================================================
# Helpers
# ============================================================

command_exists() {
    command -v "$1" >/dev/null 2>&1
}


retry() {
    local attempt=1
    local delay=2

    while true; do
        if "$@"; then
            return 0
        fi

        if [ "$attempt" -ge "$MAX_RETRIES" ]; then
            return 1
        fi

        warn "Command failed: $*"
        warn "Retry $((attempt + 1))/$MAX_RETRIES in ${delay}s..."

        sleep "$delay"

        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}


run_optional() {
    if "$@"; then
        return 0
    fi

    warn "Optional command failed:"
    warn "$*"
    return 0
}


# ============================================================
# Root
# ============================================================

need_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "Run this installer as root:

sudo bash $0"
    fi
}


# ============================================================
# Package manager
# ============================================================

detect_pm() {
    if command_exists apt-get; then
        echo "apt"
        return
    fi

    if command_exists dnf; then
        echo "dnf"
        return
    fi

    if command_exists yum; then
        echo "yum"
        return
    fi

    if command_exists zypper; then
        echo "zypper"
        return
    fi

    if command_exists pacman; then
        echo "pacman"
        return
    fi

    echo "unknown"
}


# ============================================================
# System packages
# ============================================================

install_system_packages() {

    local pm
    pm="$(detect_pm)"

    info "[1/8] Installing system dependencies..."
    info "Package manager: $pm"

    case "$pm" in

        apt)

            export DEBIAN_FRONTEND=noninteractive

            retry apt-get update ||
                die "apt-get update failed."

            retry apt-get install -y \
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
                util-linux \
                procps \
                iproute2 \
                rsync \
                file \
                jq ||
                die "Failed installing Ubuntu/Debian dependencies."

            ;;

        dnf)

            retry dnf makecache || true

            retry dnf install -y \
                curl \
                ca-certificates \
                git \
                unzip \
                tar \
                xz \
                gcc \
                gcc-c++ \
                make \
                nodejs \
                npm \
                systemd \
                acl \
                shadow-utils \
                util-linux \
                procps-ng \
                iproute \
                rsync \
                file \
                jq

            ;;

        yum)

            retry yum makecache || true

            retry yum install -y \
                curl \
                ca-certificates \
                git \
                unzip \
                tar \
                xz \
                gcc \
                gcc-c++ \
                make \
                nodejs \
                npm \
                systemd \
                acl \
                shadow-utils \
                util-linux \
                procps \
                iproute \
                rsync \
                file \
                jq

            ;;

        zypper)

            retry zypper --non-interactive refresh || true

            retry zypper --non-interactive install \
                curl \
                ca-certificates \
                git \
                unzip \
                tar \
                xz \
                gcc \
                gcc-c++ \
                make \
                nodejs \
                npm \
                systemd \
                acl \
                shadow \
                util-linux \
                procps \
                iproute2 \
                rsync \
                file \
                jq

            ;;

        pacman)

            retry pacman -Sy --noconfirm --needed \
                curl \
                ca-certificates \
                git \
                unzip \
                tar \
                xz \
                gcc \
                make \
                nodejs \
                npm \
                systemd \
                acl \
                shadow \
                util-linux \
                procps \
                iproute2 \
                rsync \
                file \
                jq

            ;;

        *)

            die "Unsupported Linux package manager."

            ;;
    esac
}


# ============================================================
# Node.js
# ============================================================

node_major() {

    node -p \
        'process.versions.node.split(".")[0]' \
        2>/dev/null || echo 0
}


ensure_node() {

    if command_exists node &&
       [ "$(node_major)" -ge 24 ]; then

        NODE_PATH="$(command -v node)"

        info "Node.js $("$NODE_PATH" --version) detected."

        return 0
    fi


    local pm
    pm="$(detect_pm)"


    if [ "$pm" = "apt" ]; then

        info "Installing Node.js 24..."

        retry bash -c \
            'curl -fsSL https://deb.nodesource.com/setup_24.x | bash -'

        retry apt-get install -y nodejs ||
            die "Node.js installation failed."

    elif [ "$pm" = "dnf" ]; then

        if command_exists dnf; then
            retry dnf install -y nodejs npm ||
                die "Node.js installation failed."
        fi

    elif [ "$pm" = "yum" ]; then

        retry yum install -y nodejs npm ||
            die "Node.js installation failed."

    fi


    command_exists node ||
        die "Node.js was not installed."

    local major
    major="$(node_major)"

    if [ "$major" -lt 24 ]; then
        die "Node.js 24+ required. Detected: $(node --version)"
    fi


    NODE_PATH="$(command -v node)"

    info "Using Node.js: $NODE_PATH"
    info "Node version: $("$NODE_PATH" --version)"
}


# ============================================================
# Service user
# ============================================================

require_service_user() {

    if [ "$SERVICE_USER" = "root" ]; then
        return 0
    fi

    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
        die "Service user '$SERVICE_USER' does not exist."
    fi
}


# ============================================================
# Optional tunnel tools
# ============================================================

install_tunnel_tools() {

    if [ "$EDITION" != "normal" ]; then
        return 0
    fi

    if [ "$SKIP_TUNNELS" = "yes" ]; then
        info "Tunnel helper installation disabled."
        return 0
    fi

    info "[1b/8] Installing optional tunnel helpers..."

    local arch
    local ngrok_arch
    local playit_arch

    arch="$(uname -m)"

    case "$arch" in

        x86_64|amd64)
            ngrok_arch="amd64"
            playit_arch="amd64"
            ;;

        aarch64|arm64)
            ngrok_arch="arm64"
            playit_arch="aarch64"
            ;;

        *)
            warn "Unsupported architecture: $arch"
            warn "Skipping tunnel helpers."
            return 0
            ;;
    esac


    if ! command_exists ngrok; then

        if retry bash -c \
            "curl -fsSL 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${ngrok_arch}.tgz' |
             tar -xz -C /usr/local/bin ngrok"
        then
            chmod 755 /usr/local/bin/ngrok
            info "ngrok installed."
        else
            warn "ngrok installation failed. Continuing."
        fi
    else
        info "ngrok already installed."
    fi


    if ! command_exists playit; then

        if retry curl -fsSL \
            "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${playit_arch}" \
            -o /usr/local/bin/playit
        then
            chmod 755 /usr/local/bin/playit
            info "playit installed."
        else
            warn "playit installation failed. Continuing."
        fi

    else
        info "playit already installed."
    fi
}


# ============================================================
# Git helpers
# ============================================================

remote_ref_exists() {

    local remote="$1"
    local ref="$2"

    git ls-remote \
        --exit-code \
        --heads \
        "$remote" \
        "$ref" >/dev/null 2>&1
}


get_default_branch() {

    local symbolic

    symbolic="$(
        git ls-remote \
            --symref \
            "$REPO_URL" \
            HEAD 2>/dev/null |
            awk '/^ref:/ {
                sub("refs/heads/", "", $2)
                print $2
                exit
            }'
    )"

    if [ -n "$symbolic" ]; then
        echo "$symbolic"
        return 0
    fi


    # Fallbacks
    if remote_ref_exists "$REPO_URL" main; then
        echo "main"
        return 0
    fi

    if remote_ref_exists "$REPO_URL" master; then
        echo "master"
        return 0
    fi


    return 1
}


# ============================================================
# Git source recovery
# ============================================================

clone_or_update() {

    info "[2/8] Preparing NexusPanel source..."

    mkdir -p "$(dirname "$INSTALL_DIR")"


    # --------------------------------------------------------
    # Existing Git repository
    # --------------------------------------------------------

    if [ -d "$INSTALL_DIR/.git" ]; then

        info "Existing Git installation found."

        cd "$INSTALL_DIR" ||
            die "Cannot enter $INSTALL_DIR."


        git remote set-url origin "$REPO_URL" 2>/dev/null || true


        info "Refreshing Git repository..."

        if ! retry git fetch origin \
            --tags \
            --prune \
            '+refs/heads/*:refs/remotes/origin/*'
        then

            warn "Git fetch failed."

            diagnostics

            die "Could not update repository."
        fi


        local target_ref=""


        # Explicit branch requested
        if [ "$REF" != "auto" ]; then

            if git show-ref \
                --verify \
                --quiet \
                "refs/remotes/origin/$REF"
            then
                target_ref="origin/$REF"

            elif git show-ref \
                --verify \
                --quiet \
                "refs/tags/$REF"
            then
                target_ref="$REF"

            elif git rev-parse \
                --verify \
                "$REF^{commit}" >/dev/null 2>&1
            then
                target_ref="$REF"
            fi

        fi


        # Automatic default branch detection
        if [ -z "$target_ref" ]; then

            local default_branch

            default_branch="$(get_default_branch || true)"

            if [ -n "$default_branch" ]; then

                info "Repository default branch: $default_branch"

                if git show-ref \
                    --verify \
                    --quiet \
                    "refs/remotes/origin/$default_branch"
                then
                    target_ref="origin/$default_branch"
                fi
            fi
        fi


        # Last-resort branch detection
        if [ -z "$target_ref" ]; then

            if git show-ref \
                --verify \
                --quiet \
                refs/remotes/origin/main
            then
                target_ref="origin/main"

            elif git show-ref \
                --verify \
                --quiet \
                refs/remotes/origin/master
            then
                target_ref="origin/master"
            fi
        fi


        if [ -z "$target_ref" ]; then

            warn "Available remote branches:"
            git branch -r || true

            die "Could not determine a usable Git branch."
        fi


        info "Using Git reference: $target_ref"


        # Save local changes if any
        if ! git diff --quiet ||
           ! git diff --cached --quiet
        then

            warn "Local Git changes detected."

            local backup_git

            backup_git="${INSTALL_DIR}.local-backup-$(date +%Y%m%d-%H%M%S)"

            info "Backing up local installation to:"
            info "$backup_git"

            mkdir -p "$backup_git"

            # Preserve important data
            for folder in \
                data \
                servers \
                software \
                backups \
                backupfolder
            do

                if [ -d "$INSTALL_DIR/$folder" ]; then
                    cp -a \
                        "$INSTALL_DIR/$folder" \
                        "$backup_git/" || true
                fi

            done

            git reset --hard HEAD || true
            git clean -fd || true
        fi


        git reset --hard "$target_ref" ||
            die "Could not reset repository to $target_ref."


        git clean -fd \
            -e data/ \
            -e servers/ \
            -e software/ \
            -e backups/ \
            -e backupfolder/ \
            || true


        NODE_PATH="$(command -v node)"

        return 0
    fi


    # --------------------------------------------------------
    # Existing non-Git directory
    # --------------------------------------------------------

    if [ -d "$INSTALL_DIR" ] &&
       [ "$(find "$INSTALL_DIR" \
            -mindepth 1 \
            -maxdepth 1 \
            -print -quit |
            wc -l)" -gt 0 ]
    then

        warn "$INSTALL_DIR exists but is not a Git repository."

        local backup_dir

        backup_dir="${INSTALL_DIR}.backup-$(date +%Y%m%d-%H%M%S)"

        info "Moving existing directory to:"
        info "$backup_dir"

        mv "$INSTALL_DIR" "$backup_dir" ||
            die "Could not move existing installation."

        info "Old installation preserved at:"
        info "$backup_dir"
    fi


    # --------------------------------------------------------
    # Fresh clone
    # --------------------------------------------------------

    local branch

    if [ "$REF" = "auto" ]; then
        branch="$(get_default_branch || true)"
    else
        branch="$REF"
    fi


    if [ -n "$branch" ]; then

        info "Cloning branch: $branch"

        if ! retry git clone \
            --branch "$branch" \
            --single-branch \
            "$REPO_URL" \
            "$INSTALL_DIR"
        then

            warn "Branch clone failed."
            warn "Trying normal clone..."

            retry git clone \
                "$REPO_URL" \
                "$INSTALL_DIR" ||
                die "Could not clone NexusPanel."
        fi

    else

        info "Default branch could not be detected."
        info "Trying normal Git clone..."

        retry git clone \
            "$REPO_URL" \
            "$INSTALL_DIR" ||
            die "Could not clone NexusPanel."
    fi


    cd "$INSTALL_DIR" ||
        die "Could not enter installation directory."


    NODE_PATH="$(command -v node)"
}


# ============================================================
# npm configuration
# ============================================================

configure_npm() {

    export npm_config_audit=false
    export npm_config_fund=false

    export npm_config_fetch_retries=5
    export npm_config_fetch_retry_mintimeout=2000
    export npm_config_fetch_retry_maxtimeout=30000

    export npm_config_maxsockets=10
}


# ============================================================
# npm install recovery
# ============================================================

npm_install_with_recovery() {

    info "[3/8] Installing Node.js dependencies..."

    cd "$INSTALL_DIR" ||
        die "Cannot enter $INSTALL_DIR."

    configure_npm


    # First attempt
    if retry npm install \
        --omit=optional \
        --no-audit \
        --no-fund
    then

        info "Core npm dependencies installed."

        npm install \
            --include=optional \
            --no-audit \
            --no-fund ||
            warn "Optional npm dependencies could not be installed."

        return 0
    fi


    # Cache recovery
    warn "npm install failed."
    warn "Running npm cache verification..."

    npm cache verify || true


    if retry npm install \
        --no-audit \
        --no-fund
    then

        info "npm recovery succeeded."
        return 0
    fi


    # Clean cache
    warn "Cleaning npm cache..."

    npm cache clean --force || true


    if retry npm install \
        --no-audit \
        --no-fund
    then

        info "npm installation succeeded after cache recovery."
        return 0
    fi


    # npm ci
    if [ -f package-lock.json ]; then

        warn "Trying npm ci recovery..."

        if retry npm ci \
            --omit=optional \
            --no-audit \
            --no-fund
        then

            info "npm ci recovery succeeded."
            return 0
        fi
    fi


    die "Node.js dependency installation failed."
}


# ============================================================
# Build components
# ============================================================

build_components() {

    info "[3a/8] Building optional native components..."

    cd "$INSTALL_DIR" ||
        die "Cannot enter installation directory."


    if npm run build:nexusmark; then
        info "NexusMark build completed."
    else
        warn "NexusMark build failed."
        warn "Continuing with fallback sandbox."
    fi


    if npm run build:host-agent; then
        info "Host agent build completed."
    else
        warn "Host agent build failed."
        warn "Continuing."
    fi
}


# ============================================================
# Advanced AI
# ============================================================

ask_ai() {

    if [ "$INSTALL_AI" = "yes" ]; then
        return 0
    fi

    if [ "$INSTALL_AI" = "no" ]; then
        return 1
    fi


    echo
    echo "=================================================="
    echo " NexusPanel Advanced AI"
    echo "=================================================="
    echo
    echo "Optional local coding/diagnostic AI:"
    echo
    echo " Model:"
    echo " Qwen2.5-Coder-0.5B-Instruct"
    echo
    echo "The model is downloaded locally and is not required"
    echo "for the normal NexusPanel panel to work."
    echo
    echo "It can increase disk usage and first-install time."
    echo


    if [ -t 0 ] && [ -t 1 ]; then

        while true; do

            read -r -p \
                "Install Advanced AI now? [y/N]: " answer

            case "$answer" in

                y|Y|yes|YES)
                    return 0
                    ;;

                n|N|no|NO|"")
                    return 1
                    ;;

                *)
                    echo "Please answer y or n."
                    ;;
            esac

        done

    fi


    # Non-interactive installation
    warn "No interactive terminal detected."
    warn "Advanced AI will be skipped."

    return 1
}


install_advanced_ai() {

    info "[4/8] Advanced AI setup..."

    if ! ask_ai; then

        info "Advanced AI skipped."

        return 0
    fi


    cd "$INSTALL_DIR" ||
        die "Cannot enter installation directory."


    info "Installing @huggingface/transformers..."

    if ! retry npm install \
        @huggingface/transformers@latest \
        --no-audit \
        --no-fund
    then

        warn "Could not install Advanced AI package."
        warn "Continuing without Advanced AI."

        return 0
    fi


    if [ ! -f "$INSTALL_DIR/backend/advanced_ai.js" ]; then

        warn "backend/advanced_ai.js does not exist."

        warn "Skipping model initialization."

        return 0
    fi


    export HF_HOME="${HF_HOME:-$INSTALL_DIR/data/huggingface}"
    export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$HF_HOME}"


    mkdir -p "$HF_HOME"


    info "Initializing local AI model..."

    if "$NODE_PATH" \
        "$INSTALL_DIR/backend/advanced_ai.js"
    then

        info "Advanced AI initialized successfully."

    else

        warn "Advanced AI model initialization failed."
        warn "Core NexusPanel will continue working."
    fi
}


# ============================================================
# Prepare folders
# ============================================================

prepare_paths() {

    info "[5/8] Preparing directories and permissions..."

    cd "$INSTALL_DIR" ||
        die "Cannot enter installation directory."


    mkdir -p \
        data \
        servers \
        software \
        backups \
        backupfolder \
        update/backups \
        data/huggingface \
        /var/lib/nexuspanel \
        /var/lib/nexuspanel/backups \
        /var/lib/nexuspanel/logs \
        /var/lib/nexuspanel/nexus-mark


    printf '%s\n' "$EDITION" \
        > "$INSTALL_DIR/data/edition"


    if [ -f "$INSTALL_DIR/update/update.sh" ]; then
        chmod 755 "$INSTALL_DIR/update/update.sh" || true
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
        /var/lib/nexuspanel/nexus-mark \
        || true


    if [ "$SERVICE_USER" != "root" ]; then

        local group

        group="$(id -gn "$SERVICE_USER")"

        chown -R \
            "$SERVICE_USER:$group" \
            "$INSTALL_DIR/data" \
            "$INSTALL_DIR/servers" \
            "$INSTALL_DIR/software" \
            "$INSTALL_DIR/backups" \
            "$INSTALL_DIR/backupfolder" \
            "$INSTALL_DIR/update/backups" \
            /var/lib/nexuspanel \
            || true
    fi
}


# ============================================================
# CLI
# ============================================================

install_cli() {

    info "[6/8] Installing nexuspanel CLI..."


    if [ ! -f "$INSTALL_DIR/backend/cli.js" ]; then

        warn "backend/cli.js missing."

        warn "CLI installation skipped."

        return 0
    fi


    cat > /usr/local/bin/nexuspanel <<EOF
#!/usr/bin/env sh

NODE="$NODE_PATH"
INSTALL="$INSTALL_DIR"

exec "\$NODE" "\$INSTALL/backend/cli.js" "\$@"
EOF


    chmod 755 /usr/local/bin/nexuspanel


    hash -r 2>/dev/null || true


    info "CLI installed:"
    info "/usr/local/bin/nexuspanel"
}


# ============================================================
# Owner setup
# ============================================================

setup_owner() {

    info "[7/8] Owner account setup..."

    cd "$INSTALL_DIR" ||
        die "Cannot enter installation directory."


    if [ ! -f "$INSTALL_DIR/backend/cli.js" ]; then

        warn "backend/cli.js missing."
        warn "Owner setup skipped."

        return 0
    fi


    # Existing unattended credentials
    if [ -n "${NEXUSPANEL_OWNER_EMAIL:-}" ] &&
       [ -n "${NEXUSPANEL_OWNER_PASSWORD:-}" ]
    then

        info "Using unattended owner configuration."

        if NEXUSPANEL_SERVICE_USER="$SERVICE_USER" \
            "$NODE_PATH" \
            "$INSTALL_DIR/backend/cli.js" \
            setup-owner
        then

            info "Owner setup completed."
            return 0
        fi

        warn "Automatic owner setup failed."
    fi


    # Interactive setup
    if [ -t 0 ] && [ -t 1 ]; then

        echo
        echo "=================================================="
        echo " NexusPanel Owner Setup"
        echo "=================================================="
        echo


        if NEXUSPANEL_SERVICE_USER="$SERVICE_USER" \
            "$NODE_PATH" \
            "$INSTALL_DIR/backend/cli.js" \
            setup-owner
        then

            info "Owner setup completed."

        else

            warn "Owner setup returned an error."
            warn "You can run it later with:"
            echo
            echo "sudo nexuspanel setup-owner"
        fi

    else

        warn "No interactive terminal."
        warn "Owner setup skipped."
        warn "Run later:"
        echo
        echo "sudo nexuspanel setup-owner"
    fi
}


# ============================================================
# Systemd
# ============================================================

systemd_available() {

    command_exists systemctl &&
    [ -d /run/systemd/system ]
}


install_service() {

    info "[8/8] Installing NexusPanel systemd service..."


    if ! systemd_available; then

        warn "systemd is not running on this machine."
        warn "NexusPanel service installation skipped."

        info "You can start the panel manually with:"
        echo
        echo "cd $INSTALL_DIR"
        echo "npm start"

        return 0
    fi


    cd "$INSTALL_DIR" ||
        die "Cannot enter installation directory."


    if [ ! -f "$INSTALL_DIR/backend/service.js" ]; then

        die "backend/service.js is missing."
    fi


    local attempt=1
    local success=0


    while [ "$attempt" -le 3 ]; do

        info "Service installation attempt $attempt/3..."


        if NEXUSPANEL_SERVICE_NAME="$SERVICE_NAME" \
            NEXUSPANEL_SERVICE_USER="$SERVICE_USER" \
            "$NODE_PATH" \
            "$INSTALL_DIR/backend/service.js" \
            install
        then

            success=1
            break
        fi


        warn "Service installation attempt $attempt failed."

        systemctl daemon-reload || true

        sleep $((attempt * 2))

        attempt=$((attempt + 1))
    done


    if [ "$success" -ne 1 ]; then

        warn "Could not install the service automatically."

        journalctl \
            -u "$SERVICE_NAME" \
            -n 100 \
            --no-pager \
            2>/dev/null || true

        return 0
    fi


    systemctl daemon-reload || true


    systemctl enable "$SERVICE_NAME" \
        2>/dev/null || true


    if systemctl restart "$SERVICE_NAME"; then
        :
    else
        systemctl start "$SERVICE_NAME" || true
    fi


    sleep 3


    if systemctl is-active \
        --quiet \
        "$SERVICE_NAME"
    then

        info "NexusPanel service is running."

        return 0
    fi


    warn "Service did not start."


    echo
    echo "========== SERVICE LOG =========="

    journalctl \
        -u "$SERVICE_NAME" \
        -n 100 \
        --no-pager \
        2>/dev/null || true

    echo "================================="


    warn "Attempting one final service recovery..."


    systemctl daemon-reload || true
    systemctl reset-failed "$SERVICE_NAME" || true


    systemctl restart "$SERVICE_NAME" \
        2>/dev/null || \
    systemctl start "$SERVICE_NAME" \
        2>/dev/null || true


    sleep 3


    if systemctl is-active \
        --quiet \
        "$SERVICE_NAME"
    then

        info "Service recovered successfully."

    else

        warn "Service is still not running."
        warn "Installation itself completed, but the service needs investigation."

    fi
}


# ============================================================
# Diagnostics
# ============================================================

diagnostics() {

    echo
    echo "=============================================="
    echo " NexusPanel Installer Diagnostics"
    echo "=============================================="

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
    echo "Installation:"
    echo "$INSTALL_DIR"


    echo
    echo "Disk:"
    df -h "$INSTALL_DIR" /var 2>/dev/null || true


    echo
    echo "Memory:"
    free -h 2>/dev/null || true


    echo
    echo "Git branches:"
    if [ -d "$INSTALL_DIR/.git" ]; then
        git -C "$INSTALL_DIR" branch -a 2>/dev/null || true
    fi


    echo
    echo "Git remotes:"
    if [ -d "$INSTALL_DIR/.git" ]; then
        git -C "$INSTALL_DIR" remote -v 2>/dev/null || true
    fi


    echo
    echo "Service:"
    if systemd_available; then
        systemctl status \
            "$SERVICE_NAME" \
            --no-pager \
            2>/dev/null || true
    fi


    echo
    echo "Recent journal:"
    if systemd_available; then
        journalctl \
            -u "$SERVICE_NAME" \
            -n 50 \
            --no-pager \
            2>/dev/null || true
    fi


    echo
    echo "=============================================="
}


# ============================================================
# Final information
# ============================================================

show_info() {

    local public_ip

    public_ip="$(
        curl -fsS \
            --max-time 5 \
            https://ifconfig.me \
            2>/dev/null ||
        echo "YOUR_VPS_IP"
    )


    echo
    echo "=================================================="
    echo " NexusPanel installation completed"
    echo "=================================================="
    echo

    echo "Panel URL:"
    echo "http://${public_ip}:3000"

    echo
    echo "Service:"
    echo "$SERVICE_NAME"

    echo
    echo "Install directory:"
    echo "$INSTALL_DIR"

    echo
    echo "Edition:"
    echo "$EDITION"

    echo
    echo "Node:"
    "$NODE_PATH" --version 2>/dev/null || true

    echo
    echo "Installer log:"
    echo "$LOG_FILE"

    echo
    echo "Useful commands:"
    echo
    echo "  sudo nexuspanel status"
    echo "  sudo nexuspanel logs"
    echo "  sudo nexuspanel start"
    echo "  sudo nexuspanel stop"
    echo "  sudo nexuspanel restart"
    echo "  sudo nexuspanel doctor"
    echo "  sudo nexuspanel agent status"
    echo "  sudo nexuspanel nexusmark status"

    echo
    echo "Systemd:"
    echo
    echo "  sudo systemctl status $SERVICE_NAME"
    echo "  sudo journalctl -u $SERVICE_NAME -n 100 --no-pager"

    echo
    echo "=================================================="
}


# ============================================================
# EXIT HANDLER
# ============================================================

on_exit() {

    local rc=$?

    if [ "$rc" -ne 0 ]; then

        err "Installer exited with code $rc."

        diagnostics || true

        err "Full log:"
        err "$LOG_FILE"
    fi

    exit "$rc"
}


trap on_exit EXIT


# ============================================================
# Main
# ============================================================

main() {

    echo
    echo "=================================================="
    echo " NexusPanel Linux Installer v${VERSION}"
    echo " Smart Recovery Edition"
    echo "=================================================="
    echo


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
