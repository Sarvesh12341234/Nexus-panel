# 🚀 NexusPanel - Minecraft Server Control Panel

A lightweight, powerful, and user-friendly web-based control panel for Minecraft **Bedrock and Java** servers.

## 🎯 Features

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Linux/Ubuntu one-command installer:

```bash
curl -fsSL https://github.com/Sarvesh12341234/Nexus-panel/releases/download/v1.1.1/nexuspanel-v1.1.1-linux-installer.sh | sudo bash
```

## VPS Background Service

On Linux VPS hosts with systemd, `npm start` installs/starts NexusPanel as a background system service instead of keeping it attached to your terminal. The service restarts automatically if the panel crashes and starts again after the VPS reboots.

```bash
npm start
```

Useful commands:

```bash
npm run service:status
npm run service:logs
sudo npm run service:install
sudo npm run service:uninstall
npm run foreground
```

After service install, Linux also gets the direct command:

```bash
nexuspanel start
nexuspanel stop
nexuspanel restart
nexuspanel status
nexuspanel logs
nexuspanel update
```

On first run, `nexuspanel start` or `nexuspanel install` asks for owner account name, email, and password before starting the panel.

- `npm start`: smart mode; on Linux/systemd it moves the panel to the background service.
- `npm run foreground`: normal console mode for debugging.
- `npm run service:logs`: live logs from `journalctl -u nexuspanel -f`.
- Windows/non-systemd machines keep using foreground mode automatically.

## Safe Updates

NexusPanel includes a safe updater that snapshots panel code, pulls/copies updates, runs `npm install`, and restarts the service without touching Minecraft data.

```bash
cd /root/summa/panel
bash update/update.sh
```

Protected folders: `servers/`, `data/`, `software/`, `node_modules/`, and the external backup store.

## v1.1.1 Transfer + Safety

- Upload chunks increased to `32MB`.
- Uploads use up to `4` parallel chunks per file.
- Browser calculates SHA-256 for the full file and each chunk.
- Backend verifies chunk checksum and final file checksum before completing upload.
- Downloads support HTTP range requests for resume/split download managers.
- Optional Nginx `X-Accel-Redirect` can offload huge downloads from Node.
- Backups default to `/var/lib/nexuspanel/backups` on Linux, outside `/opt/nexuspanel`.
- ZIP extraction validates the file first and asks whether to replace or skip duplicates.

Optional Nginx acceleration:

```nginx
location /protected-files/ {
  internal;
  alias /opt/nexuspanel/servers/;
}
```

Then set the service environment:

```bash
NEXUSPANEL_X_ACCEL_ROOT=/opt/nexuspanel/servers
NEXUSPANEL_X_ACCEL_PREFIX=/protected-files
```

With this enabled, NexusPanel still checks login/auth first, then Nginx streams the real file at maximum VPS speed.

## New Panel Upgrades

- 10 selectable neon themes from the top bar.
- External backups saved in `/var/lib/nexuspanel/backups/<server-id>/` on Linux, not inside the server or panel source folder.
- Server delete button with online-server protection.
- RAM/port/name editor after server creation.
- Live whitelist reload for running Java/Bedrock servers where supported by the server software.
- Whitelist remove confirmation plus remove-all action.
- Server metrics: process RAM, allocated RAM, CPU, and detected online players.
- Console scroll lock: scrolling up no longer snaps back down.
- Chunked/resumable file uploads with pause/cancel and cross-device progress visibility.
- File manager actions: upload, copy, cut, paste, archive, unzip, delete, select all.
- More optimizer capability cards and VPS tuning notes.
- Template-first setup replaces the old tunnel page: Bedrock, Java crossplay, PocketMine, Purpur performance, and Nexu placeholders for more games.
- Settings includes a safe GitHub updater for `Sarvesh12341234/Nexus-panel`, owner-only terminal toggle, and Nexus-Mark controls.
- `.nexu` is a JSON template format with requirements, RAM/CPU/disk, ports, start args, paths, properties, and Nexus-Mark security profile.
- Nexus-Mark is NexusPanel's original no-Docker control layer: path sandboxing, per-server root, RAM allocation guard, resource profile files, and Linux systemd/cgroup plan metadata.
- The UI includes a DevTools deterrent that redirects to Google for common inspector shortcuts; real protection is still server-side owner auth and permission checks.

## Accounts

On first launch, NexusPanel asks for an owner account in the terminal before the web panel starts. After that, the web panel only shows login until a valid session exists. Accounts are saved in `data/nexuspanel.sqlite`.

For unattended setup, set:

```bash
NEXUSPANEL_OWNER_EMAIL=owner@example.com
NEXUSPANEL_OWNER_PASSWORD=password123
npm start
```

The owner can create admin accounts with an email, password, and access level from `0` to `100`.

| Level | Access |
| --- | --- |
| `0` | View only |
| `20` | View console |
| `40` | Send console commands |
| `60` | Manage servers |
| `80` | Manage files and configs |
| `100` | Manage admins and all panel controls |

Passwords are hashed with Node's `crypto.scryptSync`. Login sessions are stored in SQLite and sent as signed HTTP-only cookies.

## Current MVP

- First-run owner creation
- Email/password login
- SQLite users, sessions, and server records
- Owner admin creation and access editing
- Guarded API routes based on numeric permissions
- Basic server dashboard records for Bedrock and Java
- Single-call `/api/overview` dashboard refresh for faster loading
- Lightweight server options: auto start, auto restart, crash backup, daily backups, backup retention, wake on join, whitelist, RAM cap, and startup delay
- Host optimizer panel for Linux/VPS networking, DNS planning, BBR/fq, socket buffers, MTU probing, file limits, and low-memory swappiness
- Smart software catalog for Bedrock Dedicated Server, Java Vanilla, Paper, Purpur, and PocketMine-MP
- Linux Java servers auto-detect missing Java and try to install Java 21 through the host package manager before downloading server software.
- Nexu templates are NexusPanel's original import format for future/custom games.
- Plugin/pack registry with compatibility checks and safe per-server target paths

## Host Optimizer

NexusPanel detects the host OS before showing optimization actions.

- Windows: optimization is disabled and shown as unsupported.
- Linux: current sysctl values, DNS resolvers, kernel, RAM, CPU count, and VPS hints are shown.
- Linux root: the owner can apply whitelisted sysctl tweaks from the panel.
- Linux non-root: NexusPanel shows copyable commands instead of trying privileged writes.

The optimizer stays lightweight: no background agent, no polling loop, no AI service, no Docker, and no extra packages.

## Software And Plugins

NexusPanel keeps server files under `servers/` and rejects plugin paths that try to escape that directory.

- Java Vanilla: no plugin loader.
- Paper and Purpur: `.jar` plugins go to `servers/<server>/plugins/`.
- PocketMine-MP: `.phar` plugins go to `servers/<server>/plugins/`.
- Bedrock Dedicated Server: `.mcpack` and `.mcaddon` packs go under `servers/<server>/packs/`.

The plugin section currently registers the correct target path and compatibility metadata. A later file-manager/upload step can copy the actual file into that verified path.

Software installation currently prepares the correct server folder, executable path, and progress/status state. It writes an install marker at the target executable path so the panel can show install progress immediately; replacing that marker with real Paper/Purpur/Bedrock download logic is the next step.
