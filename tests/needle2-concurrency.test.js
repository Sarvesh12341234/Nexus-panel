'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform === 'win32') {
  console.log('Needle worker concurrency test requires a POSIX executable; skipped.');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-needle-concurrency-'));
const executable = path.join(root, 'worker');
const model = path.join(root, 'model.cact');
fs.writeFileSync(model, Buffer.from([0x83, 0x2a, 0xe1, 0x05]));
fs.writeFileSync(executable, `#!${process.execPath}
let buffer = '', served = 0;
setTimeout(() => console.log(JSON.stringify({ready: true})), 200);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    console.log(JSON.stringify({requestId: request.requestId, result: {
      kind: 'issue', id: 'cli-unknown-command', evidence: 'unusual test evidence'
    }}));
    if (++served === 2) setTimeout(() => process.exit(0), 10);
  }
});
`, { mode: 0o755 });
process.env.NEXUSPANEL_NEEDLE2_PYTHON = executable;
process.env.NEXUSPANEL_NEEDLE2_MODEL = model;
const agent = require('../backend/needle2_agent');

(async () => {
  try {
    const answers = await Promise.all([
      agent.classify(987601, 'first unusual test evidence'),
      agent.classify(987601, 'second unusual test evidence'),
    ]);
    assert.ok(answers.every((answer) => answer?.issueId === 'cli-unknown-command'),
      'concurrent requests must wait for the same worker to become ready');
    console.log('Needle worker startup and request concurrency test passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
