# NexusPanel AI Training Corpus

**Purpose:** Ground-truth training data for a NexusPanel-specialized AI model.
**Scope:** Every command, route, capability, error, and failure mode in the panel.
**Format:** Structured records suitable for supervised fine-tuning (SFT) and
retrieval-augmented generation (RAG). Each record is a self-contained
`problem → cause → fix` triple.

**Version:** NexusPanel 6.0.0 (ASF edition)
**Generated:** 2026-10-12

---

## Table of contents

1. [System architecture](#1-system-architecture)
2. [CLI command reference](#2-cli-command-reference)
3. [HTTP API route registry](#3-http-api-route-registry)
4. [Capability & permission model](#4-capability--permission-model)
5. [ASF isolation protocol](#5-asf-isolation-protocol)
6. [Error catalogue — authentication](#6-error-catalogue--authentication)
7. [Error catalogue — permissions](#7-error-catalogue--permissions)
8. [Error catalogue — server lifecycle](#8-error-catalogue--server-lifecycle)
9. [Error catalogue — Minecraft installation](#9-error-catalogue--minecraft-installation)
10. [Error catalogue — Java runtime](#10-error-catalogue--java-runtime)
11. [Error catalogue — files & uploads](#11-error-catalogue--files--uploads)
12. [Error catalogue — backups](#12-error-catalogue--backups)
13. [Error catalogue — plugins & mods](#13-error-catalogue--plugins--mods)
14. [Error catalogue — ASF sandbox](#14-error-catalogue--asf-sandbox)
15. [Error catalogue — systemd service](#15-error-catalogue--systemd-service)
16. [Error catalogue — network & tunnels](#16-error-catalogue--network--tunnels)
17. [Error catalogue — database](#17-error-catalogue--database)
18. [Error catalogue — AI & repair agent](#18-error-catalogue--ai--repair-agent)
19. [Error catalogue — UI/UX](#19-error-catalogue--uiux)
20. [Training record schema](#20-training-record-schema)
21. [Appendix D — Numeric error code scheme](#appendix-d--numeric-error-code-scheme)
22. [Appendix E — Complete code registry](#appendix-e--complete-code-registry)
23. [Appendix F — HTTP status → error codes](#appendix-f--http-status--error-codes)
24. [Appendix G — Process exit code → error codes](#appendix-g--process-exit-code--error-codes)
25. [Appendix H — Keyword → error codes](#appendix-h--keyword--error-codes)
26. [Appendix I — Updated error count summary](#appendix-i--updated-error-count-summary)
27. [Appendix J — Linux terminal command reference](#appendix-j--linux-terminal-command-reference)
28. [Appendix K — NexusPanel terminal command reference](#appendix-k--nexuspanel-terminal-command-reference)

---

## 1. System architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Browser (vanilla JS SPA, frontend/js/main.js)                    │
│   role/capability-gated views · CSRF header · session cookie     │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTPS (reverse proxy recommended)
┌───────────────────────────▼──────────────────────────────────────┐
│ backend/index.js — Express 5 API + static host                   │
│   authMiddleware → CSRF gate → security headers → routes         │
└───┬───────────┬───────────┬───────────┬───────────┬──────────────┘
    │           │           │           │           │
┌───▼───┐ ┌─────▼─────┐ ┌───▼────┐ ┌────▼─────┐ ┌───▼──────────┐
│ db.js │ │runtime.js │ │asf.js  │ │software  │ │repair_agent  │
│SQLite │ │process   │ │kernel  │ │.js       │ │.js + micro_lm│
│       │ │supervisor│ │sandbox │ │downloads │ │              │
└───────┘ └─────┬─────┘ └───┬────┘ └──────────┘ └──────────────┘
                │           │
        ┌───────▼───────────▼────────┐
        │ asf_runtime (static-PIE C) │
        │ Landlock + seccomp + cgroup│
        └────────────┬───────────────┘
                     │
              ┌──────▼──────┐
              │ Java / PHP  │  ← the Minecraft server
              └─────────────┘
```

**Key invariants the AI must know:**

- The panel never runs Minecraft as root. ASF drops to `asf-s<id>` per server.
- Resource limits come from SQLite (`max_memory_mb`, `cpu_cores`), never from
  editable server files.
- Every mutating API call requires the `x-nexuspanel-request: 1` header.
- The owner account is the only role that can bypass capability checks.

---

## 2. CLI command reference

Binary: `nexuspanel` (installed to `/usr/local/bin/nexuspanel`).

| Command | Purpose | Requires root |
|---|---|---|
| `nexuspanel version` | Print panel version | no |
| `nexuspanel doctor` | Full platform + ASF + host-agent diagnostic | no |
| `nexuspanel platform` | Print platform capability matrix | no |
| `nexuspanel status` | systemd service status | no |
| `nexuspanel start` | Start the panel service | yes |
| `nexuspanel stop` | Stop the panel service | yes |
| `nexuspanel restart` | Restart the panel service | yes |
| `nexuspanel logs` | Follow journalctl for the panel | no |
| `nexuspanel install` | Install + start the systemd service | yes |
| `nexuspanel service install` | Install service without starting | yes |
| `nexuspanel change panelport <n>` | Change the panel HTTP port | yes |
| `nexuspanel update` | Run `update/update.sh` | yes |
| `nexuspanel setup-owner` | Create the first owner account | no |
| `nexuspanel setup-url` | Print the first-run setup URL | no |
| `nexuspanel users` | List users + sessions | no |
| `nexuspanel asf status` | ASF kernel isolation status | no |
| `nexuspanel asf rebuild` | Rebuild the ASF native binary | no |
| `nexuspanel asf start\|stop\|restart` | Control the ASF preflight unit | yes |
| `nexuspanel asf logs` | ASF preflight journal | no |
| `nexuspanel agent status` | Host agent local + live status | no |
| `nexuspanel agent start\|stop\|restart` | Control the host agent unit | yes |
| `nexuspanel agent logs` | Host agent journal | no |
| `nexuspanel intelligence [scope]` | Print learned intelligence snapshot | no |
| `nexuspanel permissions audit` | Audit file ownership/modes | no |
| `nexuspanel permissions repair` | Repair validated permission defects | yes |
| `nexuspanel foreground` | Run the panel in the foreground | no |

### CLI error records

```yaml
- id: cli-unknown-command
  trigger: "nexuspanel frobnicate"
  error: "Unknown command: frobnicate"
  cause: The command is not in the CLI dispatch table.
  fix: "Run `nexuspanel help` to list valid commands."
  exit_code: 1

- id: cli-root-required
  trigger: "nexuspanel install (as non-root)"
  error: "Root is required. Run: sudo npm run service:install"
  cause: systemd unit installation writes to /etc/systemd/system.
  fix: "Re-run with sudo."
  exit_code: 1

- id: cli-systemd-missing
  trigger: "nexuspanel install on a non-systemd host"
  error: "Systemd is required for VPS background service mode."
  cause: /run/systemd/system does not exist.
  fix: "Use `nexuspanel foreground` or install systemd."
  exit_code: 1

- id: cli-no-owner-interactive
  trigger: "nexuspanel start with no owner and no TTY"
  error: "No owner account exists. Run nexuspanel start in an interactive terminal or set NEXUSPANEL_OWNER_EMAIL and NEXUSPANEL_OWNER_PASSWORD."
  cause: First-run owner creation needs interactive input.
  fix: "Set NEXUSPANEL_OWNER_EMAIL + NEXUSPANEL_OWNER_PASSWORD, or run interactively."
  exit_code: 1

- id: cli-setup-already-done
  trigger: "nexuspanel setup-url after setup"
  error: "Initial setup is already complete."
  cause: A user already exists in the database.
  fix: "Sign in normally; the setup URL is single-use."
  exit_code: 1

- id: cli-port-invalid
  trigger: "nexuspanel change panelport 99999"
  error: "Panel port must be between 1 and 65535."
  cause: Port out of range.
  fix: "Choose a port in 1-65535."
  exit_code: 1

- id: cli-service-not-active
  trigger: "nexuspanel start when the unit fails"
  error: "nexuspanel did not become active. Run: journalctl -u nexuspanel -n 100 --no-pager"
  cause: The service crashed on boot.
  fix: "Read the journal, fix the reported error, restart."
  exit_code: 1
```

---

## 3. HTTP API route registry

All routes are prefixed `/api`. Mutating routes require the
`x-nexuspanel-request: 1` header (CSRF gate).

### Public (no auth)

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/bootstrap` | Setup state + permission list |
| POST | `/api/setup` | First-run owner creation (needs setup token) |
| POST | `/api/login` | Authenticate |
| POST | `/api/password/forgot` | Request reset OTP |
| POST | `/api/password/reset` | Reset with OTP |
| POST | `/api/logout` | Clear session |
| GET | `/api/public/backups/:token/:name` | Disabled (403 by design) |
| POST | `/api/public/backups/:token/:name` | Token-gated backup transfer |

### Authenticated

| Method | Route | Capability |
|---|---|---|
| GET | `/api/overview` | any |
| GET | `/api/servers` | any |
| GET | `/api/servers/:id` | any (ownership-scoped) |
| GET | `/api/servers/:id/console` | `console.view` |
| GET | `/api/servers/:id/console/stream` | `console.view` |
| GET | `/api/servers/:id/metrics` | any |
| GET | `/api/system/metrics` | any |
| GET | `/api/intelligence` | any |
| GET | `/api/intelligence/recommendations` | any |
| POST | `/api/presence` | any |
| GET | `/api/presence` | any |
| GET | `/api/settings` | any |
| GET | `/api/software/catalog` | any |
| GET | `/api/software/:key/versions` | any |
| GET | `/api/templates` | any |
| GET | `/api/modrinth/search` | any |
| GET | `/api/poggit/search` | any |

### Server management

| Method | Route | Capability |
|---|---|---|
| POST | `/api/servers` | `server.manage` |
| PATCH | `/api/servers/:id` | `server.manage` |
| DELETE | `/api/servers/:id` | `server.manage` |
| POST | `/api/servers/:id/start` | `server.start` |
| POST | `/api/servers/:id/stop` | `server.stop` |
| POST | `/api/servers/:id/restart` | `server.restart` |
| POST | `/api/servers/:id/kill` | `server.kill` |
| POST | `/api/servers/:id/command` | `console.command` |
| POST | `/api/servers/:id/eula` | `server.manage` |
| POST | `/api/servers/:id/fix` | `server.manage` |
| GET | `/api/servers/:id/fix/status` | `server.manage` |
| POST | `/api/servers/:id/repair-preview` | `server.manage` |
| GET | `/api/servers/:id/asf` | `server.manage` |
| GET/PUT | `/api/servers/:id/properties` | `properties.manage` |
| GET/POST/DELETE | `/api/servers/:id/whitelist` | `whitelist.manage` |
| POST | `/api/servers/:id/software/install` | `software.manage` |
| PATCH | `/api/servers/:id/software` | `software.manage` |
| POST | `/api/servers/:id/world-convert` | `server.manage` |

### Files

| Method | Route | Capability |
|---|---|---|
| GET | `/api/servers/:id/files` | `files.manage` |
| GET | `/api/servers/:id/files/preview` | `files.manage` |
| GET | `/api/servers/:id/files/download` | `files.manage` |
| PUT | `/api/servers/:id/files` | `files.manage` |
| DELETE | `/api/servers/:id/files` | `files.manage` |
| POST | `/api/servers/:id/files/upload` | `files.manage` |
| POST | `/api/servers/:id/files/upload-chunk` | `files.manage` |
| POST | `/api/servers/:id/files/upload-complete` | `files.manage` |
| POST | `/api/servers/:id/files/upload-pause` | `files.manage` |
| GET | `/api/servers/:id/files/upload-status` | `files.manage` |
| DELETE | `/api/servers/:id/files/upload-session` | `files.manage` |
| POST | `/api/servers/:id/files/mkdir` | `files.manage` |
| POST | `/api/servers/:id/files/copy` | `files.manage` |
| POST | `/api/servers/:id/files/move` | `files.manage` |
| POST | `/api/servers/:id/files/extract` | `files.manage` |
| POST | `/api/servers/:id/files/archive` | `files.manage` |

### Backups

| Method | Route | Capability |
|---|---|---|
| GET | `/api/servers/:id/backups` | `backups.manage` |
| POST | `/api/servers/:id/backups` | `backups.manage` |
| POST | `/api/servers/:id/backups/restore` | `backups.manage` |
| DELETE | `/api/servers/:id/backups` | `backups.manage` |
| PUT | `/api/servers/:id/backups/settings` | `backups.manage` |
| POST | `/api/servers/:id/backups/public-link` | `backups.manage` |
| DELETE | `/api/servers/:id/backups/public-link` | `backups.manage` |
| POST | `/api/servers/:id/backups/import-url` | `backups.manage` |
| POST | `/api/servers/:id/backups/share-code` | `backups.manage` |

### Plugins

| Method | Route | Capability |
|---|---|---|
| GET | `/api/servers/:id/plugins` | `plugins.manage` |
| POST | `/api/servers/:id/plugins` | `plugins.manage` |
| PATCH | `/api/plugins/:id` | `plugins.manage` |
| DELETE | `/api/plugins/:id` | `plugins.manage` |
| POST | `/api/servers/:id/modrinth/install` | `plugins.manage` |
| POST | `/api/servers/:id/poggit/install` | `plugins.manage` |

### Admin / security / settings

| Method | Route | Capability |
|---|---|---|
| GET/POST | `/api/users` | `admins.manage` |
| PATCH/DELETE | `/api/users/:id` | `admins.manage` |
| GET | `/api/security/render` | `security.view` |
| GET | `/api/security/ddos` | `security.view` |
| GET | `/api/health` | `security.view` |
| GET | `/api/fixed/logs` | `security.view` |
| GET | `/api/permissions/audit` | `security.view` |
| POST | `/api/permissions/repair` | `settings.manage` |
| GET | `/api/performance` | `security.view` |
| GET | `/api/database/health` | `security.view` |
| POST | `/api/database/snapshot` | `security.view` |
| PUT | `/api/settings` | `settings.manage` |
| POST | `/api/settings/update` | `settings.manage` |
| POST | `/api/settings/asf/doctor` | `settings.manage` |
| GET | `/api/optimizer/status` | `optimizer.manage` |
| GET | `/api/optimizer/plan` | `optimizer.manage` |
| POST | `/api/optimizer/apply` | `optimizer.manage` |
| GET | `/api/network/metrics` | `network.manage` |
| GET | `/api/network/download-test` | `network.manage` |
| POST | `/api/network/upload-test` | `network.manage` |
| GET | `/api/nginx/accel-config` | `admins.manage` |
| GET | `/api/host-agent/status` | `security.view` |
| GET | `/api/host/token` | owner |
| POST | `/api/host/token/regenerate` | owner |
| POST | `/api/host/provision` | host API token |

### AI / repair agent

| Method | Route | Capability |
|---|---|---|
| GET | `/api/agent/core` | `security.view` |
| POST | `/api/agent/events` | `security.view` |
| GET | `/api/ai/micro/status` | `security.view` |
| POST | `/api/ai/micro/decide` | `security.view` |
| POST | `/api/ai/micro/learn` | `settings.manage` + owner |
| GET | `/api/advanced-ai/status` | `security.view` |
| POST | `/api/advanced-ai/assess` | `security.view` |
| POST | `/api/advanced-ai/reason` | `security.view` |
| POST | `/api/advanced-ai/learn` | `settings.manage` |
| GET | `/api/repair/agent/status` | `security.view` |
| GET | `/api/repair/agent/tools` | `security.view` |
| POST | `/api/repair/agent/tools/execute` | `settings.manage` + owner |
| POST | `/api/repair/agent/commands` | `settings.manage` |
| POST | `/api/repair/agent/commands/:id/approve` | `settings.manage` + owner |
| POST | `/api/repair/agent/full-access` | `settings.manage` + owner |
| POST | `/api/repair/agent/live` | `settings.manage` |
| GET | `/api/advanced-ai/providers/openrouter` | `security.view` |
| POST/DELETE | `/api/advanced-ai/providers/openrouter/key` | `settings.manage` + owner |
| POST | `/api/advanced-ai/providers/openrouter/test` | `settings.manage` + owner |
| GET | `/api/advanced-ai/providers/openrouter/models` | `security.view` |
| POST | `/api/advanced-ai/providers/openrouter/chat` | `security.view` + owner |

---

## 4. Capability & permission model

### Roles

| Role | Behaviour |
|---|---|
| `owner` | Bypasses every capability check. Exactly one per panel. |
| `admin` | Checked against `permissions_json` (capability list) or legacy `access_level`. |

### Capabilities

```
server.start        server.stop         server.restart      server.kill
console.view        console.command     server.manage       software.manage
properties.manage   whitelist.manage    plugins.manage      files.manage
backups.manage      optimizer.manage    network.manage      admins.manage
security.view       settings.manage     timezone.manage
```

### Legacy access levels

```
VIEW_ONLY 0 · POWER_SERVERS 5 · VIEW_CONSOLE 20 · SEND_COMMANDS 40
MANAGE_SERVERS 60 · MANAGE_FILES 80 · MANAGE_ADMINS 100
```

### Permission error records

```yaml
- id: perm-not-authenticated
  http_status: 401
  error: "Your session expired. Sign in again."
  code: AUTH_REQUIRED
  cause: No valid session cookie, or the session expired/idle-timed-out.
  fix: "Sign in again."

- id: perm-insufficient-capability
  http_status: 403
  error: "This account does not have that permission."
  cause: The admin's permissions_json does not include the required capability.
  fix: "Owner grants the capability in Admins, or raises access_level."

- id: perm-owner-only
  http_status: 403
  error: "Only the owner account can <action>."
  cause: The route is hard-gated to role=owner.
  fix: "Sign in as the owner."

- id: perm-server-not-found
  http_status: 404
  error: "Server not found."
  cause: The server does not exist OR the admin does not own it (deliberate
         ambiguity to prevent enumeration).
  fix: "Verify the server id and that the account owns it."

- id: perm-owner-cannot-be-edited
  http_status: 403
  error: "Owner account cannot be edited by another user."
  cause: A non-owner tried to PATCH the owner.
  fix: "Only the owner can edit their own account."

- id: perm-owner-cannot-be-deleted
  http_status: 403
  error: "Owner account cannot be deleted."
  cause: DELETE /api/users/:id targeting the owner.
  fix: "Transfer ownership first (not supported); keep the owner account."

- id: perm-assign-all-owner-only
  http_status: 403
  error: "Only the owner can assign every server."
  cause: A non-owner used assignedServerId=all.
  fix: "Assign servers individually, or ask the owner."

- id: perm-invalid-assigned-user
  error: "Assign servers to a valid admin user, or leave unassigned for owner-only."
  cause: resolveServerOwnerUserId got a non-existent id or the owner id.
  fix: "Pick an existing admin user id."

- id: perm-grant-escalation-blocked
  behaviour: "grantablePermissionKeys filters requested keys to the actor's own keys."
  cause: A non-owner tried to grant a capability they do not hold.
  fix: "Only grant capabilities you already have."
```

---

## 5. ASF isolation protocol

ASF = **Advanced Sandbox Fabric**. Linux-only. Replaces NexusMark.

### Layers

| Layer | Mechanism | Failure exit code |
|---|---|---|
| L0 Preflight | kernel probe (landlock abi, cgroup v2, systemd) | — |
| L1 Identity | per-server locked user `asf-s<id>` + POSIX ACL | 77 |
| L2 Namespaces | mount/pid/ipc/uts/cgroup (net optional) | 201 |
| L3 Landlock | fs scope + net-port bind lock | 77 |
| L4 Seccomp | deny @mount @swap @reboot @raw-io @privileged | 77 |
| L5 Cgroup v2 | MemoryMax/High/SwapMax, CPUQuota, TasksMax | 202 |
| L6 Supervisor | exec payload, forward signals | 126/127 |

### Exit-code contract

| Code | Meaning | Panel action |
|---|---|---|
| 0 | clean exit | normal |
| 1 | payload non-zero | passthrough |
| 64 | invalid arguments | surface |
| 66 | invalid server root | surface |
| 77 | sandbox setup failed | log detail, retry compatibility tier once |
| 126 | payload not executable | surface |
| 127 | payload not found | surface |

### Tiers

| Tier | Read-only map | Net-port lock | Scoped signals |
|---|---|---|---|
| `maximum` | full host map | yes (ABI ≥ 4) | yes (ABI ≥ 6) |
| `compatible` | JVM-critical only | yes | no |
| `core` | minimal | no | no |

### ASF error records

```yaml
- id: asf-landlock-unavailable
  stderr: "[ASF] Landlock is unavailable on this kernel: <errno>"
  exit_code: 77
  cause: Kernel < 5.13 or Landlock disabled at boot.
  fix: "Upgrade to Linux 5.13+ (Ubuntu 22.04+). Panel falls back to systemd isolation."

- id: asf-landlock-abi-too-low
  stderr: "[ASF] Landlock ABI 3+ required (host ABI: <n>)"
  exit_code: 77
  cause: Kernel older than 6.2 (ABI 3 needed for truncate blocking).
  fix: "Upgrade kernel, or the panel auto-selects the 'core' tier."

- id: asf-ruleset-create-failed
  stderr: "[ASF] cannot create Landlock ruleset: <errno>"
  exit_code: 77
  cause: seccomp/LSM policy conflict or missing CAP_SYS_ADMIN.
  fix: "Check `dmesg` for LSM denials; ensure the panel runs as root."

- id: asf-path-open-failed
  stderr: "[ASF] cannot open allowed path <path>: <errno>"
  exit_code: 77
  cause: A required read-only path is missing on this distro.
  fix: "Usually harmless (non-required paths are skipped). If fatal, install the missing package."

- id: asf-net-port-rule-failed
  stderr: "[ASF] cannot restrict TCP bind port <n>: <errno>"
  exit_code: 77
  cause: Landlock ABI < 4 (kernel < 6.7).
  fix: "Panel retries with the 'core' tier automatically."

- id: asf-no-new-privs-failed
  stderr: "[ASF] cannot set no_new_privs: <errno>"
  exit_code: 77
  cause: prctl blocked (rare; nested container without privileges).
  fix: "Run the panel outside an unprivileged container."

- id: asf-seccomp-install-failed
  stderr: "[ASF] cannot install seccomp filter: <errno>"
  exit_code: 77
  cause: seccomp already restricted by an outer sandbox.
  fix: "Relax the outer sandbox, or accept the systemd fallback."

- id: asf-invalid-port
  stderr: "[ASF] invalid assigned port"
  exit_code: 64
  cause: --port outside 1-65535.
  fix: "Panel bug; report it. Port comes from the server row."

- id: asf-invalid-identity
  stderr: "[ASF] invalid isolated identity"
  exit_code: 64
  cause: --uid/--gid outside 1-2147483647.
  fix: "Panel bug; report it."

- id: asf-pdeathsig-failed
  stderr: "[ASF] cannot bind workload lifetime to supervisor"
  exit_code: 77
  cause: Parent died between fork and prctl.
  fix: "Transient; the panel restarts the server."

- id: asf-invalid-root
  stderr: "[ASF] invalid server root: <errno>"
  exit_code: 66
  cause: realpath() failed — root missing or unreadable.
  fix: "Recreate the server folder or run Repair & Diagnose."

- id: asf-root-not-directory
  stderr: "[ASF] server root is not a directory"
  exit_code: 66
  cause: server_path points at a file.
  fix: "Fix server_path in the database or recreate the server."

- id: asf-chdir-failed
  stderr: "[ASF] cannot enter server root: <errno>"
  exit_code: 66
  cause: Missing execute permission on the root.
  fix: "Run `nexuspanel permissions repair`."

- id: asf-uid-gid-mismatch
  stderr: "[ASF] both isolated uid and gid are required"
  exit_code: 64
  cause: Only one of --uid/--gid supplied.
  fix: "Panel bug; report it."

- id: asf-setresuid-failed
  stderr: "[ASF] cannot enter isolated uid/gid: <errno>"
  exit_code: 77
  cause: setresuid/setresgid failed — usually the identity user was deleted.
  fix: "Delete and recreate the server, or re-run the ASF doctor."

- id: asf-identity-verify-failed
  stderr: "[ASF] isolated identity verification failed"
  exit_code: 77
  cause: getresuid/getresgid did not match the target after the drop.
  fix: "Kernel/container quirk; the panel retries with compatibility isolation."

- id: asf-root-too-long
  stderr: "[ASF] server root is too long"
  exit_code: 66
  cause: Path exceeds 4096 bytes.
  fix: "Shorten the server name / move the install to a shorter path."

- id: asf-private-tmp-failed
  stderr: "[ASF] cannot create private temporary directory: <errno>"
  exit_code: 66
  cause: Root not writable.
  fix: "Run `nexuspanel permissions repair`."

- id: asf-exec-not-found
  stderr: "[ASF] cannot execute <path>: No such file or directory"
  exit_code: 127
  cause: The payload binary is missing.
  fix: "Reinstall the server software."

- id: asf-exec-not-executable
  stderr: "[ASF] cannot execute <path>: Permission denied"
  exit_code: 126
  cause: Missing execute bit or a noexec mount.
  fix: "Reinstall software, or remount without noexec."

- id: asf-startup-failure-diagnosis
  ai_diagnosis_id: asf-startup-failure
  confidence: 0.86-0.96
  evidence: ["exit code 200", "per-server identity failure", "native ASF active", "no normal Paper boot evidence"]
  root_cause: "The failure is most consistent with the native ASF startup path, not Minecraft world/config repair."
  next: "Read the systemd supervisor result and native stderr, then retry once with compatibility isolation."
  do_not_repair: ["whitelist.json", "banned-players.json", "banned-ips.json", "ops.json", "world data"]
```

---

## 6. Error catalogue — authentication

```yaml
- id: auth-invalid-credentials
  http_status: 401
  error: "Invalid email or password."
  cause: Email not found OR password mismatch (deliberately identical).
  fix: "Check credentials. After 5 failures the account throttles."

- id: auth-throttled
  http_status: 429
  header: "Retry-After: <seconds>"
  error: "Too many login attempts. Try again in <n> seconds."
  cause: 5 account failures or 10 IP failures within 15 minutes.
  fix: "Wait for the backoff window (exponential, capped at 1 hour)."

- id: auth-session-expired
  http_status: 401
  error: "Your session expired. Sign in again."
  cause: 12h absolute TTL or 2h idle timeout.
  fix: "Sign in again."

- id: auth-user-agent-mismatch
  behaviour: "Session is destroyed when the User-Agent hash changes."
  cause: Cookie stolen and replayed from a different browser.
  fix: "Sign in again; the stolen cookie is now dead."

- id: auth-account-expired
  behaviour: "Expired admin accounts are deleted and their sessions cleared."
  cause: expires_at passed.
  fix: "Owner recreates the admin with a new expiry."

- id: auth-setup-token-invalid
  http_status: 403
  error: "Invalid or expired setup link."
  cause: Wrong/missing x-nexuspanel-setup-token.
  fix: "Run `nexuspanel setup-url` for a fresh link."

- id: auth-setup-already-complete
  http_status: 409
  error: "Initial setup has already been completed."
  cause: A user already exists.
  fix: "Sign in normally."

- id: auth-email-invalid
  http_status: 400
  error: "Enter a valid email address."
  cause: Missing '@' or length > 254.
  fix: "Enter a valid email."

- id: auth-name-invalid
  http_status: 400
  error: "Name must be between 2 and 100 characters."
  fix: "Use 2-100 characters."

- id: auth-password-too-short
  http_status: 400
  error: "Password must be between 12 and 256 characters."
  fix: "Use at least 12 characters."

- id: auth-password-mismatch
  http_status: 400
  error: "Passwords do not match."
  fix: "Re-enter the confirmation."

- id: auth-email-taken
  http_status: 409
  error: "That email address is already registered."
  fix: "Use a different email or sign in."

- id: auth-otp-invalid
  http_status: 401
  error: "Invalid OTP."
  cause: Wrong 6-digit code (constant-time compared).
  fix: "Re-enter the code. 5 attempts max."

- id: auth-otp-expired
  http_status: 400
  error: "OTP expired. Request a new code."
  cause: 10-minute OTP TTL passed.
  fix: "Request a new code."

- id: auth-otp-too-many-attempts
  http_status: 429
  error: "Too many OTP attempts. Request a new code."
  cause: 5 failed OTP attempts.
  fix: "Request a new code."

- id: auth-otp-rate-limited
  http_status: 429
  error: "Wait one minute before requesting another code."
  cause: Two forgot-password requests within 60s.
  fix: "Wait 60 seconds."

- id: auth-otp-delivery-failed
  message: "Email delivery failed. Owner can read data/password-reset-otp.log on the VPS."
  cause: SMTP not configured or unreachable.
  fix: "Read the OTP from data/password-reset-otp.log."

- id: auth-csrf-blocked
  http_status: 403
  error: "Request verification failed."
  cause: Missing x-nexuspanel-request: 1 header on a mutating request.
  fix: "Use the panel UI; direct API calls must send the header."

- id: auth-cross-site-blocked
  http_status: 403
  error: "Cross-site request blocked."
  cause: Sec-Fetch-Site header indicates a cross-site origin.
  fix: "Only same-origin requests are accepted."

- id: auth-host-maintenance
  http_status: 503
  error: "Host maintenance is active. Only the panel owner can sign in."
  cause: host_maintenance_mode=1 in host edition.
  fix: "Owner disables maintenance mode."
```

---

## 7. Error catalogue — permissions

```yaml
- id: perm-runtime-protected
  error: "NexusPanel runtime files are protected."
  cause: A file operation targeted the `runtime/` folder.
  fix: "Runtime files are managed by the installer; do not edit them."

- id: perm-metadata-protected
  error: "NexusPanel metadata files are protected. Resource limits are enforced from the database, not editable server files."
  cause: A file operation targeted `.nexus-server.json` / `.nexus-mark.json` / `.nexuspanel`.
  fix: "Change limits in the server settings, not in files."

- id: perm-symlink-blocked
  error: "Symlinks are blocked in the server file manager."
  cause: A path component is a symlink (escape attempt).
  fix: "Use real paths inside the server root."

- id: perm-root-symlink-blocked
  error: "Server root symlinks are blocked."
  cause: The server root itself is a symlink.
  fix: "Recreate the server folder as a real directory."

- id: perm-path-escapes-storage
  error: "Path escapes NexusPanel storage."
  cause: assertInside detected `..` traversal or an absolute path outside the root.
  fix: "Use a relative path inside the server root."

- id: perm-plugin-name-invalid
  error: "Plugin file name must be a plain file name."
  cause: The plugin filename contained a path separator.
  fix: "Provide just the filename, e.g. MyPlugin.jar."

- id: perm-audit-inaccessible
  report_field: "inaccessible[]"
  cause: Files the panel user cannot read/execute.
  fix: "Run `nexuspanel permissions repair`."

- id: perm-repair-not-writable
  report_field: "writableRoot: false"
  cause: The server root is not writable by the panel user.
  fix: "Run `nexuspanel permissions repair` as root."

- id: perm-repair-chmod-failed
  action_error: "chmod/find returned non-zero"
  cause: Filesystem is read-only or mounted noexec.
  fix: "Remount rw, or move the server to a writable volume."

- id: perm-repair-chown-failed
  action_error: "chown returned non-zero"
  cause: Not running as root.
  fix: "Run the repair as root."
```

---

## 8. Error catalogue — server lifecycle

```yaml
- id: server-name-required
  http_status: 400
  error: "Server name is required."
  fix: "Use at least 2 characters."

- id: server-software-incompatible
  http_status: 400
  error: "Selected software is not compatible with this server type."
  cause: Java software chosen for a Bedrock server (or vice versa).
  fix: "Pick software matching the server edition."

- id: server-already-running
  message: "Server already running."
  cause: startServer called while the process is live.
  fix: "No action needed."

- id: server-not-installed
  error: "Install server software before starting."
  cause: executable_path missing or the file does not exist.
  fix: "Install software from the Software tab."

- id: server-eula-required
  http_status: 409
  error: "Agree to the Minecraft EULA first."
  fix: "Accept the EULA in the panel."

- id: server-no-runtime
  http_status: 400
  error: "This Nexu template needs an installer/runtime before it can start."
  fix: "Run the template installer (owner + full access)."

- id: server-stop-before-delete
  http_status: 400
  error: "Stop the server before deleting it."
  fix: "Stop the server, then delete."

- id: server-stop-before-port-change
  http_status: 409
  error: "Stop the server before changing its game port."
  fix: "Stop the server, change the port, restart."

- id: server-port-invalid
  http_status: 400
  error: "Server port must be an integer between 1024 and 65535."
  fix: "Choose a port in 1024-65535."

- id: server-port-collision
  http_status: 409
  error: "Port <n> is already allocated to <name>."
  fix: "Choose a free port."

- id: server-port-verify-failed
  http_status: 500
  error: "Port verification failed after saving."
  cause: server.properties write did not persist the port.
  fix: "Check file permissions; run Repair & Diagnose."

- id: server-port-profile-rollback
  error: "Port changed in database but ASF profile regeneration failed; change was rolled back."
  cause: writeProfile threw after the DB update.
  fix: "Check data/asf/ is writable."

- id: server-command-empty
  error: "Command is empty."
  fix: "Enter a console command."

- id: server-not-running
  error: "Server is not running."
  cause: sendCommand on an offline server.
  fix: "Start the server first."

- id: server-console-command-empty
  error: "Console command is empty."
  fix: "Enter a command."

- id: server-whitelist-name-required
  http_status: 400
  error: "Player name is required."
  fix: "Enter a player name (2+ chars)."

- id: server-whitelist-java-format
  http_status: 400
  error: "Java usernames must be 3-16 letters, numbers, or underscores."
  fix: "Use a valid Java username."

- id: server-world-convert-same-edition
  error: "Choose the opposite edition for conversion."
  fix: "Pick Java→Bedrock or Bedrock→Java."

- id: server-world-convert-online
  error: "Stop the source server before converting its world."
  fix: "Stop the server first."

- id: server-converter-missing
  error: "Chunker CLI is not installed. Install the converter first."
  fix: "Install the world converter from Settings."

- id: server-converter-no-jar
  error: "No Chunker CLI jar was found in the latest GitHub release. Download the CLI jar manually into data/tools/chunker-cli.jar."
  fix: "Download the jar manually."

- id: server-converter-release-failed
  error: "Chunker release lookup failed with <status>"
  cause: GitHub API rate limit or network issue.
  fix: "Retry later or download manually."

- id: server-properties-unreadable
  log: "Auto-heal detected an unreadable server.properties file."
  cause: Corrupt or permission-denied server.properties.
  fix: "The panel rebuilds it automatically and restarts."

- id: server-restart-storm
  log: "Restart storm stopped after 3 failures in 2 minutes."
  cause: The server crashes immediately on every start.
  fix: "Run Repair & Diagnose, then start manually."

- id: server-launch-failed
  log: "Launch failed after <n>s; skipped crash backup because the game never became stable."
  cause: The process died before becoming healthy.
  fix: "Check the console log for the real error."

- id: server-memory-guard-stop
  log: "Memory guard stopped the server (<phase>). Final usage: <n> MB / <limit> MB."
  cause: RSS exceeded the allocation guard limit.
  fix: "Increase RAM allocation or pre-generate the world."

- id: server-allocation-guard
  recovery_reason: allocation-guard
  cause: Sustained memory overuse triggered the guard.
  fix: "Raise max_memory_mb."

- id: server-properties-recovery
  recovery_reason: server-properties
  cause: server.properties unreadable at launch.
  fix: "Automatic; the panel rebuilds and restarts."

- id: server-tombstoned
  behaviour: "Deleted servers are tombstoned; recreating the same id wipes the old folder."
  cause: SQLite reuses ids after deletion.
  fix: "Expected behaviour; no action."

- id: server-quota-exceeded
  error: "Host server quota reached."
  cause: host_server_quota limit hit in host edition.
  fix: "Owner raises the quota."
```

---

## 9. Error catalogue — Minecraft installation

```yaml
- id: install-version-resolve-failed
  error: "Could not resolve a downloadable version for <software>."
  cause: Upstream API (PaperMC/Mojang/Fabric) unreachable or version invalid.
  fix: "Check network, retry, or pick a different version."

- id: install-download-404
  error: "Download URL returned 404: <url>"
  cause: The selected version was removed upstream.
  fix: "Pick a different version."

- id: install-download-failed
  error: "Download failed: <status>"
  cause: Upstream HTTP error.
  fix: "Retry; the panel retries 3 times automatically."

- id: install-download-incomplete
  error: "Download incomplete: <received>/<total> bytes"
  cause: Connection dropped mid-download.
  fix: "Retry; the panel re-downloads."

- id: install-jar-invalid
  error: "<software> download is not a valid jar. Recheck the selected version and retry."
  cause: The file is not a ZIP (jar) — wrong URL or HTML error page.
  fix: "Pick a different version."

- id: install-jar-missing
  error: "<software> download did not create a jar file."
  cause: The download path was not written.
  fix: "Check disk space and permissions."

- id: install-forge-no-args
  error: "Forge installer finished but no launch args or Forge jar was found."
  cause: The Forge installer failed silently.
  fix: "Check the install log; retry with a different Forge version."

- id: install-forge-installer-failed
  error: "Forge installer exited non-zero."
  cause: Java version mismatch or corrupt download.
  fix: "Install the correct Java version, retry."

- id: install-bedrock-no-binary
  error: "Bedrock archive extracted but server executable was not found."
  cause: Unexpected archive layout.
  fix: "Reinstall Bedrock."

- id: install-bedrock-extract-failed
  error: "Failed to extract zip."
  cause: Corrupt download or missing unzip.
  fix: "Install unzip (`apt install -y unzip`), retry."

- id: install-pocketmine-invalid-phar
  error: "PocketMine file is not a valid PHAR. Reinstall PocketMine from the Software tab."
  cause: Corrupt or wrong file.
  fix: "Reinstall PocketMine."

- id: install-pocketmine-php-missing
  error: "PocketMine bundled PHP is missing or broken. Reinstall PocketMine from the Software tab."
  cause: PHP runtime download/extract failed.
  fix: "Reinstall PocketMine."

- id: install-pocketmine-php-asset-missing
  error: "No compatible asset found in pmmp/PHP-Binaries latest release."
  cause: Upstream release layout changed.
  fix: "Report; install PHP manually."

- id: install-nexu-no-commands
  error: "This Nexu template has no installer commands."
  cause: The template defines no runtime.install.commands.
  fix: "Edit the template or use a standard software."

- id: install-nexu-executable-missing
  error: "Nexu install finished but executable was not found: <path>"
  cause: The installer did not produce the expected binary.
  fix: "Check the install log; fix the template's executable path."

- id: install-nexu-owner-required
  http_status: 403
  error: "Only the owner can run Nexu template installer commands."
  cause: Nexu installers run arbitrary shell; gated to owner.
  fix: "Sign in as owner."

- id: install-nexu-full-access-required
  http_status: 409
  error: "Unlock time-limited owner full access before running Nexu installer commands."
  fix: "Unlock full access in Security, then retry."

- id: install-steamcmd-missing
  message: "SteamCMD missing. Installing requirement..."
  cause: steamcmd not installed for a steamcmd-mode template.
  fix: "Automatic; the panel installs it."

- id: install-java-required
  error: "<software> <version> requires Java <n>, but this VPS is running Java <m>."
  cause: Java too old for the Minecraft version.
  fix: "Install Java <n>+ or pick an older Minecraft version."

- id: install-java-not-found
  error: "Java runtime was not found in PATH. Install Java 21+ (Linux: apt install -y openjdk-21-jre-headless) then restart the server."
  fix: "Install Java."

- id: install-bundled-java-broken
  error: "Bundled Java cannot be executed: <reason>"
  cause: The bundled runtime lost its execute bit or is on a noexec mount.
  fix: "Reinstall software, or remount without noexec."

- id: install-filesystem-noexec
  reason: filesystem-noexec
  cause: The server root is on a noexec mount.
  fix: "Remount with exec, or move the server."

- id: install-disk-full
  error: "ENOSPC: no space left on device"
  cause: Disk full during download/extract.
  fix: "Free disk space, retry."

- id: install-permission-denied
  error: "EACCES: permission denied"
  cause: The panel user cannot write the server root.
  fix: "Run `nexuspanel permissions repair`."

- id: install-progress-stuck
  symptom: "install_progress stays at a value and never reaches 100."
  cause: The install promise rejected without updating status.
  fix: "Check install_message; retry the install."

- id: install-status-failed
  db_field: "install_status = 'failed'"
  cause: Any install error.
  fix: "Read install_message for the specific cause."
```

---

## 10. Error catalogue — Java runtime

```yaml
- id: java-missing
  error: "Java runtime was not found in PATH."
  fix: "apt install -y openjdk-21-jre-headless"

- id: java-too-old
  error: "requires Java <n>, but this VPS is running Java <m>."
  fix: "Install the newer JDK."

- id: java-not-executable
  reason: "java-runtime-not-executable:<code>"
  fix: "chmod +x the java binary, or reinstall."

- id: java-not-file
  reason: "java-runtime-not-file"
  cause: The java path points at a directory.
  fix: "Reinstall the bundled runtime."

- id: java-runtime-missing
  error: "The bundled Java runtime for this server is missing."
  reason: "java-runtime-missing"
  cause: The bundled java binary does not exist.
  fix: "Restore the server-scoped bundled Java runtime with Repair & Diagnose."

- id: java-heap-capped
  log: "Java heap capped at <n> MB with <m> MB reserved for threads, code cache, buffers, and kernel-accounted memory."
  cause: Normal — the panel reserves ~15% for JVM overhead.
  fix: "No action; informational."

- id: java-oom-exit
  log: "Process exited code=1 signal=none" after "java.lang.OutOfMemoryError"
  cause: Heap exhausted.
  fix: "Increase max_memory_mb."

- id: java-exit-on-oom
  flag: "-XX:+ExitOnOutOfMemoryError"
  cause: The panel sets this so OOM exits cleanly instead of hanging.
  fix: "Expected; increase RAM if it triggers."

- id: java-native-extract-failed
  cause: JNA/Netty native extraction blocked by the sandbox.
  fix: "The panel sets -Djna.tmpdir and -Dio.netty.native.workdir inside the root."

- id: java-version-parse-failed
  cause: `java -version` output format unexpected.
  fix: "Use a standard OpenJDK build."
```

---

## 11. Error catalogue — files & uploads

```yaml
- id: file-path-required
  http_status: 400
  error: "Choose a file path inside the server folder."
  fix: "Provide a relative path."

- id: file-not-found
  http_status: 404
  error: "Path not found."
  fix: "Check the path."

- id: file-download-not-found
  http_status: 404
  error: "Download file not found."
  fix: "Check the path."

- id: file-preview-not-found
  http_status: 404
  error: "File not found."
  fix: "Check the path."

- id: file-preview-download-only
  http_status: 415
  error: "This file type is download-only."
  cause: The extension is not previewable.
  fix: "Download the file."

- id: file-preview-signature-mismatch
  http_status: 415
  error: "File signature does not match its extension."
  cause: Magic bytes do not match the claimed type (spoofing attempt).
  fix: "Rename the file to its real type."

- id: file-upload-not-binary
  http_status: 400
  error: "Upload body must be binary."
  fix: "Send application/octet-stream."

- id: file-upload-chunk-not-binary
  http_status: 400
  error: "Upload chunk body must be binary."
  fix: "Send application/octet-stream."

- id: file-upload-offset-invalid
  http_status: 400
  error: "Invalid upload offset."
  fix: "Send a non-negative integer offset."

- id: file-upload-size-invalid
  http_status: 400
  error: "Invalid upload size."
  fix: "Send a total size >= the chunk length."

- id: file-upload-chunk-exceeds
  http_status: 400
  error: "Chunk exceeds declared upload size."
  fix: "Fix the offset/size math."

- id: file-upload-too-large
  http_status: 413
  error: "Upload exceeds the configured size limit."
  cause: totalSize > NEXUSPANEL_MAX_UPLOAD_GB (default 50 GB).
  fix: "Raise the env var or split the file."

- id: file-upload-chunk-hash-mismatch
  http_status: 409
  error: "Chunk checksum mismatch. Retrying this chunk is safe."
  fix: "Retry the chunk."

- id: file-upload-final-hash-mismatch
  http_status: 409
  error: "Final file checksum mismatch. Retry the upload."
  fix: "Re-upload the file."

- id: file-upload-size-mismatch
  http_status: 409
  error: "Upload size mismatch. Retry the file."
  fix: "Re-upload."

- id: file-upload-missing-chunks
  http_status: 409
  error: "Upload has missing chunks. Reselect the same file to resume."
  fix: "Resume the upload."

- id: file-upload-canceled
  http_status: 409
  error: "Upload was canceled."
  fix: "Start a new upload."

- id: file-upload-session-missing
  http_status: 404
  error: "Upload session file was not found."
  fix: "Restart the upload."

- id: file-upload-session-not-found
  http_status: 404
  error: "Upload session was not found."
  fix: "Restart the upload."

- id: file-upload-path-required
  http_status: 400
  error: "Choose a destination file path."
  fix: "Provide a path."

- id: file-upload-progress-path-required
  http_status: 400
  error: "Choose an upload path."
  fix: "Provide a path."

- id: file-mkdir-name-required
  http_status: 400
  error: "Folder name is required."
  fix: "Provide a folder name."

- id: file-delete-root-blocked
  http_status: 400
  error: "Cannot delete the server root."
  fix: "Delete the server instead."

- id: file-copy-root-blocked
  http_status: 400
  error: "Cannot copy the server root."
  fix: "Select items inside the root."

- id: file-move-root-blocked
  http_status: 400
  error: "Cannot move the server root."
  fix: "Select items inside the root."

- id: file-archive-root-blocked
  http_status: 400
  error: "Cannot archive the server root directly. Select files or folders inside it."
  fix: "Select items inside the root."

- id: file-extract-not-zip
  http_status: 400
  error: "Select one or more .zip files to unzip."
  fix: "Select .zip files."

- id: file-extract-not-file
  http_status: 404
  error: "<path> is not a file."
  fix: "Select a file."

- id: file-extract-invalid-zip
  http_status: 422
  error: "<path> is not a complete valid ZIP. It may be an unfinished upload/download. Re-upload it or use a fresh backup/archive."
  fix: "Re-upload the archive."

- id: file-extract-protected-entry
  http_status: 403
  error: "Archive contains protected NexusPanel metadata/runtime path: <entry>"
  cause: The zip contains runtime/ or metadata paths.
  fix: "Use a clean archive."

- id: file-extract-zip-slip
  error: "Archive entry escapes the extraction folder and was blocked: <entry>"
  cause: Zip Slip attack — an entry with `../` or an absolute path.
  fix: "The archive is malicious; do not extract it."

- id: file-extract-absolute-entry
  error: "Archive entry uses an absolute path and was blocked: <entry>"
  cause: Zip Slip variant.
  fix: "Reject the archive."

- id: file-extract-collisions
  http_status: 409
  error: "Extract would replace <n> existing file(s). Choose Replace all or Skip existing."
  fix: "Choose a mode."

- id: file-archive-protected
  http_status: 403
  error: "Cannot archive protected NexusPanel metadata/runtime path: <entry>"
  fix: "Deselect protected paths."

- id: file-unzip-missing
  error: "unzip is required to extract zip files. Run: apt install -y unzip"
  fix: "Install unzip."

- id: file-tar-missing
  error: "tar is required to extract this archive."
  fix: "Install tar."

- id: file-archive-write-stopped
  error: "Archive write stopped before the ZIP was complete."
  cause: Disk full or I/O error during zip creation.
  fix: "Free disk space, retry."

- id: file-archive-transient
  behaviour: "ENOENT/ESTALE/EISDIR during archive collection are skipped."
  cause: Files changed during archiving.
  fix: "Expected; retry if the archive is incomplete."

- id: file-edit-timeline
  message: "Captured state before editing <path>."
  cause: Normal — every edit creates a recovery point.
  fix: "No action."

- id: file-upload-40mb-limit
  http_status: 413
  error: "request entity too large"
  cause: Single-shot upload > 40 MB.
  fix: "Use chunked upload (the UI does this automatically)."
```

---

## 12. Error catalogue — backups

```yaml
- id: backup-create-failed
  log: "Crash backup failed: <error>"
  fix: "Check disk space and permissions."

- id: backup-restore-not-found
  http_status: 404
  error: "Backup not found."
  fix: "Refresh the backup list."

- id: backup-restore-online
  http_status: 409
  error: "Stop the server before restoring a backup."
  fix: "Stop the server first."

- id: backup-invalid-archive
  error: "Backup is not a valid ZIP."
  fix: "Choose a valid backup."

- id: backup-public-link-owner-only
  http_status: 403
  error: "Only the server owner can publish backup links."
  fix: "Sign in as the server owner."

- id: backup-public-link-invalid
  http_status: 404
  error: "Public backup link is invalid, expired, or revoked."
  fix: "Generate a new link."

- id: backup-public-direct-download
  http_status: 403
  error: "Direct browser downloads are disabled. Paste this URL into NexusPanel Import Backup."
  cause: By design — prevents hotlinking.
  fix: "Use the Import Backup feature."

- id: backup-transfer-header-missing
  http_status: 403
  error: "This backup can only be transferred by NexusPanel."
  cause: Missing x-nexuspanel-transfer: backup-v1 header.
  fix: "Use the panel's import feature."

- id: backup-import-url-invalid
  error: "Enter a valid public backup URL."
  fix: "Provide a valid URL."

- id: backup-import-not-nexuspanel
  error: "This is not a NexusPanel public backup URL."
  cause: The URL lacks /api/public/backups/.
  fix: "Use a NexusPanel backup URL."

- id: backup-import-private-address
  error: "Backup imports cannot connect to local or private network addresses."
  cause: SSRF defense — the host resolves to a private IP.
  fix: "Use a public host."

- id: backup-import-http-error
  error: "Remote panel returned HTTP <status>."
  fix: "Check the remote panel."

- id: backup-import-too-large
  error: "Remote backup is larger than the configured import limit."
  cause: content-length > NEXUSPANEL_MAX_REMOTE_BACKUP_GB (default 20 GB).
  fix: "Raise the env var."

- id: backup-import-exceeded
  error: "Remote backup exceeded the configured import limit."
  cause: Streamed bytes exceeded the limit mid-transfer.
  fix: "Raise the env var."

- id: backup-import-not-zip
  error: "Remote file is not a valid ZIP backup."
  fix: "Verify the source."

- id: backup-share-code-owner-only
  http_status: 403
  error: "Only the source server owner can create backup codes."
  fix: "Sign in as the owner."

- id: backup-share-code-hide-owner-only
  http_status: 403
  error: "Only the source server owner can hide backup codes."
  fix: "Sign in as the owner."

- id: backup-paused
  log: "Backups paused for <n> minutes because <reason>."
  cause: Crash or launch failure triggered a backup pause.
  fix: "Automatic; resumes after the window."

- id: backup-scheduler-resolution
  field: "schedulerResolutionSeconds: 30"
  cause: The backup scheduler ticks every 30 seconds.
  fix: "Expected."

- id: backup-timezone
  field: "fileNameTimeZone"
  cause: Backup filenames use the server's configured timezone.
  fix: "Change the timezone in Settings."
```

---

## 13. Error catalogue — plugins & mods

```yaml
- id: plugin-extension-unsupported
  http_status: 400
  error: "Unsupported plugin or pack extension."
  fix: "Use .jar, .phar, .mcpack, or .mcaddon."

- id: plugin-incompatible
  http_status: 400
  error: "<kind> is not compatible with <software>."
  fix: "Match the plugin type to the server software."

- id: plugin-modrinth-unsupported
  http_status: 400
  error: "Modrinth install supports Paper/Purpur plugins and Fabric/Forge mods."
  fix: "Use a supported software."

- id: plugin-modrinth-project-required
  http_status: 400
  error: "Modrinth project id is required."
  fix: "Provide a project id."

- id: plugin-modrinth-versions-failed
  error: "Modrinth versions failed: <status>"
  fix: "Retry later."

- id: plugin-modrinth-no-file
  error: "No compatible Modrinth file found."
  fix: "Pick a different project or version."

- id: plugin-modrinth-search-failed
  error: "Modrinth search failed: <status>"
  fix: "Retry later."

- id: plugin-poggit-pocketmine-only
  http_status: 400
  error: "Poggit plugins can only be installed on PocketMine servers."
  fix: "Use a PocketMine server."

- id: plugin-poggit-url-invalid
  http_status: 400
  error: "Invalid Poggit download URL."
  cause: The URL does not start with https://poggit.pmmp.io/.
  fix: "Use a Poggit URL."

- id: plugin-poggit-search-failed
  error: "Poggit search failed: <status>"
  fix: "Retry later."

- id: plugin-not-found
  http_status: 404
  error: "Plugin not found."
  fix: "Refresh the plugin list."

- id: plugin-no-server-permission
  http_status: 403
  error: "No permission for this server."
  fix: "Use a server you own."

- id: plugin-restart-required
  log: "Installed <plugin>. Restart server to load it."
  fix: "Restart the server."

- id: plugin-manager-locked
  ui_message: "Plugin manager is locked until file access level 80."
  cause: The account lacks plugins.manage.
  fix: "Owner grants the capability."

- id: plugin-bedrock-manual
  ui_message: "Bedrock Dedicated Server supports resource and behavior packs, but automatic marketplace install needs manifest registration. Upload .mcpack or .mcaddon in File Manager for now."
  fix: "Upload packs manually."

- id: plugin-select-software
  ui_message: "Select Paper/Purpur for plugins or Fabric/Forge for mods."
  fix: "Choose compatible software."
```

---

## 14. Error catalogue — ASF sandbox

```yaml
- id: asf-native-unavailable
  settings_field: "asfNative.available: false"
  reason_examples: ["linux-only", "disabled", "source-missing", "compiler-missing", "build-failed", "kernel-unsupported", "self-test-failed"]
  fix: "Install a C compiler (`apt install -y build-essential`) and Linux 5.13+."

- id: asf-build-failed
  reason: build-failed
  error: "<compiler stderr>"
  fix: "Install build-essential; check the compiler output."

- id: asf-compiler-missing
  reason: compiler-missing
  fix: "apt install -y build-essential"

- id: asf-source-missing
  reason: source-missing
  cause: native/asf/src/asf_runtime.c not found.
  fix: "Reinstall the panel."

- id: asf-self-test-failed
  reason: self-test-failed
  error: "<stderr>"
  cause: The built binary failed its own sandbox self-test.
  fix: "Check kernel LSM support; the panel keeps the previous binary."

- id: asf-stale-binary
  field: "staleBinary: true"
  cause: The source changed but the rebuild failed; the old binary is used.
  fix: "Fix the build error, then `nexuspanel asf rebuild`."

- id: asf-disabled
  reason: disabled
  cause: NEXUSPANEL_NATIVE_SANDBOX=0.
  fix: "Unset the env var to re-enable."

- id: asf-doctor-tier
  field: "tier"
  values: ["maximum", "compatible", "core", "native-only", "process-guard", "windows-process-guard", "portable-path-guard"]
  fix: "Higher tiers need newer kernels; the panel auto-selects the best available."

- id: asf-preflight-failed
  field: "preflightPassed: false"
  cause: systemd-run preflight failed for all tiers.
  fix: "Check `systemctl status`; ensure systemd is running."

- id: asf-preflight-storage
  error: "preflight storage unavailable: <error>"
  cause: data/asf/ not writable.
  fix: "Fix permissions on the data directory."

- id: asf-systemd-unavailable
  reason: "systemd-run unavailable"
  fix: "Use a systemd host, or accept native-only isolation."

- id: asf-identity-unavailable
  reason_examples: ["linux-only", "disabled", "panel-not-root", "setfacl-missing", "account-tool-missing", "account-name-conflict", "account-create-failed", "server-root-outside-storage"]
  fix: "Run the panel as root; install acl (`apt install -y acl`)."

- id: asf-identity-acl-failed
  reason_examples: ["acl-apply-failed", "default-acl-failed", "executable-acl-failed", "runtime-acl-failed", "parent-traversal-acl-failed"]
  fix: "Ensure setfacl works on the filesystem (some NFS mounts do not support ACLs)."

- id: asf-identity-java-exec-failed
  reason: identity-java-exec-failed
  cause: The isolated user cannot execute the bundled Java.
  fix: "Reinstall software; the panel re-applies ACLs."

- id: asf-identity-root-access-failed
  reason: identity-root-access-failed
  cause: The isolated user cannot read/write/execute the server root.
  fix: "Run `nexuspanel permissions repair`."

- id: asf-identity-runtime-access-failed
  reason: identity-runtime-access-failed
  cause: The isolated user cannot execute a runtime binary.
  fix: "Reinstall software."

- id: asf-identity-marker-missing
  reason: identity-marker-missing
  cause: The identity marker file is gone.
  fix: "Recreate the server, or re-run the ASF doctor."

- id: asf-identity-marker-mismatch
  reason: identity-marker-mismatch
  cause: The marker does not match the current uid.
  fix: "Delete and recreate the server."

- id: asf-identity-delete-failed
  reason: account-delete-failed
  fix: "Manually `userdel asf-s<id>`."

- id: asf-cgroup-unavailable
  field: "cgroupV2: false"
  cause: cgroup v1 host.
  fix: "Boot with cgroup v2 (`systemd.unified_cgroup_hierarchy=1`)."

- id: asf-supervisor-failure
  log: "Supervisor failure detail: Result=... ExecMainStatus=..."
  cause: systemd reported the unit's failure reason.
  fix: "Read the detail; usually an ASF setup failure."

- id: asf-compatibility-retry
  log: "ASF sandbox exited too early (code=<n>). Retrying once with compatibility isolation so Paper can expose its real error."
  cause: The native sandbox failed within 5 seconds.
  fix: "Automatic; the retry surfaces the real Minecraft error."

- id: asf-native-retry-disabled
  log: "ASF native launch retry disabled; using compatibility isolation path."
  cause: The retry already ran once.
  fix: "Expected."

- id: asf-allocation-enforced
  log: "ASF allocation enforced from database: <n> MB RAM, <m> CPU core(s)."
  fix: "Informational."

- id: asf-cgroup-startup-burst
  log: "Cgroup active: startup <n>% CPU, then <m>% CPU."
  cause: Servers with ≤3 cores get a 2x startup burst.
  fix: "Expected."

- id: asf-cgroup-steady
  log: "Cgroup active: steady limit <n>% CPU (<m> cores); startup burst is disabled for allocations above 3 cores."
  fix: "Expected."

- id: asf-throttle-update-failed
  log: "CPU throttle update failed: <detail>"
  cause: systemctl set-property failed.
  fix: "Check systemd; the steady limit still applies via the unit."

- id: asf-unit-collected
  log: "Startup CPU burst unit was already collected; steady database allocation remains enforced by ASF."
  cause: The transient unit exited before the throttle timer.
  fix: "Expected."

- id: asf-identity-active
  log: "Dedicated kernel identity active: <name> (UID <n>), isolated from other server processes."
  fix: "Informational."

- id: asf-identity-unavailable-log
  log: "Per-server UID layer unavailable (<reason>); remaining ASF layers stay active."
  fix: "Run as root with acl installed."

- id: asf-policy-active
  log: "ASF <tier> policy active: cgroup v2 + Landlock + seccomp (<detail>)."
  fix: "Informational."

- id: asf-native-landlock-active
  log: "ASF native Landlock/seccomp active; systemd cgroup policy is unavailable (<detail>)."
  fix: "Informational."

- id: asf-runtime-unavailable-log
  log: "ASF native runtime unavailable (<detail>); using <engine>."
  fix: "Install a compiler / newer kernel."
```

---

## 15. Error catalogue — systemd service

```yaml
- id: service-install-root
  error: "Root is required. Run: sudo npm run service:install"
  fix: "Use sudo."

- id: service-systemd-required
  error: "Systemd is required for VPS background service mode."
  fix: "Use a systemd host."

- id: service-not-active
  error: "nexuspanel did not become active. Run: journalctl -u nexuspanel -n 100 --no-pager"
  fix: "Read the journal."

- id: service-restart-failed
  error: "nexuspanel restart failed. Run: journalctl -u nexuspanel -n 100 --no-pager"
  fix: "Read the journal."

- id: service-port-invalid
  error: "Panel port must be between 1 and 65535."
  fix: "Choose a valid port."

- id: service-unit-missing
  cause: /etc/systemd/system/nexuspanel.service does not exist.
  fix: "Run `nexuspanel install`."

- id: service-asf-unit
  unit: "nexuspanel-asf.service"
  type: oneshot
  exec: "node backend/asf_native.js"
  fix: "Rebuild with `nexuspanel asf rebuild`."

- id: service-host-agent-unit
  unit: "nexuspanel-host-agent.service"
  hardening: ["NoNewPrivileges", "PrivateTmp", "ProtectSystem=strict", "RestrictAddressFamilies=AF_UNIX", "MemoryDenyWriteExecute", "CapabilityBoundingSet="]
  fix: "Rebuild with `npm run build:host-agent`."

- id: service-env-edition
  env: "NEXUSPANEL_EDITION=<normal|host>"
  cause: Read from data/edition.
  fix: "Set the edition file."

- id: service-backup-root
  env: "NEXUSPANEL_BACKUP_ROOT=/var/lib/nexuspanel/backups"
  fix: "Ensure the directory exists and is writable."

- id: service-xaccel-empty
  env: ["NEXUSPANEL_X_ACCEL_ROOT=", "NEXUSPANEL_X_ACCEL_PREFIX="]
  cause: Empty by default; set for Nginx offload.
  fix: "Configure Nginx and set both."

- id: service-user-root-warning
  behaviour: "If the service user is root, no User=/Group= lines are written."
  fix: "Prefer a non-root service user."

- id: service-journal-empty
  symptom: "journalctl shows nothing."
  cause: The unit never started.
  fix: "`systemctl status nexuspanel` and `systemctl daemon-reload`."
```

---

## 16. Error catalogue — network & tunnels

```yaml
- id: net-download-test-size
  field: "size clamped to 1 MB - 64 MB"
  fix: "Expected."

- id: net-upload-test-body
  error: "Upload body must be binary."
  fix: "Send application/octet-stream."

- id: net-upload-64mb-limit
  http_status: 413
  cause: Upload test body > 64 MB.
  fix: "Send a smaller body."

- id: net-ngrok-not-installed
  error: "ngrok is not installed."
  fix: "Install ngrok from the Network tab."

- id: net-ngrok-token-missing
  error: "Save your ngrok auth token first."
  fix: "Save the token in Settings."

- id: net-ngrok-udp-unsupported
  note: "Bedrock uses UDP. ngrok UDP requires a plan that supports UDP endpoints; Playit is usually easier for Bedrock."
  fix: "Use Playit for Bedrock."

- id: net-ngrok-bedrock-tcp
  note: "This server is Bedrock, so public gameplay needs UDP. TCP ngrok can start but Bedrock clients will not connect through it."
  fix: "Use UDP or Playit."

- id: net-playit-not-installed
  error: "Playit is not installed."
  fix: "Install Playit from the Network tab."

- id: net-playit-apt-only
  error: "Playit one-click install currently supports Ubuntu/Debian apt hosts."
  fix: "Install manually on other distros."

- id: net-playit-claim-owner-only
  http_status: 403
  error: "Only the owner can run the Playit claim terminal."
  fix: "Sign in as owner."

- id: net-tunnels-removed
  http_status: 410
  error: "Tunnels were removed. Use Templates or your VPS reverse proxy setup instead."
  fix: "Use a reverse proxy."

- id: net-host-edition-tunnels
  http_status: 404
  error: "Normal-edition tunnel setup is not available in host edition."
  fix: "Use the normal edition."

- id: net-ssrf-private
  error: "Backup imports cannot connect to local or private network addresses."
  cause: The host resolves to 10.x/172.16-31.x/192.168.x/127.x/169.254.x/::1/fc00::/fd00::/fe80::.
  fix: "Use a public host."

- id: net-dns-rebinding
  behaviour: "The validated IP is pinned so the fetch cannot re-resolve to a private address."
  fix: "Expected defense."

- id: net-host-header-injection
  behaviour: "Invalid Host/X-Forwarded-Host values are rejected."
  fix: "Expected defense."

- id: net-xaccel-config
  route: "GET /api/nginx/accel-config"
  purpose: "Prints an Nginx snippet for X-Accel download offload."
  fix: "Copy into your Nginx server block."

- id: net-xaccel-path-escape
  behaviour: "X-Accel is only used when the file resolves inside NEXUSPANEL_X_ACCEL_ROOT."
  fix: "Expected defense."

- id: net-range-invalid
  http_status: 416
  header: "Content-Range: bytes */<size>"
  cause: Malformed Range header.
  fix: "Send a valid byte range."

- id: net-range-suffix-invalid
  http_status: 416
  cause: Suffix range <= 0.
  fix: "Send a positive suffix."

- id: net-range-start-invalid
  http_status: 416
  cause: start < 0, end < start, or start >= size.
  fix: "Send a valid range."
```

---

## 17. Error catalogue — database

```yaml
- id: db-integrity-failed
  field: "databaseHealthStatus.ok: false"
  cause: SQLite integrity_check failed.
  fix: "Restore from a snapshot in data/db-backups/."

- id: db-snapshot-failed
  error: "Database snapshot failed: <error>"
  fix: "Check disk space."

- id: db-locked
  error: "SQLITE_BUSY: database is locked"
  cause: Concurrent write contention.
  fix: "Retry; the panel uses WAL and BEGIN IMMEDIATE."

- id: db-unique-email
  error: "UNIQUE constraint failed: users.email"
  fix: "Use a different email."

- id: db-migration-failed
  cause: A schema migration threw.
  fix: "Restore a backup; report the migration error."

- id: db-verify-failed
  error: "Database verification failed."
  fix: "Restore from backup."

- id: db-backup-created
  message: "Database snapshot created."
  fix: "Informational."

- id: db-column-legacy
  column: "servers.nexus_mark_profile"
  note: "Retained for schema compatibility; now stores the ASF profile JSON."
  fix: "No action."
```

---

## 18. Error catalogue — AI & repair agent

```yaml
- id: ai-openrouter-no-key
  error: "OpenRouter API key is not configured."
  fix: "Save a key in Settings."

- id: ai-openrouter-invalid-key
  error: "Invalid OpenRouter API key format."
  cause: The key does not match ^sk-or-v1-[A-Za-z0-9_-]{20,}$.
  fix: "Paste a valid key."

- id: ai-openrouter-http-error
  error: "<OpenRouter error message>"
  fix: "Check the key, model, and quota."

- id: ai-openrouter-no-model
  error: "No OpenRouter model selected."
  fix: "Select a model."

- id: ai-openrouter-owner-only
  http_status: 403
  error: "Only the owner can configure external AI providers."
  fix: "Sign in as owner."

- id: ai-openrouter-chat-owner-only
  http_status: 403
  error: "Only the owner can use the external AI bridge."
  fix: "Sign in as owner."

- id: ai-openrouter-messages-invalid
  http_status: 400
  error: "messages must contain 1-40 items."
  fix: "Send 1-40 messages."

- id: ai-micro-reward-invalid
  http_status: 400
  error: "reward must be between -1 and 1."
  fix: "Send a reward in [-1, 1]."

- id: ai-micro-owner-only
  http_status: 403
  error: "Only the owner can update the MicroLM."
  fix: "Sign in as owner."

- id: ai-tool-unknown
  http_status: 400
  error: "Unknown AI tool."
  fix: "Use a registered tool."

- id: ai-tool-full-access-required
  http_status: 409
  error: "Unlock time-limited AI full access before running a mutating tool."
  fix: "Unlock full access."

- id: ai-tool-server-required
  http_status: 400
  error: "A server is required for this tool."
  fix: "Provide a serverId."

- id: ai-tool-owner-only
  http_status: 403
  error: "Only the owner can execute advanced AI tools."
  fix: "Sign in as owner."

- id: ai-tool-read-limit
  error: "AI text reads are limited to 512 KB files."
  fix: "Read a smaller file."

- id: ai-tool-write-limit
  error: "AI writes require a path and are limited to 512 KB."
  fix: "Provide a path and smaller content."

- id: ai-tool-console-empty
  error: "Console command is empty."
  fix: "Provide a command."

- id: ai-tool-diagnostic-not-allowed
  error: "Terminal diagnostic command is not allowed: <cmd>"
  cause: The command is not in the agent_terminal allowlist.
  fix: "Use an allowlisted diagnostic."

- id: ai-tool-diagnostic-arg-not-allowed
  error: "Terminal diagnostic argument is not allowed for <cmd>."
  cause: The argument failed the per-command regex or contained shell metacharacters.
  fix: "Use a safe argument."

- id: ai-tool-diagnostic-args-too-long
  error: "Terminal diagnostic argument list is too long."
  fix: "Use <= 32 arguments."

- id: ai-tool-diagnostic-path-escape
  error: "Path escapes NexusPanel storage."
  cause: A path argument resolved outside the server root.
  fix: "Use a path inside the server root."

- id: ai-full-access-owner-only
  http_status: 403
  error: "Only the owner can unlock AI full access."
  fix: "Sign in as owner."

- id: ai-full-access-password
  http_status: 401
  error: "Owner password is required."
  fix: "Provide the owner password."

- id: ai-command-queue-owner-only
  http_status: 403
  error: "Only the owner can queue host commands."
  fix: "Sign in as owner."

- id: ai-command-approve-owner-only
  http_status: 403
  error: "Only the owner can approve host commands."
  fix: "Sign in as owner."

- id: ai-command-not-found
  http_status: 404
  error: "Queued command not found."
  fix: "Refresh the queue."

- id: ai-command-already-run
  http_status: 409
  error: "This command was already executed."
  fix: "Queue a new command."

- id: ai-repair-agent-disabled
  field: "repairAgentTerminalEnabled: false"
  cause: Terminal diagnostics disabled in Settings.
  fix: "Enable in Settings."

- id: ai-repair-web-disabled
  field: "repairWebEnabled: false"
  cause: Web research disabled.
  fix: "Enable in Settings."

- id: ai-repair-web-untrusted
  field: "trust: untrusted-reference-only"
  cause: Web results are never executed, only referenced.
  fix: "Expected."

- id: ai-repair-web-host-blocked
  error: "Research source is not an allowed host."
  cause: repair_web only allows specific hosts.
  fix: "Expected defense."

- id: ai-repair-web-http-error
  error: "Research source returned HTTP <status>."
  fix: "Retry later."

- id: ai-repair-web-private
  error: "Research source resolves to a private address."
  fix: "Expected defense."

- id: ai-repair-playbook-untrusted
  log: "Repair playbook <sig> recorded as an untrusted candidate; it will not be replayed until stable runtime validates it."
  fix: "Expected."

- id: ai-repair-validated
  log: "Repair agent validated episode <id> after stable runtime and updated <n> neural weight(s)."
  fix: "Informational."

- id: ai-repair-penalty
  log: "Repair agent applied negative reward to the last failed recovery (<n> neural weight updates)."
  fix: "Informational."

- id: ai-repair-no-safe-fix
  log: "Auto-restart stopped because Repair did not apply a concrete fix for this Bedrock world crash."
  fix: "Restore a verified backup or remove incompatible world/pack files."

- id: ai-repair-proactive
  log: "Proactive crash repair completed: <summary>"
  fix: "Informational."

- id: ai-repair-learned-replay
  log: "Learned recovery matched <sig>. Replaying previously validated repairs."
  fix: "Informational."

- id: ai-repair-learned-failed
  log: "Learned recovery could not complete: <error>"
  fix: "Check the error; the panel falls back to proactive repair."

- id: ai-repair-exit-recovery-failed
  log: "Exit recovery failed: <error>"
  fix: "Check the error."

- id: ai-repair-crash-unknown
  log: "Crash intelligence recorded unknown signature <sig> for learning."
  fix: "Informational."

- id: ai-repair-crash-diagnosed
  log: "Crash intelligence (<severity>): <summary> Next: <technique>"
  fix: "Follow the suggested technique."

- id: ai-repair-model-reset
  log: "Repair agent model reset (signature changed)."
  cause: The knowledge base or model version changed.
  fix: "Expected."

- id: ai-repair-episode-feedback
  http_status: 400
  error: "reward must be between -1 and 1."
  fix: "Send a valid reward."

- id: ai-repair-episode-not-found
  http_status: 404
  error: "Repair episode not found."
  fix: "Refresh."

- id: ai-advanced-install-failed
  error: "Advanced AI install failed: <error>"
  cause: The @huggingface/transformers package or model download failed.
  fix: "Check network and disk space."

- id: ai-advanced-model-missing
  field: "packageInstalled: false"
  fix: "Install advanced AI from Settings."

- id: ai-advanced-disabled
  field: "enabled: false"
  fix: "Enable advanced AI."

- id: ai-advanced-download-size
  field: "estimatedDownloadMb"
  cause: Informational — the model download size.
  fix: "Ensure enough disk space."

- id: ai-world-converter-status
  route: "GET /api/world-converter/status"
  fix: "Informational."

- id: ai-world-converter-install-failed
  error: "Chunker install failed: <error>"
  fix: "Check network."

- id: ai-agent-core-snapshot
  route: "GET /api/agent/core"
  fix: "Informational."

- id: ai-agent-event-ingest
  route: "POST /api/agent/events"
  fix: "Informational."
```

---

## 19. Error catalogue — UI/UX

```yaml
- id: ui-session-expired
  toast: "Your session expired. Sign in again."
  cause: 401 from any API call.
  fix: "The SPA redirects to login."

- id: ui-toast-generic
  behaviour: "showToast(message) displays a transient message."
  fix: "Read the message."

- id: ui-empty-state-servers
  message: "No servers yet. Create one from Dashboard or Templates."
  fix: "Create a server."

- id: ui-empty-state-console
  message: "No servers yet. Create one above, then install software from the Software tab."
  fix: "Create a server."

- id: ui-empty-state-templates
  message: "No templates available."
  fix: "Import a Nexu template."

- id: ui-empty-state-software
  message: "No software available."
  fix: "Check the software catalog."

- id: ui-empty-state-plugins-locked
  message: "Plugin manager is locked until file access level 80."
  fix: "Owner grants plugins.manage."

- id: ui-empty-state-plugins-none
  message: "No plugins installed for this server yet. Search Modrinth above."
  fix: "Install a plugin."

- id: ui-empty-state-modrinth
  message: "Select Paper/Purpur for plugins or Fabric/Forge for mods."
  fix: "Choose compatible software."

- id: ui-empty-state-bedrock-packs
  message: "Bedrock Dedicated Server packs need behavior/resource pack registration. Use File Manager for now; PocketMine plugins are available after switching software."
  fix: "Upload packs manually."

- id: ui-empty-state-properties
  message: "Create a server to edit properties."
  fix: "Create a server."

- id: ui-empty-state-whitelist
  message: "Create a server to manage whitelist."
  fix: "Create a server."

- id: ui-empty-state-whitelist-none
  message: "No whitelisted players yet."
  fix: "Add a player."

- id: ui-empty-state-files
  message: "Create a server to browse files."
  fix: "Create a server."

- id: ui-empty-state-folder
  message: "Folder is empty. Create a file or paste config here."
  fix: "Create a file."

- id: ui-empty-state-preview
  message: "Safe inline preview is not available for this format. Download it to open with its native application."
  fix: "Download the file."

- id: ui-empty-state-backups
  message: "Create a server to manage backups."
  fix: "Create a server."

- id: ui-empty-state-backup-requests
  message: "No backup access requests."
  fix: "Informational."

- id: ui-empty-state-shared-backups
  message: "No shared backups approved for this server."
  fix: "Informational."

- id: ui-empty-state-optimizer-error
  message: "Error loading optimizer data."
  fix: "Check the API; retry."

- id: ui-empty-state-network
  message: "No network counters available on this OS."
  cause: /proc/net/dev missing (non-Linux).
  fix: "Expected on non-Linux."

- id: ui-empty-state-admins
  message: "No admin users yet."
  fix: "Create an admin."

- id: ui-empty-state-fixed-loading
  message: "Loading fixed history..."
  fix: "Wait."

- id: ui-empty-state-fixed-locked
  message: "Fixed history needs security access."
  fix: "Owner grants security.view."

- id: ui-empty-state-commands
  message: "No full access commands queued."
  fix: "Informational."

- id: ui-empty-state-fixed-none
  message: "No fixed events recorded in the last 24 hours."
  fix: "Informational."

- id: ui-empty-state-audit-locked
  message: "Security audit needs owner/admin access."
  fix: "Owner grants security.view."

- id: ui-empty-state-security-loading
  message: "Loading security status..."
  fix: "Wait."

- id: ui-empty-state-health
  message: "Run a health check to verify panel folders, database, software, and Java."
  fix: "Run a health check."

- id: ui-empty-state-telemetry
  message: "No server telemetry available yet."
  fix: "Start a server."

- id: ui-empty-state-logins
  message: "No login events recorded yet."
  fix: "Informational."

- id: ui-empty-state-command-search
  message: "No matching command."
  fix: "Broaden the search."

- id: ui-terminal-removed
  behaviour: "The Terminal view was removed in 6.0.0."
  fix: "Use the console for server commands."

- id: ui-asf-doctor
  button: "Run Kernel Doctor"
  action: "asf-doctor"
  status_node: "#asfDoctorStatus"
  fix: "Informational."

- id: ui-asf-doctor-failed
  status_text: "<error message>"
  fix: "Read the error."

- id: ui-layout-import-failed
  toast: "Layout import failed: <error>"
  fix: "Check the layout code."

- id: ui-layout-saved
  toast: "Alpha layout saved."
  fix: "Informational."

- id: ui-openrouter-save-no-key
  toast: "Enter an OpenRouter API key first."
  fix: "Enter a key."

- id: ui-openrouter-saved
  toast: "OpenRouter key saved securely on the server."
  fix: "Informational."

- id: ui-openrouter-connected
  toast: "OpenRouter connected. <n> models available."
  fix: "Informational."

- id: ui-openrouter-removed
  toast: "OpenRouter key removed."
  fix: "Informational."

- id: ui-advanced-ai-installing
  status_text: "Installing advanced AI. This can take several minutes on first download..."
  fix: "Wait."

- id: ui-world-converter-installing
  status_text: "Installing Chunker converter..."
  fix: "Wait."

- id: ui-world-convert-confirm
  confirm: "Convert \"<name>\" into a NEW <type> server? Source server files will not be deleted or overwritten. Player inventories/entities may not fully convert across editions."
  fix: "Confirm to proceed."

- id: ui-world-convert-select-source
  toast: "Select a source server first."
  fix: "Select a server."

- id: ui-world-convert-same-edition
  toast: "Pick the opposite edition. This server is already that type."
  fix: "Pick the opposite edition."

- id: ui-full-access-unlock
  prompt: "Owner password to unlock AI full access for 15 minutes:"
  fix: "Enter the owner password."

- id: ui-full-access-lock
  prompt: "Owner password to lock AI full access:"
  fix: "Enter the owner password."

- id: ui-live-diagnostics-confirm
  confirm: "Enable live diagnostics? It will scan console/files during adaptive maintenance, run safe offline fixes, and queue high-risk commands for owner approval."
  fix: "Confirm to enable."

- id: ui-queue-command
  prompt: "Command to queue for owner-approved full access execution:"
  fix: "Enter a command."

- id: ui-approve-command
  confirm: "Approve and run this full access command now?"
  fix: "Confirm."

- id: ui-approve-command-password
  prompt: "Owner password to run queued command:"
  fix: "Enter the owner password."

- id: ui-update-confirm
  confirm: "Update NexusPanel from GitHub now? Server files, data, software cache, and external backups stay protected."
  fix: "Confirm."

- id: ui-host-token-show
  prompt: "Host API token copied if browser allowed it:"
  fix: "Copy the token."

- id: ui-host-token-regen
  confirm: "Regenerate host API token? Old automation using the token will stop working."
  fix: "Confirm."

- id: ui-reinstall-confirm
  confirm: "Reinstall replaces the selected software runtime/build files. Worlds, configs, plugins, mods, packs, and backups stay untouched. Continue?"
  fix: "Confirm."

- id: ui-delete-server-confirm
  confirm: "Delete this server and its files?"
  fix: "Confirm."

- id: ui-restart-confirm
  confirm: "Restart this server now?"
  fix: "Confirm."

- id: ui-kill-confirm
  confirm: "Force-kill this server? Unsaved world data may be lost."
  fix: "Confirm."

- id: ui-restore-confirm
  confirm: "Restore this backup? Current world files will be replaced."
  fix: "Confirm."

- id: ui-upload-paused
  status: "paused"
  message: "Ready to resume exact chunks"
  fix: "Resume the upload."

- id: ui-upload-failed
  status: "failed"
  message: "Checksum mismatch; retry upload"
  fix: "Re-upload."

- id: ui-upload-waiting
  status: "waiting"
  message: "Waiting for upload"
  fix: "Start the upload."

- id: ui-upload-active
  status: "active"
  message: "Uploading"
  fix: "Wait."

- id: ui-upload-live
  message: "Uploading live"
  fix: "Wait."

- id: ui-console-closed
  log: "[NexusPanel terminal closed] exit=<code>"
  cause: Legacy terminal message (removed in 6.0.0).
  fix: "No action."

- id: ui-privacy-shield
  behaviour: "body[data-privacy-shield=true] blurs console/terminal output."
  fix: "Toggle the privacy shield."

- id: ui-theme-picker
  behaviour: "Theme select changes the CSS theme."
  fix: "Pick a theme."

- id: ui-server-switcher
  behaviour: "Quick switch changes the active server."
  fix: "Pick a server."

- id: ui-presence
  behaviour: "Live cursors show other admins' positions."
  fix: "Informational."

- id: ui-toast-hidden
  behaviour: "The toast element is hidden until a message is shown."
  fix: "Informational."
```

---

## 20. Training record schema

### Additional Minecraft and runtime triage records

These records describe safe diagnostics and suggestions. They do not authorize
the model to install software, disable plugins, alter a world, or start a
server. A suspected plugin conflict should be checked on an offline copy or
staging server before changing production.

```yaml
- id: minecraft-no-server-jar
  trigger: "Starting a new Java Minecraft server before choosing software"
  error: "Unable to access jarfile server.jar"
  symptom: "The server root has no server JAR, so the Java process exits before Minecraft starts."
  cause: "No Minecraft software build has been installed, or the configured JAR name does not match the installed file."
  fix: "Recommend choosing and installing a compatible build (Vanilla, Paper, Purpur, Fabric, Forge, or another supported catalog option) in the panel Software section. If a JAR already exists, verify its configured filename and server root before reinstalling."

- id: minecraft-software-install-incomplete
  trigger: "A Minecraft software download or install was interrupted"
  error: "Server JAR is missing or the downloaded JAR is zero bytes / truncated."
  symptom: "The configured server JAR is absent, empty, or fails archive validation after software installation."
  cause: "The software download did not finish, or disk/network failure left a partial artifact."
  fix: "Check free disk space and the software install log, remove only the identified partial download, then retry the selected software build from the panel catalog. Do not delete the world or unrelated server files."

- id: minecraft-server-main-class-missing
  trigger: "Launching a JAR that is not a Minecraft server build"
  error: "no main manifest attribute, in server.jar"
  symptom: "Java opens the configured JAR but it has no server entry point."
  cause: "A plugin, proxy, client, or unrelated JAR was selected as the server executable."
  fix: "Install a server distribution from the panel Software catalog, or select the correct server JAR. Do not rename an arbitrary JAR to server.jar."

- id: minecraft-eula-not-accepted
  trigger: "First Minecraft startup stops at EULA acceptance"
  error: "You need to agree to the EULA in order to run the server"
  symptom: "The server exits and eula.txt contains eula=false."
  cause: "Minecraft requires the operator to review and accept its EULA before startup."
  fix: "Show the panel EULA acceptance control and require the operator to make that choice. Do not accept the EULA automatically."

- id: minecraft-plugin-isolate-safely
  trigger: "A Paper or Purpur startup log names a plugin in the first exception or enable failure"
  error: "Error occurred while enabling ExamplePlugin; plugin disabled"
  symptom: "The server reports a plugin-specific exception during load or enable."
  cause: "The named plugin may be incompatible, misconfigured, missing a dependency, or conflicting with another plugin."
  fix: "Identify the first plugin exception and full caused-by stack. Check the plugin's server/API version and declared dependencies. Suggest disabling only the named plugin on an offline backup or staging copy, then compare a controlled boot. Never remove or disable plugins and restart the live server automatically."

- id: minecraft-plugin-java-incompatibility
  trigger: "A plugin was built for a newer Java runtime than the server uses"
  error: "UnsupportedClassVersionError while loading plugin"
  symptom: "The stack trace names a plugin class and says the runtime recognizes an older class-file version."
  cause: "The plugin requires a newer Java major version, or the server is using an incompatible plugin build."
  fix: "Compare the plugin's documented Java requirement with the selected server runtime. Recommend selecting a compatible Java runtime or plugin build, then verify on a staging copy."

- id: minecraft-plugin-missing-dependency
  trigger: "A plugin fails because its required plugin is absent"
  error: "Unknown/missing dependency PluginDependency required by ExamplePlugin"
  symptom: "The server names a required plugin or library that it cannot find."
  cause: "A required dependency is not installed, is disabled, or its plugin name/version does not satisfy the declaration."
  fix: "Show the exact missing dependency and recommend its compatible official release. Verify loader, server version, and dependency ordering; do not download from an untrusted mirror."

- id: minecraft-plugin-api-mismatch
  trigger: "A plugin fails its server API compatibility check"
  error: "Unsupported API version / legacy plugin loading is disabled"
  symptom: "The server refuses to load a plugin due to its declared API version."
  cause: "The plugin build targets an API/server version not supported by this server."
  fix: "Recommend a plugin release compatible with the current server version, using the project owner's official download page. Avoid editing plugin metadata to bypass compatibility checks."

- id: minecraft-world-corruption-startup
  trigger: "The server crashes while opening a world or region file"
  error: "Failed to read chunk / region file is corrupt / failed to load level.dat"
  symptom: "Startup log identifies world metadata, a region, or a chunk as unreadable."
  cause: "World data may be damaged, or storage returned an I/O error."
  fix: "Keep the server stopped to avoid further writes. Check disk and filesystem health, preserve a copy of the world, and recommend restoring a verified backup or using a game-specific offline repair tool. Never regenerate or overwrite the only world automatically."

- id: minecraft-bind-port-conflict
  trigger: "Minecraft cannot bind its configured game port"
  error: "FAILED TO BIND TO PORT / Address already in use"
  symptom: "The server reports that its configured TCP or UDP port is already occupied."
  cause: "Another server process or service owns the port."
  fix: "Identify the owning process and server allocation first. Stop only a confirmed stale process or assign a free port; preserve other live servers."

- id: nexuspanel-asf-wrapper-failed
  trigger: "The isolated server process exits before Java or Minecraft logs begin"
  error: "Nexus-Mark native runtime failed / process exited code=200 / ASF wrapper error"
  symptom: "Supervisor or wrapper reports a sandbox error before game startup output."
  cause: "The ASF isolation wrapper, host kernel feature, per-server identity, or ACL setup failed before launching the game runtime."
  fix: "Inspect the panel server log, transient systemd unit journal, and ASF self-test for the same server. Repair the specific host preflight/identity problem. Do not bypass isolation or launch tenant code as root. Retry only after the supported isolation path passes preflight."

- id: nexuspanel-server-runtime-failed
  trigger: "NexusPanel reports a server runtime launch failure"
  error: "Failed to start server process / spawn failed / exit before server ready"
  symptom: "The runtime supervisor could not launch or keep the configured game process alive."
  cause: "Possible executable, working-directory, permission, Java, startup-flag, isolation, or game configuration error; the supervisor message alone does not identify which."
  fix: "Use the first runtime/supervisor error and process exit status to classify the failure. Check the configured executable, server root, runtime selection, and startup flags. Do not infer a Java memory problem without JVM/OOM evidence, and do not enter a restart loop."

- id: minecraft-startup-flags-invalid
  trigger: "A custom Java startup flag prevents process launch"
  error: "Unrecognized VM option / Could not create the Java Virtual Machine"
  symptom: "Java exits immediately while parsing a custom startup option."
  cause: "A flag is invalid for the selected Java major version, malformed, or conflicts with a panel-managed memory/system property."
  fix: "Show the exact rejected flag and recommend removing or correcting that flag in Settings > Startup. Keep panel-managed heap and isolation options under panel control; do not silently discard all user flags."

- id: minecraft-plugin-crash-loop
  trigger: "A plugin exception repeats after every automatic server restart"
  error: "Server restart loop after plugin enable failure"
  symptom: "The same plugin stack trace appears on each startup and the supervisor keeps restarting the process."
  cause: "A persistent plugin/configuration failure is being retried by a restart policy."
  fix: "Stop or pause the restart loop, preserve the logs, and isolate the named plugin on an offline copy or staging server. Resume production only after a verified fix; never auto-delete plugin data."

- id: bedrock-binary-permission
  trigger: "Official Bedrock Dedicated Server is installed on Linux but will not execute"
  error: "Permission denied: bedrock_server"
  symptom: "The installed Bedrock binary exists but the operating system refuses to execute it."
  cause: "The executable bit or a parent directory permission was lost during extraction, or the server identity cannot traverse the path."
  fix: "Verify the binary and parent-directory permissions for the dedicated server identity. Restore execute permission only on the official server binary; do not chmod the full server tree or run it as root."

- id: bedrock-platform-architecture
  trigger: "Installing official Bedrock Dedicated Server on an unsupported operating system or CPU architecture"
  error: "Exec format error: bedrock_server"
  symptom: "Linux cannot execute the downloaded Bedrock server binary."
  cause: "The selected official package does not match the VPS OS or CPU architecture, or it is an incomplete download."
  fix: "Check the VPS architecture and supported BDS package platform, then reinstall a matching official build. Do not try to run an x64 binary on ARM through an unsafe compatibility workaround."

- id: bedrock-native-library-missing
  trigger: "Official Bedrock Dedicated Server fails during dynamic linking"
  error: "error while loading shared libraries: lib*.so: cannot open shared object file"
  symptom: "The BDS executable is present but exits before opening the world because a named Linux shared library is missing."
  cause: "The host is missing a runtime library required by that Bedrock build."
  fix: "Identify the exact missing library and install its supported distribution package (commonly libstdc++6, libgcc-s1, or libc6). Confirm the host distribution and architecture before installing packages."

- id: bedrock-udp-firewall
  trigger: "Bedrock server starts but Bedrock clients cannot connect"
  error: "RakNet timeout / UDP port unreachable / no Bedrock response"
  symptom: "The Bedrock process is running, but clients time out on its configured game port."
  cause: "Bedrock uses UDP; the server allocation, host firewall, provider firewall, or external route may block that UDP port."
  fix: "Verify the configured Bedrock port and open that UDP port in both host and provider firewalls. Confirm the process is listening and test from outside the VPS. A successful TCP probe does not prove UDP works."

- id: bedrock-pack-engine-version
  trigger: "A Bedrock resource or behavior pack is rejected during startup"
  error: "Pack requires a newer engine version / min_engine_version is too high"
  symptom: "The Bedrock log reports the pack's required engine version exceeds the server's accepted version."
  cause: "The pack targets a newer Bedrock engine than the installed BDS build supports."
  fix: "Match the pack release to the installed BDS version or update BDS from the supported software catalog. Preserve the world and pack before making changes; only quarantine an incompatible pack while the server is offline."

- id: bedrock-pack-manifest-invalid-startup
  trigger: "Bedrock cannot load an installed content pack"
  error: "manifest.json invalid / missing header UUID / pack manifest parse error"
  symptom: "The server identifies a malformed or missing pack manifest."
  cause: "The pack archive may be incomplete, its manifest JSON is invalid, or required UUID/version fields are absent."
  fix: "Validate the named manifest and compare it with the pack's official release. Restore a valid copy or disable only that pack on an offline copy; do not rewrite UUIDs referenced by a live world."

- id: bedrock-allowlist-rejected
  trigger: "A Bedrock player is rejected while allowlisting is enabled"
  error: "Player is not whitelisted / allowlist check failed"
  symptom: "A player cannot join even though an operator expects the name to be allowed."
  cause: "The allowlist may be enabled without the player's current XUID entry, or the allowlist file may not have reloaded."
  fix: "Check the player's Bedrock identity/XUID in the panel allowlist, confirm allowlist is enabled intentionally, and use the server-supported reload or a controlled restart. Do not disable the allowlist as an automatic fix."

- id: bedrock-pocketmine-runtime
  trigger: "PocketMine-MP fails before it starts accepting connections"
  error: "PocketMine PHP runtime missing / invalid PHAR / required extension unavailable"
  symptom: "PocketMine startup exits while loading its bundled PHP runtime or PHAR."
  cause: "The managed PHP runtime, extension set, or PocketMine PHAR is missing, incomplete, or incompatible."
  fix: "Use the panel's PocketMine software installer to restore its bundled runtime and official PHAR. Inspect the exact missing extension and install log; do not substitute an arbitrary system PHP binary."

- id: bedrock-plugin-unsupported-software
  trigger: "Trying to install a Java plugin or a Bedrock plugin on official BDS"
  error: "Plugin installation is unsupported for this software / use PocketMine for Bedrock plugins"
  symptom: "The selected software does not provide a compatible plugin loader."
  cause: "Official Bedrock Dedicated Server supports behavior/resource packs, not PocketMine .phar plugins or Java .jar plugins."
  fix: "For official BDS, install compatible behavior/resource packs. If plugin APIs are required, select PocketMine-MP and confirm its feature differences; PocketMine is not full vanilla BDS parity."

- id: panel-api-request-failed
  trigger: "A panel section fails to load or an action returns an API error"
  error: "Request failed / API returned HTTP 500 / Cannot GET or POST /api/..."
  symptom: "The UI shows an error while fetching or changing panel data."
  cause: "The route may be missing, the request method/payload may disagree with the backend, or a backend exception occurred."
  fix: "Capture the exact method, path, HTTP status, and first backend stack trace. Compare the frontend request with the registered route and return a structured error. Never expose credentials or session tokens in logs."

- id: panel-live-view-stale
  trigger: "Files or plugin state changes on the server but the panel still shows old rows"
  error: "File manager or plugin list is stale until page refresh"
  symptom: "An upload, extraction, archive, install, or delete completes but the visible list does not update."
  cause: "The mutation completed without invalidating or refreshing the corresponding live view state."
  fix: "After the operation succeeds, refresh the affected server-scoped listing or consume its live event, then reconcile with the filesystem as source of truth. Do not require a full-page reload or report success before the filesystem operation completes."

- id: panel-live-progress-disappears
  trigger: "A long archive, extraction, or backup operation runs in the panel"
  error: "Progress disappears after one second / percentage never updates"
  symptom: "The UI hides progress before the server-side operation completes or only shows a brief initial state."
  cause: "Progress lifecycle is tied to a short request/timeout instead of a persistent operation ID and terminal event."
  fix: "Track operation state by server and operation ID, report completed bytes or files where available, poll or stream updates, and dismiss only after success/failure reaches a terminal state. Do not invent percent precision when total work is unknown."

- id: panel-console-command-duplicated
  trigger: "One console message is sent but the game receives it twice"
  error: "Console command duplicated / command appears twice in server log"
  symptom: "A single submit produces duplicate console output or duplicate game action."
  cause: "The frontend may submit through both form and key handlers, or a reconnect/retry may replay a non-idempotent command."
  fix: "Trace one submit from UI event to backend write, guard against duplicate in-flight request IDs, and do not automatically replay console commands after reconnect. Preserve legitimate server output instead of deleting repeated-looking log lines."

- id: panel-section-refresh-route-lost
  trigger: "Refreshing a non-dashboard panel section returns to Dashboard"
  error: "Panel route resets to dashboard after browser refresh"
  symptom: "The selected settings, Tebex, or other section is lost on reload."
  cause: "The selected section is held only in transient UI state and is not restored from the URL or validated persisted navigation state."
  fix: "Encode the current section in the URL/history state, validate it against available sections and permissions at startup, then restore it after refresh. Do not bypass role/capability checks."

- id: panel-console-session-duplicated
  trigger: "Console output duplicates after reconnecting the panel live stream"
  error: "Duplicate console lines after reconnect / WebSocket or event stream reconnect"
  symptom: "Lines already shown before reconnect appear again."
  cause: "The client resumes without a last-seen event cursor or the backend replays overlapping log buffers."
  fix: "Use monotonically increasing event IDs or timestamps with a stable cursor and deduplicate transport replay by event ID. Do not deduplicate separate identical messages emitted by the game."

- id: panel-database-connection-failed
  trigger: "NexusPanel cannot open its configured database during startup"
  error: "SQLITE_CANTOPEN / unable to open database file / database initialization failed"
  symptom: "Panel startup or API requests fail before normal database-backed features load."
  cause: "The configured DB path is unavailable, parent directory is not writable by the service identity, disk is full, or the database file is invalid."
  fix: "Check the configured data root, service-user access, free disk space, and startup journal. Preserve the database and its WAL files before recovery; do not delete or recreate the production DB as a first step."

- id: panel-database-migration-failed
  trigger: "A panel update fails while applying a database schema migration"
  error: "Database migration failed / no such column / migration transaction rolled back"
  symptom: "The panel logs a migration error at startup or a route fails due to schema mismatch."
  cause: "The database schema does not match the running code, or a migration failed partway through."
  fix: "Stop duplicate panel instances, preserve a verified DB snapshot, and inspect the exact migration and schema version. Apply a supported forward migration or restore a matching backup; never drop user/server tables to silence the error."

- id: panel-session-cookie-invalid
  trigger: "A valid panel user is repeatedly returned to login after restart"
  error: "Session invalid / CSRF token mismatch / signed cookie verification failed"
  symptom: "The browser loses authentication after a panel restart or rejects state-changing requests."
  cause: "Cookie signing secret changed, cookies are stale, proxy HTTPS settings are inconsistent, or the request lacks the required CSRF header."
  fix: "Check persistent cookie-secret configuration, proxy trust and HTTPS cookie settings, browser cookie scope, and CSRF header wiring. Keep the signing secret stable across restarts; do not reset or delete owner accounts to repair sessions."

- id: panel-upload-session-expired
  trigger: "A large chunked upload is resumed after the server lost its upload state"
  error: "Upload session not found / committed ranges missing / checksum mismatch"
  symptom: "A resumed upload fails or progress jumps backward after reconnect or panel restart."
  cause: "The upload session or committed chunk manifest expired, was not persisted, or conflicts with the actual temporary file."
  fix: "Compare the session ID, committed byte ranges, file size, and chunk hashes. Resume only from verified committed chunks; otherwise create a fresh upload and remove only its abandoned temporary artifact after confirming it is not active."

- id: panel-plugin-inventory-stale
  trigger: "A plugin is deleted from the file manager but remains in the plugin UI"
  error: "Plugin list still shows deleted plugin / installed state out of sync"
  symptom: "The plugin catalog reports a plugin as installed after its file was removed."
  cause: "The plugin view is using stale cached metadata instead of reconciling with the server's active plugin directory."
  fix: "Rescan the correct plugins or mods directory after file mutations and derive installed state from matching files. Keep catalog search metadata separate from installed-file state; do not delete another plugin's data directory automatically."

- id: panel-service-restart-data-missing
  trigger: "Panel accounts or server records disappear after restarting NexusPanel"
  error: "Users/servers missing after restart / panel appears to run first-time setup again"
  symptom: "The restarted panel opens an empty setup state or cannot see previously stored accounts."
  cause: "The service is using a different or ephemeral data root, wrong working directory, or a newly initialized database."
  fix: "Inspect the service environment and resolved database path, then compare it with the existing production DB and backups. Restore the original configured data root; never initialize over or delete the old database until its contents are verified."

- id: panel-permission-denied-route
  trigger: "A limited panel user can see a section but its operation returns forbidden, or can call an operation they should not access"
  error: "403 Forbidden / capability denied / permission map mismatch"
  symptom: "Navigation visibility and backend authorization disagree."
  cause: "The UI and API use different capability keys, or the route lacks the expected backend authorization check."
  fix: "Use one capability definition for navigation and endpoint authorization, with backend enforcement authoritative. Verify both allowed and denied cases using a limited account; do not solve a 403 by disabling authorization."

- id: panel-service-start-limit
  trigger: "NexusPanel repeatedly crashes and systemd stops retrying it"
  error: "Start request repeated too quickly / start-limit-hit"
  symptom: "The panel service remains failed after several rapid startup attempts."
  cause: "A persistent startup error caused a restart loop and systemd rate limiting."
  fix: "Inspect the first failure in journalctl, correct the underlying issue, and only then clear the start limit and start once. Avoid increasing restart frequency or looping blindly."

- id: process-port-held
  trigger: "Minecraft or Bedrock cannot bind because another OS process is listening on the game port"
  error: "Address already in use / bind failed / EADDRINUSE"
  symptom: "The game process reports its TCP or UDP port is occupied, although the panel may not show another server allocation using it."
  cause: "A running or stale game process, proxy, or other host service owns the socket. A panel allocation collision and an OS-level listener are separate conditions."
  fix: "Inspect the protocol and listener with an OS socket tool (Linux: ss -ltnup; Windows: Get-NetTCPConnection), identify its owning PID/service, and map it to a server before stopping anything. Stop only a confirmed stale process or assign a free compatible port. Never kill an unknown process."

- id: world-session-lock-active
  trigger: "Minecraft says the world/session is already in use while a server process may still be running"
  error: "session.lock / World is already in use / Failed to lock level"
  symptom: "A second launch cannot open a world because its session lock is held."
  cause: "Another active process may be writing the same world, or an old lock file may remain after an unclean shutdown."
  fix: "First check the panel runtime status and OS process list for every process using that server root. If any process is active, stop it gracefully and do not delete the lock. Only when no process can access the world, preserve a backup and remove a confirmed stale session lock before one controlled start. Never run two servers against the same world."

- id: duplicate-server-process
  trigger: "NexusPanel says a server is already running but the status appears offline, or a second start is refused"
  error: "Server process already exists / another instance is running / PID still active"
  symptom: "The tracked process and visible server status disagree, or a second process may be starting against the same root."
  cause: "The runtime may have a stale PID record, a live child that lost its panel connection, or a duplicate external launch."
  fix: "Compare the tracked PID with the OS process command line, server root, and transient systemd unit. Reattach/reconcile a valid live process; clear stale tracking only after verifying the process is gone. Do not launch a second writer or kill a PID based only on a stale status label."

- id: server-file-busy
  trigger: "A server file cannot be moved, replaced, or deleted because a process holds it open"
  error: "EBUSY / resource busy / sharing violation / file is in use by another process"
  symptom: "A file manager operation fails while a server or backup task may still be using the file."
  cause: "The active game process, archive/backup worker, or another host process has an open handle; some filesystems also report transient busy errors during writes."
  fix: "Identify the operation and owning process, wait for active writes or stop the server cleanly, then retry. For world/database files, take an offline verified backup before repair. Do not force-delete an open world, LevelDB, SQLite, or backup file."

- id: support-config-json-missing
  trigger: "A required Minecraft support JSON file is missing or malformed"
  error: "whitelist.json / allowlist.json / permissions.json not found or JSON parse failed"
  symptom: "The server cannot load a support list/config file, or its JSON is invalid."
  cause: "A first install omitted the default file, or an interrupted edit left malformed JSON."
  fix: "For a missing file, create the documented empty-list default. For malformed content, first preserve the original in config-recovery, then rebuild only that known support file. Never reset a valid list."

- id: bedrock-missing-pack-reference
  trigger: "A Bedrock world refers to a behavior/resource pack that is not installed"
  error: "Pack UUID not found / missing behavior or resource pack / pack stack missing"
  symptom: "The world pack reference JSON names a pack UUID/version absent from installed pack manifests."
  cause: "The pack was removed or moved, or its manifest no longer matches the world reference."
  fix: "Only while the server is offline, back up the world's reference JSON and compare UUID/version values to installed manifests. Remove only references proven missing; retain and restore any pack required by the world. Never delete world data."

- id: archive-incomplete
  trigger: "An archive or transfer stopped before completion"
  error: "Unexpected end of archive / truncated ZIP / stale .download or .uploading file"
  symptom: "Extraction or archive validation fails, or an old partial transfer remains in the server root."
  cause: "A transfer was interrupted, or a partial artifact was left after a failed operation."
  fix: "Check that no upload/archive job is active and that the partial file is older than the active-operation window. Remove only confirmed stale partial artifacts, then retry or resume from verified chunks. Never remove a valid archive or backup."

- id: server-root-readonly
  trigger: "The server's isolated service identity cannot write to its own server root"
  error: "Server root not writable / write test failed / permission denied under server root"
  symptom: "The runtime cannot create logs, configuration, or world files in the configured server directory."
  cause: "Ownership or ACLs for the dedicated server identity are incorrect, or the filesystem is read-only."
  fix: "Run the scoped permission auditor and repair only the affected server-root paths for that server identity. If the mount is read-only or storage has I/O errors, stop and repair the host filesystem instead of changing permissions. Never use chmod 777 or widen access to other tenants."
```

### Training record schema

Every record in this corpus follows this schema. Use it to generate SFT pairs.

```json
{
  "code": "number — stable numeric error code (see Appendix D/E)",
  "id": "string — stable unique identifier",
  "category": "auth | permission | server | install | java | file | backup | plugin | asf | service | network | database | ai | ui",
  "severity": "info | low | medium | high | critical",
  "trigger": "string — the user action or condition that causes this",
  "symptom": "string — what the user observes",
  "http_status": "number | null",
  "error": "string — the exact error text",
  "cause": "string — the root cause",
  "fix": "string — the corrective action",
  "exit_code": "number | null",
  "related": ["array of related record ids"],
  "tags": ["array of search keywords"]
}
```

### SFT pair format

```json
{
  "messages": [
    { "role": "system", "content": "You are the NexusPanel support AI. Diagnose the issue and give the exact fix." },
    { "role": "user", "content": "<symptom or error text>" },
    { "role": "assistant", "content": "<cause + fix, referencing the exact command or setting>" }
  ],
  "metadata": { "code": "<numeric code>", "record_id": "<id>", "category": "<category>" }
}
```

### RAG chunk format

```
[<category>/<code>/<id>] <symptom>
CAUSE: <cause>
FIX: <fix>
```

---

## Appendix A — Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Panel HTTP port |
| `NEXUSPANEL_EDITION` | normal | `normal` or `host` |
| `NEXUSPANEL_DATA_ROOT` | /var/lib/nexuspanel | External data root |
| `NEXUSPANEL_BACKUP_ROOT` | <data>/backups | Backup storage |
| `NEXUSPANEL_COOKIE_SECRET` | auto | Session signing secret |
| `NEXUSPANEL_SECURE_COOKIE` | 0 | Force Secure cookie flag |
| `NEXUSPANEL_TRUST_PROXY` | loopback | Express trust proxy |
| `NEXUSPANEL_PUBLIC_URL` | — | Public base URL |
| `NEXUSPANEL_OWNER_EMAIL` | — | First-run owner email |
| `NEXUSPANEL_OWNER_PASSWORD` | — | First-run owner password |
| `NEXUSPANEL_OWNER_NAME` | Owner | First-run owner name |
| `NEXUSPANEL_NATIVE_SANDBOX` | 1 | Enable ASF native sandbox |
| `NEXUSPANEL_PER_SERVER_USERS` | 1 | Enable per-server identities |
| `NEXUSPANEL_ADVANCED_ISOLATION` | 1 | Enable extra systemd hardening |
| `NEXUSPANEL_CGROUPS` | 1 | Enable cgroup v2 limits |
| `NEXUSPANEL_MAX_UPLOAD_GB` | 50 | Max chunked upload size |
| `NEXUSPANEL_MAX_REMOTE_BACKUP_GB` | 20 | Max remote backup import |
| `NEXUSPANEL_X_ACCEL_ROOT` | — | Nginx X-Accel root |
| `NEXUSPANEL_X_ACCEL_PREFIX` | — | Nginx X-Accel prefix |
| `NEXUSPANEL_SERVICE_NAME` | nexuspanel | systemd unit base name |
| `NEXUSPANEL_SERVICE_USER` | sudo user | Service user |
| `NEXUSPANEL_HOST_AGENT_SOCKET` | /run/nexuspanel/host-agent.sock | Agent socket |
| `NEXUSPANEL_NATIVE_ROOT` | /var/lib/nexuspanel | Native binary root |
| `CC` | cc | C compiler for ASF |

---

## Appendix B — File layout

```
backend/
  index.js            Express API + static host (main)
  auth.js             sessions, capabilities, password hashing
  db.js               SQLite schema + migrations
  runtime.js          process supervisor (start/stop/console)
  asf.js              ASF orchestration (profile/wrap/spawn)
  asf_native.js       ASF binary build + probe
  asf_identity.js     per-server locked users + ACLs
  service.js          systemd unit generation
  cli.js              nexuspanel CLI
  software.js         software catalog + version resolution
  paths.js            path sandboxing (assertInside)
  zip_utils.js        archive extraction (Zip Slip guarded)
  archive.js          ZIP creation
  agent_terminal.js   audited diagnostic allowlist
  repair_agent.js     neural repair model
  repair_knowledge.js deterministic diagnostics
  repair_web.js       allowlisted web research
  micro_lm.js         micro decision model
  advanced_ai.js      forensic reasoning
  openrouter.js       external AI provider (encrypted key)
  ddos_guard.js       DDoS evidence collection
  optimizer.js        host tuning
  world_converter.js  Chunker integration
  host_agent.js       native host agent client
  permission_repair.js ownership/mode audit + repair
  performance_monitor.js route latency tracking
  intelligence_core.js learned health/incidents
  adaptive_engine.js  adaptive maintenance
  templates.js        Nexu template schema
  timezone.js         per-user timezone
  system_info.js      host CPU/memory
  process_metrics.js  per-process metrics
  platform.js         platform capability matrix
  launcher.js         service entry point
native/
  asf/src/asf_runtime.c        ASF sandbox launcher
  asf/tests/{test,test-audit,benchmark}.sh + audit.c
  host-agent/src/nexus_host_agent.c
frontend/
  index.html          SPA shell
  js/main.js          SPA logic
  css/main.css        styles
tests/
  auth.test.js, v3.test.js, setup.test.js, intelligence.test.js,
  ai.test.js, micro.test.js, security-regression.test.js,
  advanced-ops.test.js, security-exploit.test.js
```

---

## Appendix C — Error count summary

| Category | Records |
|---|---|
| CLI | 7 |
| Authentication | 18 |
| Permissions | 11 |
| Server lifecycle | 30 |
| Minecraft installation | 24 |
| Java runtime | 10 |
| Files & uploads | 40 |
| Backups | 20 |
| Plugins & mods | 15 |
| ASF sandbox | 40 |
| systemd service | 13 |
| Network & tunnels | 20 |
| Database | 9 |
| AI & repair agent | 45 |
| UI/UX | 60 |
| **Total** | **362** |

> This corpus is designed to be extended. Each new error the panel can emit
> should be added as a record with the same schema so the training set grows
> monotonically toward the 10M-parameter target.

---

## Appendix D — Numeric error code scheme

Every record has a stable numeric `code`. The code is what the AI should learn
to map from a symptom, and what support staff can quote ("error 4010").

| Range | Category | Count |
|---|---|---|
| `1001–1099` | CLI | 7 |
| `2001–2099` | Authentication | 20 |
| `3001–3099` | Permissions | 19 |
| `4001–4099` | Server lifecycle | 30 |
| `5001–5099` | Minecraft installation | 26 |
| `6001–6099` | Java runtime | 10 |
| `7001–7099` | Files & uploads | 40 |
| `8001–8099` | Backups | 20 |
| `9001–9099` | Plugins & mods | 16 |
| `10001–10099` | ASF sandbox | 54 |
| `11001–11099` | systemd service | 13 |
| `12001–12099` | Network & tunnels | 20 |
| `13001–13099` | Database | 9 |
| `14001–14099` | AI & repair agent | 53 |
| `15001–15099` | UI/UX | 71 |

**Total: 408 coded records.**

### Code format for the model

```
NP-<code>  e.g. NP-4010
```

When the AI sees a raw error, it should emit the matching code, then the cause,
then the fix. Example training target:

```
INPUT:  "Port 25565 is already allocated to Survival"
OUTPUT: "NP-4010 — Port collision. Another server row already owns that port.
         Fix: choose a free port, or stop/delete the conflicting server."
```

---

## Appendix E — Complete code registry

`code | record id | http | exit | cause (short)`

### CLI (1001–1007)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 1001 | cli-unknown-command | — | 1 | Command not in the CLI dispatch table |
| 1002 | cli-root-required | — | 1 | systemd unit install needs root |
| 1003 | cli-systemd-missing | — | 1 | `/run/systemd/system` absent |
| 1004 | cli-no-owner-interactive | — | 1 | First-run owner creation needs a TTY |
| 1005 | cli-setup-already-done | — | 1 | A user already exists |
| 1006 | cli-port-invalid | — | 1 | Port outside 1–65535 |
| 1007 | cli-service-not-active | — | 1 | Unit crashed on boot |

### Authentication (2001–2020)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 2001 | auth-invalid-credentials | 401 | — | Email unknown or password mismatch |
| 2002 | auth-throttled | 429 | — | 5 account / 10 IP failures in 15 min |
| 2003 | auth-session-expired | 401 | — | 12 h TTL or 2 h idle exceeded |
| 2004 | auth-user-agent-mismatch | 401 | — | Cookie replayed from another browser |
| 2005 | auth-account-expired | 401 | — | Admin `expires_at` passed |
| 2006 | auth-setup-token-invalid | 403 | — | Wrong/missing setup token |
| 2007 | auth-setup-already-complete | 409 | — | A user already exists |
| 2008 | auth-email-invalid | 400 | — | Missing `@` or length > 254 |
| 2009 | auth-name-invalid | 400 | — | Name outside 2–100 chars |
| 2010 | auth-password-too-short | 400 | — | Password outside 12–256 chars |
| 2011 | auth-password-mismatch | 400 | — | Confirmation differs |
| 2012 | auth-email-taken | 409 | — | UNIQUE constraint on users.email |
| 2013 | auth-otp-invalid | 401 | — | Wrong 6-digit OTP |
| 2014 | auth-otp-expired | 400 | — | 10-minute OTP TTL passed |
| 2015 | auth-otp-too-many-attempts | 429 | — | 5 failed OTP attempts |
| 2016 | auth-otp-rate-limited | 429 | — | Two forgot requests within 60 s |
| 2017 | auth-otp-delivery-failed | 200 | — | SMTP unconfigured/unreachable |
| 2018 | auth-csrf-blocked | 403 | — | Missing `x-nexuspanel-request: 1` |
| 2019 | auth-cross-site-blocked | 403 | — | `Sec-Fetch-Site` is cross-site |
| 2020 | auth-host-maintenance | 503 | — | `host_maintenance_mode=1` |

### Permissions (3001–3019)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 3001 | perm-runtime-protected | 400 | — | Target is the `runtime/` folder |
| 3002 | perm-metadata-protected | 400 | — | Target is `.nexus-server.json` etc. |
| 3003 | perm-symlink-blocked | 400 | — | A path component is a symlink |
| 3004 | perm-root-symlink-blocked | 400 | — | Server root itself is a symlink |
| 3005 | perm-path-escapes-storage | 400 | — | `..` traversal or absolute path |
| 3006 | perm-plugin-name-invalid | 400 | — | Filename contained a separator |
| 3007 | perm-audit-inaccessible | 200 | — | Files unreadable by the panel user |
| 3008 | perm-repair-not-writable | 200 | — | Server root not writable |
| 3009 | perm-repair-chmod-failed | 200 | — | Read-only or noexec filesystem |
| 3010 | perm-repair-chown-failed | 200 | — | Not running as root |
| 3011 | perm-not-authenticated | 401 | — | No valid session |
| 3012 | perm-insufficient-capability | 403 | — | Capability missing from permissions_json |
| 3013 | perm-owner-only | 403 | — | Route hard-gated to role=owner |
| 3014 | perm-server-not-found | 404 | — | Server absent OR not owned |
| 3015 | perm-owner-cannot-be-edited | 403 | — | Non-owner PATCHed the owner |
| 3016 | perm-owner-cannot-be-deleted | 403 | — | DELETE targeted the owner |
| 3017 | perm-assign-all-owner-only | 403 | — | Non-owner used `assignedServerId=all` |
| 3018 | perm-invalid-assigned-user | 400 | — | Non-existent or owner user id |
| 3019 | perm-grant-escalation-blocked | 403 | — | Tried to grant a capability not held |

### Server lifecycle (4001–4030)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 4001 | server-name-required | 400 | — | Name shorter than 2 chars |
| 4002 | server-software-incompatible | 400 | — | Software edition ≠ server type |
| 4003 | server-already-running | 200 | — | Process already live |
| 4004 | server-not-installed | 400 | — | `executable_path` missing |
| 4005 | server-eula-required | 409 | — | EULA not accepted |
| 4006 | server-no-runtime | 400 | — | Nexu template has no runtime |
| 4007 | server-stop-before-delete | 400 | — | Server still online |
| 4008 | server-stop-before-port-change | 409 | — | Server still online |
| 4009 | server-port-invalid | 400 | — | Port outside 1024–65535 |
| 4010 | server-port-collision | 409 | — | Another server owns the port |
| 4011 | server-port-verify-failed | 500 | — | server.properties write not persisted |
| 4012 | server-port-profile-rollback | 400 | — | ASF profile regen failed after DB update |
| 4013 | server-command-empty | 400 | — | Empty console command |
| 4014 | server-not-running | 400 | — | sendCommand on offline server |
| 4015 | server-console-command-empty | 400 | — | Empty command |
| 4016 | server-whitelist-name-required | 400 | — | Player name missing |
| 4017 | server-whitelist-java-format | 400 | — | Invalid Java username |
| 4018 | server-world-convert-same-edition | 400 | — | Target edition = source edition |
| 4019 | server-world-convert-online | 400 | — | Source server still online |
| 4020 | server-converter-missing | 400 | — | Chunker CLI not installed |
| 4021 | server-converter-no-jar | 400 | — | No CLI jar in the release |
| 4022 | server-converter-release-failed | 400 | — | GitHub API rate limit / network |
| 4023 | server-properties-unreadable | 200 | — | Corrupt/permission-denied properties |
| 4024 | server-restart-storm | 200 | — | 3 crashes in 2 minutes |
| 4025 | server-launch-failed | 200 | — | Died before becoming healthy |
| 4026 | server-memory-guard-stop | 200 | — | RSS exceeded the guard limit |
| 4027 | server-allocation-guard | 200 | — | Sustained memory overuse |
| 4028 | server-properties-recovery | 200 | — | Auto-heal rebuilt properties |
| 4029 | server-tombstoned | 200 | — | SQLite reused a deleted id |
| 4030 | server-quota-exceeded | 400 | — | `host_server_quota` reached |

### Minecraft installation (5001–5026)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 5001 | install-version-resolve-failed | 400 | — | Upstream API unreachable / bad version |
| 5002 | install-download-404 | 400 | — | Version removed upstream |
| 5003 | install-download-failed | 400 | — | Upstream HTTP error |
| 5004 | install-download-incomplete | 400 | — | Connection dropped mid-download |
| 5005 | install-jar-invalid | 400 | — | File is not a ZIP/jar |
| 5006 | install-jar-missing | 400 | — | Download path not written |
| 5007 | install-forge-no-args | 400 | — | Forge installer failed silently |
| 5008 | install-forge-installer-failed | 400 | — | Java mismatch / corrupt download |
| 5009 | install-bedrock-no-binary | 400 | — | Unexpected archive layout |
| 5010 | install-bedrock-extract-failed | 400 | — | Corrupt download / missing unzip |
| 5011 | install-pocketmine-invalid-phar | 400 | — | Corrupt or wrong file |
| 5012 | install-pocketmine-php-missing | 400 | — | PHP runtime download/extract failed |
| 5013 | install-pocketmine-php-asset-missing | 400 | — | Upstream release layout changed |
| 5014 | install-nexu-no-commands | 400 | — | Template defines no install commands |
| 5015 | install-nexu-executable-missing | 400 | — | Installer produced no binary |
| 5016 | install-nexu-owner-required | 403 | — | Nexu installers run arbitrary shell |
| 5017 | install-nexu-full-access-required | 409 | — | Owner full access not unlocked |
| 5018 | install-steamcmd-missing | 200 | — | steamcmd not installed |
| 5019 | install-java-required | 400 | — | Java too old for the MC version |
| 5020 | install-java-not-found | 400 | — | Java absent from PATH |
| 5021 | install-bundled-java-broken | 400 | — | Bundled runtime lost exec bit |
| 5022 | install-filesystem-noexec | 400 | — | Server root on a noexec mount |
| 5023 | install-disk-full | 400 | — | ENOSPC during download/extract |
| 5024 | install-permission-denied | 400 | — | EACCES writing the server root |
| 5025 | install-progress-stuck | 200 | — | Install promise rejected silently |
| 5026 | install-status-failed | 200 | — | Any install error |

### Java runtime (6001–6010)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 6001 | java-missing | 400 | — | Java absent from PATH |
| 6002 | java-too-old | 400 | — | Installed major < required major |
| 6003 | java-not-executable | 400 | — | Missing exec bit |
| 6004 | java-not-file | 400 | — | Path points at a directory |
| 6005 | java-runtime-missing | 400 | — | Bundled java binary absent |
| 6006 | java-heap-capped | 200 | — | Normal ~15% JVM reserve |
| 6007 | java-oom-exit | 200 | — | Heap exhausted |
| 6008 | java-exit-on-oom | 200 | — | `-XX:+ExitOnOutOfMemoryError` fired |
| 6009 | java-native-extract-failed | 200 | — | JNA/Netty extraction blocked |
| 6010 | java-version-parse-failed | 200 | — | Unexpected `java -version` format |

### Files & uploads (7001–7040)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 7001 | file-path-required | 400 | — | No relative path supplied |
| 7002 | file-not-found | 404 | — | Path does not exist |
| 7003 | file-download-not-found | 404 | — | Download target missing |
| 7004 | file-preview-not-found | 404 | — | Preview target missing |
| 7005 | file-preview-download-only | 415 | — | Extension not previewable |
| 7006 | file-preview-signature-mismatch | 415 | — | Magic bytes ≠ extension |
| 7007 | file-upload-not-binary | 400 | — | Body not octet-stream |
| 7008 | file-upload-chunk-not-binary | 400 | — | Chunk body not octet-stream |
| 7009 | file-upload-offset-invalid | 400 | — | Negative/non-integer offset |
| 7010 | file-upload-size-invalid | 400 | — | totalSize < chunk length |
| 7011 | file-upload-chunk-exceeds | 400 | — | offset+len > totalSize |
| 7012 | file-upload-too-large | 413 | — | totalSize > MAX_UPLOAD_GB |
| 7013 | file-upload-chunk-hash-mismatch | 409 | — | Chunk SHA-256 mismatch |
| 7014 | file-upload-final-hash-mismatch | 409 | — | Final SHA-256 mismatch |
| 7015 | file-upload-size-mismatch | 409 | — | Partial size ≠ declared |
| 7016 | file-upload-missing-chunks | 409 | — | Chunk ranges incomplete |
| 7017 | file-upload-canceled | 409 | — | Session canceled |
| 7018 | file-upload-session-missing | 404 | — | `.uploading` file absent |
| 7019 | file-upload-session-not-found | 404 | — | No upload session row |
| 7020 | file-upload-path-required | 400 | — | No destination path |
| 7021 | file-upload-progress-path-required | 400 | — | No upload path |
| 7022 | file-mkdir-name-required | 400 | — | No folder name |
| 7023 | file-delete-root-blocked | 400 | — | Tried to delete the root |
| 7024 | file-copy-root-blocked | 400 | — | Tried to copy the root |
| 7025 | file-move-root-blocked | 400 | — | Tried to move the root |
| 7026 | file-archive-root-blocked | 400 | — | Tried to archive the root |
| 7027 | file-extract-not-zip | 400 | — | Selection is not .zip |
| 7028 | file-extract-not-file | 404 | — | Selection is not a file |
| 7029 | file-extract-invalid-zip | 422 | — | Incomplete/invalid ZIP |
| 7030 | file-extract-protected-entry | 403 | — | Archive contains runtime/metadata |
| 7031 | file-extract-zip-slip | 400 | — | Entry escapes the destination |
| 7032 | file-extract-absolute-entry | 400 | — | Entry uses an absolute path |
| 7033 | file-extract-collisions | 409 | — | Would overwrite existing files |
| 7034 | file-archive-protected | 403 | — | Archive target is protected |
| 7035 | file-unzip-missing | 400 | — | `unzip` not installed |
| 7036 | file-tar-missing | 400 | — | `tar` not installed |
| 7037 | file-archive-write-stopped | 400 | — | Disk full / I/O error |
| 7038 | file-archive-transient | 200 | — | ENOENT/ESTALE/EISDIR skipped |
| 7039 | file-edit-timeline | 200 | — | Recovery point created |
| 7040 | file-upload-40mb-limit | 413 | — | Single-shot upload > 40 MB |

### Backups (8001–8020)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 8001 | backup-create-failed | 200 | — | Disk space / permissions |
| 8002 | backup-restore-not-found | 404 | — | Backup missing |
| 8003 | backup-restore-online | 409 | — | Server still online |
| 8004 | backup-invalid-archive | 400 | — | Not a valid ZIP |
| 8005 | backup-public-link-owner-only | 403 | — | Not the server owner |
| 8006 | backup-public-link-invalid | 404 | — | Token invalid/expired/revoked |
| 8007 | backup-public-direct-download | 403 | — | Hotlink prevention |
| 8008 | backup-transfer-header-missing | 403 | — | Missing transfer header |
| 8009 | backup-import-url-invalid | 400 | — | Malformed URL |
| 8010 | backup-import-not-nexuspanel | 400 | — | URL lacks `/api/public/backups/` |
| 8011 | backup-import-private-address | 400 | — | SSRF: resolves to a private IP |
| 8012 | backup-import-http-error | 400 | — | Remote panel error |
| 8013 | backup-import-too-large | 400 | — | content-length > limit |
| 8014 | backup-import-exceeded | 400 | — | Streamed bytes > limit |
| 8015 | backup-import-not-zip | 400 | — | Remote file not a ZIP |
| 8016 | backup-share-code-owner-only | 403 | — | Not the source owner |
| 8017 | backup-share-code-hide-owner-only | 403 | — | Not the source owner |
| 8018 | backup-paused | 200 | — | Crash/launch failure pause |
| 8019 | backup-scheduler-resolution | 200 | — | 30-second scheduler tick |
| 8020 | backup-timezone | 200 | — | Filenames use server timezone |

### Plugins & mods (9001–9016)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 9001 | plugin-extension-unsupported | 400 | — | Unknown extension |
| 9002 | plugin-incompatible | 400 | — | Kind ≠ software |
| 9003 | plugin-modrinth-unsupported | 400 | — | Software not Paper/Purpur/Fabric/Forge |
| 9004 | plugin-modrinth-project-required | 400 | — | No project id |
| 9005 | plugin-modrinth-versions-failed | 400 | — | Modrinth API error |
| 9006 | plugin-modrinth-no-file | 400 | — | No compatible file |
| 9007 | plugin-modrinth-search-failed | 400 | — | Modrinth search error |
| 9008 | plugin-poggit-pocketmine-only | 400 | — | Not a PocketMine server |
| 9009 | plugin-poggit-url-invalid | 400 | — | URL not from poggit.pmmp.io |
| 9010 | plugin-poggit-search-failed | 400 | — | Poggit API error |
| 9011 | plugin-not-found | 404 | — | Plugin row missing |
| 9012 | plugin-no-server-permission | 403 | — | Not the server owner |
| 9013 | plugin-restart-required | 200 | — | Restart to load |
| 9014 | plugin-manager-locked | 200 | — | Missing plugins.manage |
| 9015 | plugin-bedrock-manual | 200 | — | Packs need manual upload |
| 9016 | plugin-select-software | 200 | — | No compatible loader |

### ASF sandbox (10001–10054)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 10001 | asf-landlock-unavailable | — | 77 | Kernel < 5.13 or Landlock disabled |
| 10002 | asf-landlock-abi-too-low | — | 77 | Kernel older than 6.2 (ABI 3) |
| 10003 | asf-ruleset-create-failed | — | 77 | LSM conflict / missing CAP_SYS_ADMIN |
| 10004 | asf-path-open-failed | — | 77 | Required read-only path missing |
| 10005 | asf-net-port-rule-failed | — | 77 | Landlock ABI < 4 |
| 10006 | asf-no-new-privs-failed | — | 77 | prctl blocked |
| 10007 | asf-seccomp-install-failed | — | 77 | Outer sandbox already restricts seccomp |
| 10008 | asf-invalid-port | — | 64 | `--port` outside 1–65535 |
| 10009 | asf-invalid-identity | — | 64 | `--uid/--gid` out of range |
| 10010 | asf-pdeathsig-failed | — | 77 | Parent died between fork and prctl |
| 10011 | asf-invalid-root | — | 66 | `realpath()` failed |
| 10012 | asf-root-not-directory | — | 66 | `server_path` points at a file |
| 10013 | asf-chdir-failed | — | 66 | Missing execute permission |
| 10014 | asf-uid-gid-mismatch | — | 64 | Only one of uid/gid supplied |
| 10015 | asf-setresuid-failed | — | 77 | Identity user deleted |
| 10016 | asf-identity-verify-failed | — | 77 | getresuid mismatch after drop |
| 10017 | asf-root-too-long | — | 66 | Path > 4096 bytes |
| 10018 | asf-private-tmp-failed | — | 66 | Root not writable |
| 10019 | asf-exec-not-found | — | 127 | Payload binary missing |
| 10020 | asf-exec-not-executable | — | 126 | Missing exec bit / noexec mount |
| 10021 | asf-startup-failure-diagnosis | 200 | — | Native ASF startup path failure |
| 10022 | asf-native-unavailable | 200 | — | No compiler / old kernel |
| 10023 | asf-build-failed | 200 | — | Compiler error |
| 10024 | asf-compiler-missing | 200 | — | No `cc`/`gcc`/`clang` |
| 10025 | asf-source-missing | 200 | — | `asf_runtime.c` absent |
| 10026 | asf-self-test-failed | 200 | — | Built binary failed self-test |
| 10027 | asf-stale-binary | 200 | — | Rebuild failed; old binary used |
| 10028 | asf-disabled | 200 | — | `NEXUSPANEL_NATIVE_SANDBOX=0` |
| 10029 | asf-doctor-tier | 200 | — | Informational tier report |
| 10030 | asf-preflight-failed | 200 | — | All systemd tiers failed |
| 10031 | asf-preflight-storage | 200 | — | `data/asf/` not writable |
| 10032 | asf-systemd-unavailable | 200 | — | `systemd-run` missing |
| 10033 | asf-identity-unavailable | 200 | — | Not root / no setfacl |
| 10034 | asf-identity-acl-failed | 200 | — | Filesystem lacks ACL support |
| 10035 | asf-identity-java-exec-failed | 200 | — | Isolated user cannot exec Java |
| 10036 | asf-identity-root-access-failed | 200 | — | Isolated user cannot access root |
| 10037 | asf-identity-runtime-access-failed | 200 | — | Isolated user cannot exec runtime |
| 10038 | asf-identity-marker-missing | 200 | — | Identity marker gone |
| 10039 | asf-identity-marker-mismatch | 200 | — | Marker ≠ current uid |
| 10040 | asf-identity-delete-failed | 200 | — | `userdel` failed |
| 10041 | asf-cgroup-unavailable | 200 | — | cgroup v1 host |
| 10042 | asf-supervisor-failure | 200 | — | systemd reported the failure |
| 10043 | asf-compatibility-retry | 200 | — | Native sandbox died < 5 s |
| 10044 | asf-native-retry-disabled | 200 | — | Retry already ran |
| 10045 | asf-allocation-enforced | 200 | — | Informational |
| 10046 | asf-cgroup-startup-burst | 200 | — | ≤3 cores get a 2× burst |
| 10047 | asf-cgroup-steady | 200 | — | Burst disabled above 3 cores |
| 10048 | asf-throttle-update-failed | 200 | — | `systemctl set-property` failed |
| 10049 | asf-unit-collected | 200 | — | Transient unit exited early |
| 10050 | asf-identity-active | 200 | — | Informational |
| 10051 | asf-identity-unavailable-log | 200 | — | Not root / no acl |
| 10052 | asf-policy-active | 200 | — | Informational |
| 10053 | asf-native-landlock-active | 200 | — | Informational |
| 10054 | asf-runtime-unavailable-log | 200 | — | No compiler / old kernel |

### systemd service (11001–11013)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 11001 | service-install-root | — | 1 | Not root |
| 11002 | service-systemd-required | — | 1 | No systemd |
| 11003 | service-not-active | — | 1 | Unit crashed on boot |
| 11004 | service-restart-failed | — | 1 | Restart did not become active |
| 11005 | service-port-invalid | — | 1 | Port outside 1–65535 |
| 11006 | service-unit-missing | — | 1 | Unit file absent |
| 11007 | service-asf-unit | — | 1 | ASF preflight unit issue |
| 11008 | service-host-agent-unit | — | 1 | Host agent unit issue |
| 11009 | service-env-edition | — | 1 | Edition file missing |
| 11010 | service-backup-root | — | 1 | Backup dir not writable |
| 11011 | service-xaccel-empty | — | 1 | X-Accel env unset |
| 11012 | service-user-root-warning | — | 1 | Service runs as root |
| 11013 | service-journal-empty | — | 1 | Unit never started |

### Network & tunnels (12001–12020)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 12001 | net-download-test-size | 200 | — | Size clamped 1–64 MB |
| 12002 | net-upload-test-body | 400 | — | Body not octet-stream |
| 12003 | net-upload-64mb-limit | 413 | — | Body > 64 MB |
| 12004 | net-ngrok-not-installed | 400 | — | ngrok absent |
| 12005 | net-ngrok-token-missing | 400 | — | Auth token not saved |
| 12006 | net-ngrok-udp-unsupported | 200 | — | Plan lacks UDP |
| 12007 | net-ngrok-bedrock-tcp | 200 | — | Bedrock needs UDP |
| 12008 | net-playit-not-installed | 400 | — | Playit absent |
| 12009 | net-playit-apt-only | 400 | — | Non-apt distro |
| 12010 | net-playit-claim-owner-only | 403 | — | Not the owner |
| 12011 | net-tunnels-removed | 410 | — | Feature removed |
| 12012 | net-host-edition-tunnels | 404 | — | Host edition |
| 12013 | net-ssrf-private | 400 | — | Resolves to a private IP |
| 12014 | net-dns-rebinding | 200 | — | Pinned-IP defense |
| 12015 | net-host-header-injection | 200 | — | Invalid Host rejected |
| 12016 | net-xaccel-config | 200 | — | Nginx snippet |
| 12017 | net-xaccel-path-escape | 200 | — | X-Accel confined to root |
| 12018 | net-range-invalid | 416 | — | Malformed Range header |
| 12019 | net-range-suffix-invalid | 416 | — | Suffix ≤ 0 |
| 12020 | net-range-start-invalid | 416 | — | start/end out of bounds |

### Database (13001–13009)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 13001 | db-integrity-failed | 200 | — | `integrity_check` failed |
| 13002 | db-snapshot-failed | 400 | — | Disk space |
| 13003 | db-locked | 400 | — | SQLITE_BUSY |
| 13004 | db-unique-email | 409 | — | UNIQUE constraint |
| 13005 | db-migration-failed | 400 | — | Migration threw |
| 13006 | db-verify-failed | 400 | — | Verification failed |
| 13007 | db-backup-created | 200 | — | Snapshot created |
| 13008 | db-column-legacy | 200 | — | `nexus_mark_profile` retained |
| 13009 | db-restore-failed | 400 | — | Restore error |

### AI & repair agent (14001–14053)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 14001 | ai-openrouter-no-key | 400 | — | Key not configured |
| 14002 | ai-openrouter-invalid-key | 400 | — | Key format invalid |
| 14003 | ai-openrouter-http-error | 400 | — | Upstream error |
| 14004 | ai-openrouter-no-model | 400 | — | No model selected |
| 14005 | ai-openrouter-owner-only | 403 | — | Not the owner |
| 14006 | ai-openrouter-chat-owner-only | 403 | — | Not the owner |
| 14007 | ai-openrouter-messages-invalid | 400 | — | messages outside 1–40 |
| 14008 | ai-micro-reward-invalid | 400 | — | reward outside [-1,1] |
| 14009 | ai-micro-owner-only | 403 | — | Not the owner |
| 14010 | ai-tool-unknown | 400 | — | Unregistered tool |
| 14011 | ai-tool-full-access-required | 409 | — | Full access locked |
| 14012 | ai-tool-server-required | 400 | — | No serverId |
| 14013 | ai-tool-owner-only | 403 | — | Not the owner |
| 14014 | ai-tool-read-limit | 400 | — | File > 512 KB |
| 14015 | ai-tool-write-limit | 400 | — | Write > 512 KB |
| 14016 | ai-tool-console-empty | 400 | — | Empty command |
| 14017 | ai-tool-diagnostic-not-allowed | 400 | — | Command not allowlisted |
| 14018 | ai-tool-diagnostic-arg-not-allowed | 400 | — | Argument rejected |
| 14019 | ai-tool-diagnostic-args-too-long | 400 | — | > 32 arguments |
| 14020 | ai-tool-diagnostic-path-escape | 400 | — | Path outside the root |
| 14021 | ai-full-access-owner-only | 403 | — | Not the owner |
| 14022 | ai-full-access-password | 401 | — | Wrong owner password |
| 14023 | ai-command-queue-owner-only | 403 | — | Not the owner |
| 14024 | ai-command-approve-owner-only | 403 | — | Not the owner |
| 14025 | ai-command-not-found | 404 | — | Queued command missing |
| 14026 | ai-command-already-run | 409 | — | Already executed |
| 14027 | ai-repair-agent-disabled | 200 | — | Terminal diagnostics off |
| 14028 | ai-repair-web-disabled | 200 | — | Web research off |
| 14029 | ai-repair-web-untrusted | 200 | — | Reference-only |
| 14030 | ai-repair-web-host-blocked | 400 | — | Host not allowlisted |
| 14031 | ai-repair-web-http-error | 400 | — | Source error |
| 14032 | ai-repair-web-private | 400 | — | Private address |
| 14033 | ai-repair-playbook-untrusted | 200 | — | Awaiting validation |
| 14034 | ai-repair-validated | 200 | — | Episode validated |
| 14035 | ai-repair-penalty | 200 | — | Negative reward applied |
| 14036 | ai-repair-no-safe-fix | 200 | — | No concrete fix found |
| 14037 | ai-repair-proactive | 200 | — | Proactive repair done |
| 14038 | ai-repair-learned-replay | 200 | — | Replaying learned repair |
| 14039 | ai-repair-learned-failed | 200 | — | Learned recovery failed |
| 14040 | ai-repair-exit-recovery-failed | 200 | — | Exit recovery error |
| 14041 | ai-repair-crash-unknown | 200 | — | Unknown crash signature |
| 14042 | ai-repair-crash-diagnosed | 200 | — | Crash diagnosed |
| 14043 | ai-repair-model-reset | 200 | — | Model signature changed |
| 14044 | ai-repair-episode-feedback | 400 | — | reward outside [-1,1] |
| 14045 | ai-repair-episode-not-found | 404 | — | Episode missing |
| 14046 | ai-advanced-install-failed | 400 | — | Package/model download failed |
| 14047 | ai-advanced-model-missing | 200 | — | Package not installed |
| 14048 | ai-advanced-disabled | 200 | — | Advanced AI off |
| 14049 | ai-advanced-download-size | 200 | — | Informational |
| 14050 | ai-world-converter-status | 200 | — | Informational |
| 14051 | ai-world-converter-install-failed | 400 | — | Chunker install error |
| 14052 | ai-agent-core-snapshot | 200 | — | Informational |
| 14053 | ai-agent-event-ingest | 200 | — | Informational |

### UI/UX (15001–15071)

| Code | Record | HTTP | Exit | Cause |
|---|---|---|---|---|
| 15001 | ui-session-expired | 401 | — | 401 from any API call |
| 15002 | ui-toast-generic | 200 | — | Transient message |
| 15003 | ui-empty-state-servers | 200 | — | No servers |
| 15004 | ui-empty-state-console | 200 | — | No servers |
| 15005 | ui-empty-state-templates | 200 | — | No templates |
| 15006 | ui-empty-state-software | 200 | — | No software |
| 15007 | ui-empty-state-plugins-locked | 200 | — | Missing plugins.manage |
| 15008 | ui-empty-state-plugins-none | 200 | — | No plugins installed |
| 15009 | ui-empty-state-modrinth | 200 | — | No compatible loader |
| 15010 | ui-empty-state-bedrock-packs | 200 | — | Packs need manual upload |
| 15011 | ui-empty-state-properties | 200 | — | No server |
| 15012 | ui-empty-state-whitelist | 200 | — | No server |
| 15013 | ui-empty-state-whitelist-none | 200 | — | Empty whitelist |
| 15014 | ui-empty-state-files | 200 | — | No server |
| 15015 | ui-empty-state-folder | 200 | — | Empty folder |
| 15016 | ui-empty-state-preview | 200 | — | Format not previewable |
| 15017 | ui-empty-state-backups | 200 | — | No server |
| 15018 | ui-empty-state-backup-requests | 200 | — | No requests |
| 15019 | ui-empty-state-shared-backups | 200 | — | No shared backups |
| 15020 | ui-empty-state-optimizer-error | 200 | — | Optimizer API error |
| 15021 | ui-empty-state-network | 200 | — | `/proc/net/dev` missing |
| 15022 | ui-empty-state-admins | 200 | — | No admins |
| 15023 | ui-empty-state-fixed-loading | 200 | — | Loading |
| 15024 | ui-empty-state-fixed-locked | 200 | — | Missing security.view |
| 15025 | ui-empty-state-commands | 200 | — | No queued commands |
| 15026 | ui-empty-state-fixed-none | 200 | — | No events in 24 h |
| 15027 | ui-empty-state-audit-locked | 200 | — | Missing security.view |
| 15028 | ui-empty-state-security-loading | 200 | — | Loading |
| 15029 | ui-empty-state-health | 200 | — | No check yet |
| 15030 | ui-empty-state-telemetry | 200 | — | No telemetry |
| 15031 | ui-empty-state-logins | 200 | — | No login events |
| 15032 | ui-empty-state-command-search | 200 | — | No match |
| 15033 | ui-terminal-removed | 200 | — | Terminal removed in 6.0.0 |
| 15034 | ui-asf-doctor | 200 | — | Kernel doctor button |
| 15035 | ui-asf-doctor-failed | 200 | — | Doctor error |
| 15036 | ui-layout-import-failed | 200 | — | Bad layout code |
| 15037 | ui-layout-saved | 200 | — | Layout saved |
| 15038 | ui-openrouter-save-no-key | 200 | — | No key entered |
| 15039 | ui-openrouter-saved | 200 | — | Key saved |
| 15040 | ui-openrouter-connected | 200 | — | Connection OK |
| 15041 | ui-openrouter-removed | 200 | — | Key removed |
| 15042 | ui-advanced-ai-installing | 200 | — | Install in progress |
| 15043 | ui-world-converter-installing | 200 | — | Install in progress |
| 15044 | ui-world-convert-confirm | 200 | — | Confirmation prompt |
| 15045 | ui-world-convert-select-source | 200 | — | No source selected |
| 15046 | ui-world-convert-same-edition | 200 | — | Same edition |
| 15047 | ui-full-access-unlock | 200 | — | Password prompt |
| 15048 | ui-full-access-lock | 200 | — | Password prompt |
| 15049 | ui-live-diagnostics-confirm | 200 | — | Confirmation prompt |
| 15050 | ui-queue-command | 200 | — | Command prompt |
| 15051 | ui-approve-command | 200 | — | Confirmation prompt |
| 15052 | ui-approve-command-password | 200 | — | Password prompt |
| 15053 | ui-update-confirm | 200 | — | Confirmation prompt |
| 15054 | ui-host-token-show | 200 | — | Token display |
| 15055 | ui-host-token-regen | 200 | — | Confirmation prompt |
| 15056 | ui-reinstall-confirm | 200 | — | Confirmation prompt |
| 15057 | ui-delete-server-confirm | 200 | — | Confirmation prompt |
| 15058 | ui-restart-confirm | 200 | — | Confirmation prompt |
| 15059 | ui-kill-confirm | 200 | — | Confirmation prompt |
| 15060 | ui-restore-confirm | 200 | — | Confirmation prompt |
| 15061 | ui-upload-paused | 200 | — | Upload paused |
| 15062 | ui-upload-failed | 200 | — | Checksum mismatch |
| 15063 | ui-upload-waiting | 200 | — | Waiting |
| 15064 | ui-upload-active | 200 | — | Uploading |
| 15065 | ui-upload-live | 200 | — | Live progress |
| 15066 | ui-console-closed | 200 | — | Legacy terminal message |
| 15067 | ui-privacy-shield | 200 | — | Privacy toggle |
| 15068 | ui-theme-picker | 200 | — | Theme select |
| 15069 | ui-server-switcher | 200 | — | Quick switch |
| 15070 | ui-presence | 200 | — | Live cursors |
| 15071 | ui-toast-hidden | 200 | — | Toast hidden |

---

## Appendix F — HTTP status → error codes

Use this to answer "what causes a 404?" style questions.

| Status | Meaning | Error codes |
|---|---|---|
| **400** | Bad request / validation | 2008, 2009, 2010, 2011, 2014, 3001, 3002, 3003, 3004, 3005, 3006, 3018, 4001, 4002, 4004, 4006, 4007, 4009, 4012, 4013, 4014, 4015, 4016, 4017, 4018, 4019, 4020, 4021, 4022, 4030, 5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010, 5011, 5012, 5013, 5014, 5015, 5019, 5020, 5021, 5022, 5023, 5024, 6001, 6002, 6003, 6004, 6005, 7001, 7007, 7008, 7009, 7010, 7011, 7020, 7021, 7022, 7023, 7024, 7025, 7026, 7027, 7031, 7032, 7035, 7036, 7037, 8004, 8009, 8010, 8011, 8012, 8013, 8014, 8015, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9010, 12002, 12004, 12005, 12008, 12009, 12013, 13002, 13003, 13005, 13006, 13009, 14001, 14002, 14003, 14004, 14007, 14008, 14010, 14012, 14014, 14015, 14016, 14017, 14018, 14019, 14020, 14030, 14031, 14032, 14044, 14046, 14051 |
| **401** | Unauthenticated | 2001, 2003, 2004, 2005, 2013, 3011, 14022, 15001 |
| **403** | Forbidden | 2006, 2018, 2019, 3012, 3013, 3015, 3016, 3017, 3019, 5016, 7030, 7034, 8005, 8007, 8008, 8016, 8017, 9012, 12010, 14005, 14006, 14009, 14013, 14021, 14023, 14024 |
| **404** | Not found | 3014, 7002, 7003, 7004, 7018, 7019, 7028, 8002, 8006, 9011, 12012, 14025, 14045 |
| **409** | Conflict | 2007, 2012, 4005, 4008, 4010, 5017, 7013, 7014, 7015, 7016, 7017, 7033, 8003, 13004, 14011, 14026 |
| **410** | Gone | 12011 |
| **413** | Payload too large | 7012, 7040, 12003 |
| **415** | Unsupported media | 7005, 7006 |
| **416** | Range not satisfiable | 12018, 12019, 12020 |
| **422** | Unprocessable entity | 7029 |
| **429** | Too many requests | 2002, 2015, 2016 |
| **500** | Internal error | 4011 |
| **503** | Service unavailable | 2020 |

### Quick answers

- **"What causes a 404?"** → 3014 (server not found / not owned), 7002–7004 (file missing), 7018–7019 (upload session missing), 7028 (extract target not a file), 8002 (backup missing), 8006 (public link invalid), 9011 (plugin missing), 12012 (host-edition tunnels), 14025 (queued command missing), 14045 (repair episode missing).
- **"What causes a 403?"** → 2006 (bad setup token), 2018/2019 (CSRF/cross-site), 3012 (missing capability), 3013 (owner-only), 3015–3017 (owner protection), 3019 (grant escalation), 5016 (Nexus installer owner-only), 7030/7034 (protected archive path), 8005/8007/8008/8016/8017 (backup sharing), 9012 (plugin server permission), 12010 (Playit claim), 14005/14006/14009/14013/14021/14023/14024 (AI owner gates).
- **"What causes a 409?"** → 2007 (setup done), 2012 (email taken), 4005 (EULA), 4008 (port change while online), 4010 (port collision), 5017 (full access locked), 7013–7017 (upload integrity), 7033 (extract collisions), 8003 (restore while online), 13004 (unique email), 14011 (full access), 14026 (command already run).
- **"What causes a 429?"** → 2002 (login throttle), 2015 (OTP attempts), 2016 (OTP rate limit).
- **"What causes a 413?"** → 7012 (chunked upload over limit), 7040 (single-shot > 40 MB), 12003 (upload test > 64 MB).

---

## Appendix G — Process exit code → error codes

| Exit | Meaning | Error codes |
|---|---|---|
| **1** | Generic CLI failure | 1001, 1002, 1003, 1004, 1005, 1006, 1007, 11001, 11002, 11003, 11004, 11005, 11006, 11007, 11008, 11009, 11010, 11011, 11012, 11013 |
| **64** | Invalid ASF arguments | 10008, 10009, 10014 |
| **66** | Invalid server root | 10011, 10012, 10013, 10017, 10018 |
| **77** | ASF sandbox setup failed | 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10010, 10015, 10016 |
| **126** | Payload not executable | 10020 |
| **127** | Payload not found | 10019 |
| **200** | ASF setup failure surfaced to panel | 10021 |

---

## Appendix H — Keyword → error codes

Fast fuzzy lookup for the model. Match the keyword in the user's message.

| Keyword / phrase | Codes |
|---|---|
| `port already` / `port in use` / `EADDRINUSE` | 4010, 4009, 4008 |
| `EULA` / `eula.txt` | 4005 |
| `OutOfMemory` / `OOM` / `heap` | 6007, 6008, 4026, 4027 |
| `Java` / `jdk` / `jre` | 6001–6010, 5019, 5020, 5021 |
| `permission denied` / `EACCES` | 5024, 3007, 3008, 3009, 3010 |
| `no space` / `ENOSPC` / `disk full` | 5023, 7037, 13002 |
| `zip` / `unzip` / `extract` | 7027–7036, 5010 |
| `checksum` / `sha256` | 7013, 7014, 7015 |
| `upload` | 7007–7021, 7040, 15061–15065 |
| `backup` | 8001–8020 |
| `symlink` | 3003, 3004 |
| `traversal` / `..` / `escape` | 3005, 7031, 7032 |
| `csrf` / `cross-site` | 2018, 2019 |
| `session` / `expired` / `login` | 2001–2005, 3011, 15001 |
| `otp` / `reset code` | 2013–2017 |
| `throttle` / `too many` | 2002, 2015, 2016 |
| `landlock` | 10001, 10002, 10003, 10004, 10005 |
| `seccomp` | 10007 |
| `cgroup` | 10041, 10046, 10047, 10048 |
| `identity` / `uid` / `gid` | 10009, 10014, 10015, 10016, 10033–10040 |
| `acl` / `setfacl` | 10034 |
| `systemd` / `systemctl` | 10032, 11001–11013 |
| `ngrok` | 12004, 12005, 12006, 12007 |
| `playit` | 12008, 12009, 12010 |
| `ssrf` / `private address` | 12013, 8011, 14032 |
| `modrinth` | 9003–9007 |
| `poggit` | 9008, 9009, 9010 |
| `forge` | 5007, 5008 |
| `bedrock` | 5009, 5010, 9015, 12007 |
| `pocketmine` / `phar` | 5011, 5012, 5013, 9008 |
| `nexu` / `template` | 5014, 5015, 5016, 5017 |
| `openrouter` | 14001–14007 |
| `full access` | 14011, 14021, 14022, 15047, 15048 |
| `repair` / `fix` | 14027–14045 |
| `world convert` / `chunker` | 4018–4022, 14050, 14051 |
| `database` / `sqlite` | 13001–13009 |
| `snapshot` | 13002, 13007 |
| `404` | 3014, 7002, 7003, 7004, 7018, 7019, 7028, 8002, 8006, 9011, 12012, 14025, 14045 |
| `403` | 2006, 2018, 2019, 3012, 3013, 3015, 3016, 3017, 3019, 5016, 7030, 7034, 8005, 8007, 8008, 8016, 8017, 9012, 12010, 14005, 14006, 14009, 14013, 14021, 14023, 14024 |
| `409` | 2007, 2012, 4005, 4008, 4010, 5017, 7013, 7014, 7015, 7016, 7017, 7033, 8003, 13004, 14011, 14026 |
| `429` | 2002, 2015, 2016 |
| `413` | 7012, 7040, 12003 |
| `416` | 12018, 12019, 12020 |
| `500` | 4011 |
| `503` | 2020 |

---

## Appendix I — Updated error count summary

| Category | Records | Code range |
|---|---|---|
| CLI | 7 | 1001–1007 |
| Authentication | 20 | 2001–2020 |
| Permissions | 19 | 3001–3019 |
| Server lifecycle | 30 | 4001–4030 |
| Minecraft installation | 26 | 5001–5026 |
| Java runtime | 10 | 6001–6010 |
| Files & uploads | 40 | 7001–7040 |
| Backups | 20 | 8001–8020 |
| Plugins & mods | 16 | 9001–9016 |
| ASF sandbox | 54 | 10001–10054 |
| systemd service | 13 | 11001–11013 |
| Network & tunnels | 20 | 12001–12020 |
| Database | 9 | 13001–13009 |
| AI & repair agent | 53 | 14001–14053 |
| UI/UX | 71 | 15001–15071 |
| **Total** | **408** | — |

### Training target format with codes

```json
{
  "messages": [
    { "role": "system", "content": "You are the NexusPanel support AI. Reply with the error code, the cause, and the exact fix." },
    { "role": "user", "content": "Port 25565 is already allocated to Survival" },
    { "role": "assistant", "content": "NP-4010 — Port collision. Another server row already owns port 25565.\nFix: choose a free port in 1024-65535, or stop and delete the conflicting server." }
  ],
  "metadata": { "code": 4010, "record_id": "server-port-collision", "category": "server", "http_status": 409 }
}
```

### Reverse-lookup training pairs

```json
{ "messages": [
  { "role": "user", "content": "What causes error 404 in NexusPanel?" },
  { "role": "assistant", "content": "HTTP 404 maps to codes: 3014 (server not found or not owned), 7002-7004 (file/download/preview missing), 7018-7019 (upload session missing), 7028 (extract target not a file), 8002 (backup missing), 8006 (public backup link invalid/expired/revoked), 9011 (plugin missing), 12012 (host-edition tunnels), 14025 (queued command missing), 14045 (repair episode missing)." }
] }
```

```json
{ "messages": [
  { "role": "user", "content": "Error 10005" },
  { "role": "assistant", "content": "NP-10005 — ASF cannot restrict the TCP bind port. Cause: Landlock ABI < 4 (kernel older than 6.7). Fix: the panel automatically retries with the 'core' tier; upgrade the kernel to 6.7+ for full net-port locking." }
] }
```

---

## Appendix J — Linux terminal command reference

The AI must know standard Linux commands to help users fix panel problems.
Each entry: what it does, common panel-related usage, and typical errors.

### File & directory management

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `ls` | List directory contents | `ls -la /var/lib/nexuspanel` | `Permission denied` (not root) |
| `ls -la` | List with hidden files + details | Inspect server folders | — |
| `cd` | Change directory | `cd /opt/nexuspanel` | `No such file or directory` |
| `pwd` | Print working directory | Confirm location | — |
| `mkdir -p` | Create nested directories | `mkdir -p /var/lib/nexuspanel/asf` | `Permission denied` |
| `rm` | Remove files | `rm data/last_update.log` | `No such file or directory` |
| `rm -rf` | Remove directory recursively | **Danger**: `rm -rf servers/` deletes all worlds | `Read-only file system` |
| `rm -f` | Force remove, no prompt | Clean stale temp files | — |
| `cp` | Copy files | `cp panel.db panel.db.bak` | `No space left on device` |
| `cp -r` | Copy directories recursively | Back up a server folder | — |
| `mv` | Move/rename | `mv old.jar server.jar` | cross-device errors (use cp) |
| `touch` | Create empty file / update mtime | `touch data/edition` | — |
| `find` | Search files | `find . -name "server.properties"` | — |
| `find -exec` | Run command per result | `find . -type f -name "*.log" -delete` | quoting mistakes |
| `du -sh` | Directory size human-readable | `du -sh servers/1-survival` | — |
| `df -h` | Disk free human-readable | Check before installs | — |
| `df -i` | Inode usage | Diagnose "no space" with free GB | — |
| `stat` | File metadata | `stat server.jar` | — |
| `file` | Detect file type | `file server.jar` → ZIP | — |
| `readlink -f` | Resolve symlinks | Verify binary paths | — |
| `realpath` | Absolute path | — | — |
| `tree` | Directory as tree | Visualize server layout | not installed by default |

### Permissions & ownership

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `chmod` | Change mode | `chmod 750 /var/lib/nexuspanel` | `Operation not permitted` (not owner) |
| `chmod +x` | Add execute | `chmod +x bedrock_server` | — |
| `chmod 600` | Owner read/write only | `chmod 600 data/cookie_secret` | — |
| `chmod 644` | Owner rw, others read | Config files | — |
| `chmod 750` | Owner rwx, group rx | Panel directories | — |
| `chmod 755` | Owner rwx, others rx | Binaries/scripts | — |
| `chown` | Change owner | `chown -R nexus:nexus servers/` | needs root |
| `chown user:group` | Owner + group | `chown asf-s1:asf-s1 servers/1-x` | `invalid user` |
| `chgrp` | Change group | — | needs root |
| `getfacl` | Read ACLs | Debug ASF identity access | not installed (`apt install acl`) |
| `setfacl -m` | Modify ACLs | Panel does this for asf-s<id> users | filesystem may lack ACL support |
| `umask` | Default permission mask | Panel sets 0077 in ASF | — |
| `sudo` | Run as root | `sudo npm run service:install` | `user is not in sudoers` |
| `sudo -n` | Non-interactive sudo | Panel automation | `sudo: a password is required` |

### Viewing & editing text

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `cat` | Print file | `cat data/edition` | — |
| `head -n 50` | First 50 lines | `head -n 50 logs/server-1.log` | — |
| `tail -n 100` | Last 100 lines | `tail -n 100 data/last_update.log` | — |
| `tail -f` | Follow live output | `tail -f logs/server-1.log` | Ctrl+C to stop |
| `less` | Page through | `less server.properties` | `q` to quit |
| `grep` | Search text | `grep -i "error" server.log` | — |
| `grep -r` | Recursive search | `grep -r "EULA" servers/` | slow on big trees |
| `grep -E` | Regex search | `grep -E "WARN\|ERROR" log` | — |
| `nano` | Simple editor | `nano server.properties` | not installed everywhere |
| `vi` / `vim` | Modal editor | emergency edits | confusing for beginners |
| `echo` | Print text | `echo "normal" > data/edition` | — |
| `echo >>` | Append line | `echo "note" >> notes.txt` | — |
| `wc -l` | Count lines | `wc -l server.log` | — |
| `diff` | Compare files | `diff old.properties new.properties` | — |
| `sed` | Stream edit | `sed -i 's/25565/25566/' server.properties` | `-i` edits in place |
| `awk` | Column processing | `awk '{print $1}' access.log` | — |
| `sort` | Sort lines | `sort ips.txt` | — |
| `uniq` | Deduplicate | `sort x | uniq -c` | needs sorted input |

### Archives

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `unzip` | Extract zip | `unzip backup.zip -d restore/` | `unzip: command not found` → `apt install unzip` |
| `unzip -l` | List zip contents | Verify before extract | — |
| `zip` | Create zip | `zip -r world.zip world/` | not installed by default |
| `tar -czf` | Create tar.gz | `tar -czf snap.tar.gz dir/` | — |
| `tar -xzf` | Extract tar.gz | Extract PHP runtimes | — |
| `tar -tzf` | List tar.gz | Check for traversal entries | — |
| `sha256sum` | File checksum | Verify downloads | — |
| `md5sum` | Legacy checksum | Quick compare | — |

### Process & system

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `ps aux` | List processes | `ps aux \| grep java` | — |
| `top` / `htop` | Live process view | Find CPU hogs | htop not installed |
| `kill` | Send signal | `kill <pid>` (SIGTERM) | `No such process` |
| `kill -9` | Force kill | `kill -9 <pid>` (SIGKILL) | data loss risk |
| `pkill -f` | Kill by name/pattern | `pkill -f playitd` | can kill too much |
| `pgrep` | Find pid by name | `pgrep -f nexuspanel` | — |
| `free -h` | Memory usage | Check before raising RAM | — |
| `uptime` | Load average | `uptime` | — |
| `uname -a` | Kernel info | Verify Landlock support (5.13+) | — |
| `hostname` | System hostname | — | — |
| `whoami` | Current user | Confirm not root | — |
| `id` | User/group ids | `id asf-s1` | `no such user` |
| `env` | Environment vars | Check NEXUSPANEL_* | — |
| `date` | System time | Debug backup timestamps | — |
| `lscpu` | CPU details | Core count for allocation | — |
| `vmstat` | Virtual memory stats | Diagnose swapping | — |
| `iostat` | Disk I/O stats | Diagnose world lag | sysstat not installed |
| `dmesg` | Kernel messages | `dmesg --level=err` for OOM kills | needs root on some hosts |

### systemd service management

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `systemctl status` | Service state | `systemctl status nexuspanel` | `Unit not found` |
| `systemctl start` | Start service | `sudo systemctl start nexuspanel` | needs root |
| `systemctl stop` | Stop service | `sudo systemctl stop nexuspanel` | — |
| `systemctl restart` | Restart service | `sudo systemctl restart nexuspanel` | — |
| `systemctl enable` | Boot autostart | `sudo systemctl enable nexuspanel` | — |
| `systemctl disable` | Remove autostart | — | — |
| `systemctl is-active` | Check running | `systemctl is-active nexuspanel` | exit 3 = inactive |
| `systemctl daemon-reload` | Reload unit files | After editing .service | — |
| `systemctl list-units` | List units | `systemctl list-units 'asf-*'` | — |
| `systemctl set-property` | Adjust cgroup limits | Panel uses for CPUQuota | transient units only |
| `systemd-run` | Run transient unit | Panel launches servers this way | needs systemd host |
| `journalctl -u` | Service logs | `journalctl -u nexuspanel -n 100` | — |
| `journalctl -f` | Follow logs | `journalctl -u nexuspanel -f` | Ctrl+C to stop |
| `journalctl --disk-usage` | Journal size | Free disk from logs | — |

### Networking

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `ip a` | Interface addresses | Find the VPS IP | — |
| `ip route` | Routing table | Debug connectivity | — |
| `ss -lntu` | Listening ports | `ss -lntu \| grep 25565` | — |
| `netstat -tulpn` | Legacy port list | Same as ss | net-tools not installed |
| `ping` | ICMP reachability | `ping 1.1.1.1` | blocked by some hosts |
| `curl` | HTTP client | `curl -I https://api.papermc.io` | — |
| `curl -o` | Download file | `curl -o server.jar <url>` | — |
| `wget` | Download | `wget <url>` | not installed everywhere |
| `dig` | DNS lookup | `dig example.com A` | dnsutils not installed |
| `nslookup` | Legacy DNS | — | — |
| `traceroute` | Route path | Debug player lag | not installed |
| `ufw allow` | Firewall rule | `ufw allow 25565/tcp` | ufw inactive |
| `iptables -L` | List rules | Debug blocked ports | needs root |
| `nft list ruleset` | nftables rules | Modern firewall check | needs root |

### Package management (Ubuntu/Debian)

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `apt update` | Refresh package index | Before installs | needs root |
| `apt install -y` | Install package | `apt install -y unzip openjdk-21-jre-headless` | `Unable to locate package` |
| `apt remove` | Remove package | — | — |
| `apt list --installed` | List packages | Verify java version | — |
| `dpkg -l` | Installed packages | `dpkg -l \| grep jdk` | — |
| `npm install` | Node deps | After panel update | network/registry errors |
| `npm run <script>` | Run package script | `npm run build:asf` | script missing |
| `npm test` | Run test suite | Validate the panel | test failures |

### Users & identity (ASF)

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `useradd --system` | Create system user | Panel creates `asf-s<id>` | `name already in use` |
| `userdel` | Delete user | Panel cleans identities | `user is currently used` |
| `passwd -l` | Lock password | Panel locks identity users | — |
| `getent passwd` | Query user db | `getent passwd asf-s1` | no output = missing |
| `adduser` | Debian user tool | Fallback for useradd | — |

### Java-specific

| Command | Purpose | Panel usage | Common errors |
|---|---|---|---|
| `java -version` | Java version | Verify 21+ for MC 1.21 | `command not found` |
| `java -jar` | Run jar | How servers launch | `Unable to access jarfile` |
| `update-alternatives --config java` | Pick default Java | Switch JDK versions | — |
| `jps` | List JVM processes | Find running servers | JDK only, not JRE |

### Common error messages the AI must recognize

| Terminal error | Meaning | Panel fix |
|---|---|---|
| `command not found` | Binary not installed or PATH broken | Install the package; check PATH |
| `Permission denied` | Missing rights | Use sudo, or fix ownership |
| `No such file or directory` | Path wrong | Verify with `ls`/`pwd` |
| `Read-only file system` | Disk mounted ro | `mount -o remount,rw` |
| `No space left on device` | Disk full | `df -h`, clean logs/backups |
| `Text file busy` | Binary in use | Stop the process first |
| `Operation not permitted` | Capability missing | Run as root |
| `Connection refused` | Nothing listening | Start the service |
| `Name or service not known` | DNS failure | Check resolv.conf |
| `EADDRINUSE` | Port taken | `ss -lntu`, free the port |
| `Killed` | OOM killer | Raise RAM or lower -Xmx |
| `Segmentation fault` | Crash | Check dmesg, reinstall binary |

---

## Appendix K — NexusPanel terminal command reference

The `nexuspanel` CLI (installed at `/usr/local/bin/nexuspanel`).

### Core commands

| Command | What it does | Example | Needs root |
|---|---|---|---|
| `nexuspanel version` | Print panel version | `nexuspanel version` → `NexusPanel 1.0.0` | no |
| `nexuspanel help` | List all commands | `nexuspanel help` | no |
| `nexuspanel doctor` | Full diagnostic (platform, ASF, agent, service) | `nexuspanel doctor` | no |
| `nexuspanel platform` | Capability matrix | `nexuspanel platform` | no |
| `nexuspanel status` | Service status JSON | `nexuspanel status` | no |

### Service lifecycle

| Command | What it does | Needs root |
|---|---|---|
| `nexuspanel start` | Start the panel service | yes |
| `nexuspanel stop` | Stop the panel service | yes |
| `nexuspanel restart` | Restart the panel service | yes |
| `nexuspanel install` | Install + start systemd service | yes |
| `nexuspanel service install` | Install without starting | yes |
| `nexuspanel logs` | Follow panel journal | no |
| `nexuspanel change panelport <n>` | Change panel HTTP port | yes |
| `nexuspanel update` | Run the safe updater | yes |
| `nexuspanel foreground` | Run in foreground (debug) | no |

### ASF isolation

| Command | What it does | Needs root |
|---|---|---|
| `nexuspanel asf status` | Kernel isolation status (tier, ABI, cgroup) | no |
| `nexuspanel asf rebuild` | Rebuild the ASF native binary | no |
| `nexuspanel asf start` | Start the ASF preflight unit | yes |
| `nexuspanel asf stop` | Stop the ASF preflight unit | yes |
| `nexuspanel asf restart` | Restart the ASF preflight unit | yes |
| `nexuspanel asf logs` | ASF preflight journal | no |

### Host agent

| Command | What it does | Needs root |
|---|---|---|
| `nexuspanel agent status` | Agent local + live status | no |
| `nexuspanel agent start` | Start the host agent unit | yes |
| `nexuspanel agent stop` | Stop the host agent unit | yes |
| `nexuspanel agent restart` | Restart the host agent unit | yes |
| `nexuspanel agent logs` | Host agent journal | no |

### Users & setup

| Command | What it does | Needs root |
|---|---|---|
| `nexuspanel setup-owner` | Create the first owner interactively | no |
| `nexuspanel setup-url` | Print the first-run setup URL | no |
| `nexuspanel users` | List users + sessions | no |
| `nexuspanel reset-password` | Reset a password (scripts/) | no |
| `nexuspanel debug-users` | Debug user DB (scripts/) | no |

### Intelligence & permissions

| Command | What it does | Needs root |
|---|---|---|
| `nexuspanel intelligence [scope]` | Learned intelligence snapshot | no |
| `nexuspanel permissions audit` | Audit ownership/modes | no |
| `nexuspanel permissions repair` | Repair validated defects | yes |

### npm scripts (run in the panel directory)

| Script | What it does |
|---|---|
| `npm start` | Start via launcher |
| `npm run foreground` | Run backend directly |
| `npm run dev` | Watch mode |
| `npm test` | Full test suite |
| `npm run test:exploit` | Adversarial security suite |
| `npm run build:asf` | Build the ASF binary |
| `npm run build:host-agent` | Build the host agent |
| `npm run audit:asf` | Root adversarial sandbox audit |
| `npm run benchmark:asf` | ASF launch overhead benchmark |
| `npm run service:install` | Install systemd units |
| `npm run service:uninstall` | Remove systemd units |
| `npm run service:status` | Service status |
| `npm run update` | Run update/update.sh |

### Environment variables (terminal)

| Variable | Default | Set where |
|---|---|---|
| `NEXUSPANEL_OWNER_EMAIL` | — | First-run owner email |
| `NEXUSPANEL_OWNER_PASSWORD` | — | First-run owner password |
| `NEXUSPANEL_OWNER_NAME` | Owner | First-run owner name |
| `NEXUSPANEL_EDITION` | normal | `normal` or `host` |
| `PORT` | 3000 | Panel HTTP port |
| `NEXUSPANEL_DATA_ROOT` | /var/lib/nexuspanel | External data |
| `NEXUSPANEL_NATIVE_SANDBOX` | 1 | `0` disables ASF |
| `NEXUSPANEL_PER_SERVER_USERS` | 1 | `0` disables identities |
| `NEXUSPANEL_MAX_UPLOAD_GB` | 50 | Upload cap |
| `NEXUSPANEL_MAX_REMOTE_BACKUP_GB` | 20 | Import cap |
| `NEXUSPANEL_NGROK_API` | http://127.0.0.1:4040 | ngrok status URL |

### Common terminal workflows

```bash
# First install on a fresh VPS
sudo nexuspanel install
sudo nexuspanel setup-url     # open the printed URL

# Diagnose a server that will not start
nexuspanel doctor
nexuspanel asf status
sudo journalctl -u nexuspanel -n 100 --no-pager

# Rebuild the sandbox after a kernel upgrade
nexuspanel asf rebuild
sudo nexuspanel asf restart

# Fix permissions on all server folders
sudo nexuspanel permissions repair

# Update the panel safely
sudo nexuspanel update
sudo nexuspanel restart
```

### Terminal error records (codes 16001+)

| Code | Command | Error | Cause | Fix |
|---|---|---|---|---|
| 16001 | any | `command not found` | Binary missing or PATH broken | Install the package |
| 16002 | any | `Permission denied` | Insufficient rights | Use sudo / fix ownership |
| 16003 | any | `No such file or directory` | Wrong path | Verify with ls/pwd |
| 16004 | any | `Read-only file system` | Disk mounted ro | `mount -o remount,rw` |
| 16005 | any | `No space left on device` | Disk full | `df -h`, clean up |
| 16006 | any | `Text file busy` | Binary in use | Stop the process first |
| 16007 | any | `Operation not permitted` | Capability missing | Run as root |
| 16008 | any | `Connection refused` | Nothing listening | Start the service |
| 16009 | any | `EADDRINUSE` | Port taken | Free the port |
| 16010 | any | `Killed` | OOM killer | Raise RAM |
| 16011 | any | `Segmentation fault` | Crash | Check dmesg, reinstall |
| 16012 | `unzip` | `command not found` | unzip not installed | `apt install -y unzip` |
| 16013 | `java` | `command not found` | Java not installed | `apt install -y openjdk-21-jre-headless` |
| 16014 | `cc`/`gcc` | `command not found` | No compiler | `apt install -y build-essential` |
| 16015 | `setfacl` | `command not found` | acl not installed | `apt install -y acl` |
| 16016 | `systemctl` | `Unit not found` | Service not installed | `nexuspanel install` |
| 16017 | `journalctl` | `No journal files` | Logging not persistent | `apt install -y systemd-journald` |
| 16018 | `npm` | `Missing script` | package.json outdated | `npm install` then retry |
| 16019 | `git` | `not a git repository` | Source installed without git | Reinstall via git clone |
| 16020 | `sudo` | `user is not in sudoers` | No sudo rights | Use root account |
