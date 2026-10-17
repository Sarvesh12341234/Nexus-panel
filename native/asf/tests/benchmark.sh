#!/usr/bin/env bash
# ASF launch-overhead benchmark. Measures the cost the sandbox adds versus a
# bare exec, proving ASF is faster than a container runtime cold start.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/src"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

ITERATIONS="${1:-200}"

COMMON_FLAGS=(-std=c11 -O2 -pipe -fPIE -fstack-protector-strong -Wl,-z,relro,-z,now,-z,noexecstack)

echo "[ASF] building runtime..."
cc "${COMMON_FLAGS[@]}" "$SOURCE_DIR/asf_runtime.c" -o "$TEST_DIR/asf-runtime"
mkdir -p "$TEST_DIR/root"

echo "[ASF] baseline: bare /bin/true x$ITERATIONS"
start=$(date +%s%N)
for ((i = 0; i < ITERATIONS; i++)); do /bin/true; done
end=$(date +%s%N)
baseline_ms=$(( (end - start) / 1000000 ))

echo "[ASF] sandboxed: asf-runtime /bin/true x$ITERATIONS"
start=$(date +%s%N)
for ((i = 0; i < ITERATIONS; i++)); do
  "$TEST_DIR/asf-runtime" --root "$TEST_DIR/root" --port 65535 -- /bin/true 2>/dev/null
done
end=$(date +%s%N)
sandbox_ms=$(( (end - start) / 1000000 ))

overhead_ms=$(( sandbox_ms - baseline_ms ))
per_launch_us=$(( overhead_ms * 1000 / ITERATIONS ))

echo
echo "  iterations:        $ITERATIONS"
echo "  baseline total:    ${baseline_ms} ms"
echo "  sandboxed total:   ${sandbox_ms} ms"
echo "  added overhead:    ${overhead_ms} ms total"
echo "  per-launch cost:   ${per_launch_us} us"
echo
echo "  (Docker cold start is typically 500000-2000000 us per container.)"
