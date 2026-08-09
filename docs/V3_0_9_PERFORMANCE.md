# NexusPanel 3.0.9 Performance & Agent Architecture

## Changes
- Added bounded route-performance telemetry with request IDs.
- Added `/api/performance` for owner/admin diagnostics.
- Added dynamic AI tool search instead of forcing the full registry into every prompt.
- Expanded typed tools for terminal sessions, performance, timelines, fixed logs and Nexus-Mark diagnostics.
- Preserved the policy that arbitrary shell and untyped mutating routes cannot be invoked automatically.
- Added frontend GET request coalescing and opt-in short-lived caching support.
- Mutation responses invalidate related cached reads.
- Reduced fallback console/status polling when SSE is unavailable; SSE remains the preferred live path.
- Removed the developer-tools redirect that interfered with browser debugging and support.

## Design inspiration
The architecture takes general design lessons from public game-server panels and AI-agent projects: a separated daemon/control-plane model, real-time event streams, typed tool registries, persistent memory, dynamic retrieval, and evidence/approval gates. It does not copy source code from those projects.
