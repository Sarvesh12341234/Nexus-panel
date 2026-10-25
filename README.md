# NexusPanel 1.0.4

Linux-native Minecraft server panel with the **ASF (Advanced Sandbox Fabric)**
kernel isolation protocol — our own Landlock + seccomp + cgroup v2 sandbox that
outperforms Docker on speed, memory, and version compatibility.

## Requirements

- Ubuntu / Debian / other systemd Linux (x86_64 or ARM64)
- Node.js ≥ 22.5.0 and < 25.0.0 (Node.js 24 is recommended)
- Python 3 for safe extraction of bundled Java runtimes
- A C compiler for the ASF sandbox (`apt install -y build-essential`)
- `acl` for per-server identities (`apt install -y acl`)

## Quick start

```bash
# 1. Clone and install
git clone <repo> nexuspanel && cd nexuspanel
npm install

# 2. Install the systemd service
sudo npm run service:install

# 3. Create the owner account
sudo nexuspanel setup-url
# Open the printed URL in a browser
```

Check `node --version` before installing manually. The supported range is
Node.js `>=22.5.0` and `<25.0.0`; Node.js 25 and newer are rejected until the
SQLite adapter is verified on that major version. If the version is outside
that range, install Node.js 24 and rerun the installation.

## Installers

The Linux release installers are in [`installers/`](installers/):

- `nexuspanel-normal-v1.0.4-linux-installer.sh` installs the normal edition.
- `nexuspanel-host-v1.0.4-linux-installer.sh` installs the host edition.

Both installers use the `v1.0.4` source tag by default. Windows users can run
[`install.bat`](install.bat) from the extracted release source.

Game-server execution is supported only on Linux hosts where the per-server
locked identity and ASF systemd isolation preflight succeed. Launch fails closed
if either isolation prerequisite is unavailable; it never falls back to running
tenant code as the panel service account. The legacy Windows SYSTEM startup task
is removed by the Windows service installer; server starts are disabled on
Windows until an equivalent per-server isolation boundary is available.

The file manager remains available while a server is running for browsing and
downloading. Plugin configuration files under `plugins/<plugin>/` can also be
edited live; whether changes apply immediately depends on the plugin, and many
require a plugin reload or server restart. Uploads, deletes, moves, extraction,
and other file changes require the server to be stopped.

## Per-server database provisioning

NexusPanel can provision a dedicated MySQL/MariaDB database and random user for
each game server on an existing database host. It does not install or host
MariaDB itself. The panel keeps its own application database separate.

Configure the existing database host for the systemd service:

```bash
sudo install -d -m 0750 /etc/nexuspanel
sudo install -m 0600 /dev/null /etc/nexuspanel/database.env
sudoedit /etc/nexuspanel/database.env
```

Add the following settings, replacing the host, admin user, and password:

```ini
NEXUSPANEL_DB_HOST=127.0.0.1
NEXUSPANEL_DB_PORT=3306
NEXUSPANEL_DB_USER=nexuspanel_admin
NEXUSPANEL_DB_PASSWORD=replace-with-a-long-random-secret
NEXUSPANEL_DB_ALLOWED_HOST=%
NEXUSPANEL_DB_PUBLIC_HOST=127.0.0.1
```

The database admin account needs privileges to create/drop databases and users,
alter generated users, and grant privileges on newly created databases. The
default allowed host `%` matches the screenshot but permits access from any
source accepted by the database server; replace it with a trusted game-server
IP/host where possible. Set `NEXUSPANEL_DB_PUBLIC_HOST` to the address the game
server should use if it cannot reach the host via `127.0.0.1`. Then restart
NexusPanel with `sudo systemctl restart nexuspanel`.

Open a server's **Databases** view and choose **Create database**. **Details**
shows its endpoint, allowed source, username, password, and JDBC URL. Passwords
are encrypted at rest; rotating one changes the database user password, so
update the game-server configuration afterwards. Deleting a provisioned entry
also drops its database and user. Existing external connections can still be
saved separately without provisioning.

## The ASF protocol

ASF isolates every Minecraft server with kernel-enforced rules — no Docker
daemon, no images, no overlayfs:

| Layer | Mechanism |
|---|---|
| Identity | Locked system user `asf-s<id>` + POSIX ACLs |
| Landlock | Filesystem scope + net-port bind lock (ABI 4+) |
| Seccomp BPF | Denies mount/swap/reboot/raw-io/privileged syscalls |
| Cgroup v2 | MemoryMax, CPUQuota, TasksMax, IOWeight |
| Supervisor | `asf_runtime` static-PIE binary, exit-code contract |

Full spec: [`docs/ASF-PROTOCOL.md`](docs/ASF-PROTOCOL.md)

## CLI

```bash
nexuspanel status            # service status
nexuspanel doctor            # full diagnostic
nexuspanel asf status        # kernel isolation status
nexuspanel asf rebuild       # rebuild the sandbox binary
nexuspanel permissions repair # fix file ownership/modes
nexuspanel update            # safe self-update with rollback
nexuspanel help               # everything else
```

## Security model

- Sessions: HMAC-signed cookies, 12 h TTL, 2 h idle, UA binding
- CSRF: `x-nexuspanel-request` header on every mutating call
- Headers: CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy
- Files: path-traversal guard, symlink walk block, Zip Slip protection
- SSRF: private-address blocking + DNS pinning (rebinding-proof)
- Uploads: SHA-256 chunk verification, size caps
- Archives: ZIP, TAR, GZ, BZ2, XZ, ZST, 7Z, and RAR extraction; 7Z/RAR need libarchive (`bsdtar`)
- CSRF: mutating cookie-authenticated requests require the custom header and reject cross-site/same-site origins
- Auth: scrypt password hashing, login throttling, constant-time OTP compare
- Errors: no stack traces or internal paths leak to clients

## Testing

```bash
npm test               # full suite
npm run test:exploit   # 90+ adversarial attack simulations
npm run build:asf      # build the sandbox
sudo npm run audit:asf # root sandbox-escape audit
npm run benchmark:asf  # launch overhead benchmark
```

## AI training corpus

[`docs/AI-TRAINING-CORPUS.md`](docs/AI-TRAINING-CORPUS.md) — 408 coded error
records, full route registry, CLI reference, Linux command reference, and
SFT/RAG training formats for the NexusPanel support AI.

## Layout

```
backend/    Express API, ASF engine, runtime supervisor
native/     asf_runtime.c sandbox + host agent (C)
frontend/   Vanilla JS SPA
tests/      Unit + adversarial security suites
installers/ Linux install scripts
update/     Safe updater with rollback
```

## License

MIT
