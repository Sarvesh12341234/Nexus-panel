'use strict';

const assert = require('node:assert/strict');
if (process.env.NEXUSPANEL_NEEDLE2_LIVE_TEST !== '1') {
  console.log('Needle live model test skipped; set NEXUSPANEL_NEEDLE2_LIVE_TEST=1 with a model and runtime.');
  process.exit(0);
}

const { knowledgeRules } = require('../backend/repair_knowledge');
const { DIAGNOSTIC_ISSUES, panelRepairCandidates } = require('../backend/needle2_repair_candidates');
const agent = require('../backend/needle2_agent');

(async () => {
  try {
    assert.ok(agent.enabled('repair'), 'repair model must be installed');
    const candidates = knowledgeRules().filter((rule) => DIAGNOSTIC_ISSUES[rule.id])
      .flatMap((rule) => panelRepairCandidates([rule]));
    candidates.push(...panelRepairCandidates([], true));
    assert.equal(candidates.length, 12);
    const failures = [];
    for (const candidate of candidates) {
      const result = await agent.suggestRepairTool(987603, candidate);
      if (result?.issueId !== candidate.issueId || result?.tool !== candidate.tool) {
        failures.push({ issue: candidate.issueId, result });
      }
    }
    assert.deepEqual(failures, [], `real model rejected or misrouted candidates: ${JSON.stringify(failures)}`);
    const first = candidates[0];
    assert.equal(await agent.suggestRepairTool(987603, { ...first, tool: 'not_a_registered_tool' }), null);
    console.log(`Needle live panel-to-worker routing passed for ${candidates.length} candidates.`);
  } finally {
    agent.shutdownWorkers();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
