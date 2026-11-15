# NexusPanel 1.0.0

NexusPanel is a Minecraft server management panel with a web console, file
manager, backups, server configuration, and local repair tools. Linux game
servers run under the ASF (Advanced Sandbox Fabric) isolation system, using
per-server identities and kernel controls.

## Install on a Linux VPS

Use a supported systemd-based Linux host. The installer installs dependencies,
downloads the panel and its Git LFS model, sets up the service, and prints a
first-run setup URL. It installs the local Needle repair runtime by default.

**Normal edition:**

```bash
curl -fsSL https://github.com/Sarvesh12341234/Nexus-panel/releases/latest/download/nexuspanel-normal-v1.0.0-linux-installer.sh -o nexuspanel-install.sh
sudo bash nexuspanel-install.sh
```

**Host edition:**

```bash
curl -fsSL https://github.com/Sarvesh12341234/Nexus-panel/releases/latest/download/nexuspanel-host-v1.0.0-linux-installer.sh -o nexuspanel-host-install.sh
sudo bash nexuspanel-host-install.sh
```

Open the setup URL printed by the installer to create the owner account. The
panel listens on port **3000** by default; configure your firewall and reverse
proxy for your deployment. To skip the optional Needle runtime, run the
installer with `sudo env NEXUSPANEL_INSTALL_AI=no bash nexuspanel-install.sh`.

The release installers use the `v1.0.0` source tag by default. The Linux panel
service currently runs as root to provision separate locked server identities
and ACLs; game servers run under those separate identities. Starts fail closed
when the required ASF isolation or identity checks do not succeed.

## Requirements

- Linux with systemd for isolated game-server execution.
- Node.js `>=22.5.0` and `<25`, and npm `>=10` for manual installation.
- Git LFS for the bundled model, Python 3 and a virtual environment for
  Needle, a C compiler for ASF, and POSIX ACL tools. The installer attempts
  to install the required packages.
- Windows can run the panel for management, but game-server starts are
  disabled until equivalent per-server isolation is available. Run
  [`install.bat`](install.bat) from a checkout with Node.js installed.

## Features

- Manage servers and view the live console, status, and resource metrics.
- Browse files, search names and text, edit supported files, upload in chunks,
  and manage archives. Browsing and downloading remain available while a
  server runs; most file changes require it to be stopped. Plugin configuration
  files under `plugins/<plugin>/` can be edited live, subject to plugin behavior.
- Manage software, server properties, whitelist, plugins, backups, network
  allocations, database connections, admins, and panel settings.
- Provision per-server databases on an existing MySQL/MariaDB host; NexusPanel
  does not install or host the database server for you.
- Use the repair preview and bounded repair tools. The local Needle repair
  model routes confirmed diagnostic candidates; it is not an unrestricted
  autonomous repair agent. See [Needle setup and limitations](ai/needle2/README.md).

## Optional AI chat

The owner can enable AI chat in Settings, select OpenAI, NVIDIA or Anthropic,
and enter a provider model ID and API key. The key is encrypted on the panel;
keep the panel data directory and its `ai-chat.secret` file together in backups.
On the first visit to the AI section, choose a separate password of at least
12 characters. Unlocks and in-memory chat history expire after ten minutes.

The assistant works on the selected server: it can inspect text files, logs,
server status and panel events, edit text files while the server is stopped,
send server console commands, and run a small set of diagnostic commands.
These operations can change server data. The provider receives chat messages
and any file or log content the assistant reads, and provider usage may incur
charges. Terminal access is limited to diagnostics, and repairs depend on the
model and available tools; successful repair is not guaranteed. This optional
cloud feature is separate from the local Needle repair model.

Owners can optionally enable **AI full access** in Settings using the AI chat
password. It allows the assistant to run shell commands with the panel service
account's privileges, starting in the selected server directory. On a standard
Linux installation the service runs as root, so those commands can access and
modify the entire VPS, including panel settings and other servers. Enable it
only for a trusted provider. Disabling AI chat also disables full access;
changing the full-access setting locks current AI sessions.

## Update and administration

```bash
sudo nexuspanel status
sudo nexuspanel logs
sudo nexuspanel doctor
sudo nexuspanel asf status
sudo nexuspanel restart
sudo nexuspanel setup-url       # only before the first owner is created
sudo nexuspanel update
nexuspanel help
```

The updater preserves server files, panel data, backups, and configuration.
See [updater documentation](update/README.md) for details and tag overrides.
Installations created from a source archive need Git and Git LFS to retrieve
the bundled repair model.

To configure database provisioning, create `/etc/nexuspanel/database.env`:

```ini
NEXUSPANEL_DB_HOST=127.0.0.1
NEXUSPANEL_DB_PORT=3306
NEXUSPANEL_DB_USER=nexuspanel_admin
NEXUSPANEL_DB_PASSWORD=replace-with-a-long-random-secret
NEXUSPANEL_DB_ALLOWED_HOST=trusted-game-server-host
NEXUSPANEL_DB_PUBLIC_HOST=database-address-visible-to-game-servers
```

Restrict access to that file and restart the service. The database admin needs
permission to create and remove the databases and users NexusPanel provisions.
Rotating a database password requires updating the game-server configuration.

## Manual development setup

```bash
git lfs install
git clone https://github.com/Sarvesh12341234/Nexus-panel.git
cd Nexus-panel
git lfs pull
npm ci
npm run foreground
```

For a Linux systemd service, run `sudo npm run service:install` and then
`sudo nexuspanel setup-url`. The repair model needs the pinned Python runtime;
see the [Needle documentation](ai/needle2/README.md) for setup and evaluation.

## Testing and project layout

```bash
npm test
npm run test:exploit
npm run build:asf
sudo npm run audit:asf
```

`backend/` contains the API and runtime, `frontend/` the web interface,
`native/` the ASF and host-agent sources, `models/` the repair model,
`tests/` the regression tests, and `installers/` and `update/` the deployment
scripts. See the [ASF protocol](docs/ASF-PROTOCOL.md) for isolation details.

## License

NexusPanel is MIT licensed. The repair model is derived from
[Cactus Compute Needle 2](https://huggingface.co/Cactus-Compute/needle2); see
its upstream license and the [model documentation](ai/needle2/README.md).
