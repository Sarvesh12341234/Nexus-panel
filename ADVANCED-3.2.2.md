# NexusPanel 3.2.2 Advanced Operations

Lightweight additions:
- bounded health scoring
- bounded incident timeline
- dependency/correlation graph primitives
- staged change plans with snapshot/verify/rollback metadata
- MicroLM vs remote-model routing hints

These primitives are dependency-free and do not start background model processes.

## 3.2.2 continuation
- Fixed a startup-order bug where NexusAgentCore referenced RepairAgent before initialization.
- Added request correlation IDs.
- Added lightweight health scoring, incident timeline, dependency graph, and staged change-plan APIs.
- Added live security/operations summary to the security view.
- Added regression tests for the advanced operations core.
