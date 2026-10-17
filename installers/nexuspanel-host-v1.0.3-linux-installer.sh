#!/usr/bin/env bash
set -euo pipefail

SOURCE_URL="${NEXUSPANEL_INSTALLER_SOURCE_URL:-https://raw.githubusercontent.com/Sarvesh12341234/Nexus-panel/v1.0.3/installers/nexuspanel-normal-v1.0.3-linux-installer.sh}"
TEMP_INSTALLER="$(mktemp)"
trap 'rm -f "$TEMP_INSTALLER"' EXIT

curl -fsSL "$SOURCE_URL" -o "$TEMP_INSTALLER"
chmod 700 "$TEMP_INSTALLER"

NEXUSPANEL_EDITION=host \
NEXUSPANEL_REF=v1.0.3 \
NEXUSPANEL_UPDATE_TAG=v1.0.3 \
bash "$TEMP_INSTALLER"
