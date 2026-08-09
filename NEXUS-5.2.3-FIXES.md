# NexusPanel 5.2.3 hardened permission fixes

This patch targets the observed Linux `203/EXEC Permission denied` startup failure.

## Main fix

The previous identity ACL assigned `u:<server>:rw-` recursively. If a bundled Java archive had lost its executable bit, the later owner-only `chmod u+x` did not grant execute permission to the named ACL user. The server UID could therefore read Java but could not execute it.

The new identity setup:
- discovers bundled JDK launchers/helpers under each server's `runtime/` tree;
- restores execute permission only for those runtime executables;
- grants the server UID `r-x` ACL on those executables;
- re-checks `java -version` as the exact server UID;
- re-validates Java execution when a cached identity is reused.

The installer also performs a privileged ACL traversal preflight.

Security model remains: root is used for installation/host control only; Minecraft runs as its locked per-server system account. No recursive `chmod 777` is introduced.
