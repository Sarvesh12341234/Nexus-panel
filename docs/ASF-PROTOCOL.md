# ASF — Advanced Sandbox Fabric

**NexusPanel's own kernel-level isolation protocol. Linux-only. No Docker. No Windows.**

ASF is the successor to NexusMark. It keeps everything that made NexusMark strong
(Landlock LSM, seccomp BPF, cgroup v2, per-server identities) and adds the layers
that made Docker attractive — without a daemon, without images, without overlayfs.

## Design goals

| Goal | How ASF achieves it |
|---|---|
| Surpass Docker security | Landlock ABI ≥ 4 net-port rules + seccomp + namespaces + cgroup v2 + per-server UID — all enforced by the kernel, not a daemon |
| Surpass Docker speed | Zero image pulls, zero overlayfs, zero daemon round-trips. Launch = `fork/exec` with kernel rules already applied. Cold start < 50 ms |
| Surpass Docker resource usage | No dockerd (~80 MB RSS), no containerd, no overlayfs metadata. ASF runtime is a ~40 KB static-PIE binary that execs away |
| All MC versions work | Direct jar execution — the host Java runs the jar directly. No image-per-version matrix |
| Download system works | Direct filesystem access to `software/` cache — no volume mounts, no image layers |

## Protocol layers (applied in order, all fail-closed)

```
┌─────────────────────────────────────────────────────────────┐
│ L0  Preflight      kernel probe: landlock abi, cgroup v2,   │
│                    systemd version, seccomp actions         │
│ L1  Identity       per-server locked system user            │
│                    (nexusmark-s<id>, nologin, ACL-scoped)   │
│ L2  Namespaces     unshare: mount, pid, ipc, uts, cgroup    │
│                    (user-ns optional, net-ns optional)      │
│ L3  Landlock       filesystem: write/execute scoped to      │
│                    server root + runtime paths only         │
│                    network (ABI 4+): bind tcp/udp ONLY on   │
│                    the server's assigned game port          │
│ L4  Seccomp BPF    deny @mount @swap @reboot @raw-io        │
│                    @privileged; no_new_privs; SCMP_ACT_ERRNO│
│ L5  Cgroup v2      MemoryMax, MemoryHigh, MemorySwapMax,    │
│                    CPUQuota (startup burst → steady),       │
│                    TasksMax, IOWeight                       │
│ L6  Supervisor     asf_runtime execs the payload, forwards  │
│                    signals, enforces exit-code contract     │
└─────────────────────────────────────────────────────────────┘
```

## Exit-code contract (supervisor ↔ panel)

| Code | Meaning | Panel action |
|---|---|---|
| 0 | clean exit | normal |
| 1 | payload exited non-zero | passthrough |
| 126 | payload not executable | surface to user |
| 127 | payload not found | surface to user |
| 200 | ASF setup failed (landlock/seccomp/identity) | log `asf.detail`, retry compatibility tier once |
| 201 | namespace setup failed | retry without net-ns |
| 202 | cgroup attach failed | retry without cgroup |

## CLI surface

```
asf_runtime --root <dir> --port <n> [--uid <u> --gid <g>] [--tier maximum|compatible|core]
            [--no-netns] [--no-cgroup] -- <payload> [args...]
asf_runtime --probe          # prints asf-abi=<n> landlock-abi=<n> seccomp=ok cgroup-v2=ok|no
```

## JS orchestration surface (`backend/asf.js`)

Same interface NexusMark exposed, so `runtime.js` and `index.js` keep their shape:

- `profileForServer(server, nexu)` → ASF profile (engine: `asf`)
- `wrapCommand(command, args, profile, options)` → `{ command, args, unit, engine, policyTier, identity }`
- `spawnOptions(baseOptions, profile)` → scrubbed env + ASF env vars
- `writeProfile(server, root, nexu)` → persists `data/asf/<id>/profile.json`
- `kernelStatus({ refresh })` → tiered preflight (maximum / compatible / core)
- `nativeStatus()` → builds/probes `asf_runtime` binary

## What replaced what

| NexusMark | ASF |
|---|---|
| `nexusmark.c` | `asf_runtime.c` (adds net-port landlock, tiered fallback, exit contract) |
| `nexus_mark.js` | `asf.js` |
| `nexus_mark_native.js` | `asf_native.js` |
| `nexus_mark_identity.js` | `asf_identity.js` (same locked-user + ACL model) |
| `nexusmark-<id>.service` transient units | same mechanism, renamed `asf-<id>.service` |
| `data/nexus-mark/` | `data/asf/` |
| `NEXUS_MARK_*` env | `ASF_*` env |

## Why this beats Docker for NexusPanel's use case

1. **No image matrix.** Docker needs `eclipse-temurin:17`, `:21`, `:8`… per MC version.
   ASF runs the host's (or bundled) Java directly — every MC version, day one.
2. **No daemon.** Docker's attack surface is a root daemon with a socket. ASF's
   attack surface is kernel-enforced rules on a single process tree.
3. **Faster cold start.** `docker run` = daemon IPC + overlayfs mount + netns setup
   (~0.5–2 s). ASF = preflight-cached rules + exec (< 50 ms).
4. **Less memory.** dockerd + containerd idle ≈ 100–150 MB. ASF ≈ 0 (binary execs away).
5. **Same kernel primitives.** Docker's isolation IS namespaces + cgroups + seccomp.
   ASF uses the same primitives directly, plus Landlock (which Docker does not use).
