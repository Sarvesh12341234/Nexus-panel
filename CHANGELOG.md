# Changelog

## 1.2.0 - 2026-06-29

### Fixed

- Prevented live polling from rebuilding Settings while timezone controls are in use.
- Added per-account timezones with explicit India aliases.
- Moved password recovery to `/reset.html` and added Resend-compatible delivery.
- Restored auto-start, crash-aware auto-restart, and wake-listener recovery.
- Corrected CPU core accounting and added Linux systemd cgroup enforcement.
- Fixed the Servers page Open action and embedded-login reset link.
- Removed backup controls from general Settings; they remain per server.
- Removed the Linux updater BOM and forced safe release-tag refreshes.
- Added milestone-based updater percentages.
- Fixed the versioned Linux installer's Node path and release checkout.

### Added

- Expiring, revocable public backup archive links for cross-panel transfer.
- Secure remote backup import with ZIP, size, redirect, and private-network checks.
- Repair & Diagnose checks for runtimes, stale transfers, worlds, disk, and profiles.
- Beta navigation ordering, compact density, reduced motion, live polling, undo, and redo.
- Dedicated password reset request throttling and session invalidation.

### Notes

- Existing `servers/`, `data/`, `software/`, and external backup files remain protected by the updater.
- Linux cgroup enforcement requires systemd and can be disabled with `NEXUSPANEL_CGROUPS=0`.
- Set `NEXUSPANEL_PUBLIC_URL` when the panel is behind a reverse proxy or its detected host is not publicly reachable.
