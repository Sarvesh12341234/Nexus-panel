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
curl -fsSL https://github.com/Sarvesh12341234/Nexus-panel/releases/download/normal-v1.2.0/nexuspanel-normal-v1.2.0-linux-installer.sh | sudo bash
```

Host edition:

```bash
curl -fsSL https://github.com/Sarvesh12341234/Nexus-panel/releases/download/host-v1.2.0/nexuspanel-host-v1.2.0-linux-installer.sh | sudo bash
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
nexuspanel change panelport 8080
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

## v1.2.0 Editions

- `normal-v1.2.0`: advanced solo panel with fast transfer, backups, plugin/file/software managers, shared admin visibility, and host-only features hidden.
- `host-v1.2.0`: hosting edition using the same engine plus owner/all-server visibility, host API, templates, and assigned-user server isolation.
- The updater stores the installed edition in `data/edition` and updates from the matching tag: `normal-v1.2.0` or `host-v1.2.0`.
- The update repository is locked to `Sarvesh12341234/Nexus-panel`; users cannot change it from the panel UI.
- If an update finds server folders such as `5-summa` missing from SQLite, NexusPanel recovers them into the server list on boot.

## v1.2.0 Transfer + Safety

- Upload chunks increased to `32MB`.
- Uploads use up to `4` parallel chunks per file.
- Browser calculates SHA-256 for the full file and each chunk.
- Backend verifies chunk checksum and final file checksum before completing upload.
- Upload progress now resumes from saved chunks without crashing the browser progress code.
- File-manager copy/cut/paste is locked to the source server, preventing cross-server paste leaks.
- Downloads support HTTP range requests for resume/split download managers.
- Optional Nginx `X-Accel-Redirect` can offload huge downloads from Node.
- The Network page uses a real browser-to-panel upload/download probe instead of guessing from interface counters.
- Backups default to `/var/lib/nexuspanel/backups` on Linux, outside `/opt/nexuspanel`.
- Backup intervals support typed minute or hour values instead of hours only.
- ZIP extraction validates the file first and asks whether to replace or skip duplicates.

## v1.2.0 Fixes

