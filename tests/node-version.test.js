'use strict';

const assert = require('node:assert/strict');
const { assertSupportedNode, nodeVersionSupported } = require('../backend/node_version');

for (const version of ['22.5.0', '22.5.1', '22.18.0', '24.0.0', '24.21.0']) {
  assert.equal(nodeVersionSupported(version), true, `${version} should be supported`);
}
for (const version of ['20.20.2', '22.4.9', '25.0.0', 'not-a-version']) {
  assert.equal(nodeVersionSupported(version), false, `${version} should be rejected`);
  assert.throws(() => assertSupportedNode(version), /requires Node\.js >=22\.5\.0 and <25\.0\.0/);
}
assert.doesNotThrow(() => assertSupportedNode('22.5.0'));
console.log('Node.js runtime requirement tests passed.');
