# Changelog

## 1.2.0 Reliability Revision - 2026-06-29

### Fixed

- Saved precision positions switch live between desktop and mobile breakpoints during resize or orientation changes.
- Layout reordering preserves untouched form-control slots, so moving boxes cannot pull submit buttons or inputs into unintended positions.
- Alpha UI editing now stays responsive on desktop and mobile without page overflow.
- Hidden switch inputs no longer expand the Settings page beyond the viewport.
- Runtime now falls back to the verified server directory when a stored path is missing.
- Software version selection no longer gets rebuilt by ordinary status polling.
- Action groups wrap inside their containers on phone, tablet, and desktop layouts.
- Nexus-Mark now uses a transient systemd service because `--scope` is incompatible with `--pipe`.
- CPU startup burst applies only to 1-3 core allocations; allocations of 4+ cores start at their steady limit.
- Launch failures skip crash backups and restart storms stop after three failures in two minutes.
- Public backup URLs reject direct browser downloads and only stream to NexusPanel's importer.
- Backup filenames use each server owner's IANA timezone and include a UTC offset.
- Automatic backup checks run every 30 seconds and expose the calculated next run.
- Eligible Normal Edition admins can create public backup links.
- Legacy upload ranges no longer cause `ranges.map is not a function`.
- Parallel chunks cannot overwrite shared cross-client progress.
- `UTC`, `Asia/Kolkata`, and `Asia/Calcutta` are always selectable.
- Linux CLI start/restart verifies the service became active.
- CPU topology is cached instead of queried on every overview poll.

### Added

- Bounded Free placement with exact X/Y inputs, 1px keyboard nudging, Shift+Arrow 10px movement, 1-16px mouse snapping, layer controls, and per-breakpoint coordinates.
- A Flow/Free switch keeps responsive order editing available alongside cursor-precise placement.
- Advanced Boxes mode for moving and resizing complete cards, forms, status blocks, field groups, and tool panels independently from Buttons mode.
- Nested drop-zone matching lets large parent panels move correctly even when the pointer is over one of their child cards.
- Free drag placement for panel command buttons and navigation, per-button widths, a floating editor toolbar, and permanent UI layout codes.
- A repair playbook learner that fingerprints redacted crash output, learns from successful Repair & Diagnose runs, and repeats only the panel's safe repair routine.
- Accessible show/hide password controls across login, reset, and owner-password fields.
- Three additional panel utilities are included for discovery.
- Alpha Studio now includes 20 button shapes, 10 additional sizing/detail controls, and portable non-expiring layout codes.
- Start, stop, restart, and kill commands have responsive command animations.
- Password reset email relays receive a styled NexusPanel HTML message as well as plain text.
- Adaptive baseline monitoring and safe automatic maintenance.
- Alpha UI Studio with 20 controls, drafts, save/cancel, undo/redo, and command ordering.
- Forge Geometry theme with a distinct button silhouette.
- Configurable public panel URL for reverse-proxied backup links.
- Host maintenance mode and per-account server quotas.

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
