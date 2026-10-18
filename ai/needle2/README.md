# NexusPanel local diagnosis model

Needle 2 runs locally per server. It can classify documented issues and
request one registered repair tool. It does not receive arbitrary endpoint,
shell, file-path, or command execution tools. The Node backend validates each
request against the issue registry, exact supplied evidence, deterministic
diagnostics, server edition, and offline state before dispatching a bounded
repair routine.

## Training data and limits

`scripts/prepare_needle2_dataset.py` extracts issue records from
`docs/AI-TRAINING-CORPUS.md` and builds a Needle tool-calling JSONL set under
ignored `data/needle2/`. `known-issues.json` lets the server validate predicted
issue IDs. `repair-tools.json` defines callable tool names and the issue-to-tool
allowlist; the generator creates tool-call examples only for issues explicitly
mapped to an existing backend repair.

The corpus is a starting knowledge base, not a complete inventory of bugs.
Some entries are stale or refer to features that do not exist in the current
1.0.3 code. An AI result must therefore remain advisory until cross-checked
against current deterministic diagnostics. Unknown errors should return no
match and be added to the corpus only after they are reproduced and verified.

## Local training on the RTX GPU (WSL2)

Needle 2's training code uses JAX. The native Windows install currently sees
CPU only; WSL2 exposes the RTX 3050. Run these commands from the repository:

```bash
python3 -m venv ~/.venvs/nexuspanel-needle2
source ~/.venvs/nexuspanel-needle2/bin/activate
python -m pip install --upgrade pip
python -m pip install 'cactus-needle[train,gpu]==2.0.15'
cd /mnt/c/Users/Sinjita/Pictures/spawn/Nexus-panel-review
python scripts/prepare_needle2_dataset.py
python -c 'import jax; print(jax.devices())'
python scripts/check_needle2_dataset.py data/needle2/repair-train.jsonl --max-len 256
XLA_PYTHON_CLIENT_PREALLOCATE=false XLA_PYTHON_CLIENT_MEM_FRACTION=0.70 needle finetune data/needle2/repair-train.jsonl --checkpoint data/needle2/checkpoints/needle2.pkl --epochs 3 --batch-size 1 --max-len 256 --lora-rank 4 --lora-alpha 8 --val-split 0.1 --seed 17 --checkpoint-dir data/needle2/checkpoints --out data/needle2/repair-lora-v3.pkl
JAX_PLATFORMS=cpu needle build data/needle2/checkpoints/needle2.pkl --lora data/needle2/repair-lora-v3.pkl --out data/needle2/nexuspanel-needle2-v3.cact
```

Training is local; no hosted API or generated examples are used. Start with a
small batch because the desktop is already using part of the 4 GB VRAM. If JAX
selects CPU or reports an out-of-memory error, stop instead of silently claiming
GPU training succeeded. Keep the `.cact` file local/ignored until it has passed
the project-specific evaluation set.

The dataset generator keeps both function choices in every compact training
schema and caps the evidence excerpt so each answer fits within the training
sequence. The checker must report zero examples with truncated answers before fine-tuning.
Do not train with `--max-len 128`: the full prompt can exceed that length, leaving
the loss mask empty and producing a misleading `loss 0.0000` throughout.
The v2 trial used target-only schemas, so it learned issue lookup but selected
that function instead of repair requests when both choices were available. Do
not enable v2 for model-selected repairs; v3 trains with both choices present.

## Per-server isolation and registered repair tools

The optional runtime creates a separate worker process for each server ID and
passes only that server's last 1,400 characters of redacted console logs. Each
worker can share the immutable model file, but does not share logs, tool results,
or conversation state. Workers reset the model conversation for each request
and idle out after ten minutes; no more than eight workers run by default.

Needle can call `lookup_documented_issue` or request one of these repair tools:

- Repair `server.properties` and known support JSON files.
- Restore the selected server's missing executable.
- Install a compatible bundled Java runtime inside that server's root.
- Reconcile Bedrock world pack references or quarantine an incompatible pack.
- Quarantine a specifically identified failing plugin/mod while offline.
- Remove old partial transfers only while offline and when no server operation
  or resumable upload is active.

The model only requests a tool. Repair prompts label the confirmed issue ID and
evidence explicitly so the model can fill the tool contract. Node checks the
tool name, mapped issue ID, exact evidence substring, a matching diagnostic (or
verifies that the selected executable is actually missing), tool-specific
server conditions, and offline state, then calls the existing bounded repair
function. The browser's Repair &
Diagnose action and eligible crash recovery are the only call sites; the preview
endpoint remains read-only. Unsupported requests are ignored, and deterministic
repairs continue as fallback if Needle is unavailable.

World recovery, deleting a world lock, killing a process, recursive permission
rewrites, arbitrary shell or file paths, and plugin testing/restarts are not
exposed as model tools. Permission repair stays out of the AI tool list because
the existing recursive mode/ownership repair needs a narrower per-server ACL
implementation first. Because
the previous training set taught only issue lookup, rebuild the LoRA adapter
and `.cact` after regenerating the dataset before enabling model-selected
tools. An older model keeps deterministic repairs but will not reliably request
these tools.

To enable inference on a host, install the pinned runtime in a Python
environment and point NexusPanel at both the environment and the trained model:

```bash
python3 -m pip install 'cactus-needle==2.0.15'
NEXUSPANEL_NEEDLE2_PYTHON=/path/to/venv/bin/python
NEXUSPANEL_NEEDLE2_MODEL=/path/to/nexuspanel-needle2.cact
```

Set those variables in the NexusPanel service environment. Leaving either
unset disables Needle and keeps deterministic repair behavior unchanged.
