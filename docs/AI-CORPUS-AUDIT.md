# AI training corpus audit

Reviewed against the current NexusPanel 1.0.3 checkout on 2026-10-19.

## Findings

- `AI-TRAINING-CORPUS.md` calls itself a complete, current inventory, but it is
  labeled NexusPanel 6.0.0 and was generated on 2026-10-12. The repository
  package is 1.0.3.
- The corpus now contains 452 unique `id` records; 364 have enough
  symptom/error text to seed the current classifier. The historical summary
  remains stale and should not be treated as a live count.
- Its file-layout appendix names AI modules that are absent from `backend/`,
  and its AI route table lists routes that the current code explicitly says
  were removed in 1.0.0.
- It has broad categories (auth, permissions, lifecycle, archives, plugins,
  isolation, network, database, AI, and UI), but it does not prove exhaustive
  error coverage. It has no required link from each entry to a current source
  location, reproduction, regression case, or last-verified revision.
- Many records have only a short generic fix, and third-party plugin/runtime
  failures are open-ended. A static catalogue cannot cover every plugin's
  messages or every host/kernel configuration.

## How this model uses it

The current prepared set has 1,356 examples, including 170 off-topic examples
and 42 targets for registered repair-tool requests across eight bounded tools.
Recent records cover panel API/live UI, console duplication and reconnect, database, session, upload,
plugin inventory, service restart, permissions, Bedrock Dedicated Server and
PocketMine failures, and locks. The tool allowlist covers only existing bounded
repair routines. A request must match exact supplied evidence and a current
deterministic diagnostic (or a verified missing executable); it must also pass
server-state checks in the backend. Recursive permission rewriting is not
exposed because it needs narrower per-server ACL handling. Needle cannot issue
shell commands, choose arbitrary paths, delete worlds/locks, kill processes,
or restart a server.
Current deterministic diagnostics and their bounded repair path remain the
fallback and source of truth.

Before treating the corpus as a production troubleshooting source, update it
from live backend routes and error-producing code, reconcile its counts, then
add regression examples tied to reproductions and current source revisions.
