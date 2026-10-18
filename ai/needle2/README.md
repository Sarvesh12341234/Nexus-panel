# NexusPanel local diagnosis model

Needle 2 is used here only as a local, read-only issue-ID classifier. It does
not receive arbitrary endpoint, shell, file-write, or repair tools. The Node
repair engine remains responsible for diagnosis verification and bounded fixes.

## Training data and limits

`scripts/prepare_needle2_dataset.py` extracts documented issue records from
`docs/AI-TRAINING-CORPUS.md` and builds a Needle tool-calling JSONL set. The
generated training file is placed under ignored `data/needle2/`. The checked-in
`known-issues.json` registry lets the server validate every predicted ID before
using its cause or fix text.

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
needle finetune data/needle2/repair-train.jsonl --epochs 10 --batch-size 2 --max-len 256 --val-split 0.1 --seed 17 --checkpoint-dir data/needle2/checkpoints --out data/needle2/repair-lora.pkl
needle build data/needle2/checkpoints/needle2.pkl --lora data/needle2/repair-lora.pkl --out data/needle2/nexuspanel-needle2.cact
```

Training is local; no hosted API or generated examples are used. Start with a
small batch because the desktop is already using part of the 4 GB VRAM. If JAX
selects CPU or reports an out-of-memory error, stop instead of silently claiming
GPU training succeeded. Keep the `.cact` file local/ignored until it has passed
the project-specific evaluation set.

## Per-server isolation

The optional runtime creates a separate worker process for each server ID and
passes only that server's last 1,400 characters of redacted console logs. Each
worker can share the immutable model file, but does not share logs, tool results,
or conversation state. Workers reset the model conversation for each request
and idle out after ten minutes; no more than eight workers run by default. The
only exposed tool is `lookup_documented_issue`. Any write, restart, console
command, or endpoint mutation must pass the existing server-scoped repair
authorization and verification path. A model result is surfaced only as an
unverified advisory in the repair preview and is never fed into automatic fixes.

To enable inference on a host, install the pinned runtime in a Python
environment and point NexusPanel at both the environment and the trained model:

```bash
python3 -m pip install 'cactus-needle==2.0.15'
NEXUSPANEL_NEEDLE2_PYTHON=/path/to/venv/bin/python
NEXUSPANEL_NEEDLE2_MODEL=/path/to/nexuspanel-needle2.cact
```

Set those variables in the NexusPanel service environment. Leaving either
unset disables Needle and keeps deterministic repair behavior unchanged.
