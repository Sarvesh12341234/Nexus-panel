# NexusPanel 5.2.3 — Nexus-Mark execution reliability

This release hardens Linux server startup around per-server identities.

- Grants only traversal (`--x`) on every parent directory needed by the server UID.
- Verifies the actual Java executable as the exact service identity before launch.
- Handles symlinked/resolved Java and native binaries.
- Keeps the Minecraft process unprivileged; root is used only for controlled setup.
- Classifies Java execution failures separately from JVM out-of-memory failures.

The design follows the control-plane/runtime separation used by game-server panels such as Pterodactyl Wings and container runtimes such as runc, without copying their implementation or introducing a Docker dependency.

## 5.2.3 permission/runtime fix

- Java runtime executables receive an explicit per-server `r-x` ACL even when a downloaded archive loses POSIX execute bits.
- Java runtime helper binaries under the bundled JDK are repaired selectively; ordinary server data is never made executable.
- The exact per-server UID is re-tested with `runuser java -version` before cached identity reuse.
- The installer performs a root/ACL preflight and installs `sudo` through the host package manager when available.
- Installation parents use traversal-only permissions (`0711`) instead of world-readable/world-writable permissions.
- Root privileges are used for controlled setup; Minecraft processes remain unprivileged per-server identities.
