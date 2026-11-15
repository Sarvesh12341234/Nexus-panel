#!/usr/bin/env python3
"""Build an experimental, panel-derived repair routing dataset.

This does not read server logs or change the active model. Validation prompts
use different wording from training and are written separately.
"""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from needle2_worker import TOOLS  # noqa: E402

contract = json.loads((ROOT / 'ai/needle2/repair-tools.json').read_text(encoding='utf-8'))
panel = json.loads(subprocess.check_output(
    ['node', '-e', "process.stdout.write(JSON.stringify({rules:require('./backend/repair_knowledge').knowledgeRules(),mapping:require('./backend/needle2_repair_candidates').DIAGNOSTIC_ISSUES}))"],
    cwd=ROOT, text=True))
rules_by_id = {rule['id']: rule for rule in panel['rules']}
records = []
for diagnostic, issue in panel['mapping'].items():
    rule = rules_by_id[diagnostic]
    tool = contract['issueMap'][issue]
    records.append({'diagnostic': diagnostic, 'issueId': issue, 'tool': tool, 'evidence': rule['summary']})
records.append({'diagnostic': 'missing-executable', 'issueId': 'server-not-installed',
                'tool': contract['issueMap']['server-not-installed'],
                'evidence': 'Install server software before starting.'})

TRAIN_FORMATS = [
    'Confirmed offline repair. issueId: {issueId}; tool: {tool}; evidence: {evidence}',
    'Request a repair. issueId: {issueId}; tool: {tool}; evidence: {evidence}',
    'Use the registered tool. issueId: {issueId}; tool: {tool}; evidence: {evidence}',
    'For this confirmed issue, request the repair. issueId: {issueId}; tool: {tool}; evidence: {evidence}',
]
EVAL_FORMATS = [
    'Confirmed offline candidate: issueId: {issueId}; tool: {tool}; evidence: {evidence}',
    'Select the registered repair: issueId: {issueId}; tool: {tool}; evidence: {evidence}',
]
NEGATIVES = [
    'No confirmed repair candidate is available.',
    'The server is online. Do not request a repair.',
    'The server started successfully and no fault was detected.',
    'A port is busy; no registered file repair is confirmed.',
    'The disk is full; no repair tool was confirmed.',
    'Unknown issue; no tool and no evidence are available.',
    'The weather is sunny. Do not request a repair.',
    'No repair is needed for this healthy server.',
]

def positive(row, template):
    return {'query': template.format(**row), 'tools': TOOLS,
            'answers': [{'name': 'request_repair_tool', 'arguments': {
                'tool': row['tool'], 'issueId': row['issueId'], 'evidence': row['evidence']}}]}

train = [positive(row, fmt) for row in records for fmt in TRAIN_FORMATS for _ in range(4)]
train += [{'query': text, 'tools': TOOLS, 'answers': []} for text in NEGATIVES for _ in range(8)]
evaluation = [positive(row, fmt) for row in records for fmt in [TRAIN_FORMATS[0], *EVAL_FORMATS]]
evaluation += [{'query': text, 'tools': TOOLS, 'answers': []} for text in [
    'The server is online, so no repair request is permitted.',
    'Healthy server: no diagnostic matched and no repair is needed.',
    'A player joined successfully; no confirmed repair candidate exists.',
    'Network timeout occurred; no registered repair has been confirmed.',
]]
out = ROOT / 'data/needle2'
out.mkdir(parents=True, exist_ok=True)
for name, rows in [('repair-routing-train.jsonl', train), ('repair-routing-eval.jsonl', evaluation)]:
    with (out / name).open('w', encoding='utf-8', newline='\n') as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
print(json.dumps({'panelDiagnostics': len(records), 'trainingExamples': len(train),
                  'evaluationExamples': len(evaluation), 'heldOutPromptTemplates': len(EVAL_FORMATS)}))
