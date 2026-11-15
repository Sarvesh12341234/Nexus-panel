'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diagnoseRuntime, knowledgeRules } = require('../backend/repair_knowledge');
const { DIAGNOSTIC_ISSUES, REPAIR_TOOL_DIAGNOSTICS, panelRepairCandidates, repairCandidatePrompt } = require('../backend/needle2_repair_candidates');
const contract = require('../ai/needle2/repair-tools.json');
const registry = require('../ai/needle2/known-issues.json');

const rules = new Set(knowledgeRules().map((rule) => rule.id));
for (const [diagnosticId, issueId] of Object.entries(DIAGNOSTIC_ISSUES)) {
  assert.ok(rules.has(diagnosticId), `missing panel diagnostic ${diagnosticId}`);
  assert.equal(registry[issueId]?.repairTool, contract.issueMap[issueId], `invalid tool mapping for ${issueId}`);
  assert.ok(REPAIR_TOOL_DIAGNOSTICS[contract.issueMap[issueId]]?.includes(diagnosticId), `diagnostic ${diagnosticId} is not authorized for its tool`);
}
const java = panelRepairCandidates(diagnoseRuntime(['[Server] spawn java ENOENT']));
assert.ok(java.some((item) => item.issueId === 'java-missing' && item.tool === 'install_bundled_java_runtime'));
const javaVersion = panelRepairCandidates(diagnoseRuntime(['UnsupportedClassVersionError']));
assert.ok(javaVersion.some((item) => item.issueId === 'java-too-old'));
assert.equal(panelRepairCandidates(diagnoseRuntime(['Server started successfully.'])).length, 0);
assert.equal(panelRepairCandidates([{ id: 'java-heap', summary: 'Out of memory' }]).length, 0);
const missing = panelRepairCandidates([], true);
assert.equal(missing[0].issueId, 'server-not-installed');
assert.equal(repairCandidatePrompt(missing[0]),
  'Confirmed offline repair. issueId: server-not-installed; tool: repair_missing_executable; evidence: Install server software before starting.');
const agent = require('../backend/needle2_agent');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lfs-pointer-'));
const oldModel = process.env.NEXUSPANEL_NEEDLE2_REPAIR_MODEL;
try {
  const pointer = path.join(temp, 'model.cact');
  fs.writeFileSync(pointer, 'version https://git-lfs.github.com/spec/v1\noid sha256:1234\n');
  process.env.NEXUSPANEL_NEEDLE2_REPAIR_MODEL = pointer;
  assert.equal(agent.enabled('repair'), false, 'an unresolved LFS pointer is not a model');
  assert.match(agent.status().repairModelError, /Git LFS pointer/);
} finally {
  if (oldModel === undefined) delete process.env.NEXUSPANEL_NEEDLE2_REPAIR_MODEL;
  else process.env.NEXUSPANEL_NEEDLE2_REPAIR_MODEL = oldModel;
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('Needle panel diagnostic and repair candidate tests passed.');
