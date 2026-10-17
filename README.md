# NexusPanel 1.0.0

Linux-native Minecraft server panel with the **ASF (Advanced Sandbox Fabric)**
kernel isolation protocol — our own Landlock + seccomp + cgroup v2 sandbox that
outperforms Docker on speed, memory, and version compatibility.

## Requirements

- Ubuntu / Debian / other systemd Linux (x86_64 or ARM64)
- Node.js ≥ 22.5.0
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

## Installers

The Linux release installers are in [`installers/`](installers/):

- `nexuspanel-normal-v1.0.0-linux-installer.sh` installs the normal edition.
- `nexuspanel-host-v1.0.0-linux-installer.sh` installs the host edition.

Both installers use the `v1.0.0` source tag by default. Windows users can run
[`install.bat`](install.bat) from the extracted release source.

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
