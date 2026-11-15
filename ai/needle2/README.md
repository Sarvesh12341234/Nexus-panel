# NexusPanel local Needle models

NexusPanel uses separate local models for documented-issue suggestions and
for routing confirmed repair diagnostics. Neither model receives arbitrary
shell, endpoint, or file-path execution tools.

The repair model is deliberately narrow: it routes candidates created from
the panel's own diagnostic rules. The panel offers a candidate only while the
server is offline, and validates the returned issue, registered tool, and
evidence before independently checking the diagnostic, server edition, state,
and tool-specific conditions. Normal deterministic repairs remain available
when the model or Python runtime is unavailable. A model request does not
override these checks.

The current repair model was fine-tuned from
[Cactus Compute Needle 2](https://huggingface.co/Cactus-Compute/needle2) on
256 generated examples derived from 12 panel diagnostic mappings. These are
templates built from the panel's own summaries, not private server logs.
Tests cover 36 positive prompts and four unrelated prompts. Unguarded model
inference can still request a tool for unrelated text: do not expose the
model directly as an autonomous repair agent. The repair worker rejects
missing, malformed, or inconsistent candidate fields before inference.
These tests do not establish accuracy for unseen incidents.

The older general issue-classification model remains advisory and has not
passed the same quality threshold. An unambiguous exact match against a
documented error is labeled separately and does not count as a prediction.
Unknown or ambiguous issues need independent diagnosis.

## Install and configure

The bundled repair model is `models/nexuspanel-needle2-repair.cact`, tracked
with Git LFS. The Linux installer fetches LFS objects and installs the pinned
`cactus-needle==2.0.15` runtime into `data/needle2/runtime-linux` by default;
set `NEXUSPANEL_INSTALL_AI=no` to skip runtime installation. If the model is
an LFS pointer rather than the full file, run `git lfs pull` in the checkout.

`NEXUSPANEL_NEEDLE2_PYTHON` overrides the Python executable. Otherwise the
panel uses `data/needle2/runtime-linux/bin/python` on Linux or
`data/needle2/runtime-win/Scripts/python.exe` on Windows if present, then
falls back to `python3` or `python` on PATH. The optional environment variables
`NEXUSPANEL_NEEDLE2_REPAIR_MODEL` and `NEXUSPANEL_NEEDLE2_MODEL` override the
repair and advisory models independently. A local repair model at
`data/needle2/nexuspanel-needle2-repair.cact` also takes precedence over the
bundled model, so updates do not overwrite local model files. Set service environment variables
in a systemd drop-in or the service environment file, then restart the panel.
Worker initialization errors are reported in the repair preview.

Separate workers are used for each server and model role, with a shared limit
of eight by default. Workers reset their conversation for every request and
idle out after ten minutes. Only redacted server text or panel-generated
candidate summaries are sent to the local worker.

## Rebuild and evaluate the repair model

Run from the repository root in an environment with
`cactus-needle[train,gpu]==2.0.15` installed and a compatible GPU. The base
checkpoint is available from the upstream Needle 2 project.

```bash
python scripts/prepare_needle2_repair_data.py
python scripts/check_needle2_dataset.py data/needle2/repair-routing-train.jsonl --max-len 256
XLA_PYTHON_CLIENT_PREALLOCATE=false needle finetune data/needle2/repair-routing-train.jsonl --checkpoint checkpoints/needle2.pkl --epochs 6 --batch-size 1 --max-len 256 --lora-rank 4 --lora-alpha 8 --val-split 0 --seed 42 --checkpoint-dir checkpoints --out data/needle2/repair-routing-v1.pkl
JAX_PLATFORMS=cpu needle build checkpoints/needle2.pkl --lora data/needle2/repair-routing-v1.pkl --out data/needle2/repair-routing-candidate.cact
python scripts/evaluate_needle2_routing.py data/needle2/repair-routing-candidate.cact
python scripts/evaluate_needle2_protected.py data/needle2/repair-routing-candidate.cact --require-quality
```

The raw evaluation reports model calls even when the worker rejects their
arguments. The protected evaluation exercises the production-format
candidates and rejects malformed requests before the model is called. Do not
replace the installed model on the basis of training loss alone.
