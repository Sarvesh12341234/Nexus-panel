# NexusPanel 5.0

Major architecture milestone.

## Core
- bounded autonomous repair loop
- event-driven orchestration
- verification-first completion
- change ledger
- protected-data boundary
- daily routine-log retention
- quiet UI activity indicators

## Log policy
Routine operational activity is eligible for cleanup after 24 hours.
Important records (security, backups, rollbacks, learned/neural state, world/database changes, critical events, policy and authentication events) are retained.

The cleanup policy must be run by the existing scheduler/maintenance process; this module does not create an always-running timer.
