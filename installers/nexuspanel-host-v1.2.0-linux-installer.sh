#!/usr/bin/env bash
set -euo pipefail

SOURCE_URL="${NEXUSPANEL_INSTALLER_SOURCE_URL:-https://raw.githubusercontent.com/Sarvesh12341234/Nexus-panel/host-v1.2.0/installers/nexuspanel-normal-v1.2.0-linux-installer.sh}"
TEMP_INSTALLER="$(mktemp)"
trap 'rm -f "$TEMP_INSTALLER"' EXIT

curl -fsSL "$SOURCE_URL" -o "$TEMP_INSTALLER"
chmod 700 "$TEMP_INSTALLER"

NEXUSPANEL_EDITION=host \
NEXUSPANEL_RELEASE_TAG=host-v1.2.0 \
bash "$TEMP_INSTALLER"
