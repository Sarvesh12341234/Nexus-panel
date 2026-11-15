#!/usr/bin/env python3
"""Evaluate panel-derived repair routing, including no-repair inputs."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('model')
parser.add_argument('--dataset', default=str(ROOT / 'data/needle2/repair-routing-eval.jsonl'))
parser.add_argument('--require-quality', action='store_true')
args = parser.parse_args()
rows = [json.loads(line) for line in Path(args.dataset).read_text(encoding='utf-8').splitlines() if line.strip()]
requests = ''.join(json.dumps({'requestId': i + 1, 'text': row['query']}) + '\n' for i, row in enumerate(rows))
run = subprocess.run([sys.executable, str(ROOT / 'backend/needle2_worker.py'), args.model],
                     input=requests, text=True, capture_output=True, timeout=300, check=True,
                     env={**os.environ, 'NEEDLE_TELEMETRY': '0'})
messages = [json.loads(line) for line in run.stdout.splitlines() if line.startswith('{')]
if not messages or messages[0].get('ready') is not True:
    raise SystemExit('Worker failed to initialize.')
responses = {entry.get('requestId'): entry for entry in messages[1:]}
positive = correct = negative = false_calls = errors = 0
failures = []
for i, row in enumerate(rows, 1):
    response = responses.get(i, {})
    errors += bool(response.get('error') or not response)
    answer = response.get('result') or {}
    if not row['answers']:
        negative += 1
        false_calls += bool(response.get('modelCalled'))
        continue
    positive += 1
    expected = row['answers'][0]['arguments']
    evidence = answer.get('evidence')
    good = (answer.get('kind') == 'repair-tool'
            and all(answer.get(k) == expected[k] for k in ('tool', 'issueId'))
            and isinstance(evidence, str) and len(evidence) >= 12 and evidence in expected['evidence'])
    correct += bool(good)
    if not good:
        failures.append({'expected': expected['issueId'], 'actual': answer})
summary = {'positive': positive, 'correct': correct, 'negative': negative,
           'falseCalls': false_calls, 'workerErrors': errors, 'failures': failures}
print(json.dumps(summary, indent=2))
if args.require_quality and (not positive or not negative or correct != positive or false_calls or errors):
    raise SystemExit(1)
