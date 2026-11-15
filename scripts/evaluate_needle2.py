#!/usr/bin/env python3
"""Evaluate the worker against documented errors and unrelated inputs."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('model')
parser.add_argument('--limit', type=int, default=30)
parser.add_argument('--require-quality', action='store_true', help='exit nonzero unless the candidate meets the promotion checks')
args = parser.parse_args()
registry = json.loads((ROOT / 'ai/needle2/known-issues.json').read_text(encoding='utf-8'))
errors = [(key, value.get('error', '').strip()) for key, value in registry.items()]
counts = {}
for _, error in errors:
    counts[error] = counts.get(error, 0) + 1
examples = [(key, error) for key, error in errors if len(error) >= 15 and counts[error] == 1]
if len(examples) > args.limit:
    examples = [examples[i * len(examples) // args.limit] for i in range(args.limit)]
examples = [(key, f'[12:34:56] [Server thread/ERROR]: {error}') for key, error in examples]
negative = ['What is the weather today?', 'The purple elephant is dancing.',
            'Server started successfully.', 'Player Steve joined the game.',
            'Please tell me a joke.', 'No error has occurred.']
contract = json.loads((ROOT / 'ai/needle2/repair-tools.json').read_text(encoding='utf-8'))
repairs = [(key, tool, registry[key].get('error', '').strip()[:64])
           for key, tool in contract['issueMap'].items() if key in registry and registry[key].get('error', '').strip()][:8]
requests = [{'requestId': i + 1, 'text': text} for i, (_, text) in enumerate(examples)]
requests += [{'requestId': len(requests) + i + 1, 'text': text} for i, text in enumerate(negative)]
requests += [{'requestId': len(requests) + i + 1, 'text': f'Repair issue {key} if safe. Evidence: {text}'}
             for i, (key, _, text) in enumerate(repairs)]
env = {**os.environ, 'NEEDLE_TELEMETRY': '0'}
result = subprocess.run([sys.executable, str(ROOT / 'backend/needle2_worker.py'), args.model],
                        input=''.join(json.dumps(item) + '\n' for item in requests),
                        text=True, capture_output=True, env=env, timeout=300, check=True)
messages = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
if not messages or messages[0].get('ready') is not True:
    raise SystemExit('Worker did not initialize successfully.')
responses = {item.get('requestId'): item for item in messages[1:]}
correct = 0
invalid = 0
failures = []
for index, (expected, text) in enumerate(examples, 1):
    answer = responses.get(index, {}).get('result') or {}
    valid = answer.get('kind') == 'issue' and answer.get('id') in registry and bool(answer.get('evidence')) and answer['evidence'] in text
    correct += bool(valid and answer['id'] == expected)
    invalid += bool(answer and not valid)
    if not valid or answer['id'] != expected:
        failures.append({'expected': expected, 'actual': answer.get('id'), 'valid': valid})
false_positives = sum(bool(responses.get(len(examples) + i + 1, {}).get('result')) for i in range(len(negative)))
repair_correct = 0
for i, (issue_id, tool, text) in enumerate(repairs):
    answer = responses.get(len(examples) + len(negative) + i + 1, {}).get('result') or {}
    evidence = answer.get('evidence')
    repair_correct += bool(answer.get('kind') == 'repair-tool' and answer.get('issueId') == issue_id
                           and answer.get('tool') == tool and evidence and evidence in text)
print(json.dumps({'known': len(examples), 'correct': correct, 'invalid': invalid,
                  'negative': len(negative), 'negativeCalls': false_positives,
                  'repairRequests': len(repairs), 'correctRepairRequests': repair_correct,
                  'failures': failures}, indent=2))
if args.require_quality and (not examples or not repairs or correct * 10 < len(examples) * 9
                             or invalid or false_positives or repair_correct != len(repairs)):
    raise SystemExit(1)
