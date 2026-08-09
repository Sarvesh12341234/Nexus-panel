# NexusPanel 5.2.0 — Runtime Execution Hardening

## Fixed in this build

- Bundled Java launchers receive a targeted executable-bit repair.
- Nexus-Mark ACL setup explicitly grants execute access to the native launcher and bundled Java runtime.
- Java execution preflight runs before Paper startup.
- `findmnt` detects a `noexec` filesystem before launch when available.
- Added a dedicated `java-exec-permission` diagnostic for systemd `203/EXEC`.
- False JVM-memory diagnoses are suppressed when the authoritative failure is a pre-JVM `203/EXEC` permission failure.
- Installer authenticates through sudo/PAM and never reads or stores the administrator password.
- Installer repairs only required executable files; it never uses recursive `chmod 777`.

## Privilege model

NexusPanel's host-management service/agent can run with root privileges because it performs controlled host administration. Individual Minecraft servers should **not** run as root. Nexus-Mark creates locked, unprivileged per-server system accounts (`nexusmark-s<ID>`) and uses ACLs/cgroups/systemd isolation around them. Giving a game account root would defeat the isolation boundary.

## Expected result

For the failure shown in the supplied logs:

`status=203/EXEC` + `Permission denied`

the launcher now repairs/verifies the Java executable before invoking systemd/Nexus-Mark, verifies the server identity's access, and checks for `noexec`. If the host still blocks execution, NexusPanel reports that exact layer instead of blaming Java memory, rebuilding unrelated Minecraft JSON files, or entering an endless restart loop.
