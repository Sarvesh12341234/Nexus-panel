const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registry, search } = require('../backend/ai_tool_registry');
const { AILearningStore } = require('../backend/ai_learning');

const tools = registry();
assert.ok(tools.templates.length >= 40, `expected >=40 tools, got ${tools.templates.length}`);
assert.ok(tools.templates.some((tool) => tool.id === 'server.start'));
assert.ok(tools.templates.some((tool) => tool.id === 'repair.command.approve'));
assert.ok(tools.templates.some((tool) => tool.id === 'performance.snapshot'));
assert.ok(search('permission repair').some((tool) => tool.id === 'permissions.repair'));
assert.equal(tools.policy.allowUntypedMutationAuto, false);
assert.equal(tools.policy.allowArbitraryShellAuto, false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ai-'));
const store = new AILearningStore(root);
store.learn({ category: 'permission', tool: 'permissions.audit', reward: 1, diagnosis: 'EACCES', outcome: 'verified', verified: true });
store.learn({ category: 'permission', tool: 'permissions.audit', reward: 1, diagnosis: 'EACCES', outcome: 'fixed', verified: true });
assert.equal(store.summary().episodes, 2);
assert.ok(store.rank('permission', [{ id: 'permissions.audit' }])[0].learnedConfidence > 0.5);
console.log('Advanced AI tool registry and continuous learning test passed.');
