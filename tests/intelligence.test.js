const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IntelligenceCore } = require('../backend/intelligence_core');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-intel-'));
const intel = new IntelligenceCore(root, { alpha: 0.25 });
for (let i = 0; i < 12; i++) intel.observe('server:1', { cpu: 20 + (i % 2), memory: 512 });
intel.observe('server:1', { cpu: 99, memory: 512 });
const snapshot = intel.snapshot('server:1');
assert.equal(snapshot.scope, 'server:1');
assert.ok(snapshot.metrics['server:1:cpu']);
assert.ok(Array.isArray(snapshot.predictions));
const incident = intel.recordIncident({ type: 'native-startup', scope: 'server:1', severity: 'critical', evidence: ['identity-root-access-failed'] });
assert.equal(intel.health('server:1') < 100, true);
assert.ok(intel.recommend({ scope: 'server:1', nativeStartupFailure: true }).recommendations.some((r) => r.action === 'native-forensics'));
assert.equal(intel.resolveIncident(incident.id), true);
console.log('Nexus Intelligence core test passed.');
