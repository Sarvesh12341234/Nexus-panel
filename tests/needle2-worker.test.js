'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-needle-worker-'));
try {
  fs.writeFileSync(path.join(temp, 'needle.py'), `
import re
class Needle:
    def __init__(self, **kwargs): pass
    def reset(self): pass
    def complete(self, text):
        match = re.match(r'^Confirmed offline repair\\. issueId: (.*?); tool: (.*?); evidence: (.*)$', text)
        if not match: return {'function_calls': [{'name':'lookup_documented_issue','arguments':{'id':'test','evidence':'test'}}]}
        return {'function_calls': [{'name':'request_repair_tool','arguments':{'issueId':match[1], 'tool':match[2], 'evidence':match[3]}}]}
`);
  const candidate = { issueId: 'java-missing', tool: 'install_bundled_java_runtime', evidence: 'Java is missing from the service environment.' };
  const text = `Confirmed offline repair. issueId: ${candidate.issueId}; tool: ${candidate.tool}; evidence: ${candidate.evidence}`;
  const requests = [
    { requestId: 1, mode: 'repair', text: 'healthy server' },
    { requestId: 2, mode: 'repair', text, candidate: { ...candidate, tool: 'repair_missing_executable' } },
    { requestId: 3, mode: 'repair', text: `${text} altered`, candidate },
    { requestId: 4, mode: 'repair', text, candidate },
    { requestId: 5, mode: 'unknown', text },
  ];
  const worker = path.join(__dirname, '../backend/needle2_worker.py');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, [worker, path.join(temp, 'unused.cact')], {
    input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: temp }, timeout: 10000,
  });
  if (result.error?.code === 'ENOENT') {
    console.log('Needle worker protocol test skipped; Python is not installed.');
  } else {
    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(messages[0].ready, true);
    for (const index of [1, 2, 3, 5]) {
      assert.equal(messages[index].blocked, true);
      assert.equal(messages[index].modelCalled, false);
      assert.equal(messages[index].result, null);
    }
    assert.equal(messages[4].modelCalled, true);
    assert.equal(messages[4].result.tool, candidate.tool);
    assert.equal(messages[4].result.issueId, candidate.issueId);
    assert.equal(messages[4].result.evidence, candidate.evidence);
    console.log('Needle worker protocol and pre-inference rejection tests passed.');
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
