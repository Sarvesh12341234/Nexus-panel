# AI training corpus audit

Reviewed against the current NexusPanel 1.0.3 checkout on 2026-10-19.

## Findings

- `AI-TRAINING-CORPUS.md` calls itself a complete, current inventory, but it is
  labeled NexusPanel 6.0.0 and was generated on 2026-10-12. The repository
  package is 1.0.3.
- The corpus contains 407 `id` record entries, while its summary says 362. Of
  those, 282 contain enough symptom/error text to seed the current classifier.
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

The prepared set has 645 examples: two issue-ID classification prompts for
each of 282 evidence-bearing records, plus 81 off-topic examples. Runtime
results are checked against the generated ID registry and shown as unverified
advice only. They never trigger a repair, command, file write, server restart,
or API mutation. Current deterministic diagnostics and their existing bounded
repair path remain authoritative.

Before treating the corpus as a production troubleshooting source, update it
from live backend routes and error-producing code, reconcile its counts, then
add regression examples tied to reproductions and current source revisions.
