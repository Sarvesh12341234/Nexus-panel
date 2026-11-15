'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diagnoseRuntime } = require('../backend/repair_knowledge');
const { panelRepairCandidates } = require('../backend/needle2_repair_candidates');

if (process.platform === 'win32') {
  console.log('Needle repair routing integration test requires a POSIX executable; skipped.');
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-needle-routing-'));
const executable = path.join(root, 'worker');
const model = path.join(root, 'model.cact');
fs.writeFileSync(model, Buffer.from([0x83, 0x2a, 0xe1, 0x05]));
fs.writeFileSync(executable, `#!${process.execPath}
let buffer = '', served = 0;
console.log(JSON.stringify({ready: true}));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const match = request.text.match(/^Confirmed offline repair\\. issueId: (.*?); tool: (.*?); evidence: (.*)$/);
    const result = match && {kind:'repair-tool', issueId:match[1], tool:match[2], evidence:match[3]};
    if (result && ++served === 2) result.evidence = 'unrelated evidence';
    console.log(JSON.stringify({requestId:request.requestId, result}));
    if (served === 2) setTimeout(() => process.exit(0), 10);
  }
});
`, { mode: 0o755 });
process.env.NEXUSPANEL_NEEDLE2_PYTHON = executable;
process.env.NEXUSPANEL_NEEDLE2_REPAIR_MODEL = model;
const agent = require('../backend/needle2_agent');

(async () => {
  try {
    const candidate = panelRepairCandidates(diagnoseRuntime(['spawn java ENOENT']))[0];
    const accepted = await agent.suggestRepairTool(987602, candidate);
    assert.equal(accepted?.issueId, 'java-missing');
    assert.equal(accepted?.tool, 'install_bundled_java_runtime');
    assert.equal(accepted?.evidence, candidate.evidence);
    const rejected = await agent.suggestRepairTool(987602, candidate);
    assert.equal(rejected, null, 'altered evidence must never be accepted');
    assert.equal(await agent.suggestRepairTool(987602, { ...candidate, tool: 'repair_missing_executable' }), null);
    console.log('Needle confirmed candidate and altered-evidence integration tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
