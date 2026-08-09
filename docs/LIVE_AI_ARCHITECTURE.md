# NexusPanel Live AI v3.0.7

The Live AI is an evidence-bound infrastructure assistant. It continuously learns from **verified** outcomes and owner feedback; it does not rewrite its own executable code or grant itself unrestricted shell access.

## Layers

1. **Telemetry** — host/server metrics, console events, files, runtime and Nexus-Mark evidence.
2. **Deterministic forensics** — signatures, precondition checks and weighted cause graph.
3. **Typed API registry** — panel APIs are exposed as named tools with method, endpoint, risk and description.
4. **Learned ranking** — verified outcomes adjust category/tool confidence without changing executable code.
5. **Optional local model** — used only when installed/enabled; model output is advisory.
6. **Repair gate** — mutations require the existing authorization/owner gates.
7. **Post-repair verification** — a repair is not considered successful merely because a command returned zero.

## Continuous learning

The store is `data/ai-learning.json` and contains bounded episodes, skill confidence and per-tool outcomes. Only explicit, verified feedback should be used as positive/negative training signals.

## API access

`GET /api/advanced-ai/tools` returns the typed registry plus a live inventory of API routes discovered from `backend/index.js`.

Typed read-only tools can be inspected automatically. Typed mutating tools remain behind authorization. Discovered but untyped mutating routes cannot be automatically invoked. Arbitrary shell is never an automatic AI capability.

## Lightweight behavior

The deterministic layer runs without the model package. The optional model runs in a worker process so model memory and failures do not destabilize the main panel process.