- Settings updater shows live progress, status text, and final exit state.
- Backup scheduling has 30-second resolution, per-server owner timezones, visible next-run timing, and offset-stamped archive names.
- Uploads use server-authoritative ranges, per-file locks, 8 MB chunks, and one-second cross-client progress refresh.
- Public backup links support a configurable public panel URL and eligible Normal/Host account ownership.
- Transfer URLs reject normal browser downloads and are consumed through NexusPanel's Import Backup workflow.
- The Adaptive Engine learns baselines for servers, backups, uploads, CPU, and memory and performs non-destructive maintenance.
- Alpha UI Studio provides 20 controls, draft previews, explicit save/cancel, undo/redo, navigation order, and command order.
- Its visual editor has separate Boxes and Buttons modes for mouse, pen, and touch placement. Cards, forms, status blocks, field groups, tool panels, and buttons can be reordered and resized without moving the outer panel shell.
- Free mode supports bounded pixel-level X/Y placement, 1px arrow-key nudging, Shift+Arrow 10px movement, configurable mouse snapping, layers, position reset, and independent desktop/mobile coordinates. Flow mode retains responsive order-based placement.
- Component and button layouts share the floating save/undo controls and permanent portable UI codes.
- Portable UI codes use a versioned `NXUI2` format. Import remains compatible with older URL-safe Base64 codes, standard Base64, raw JSON, and codes pasted with surrounding text.
- Editor selection survives live panel rerenders, supports Shift/Ctrl multi-select, and can align edges or centers and distribute three or more boxes/buttons horizontally or vertically.
- Visual-editor undo and redo operate on one drag, nudge, resize, coordinate edit, or alignment action at a time without reverting unrelated sections.
- Repair & Diagnose learns a redacted crash signature from successful fixes and safely repeats the same built-in repair workflow when that error returns.
- The repair brain includes 748 diagnostic signals across 47 cause families covering game runtimes, plugins, mods, worlds, networks, storage, databases, and VPS limits.
- Owner-terminal commands can be associated with a crashed server. Exit-zero commands are observed, stability-validated after the game remains online, and replayed only when they are idempotent and confined to that server root; dangerous commands remain redacted evidence.
- Stored server roots are rediscovered from ID-prefixed folders and real game files. Missing or malformed `server.properties` files are backed up, validated, normalized, and atomically rewritten before startup.
- SQLite uses integrity checks, foreign-key checks, verified rotating snapshots, and startup recovery from the latest verified snapshot when the primary database cannot open.
- Login, password reset, and protected owner-password fields include accessible password reveal controls.
- Password-reset delivery sends styled multipart HTML through local sendmail and provider-specific Resend, Brevo, SendGrid, or generic API payloads.
- Host Edition adds maintenance mode and configurable per-account server quotas.
- Nexus-Mark uses transient systemd services; 1-3 core servers receive a temporary startup burst while allocations of 4+ cores stay at their configured steady limit.
- Launch-failure restart storms stop automatically and do not create meaningless crash backups.
- Server settings now expose per-server auto start, auto restart, wake on join, crash backup, startup delay, RAM, port, and a confirmed Fix Server action after creation.
- Backups include minute/hour scheduling, 6-digit share-code requests, owner approval, timed access, revoke, and a separate shared-backup restore section.
- Cross-panel backup transfer uses revocable public archive links with 256-bit random tokens, hashed token storage, expiry, ranged downloads, remote ZIP validation, and private-network import blocking.
- Timezone selection is per account, includes `Asia/Kolkata` and `Asia/Calcutta`, and remains stable while live status polling runs.
- Password recovery now has a dedicated `/reset.html` page, one-minute request throttling, session invalidation after reset, generic email-relay support, and first-class Resend payload support.
- Auto-start now runs at panel boot with each server's startup delay. Unexpected exits can create a crash backup and auto-restart; operator Stop, Kill, and Restart remain intentional.
- On Linux/systemd, Nexus-Mark launches game processes in transient cgroup scopes with RAM, task, and CPU limits. Servers receive a 90-second CPU startup burst before returning to their configured core limit.
- Normal edition admins can see assigned panel servers by permission level; host-only templates and host token controls are hidden outside host edition.
- Software version selects prefer the latest refreshed version for installs.
- Starting a server can run a deterministic smart repair for missing executables before retrying.
- Admin creation supports permanent or temporary accounts, with expiry enforced during auth.
- Login has a real reset-password code form; without email relay the code is written to `data/password-reset-otp.log` for the VPS owner.

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
- Template-first setup replaces the old tunnel page: Bedrock, Java crossplay, PocketMine, Purpur performance, Rust, ARK, Valheim, Palworld, Factorio, Satisfactory, and Project Zomboid templates.
- Settings includes a safe GitHub updater for `Sarvesh12341234/Nexus-panel`, owner-only terminal toggle, and Nexus-Mark controls.
- Network page shows inbound/outbound traffic totals and a one-click current upload/download speed sample.
- System metrics use Linux `/proc/stat` CPU deltas and `MemAvailable` RAM where available, with robust logical-core detection through `nproc`/`lscpu`.
- Template view defaults host edition to Minecraft templates; selecting another game switches the available templates and software path.
- Host API can create an account and assigned server in one request for hosting automation.
- Template JSON supports requirements, RAM/CPU/disk, ports, start args, paths, properties, and Nexus-Mark security profile.
- Nexus-Mark is NexusPanel's original no-Docker control layer: path sandboxing, per-server root, RAM allocation guard, external resource profile files, and Linux systemd/cgroup plan metadata.
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

Forgot-password OTP reset is built in. Configure a tiny email relay with:

```bash
NEXUSPANEL_EMAIL_API_URL=https://your-email-api/send
NEXUSPANEL_EMAIL_API_KEY=optional-token
NEXUSPANEL_EMAIL_FROM=NexusPanel <panel@example.com>
```

Without an email relay, OTPs are written to `data/password-reset-otp.log` for the VPS owner.

For Resend, set `NEXUSPANEL_EMAIL_PROVIDER=resend` and use
`NEXUSPANEL_EMAIL_API_URL=https://api.resend.com/emails`. The API key is sent as a
Bearer token. Password recovery is available on the dedicated `/reset.html` page.

Host API provisioning example:

```bash
curl -X POST http://YOUR_PANEL:3000/api/host/provision \
  -H "Authorization: Bearer YOUR_HOST_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account":{"email":"player@example.com","password":"StrongPass123","name":"Player","accessLevel":5},"server":{"name":"Player SMP","type":"java","ramMb":4096,"cpuCores":2,"port":25565,"softwareKey":"paper"}}'
```

| Level | Access |
| --- | --- |
| `0` | View only |
| `5` | Start, stop, restart, kill |
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
