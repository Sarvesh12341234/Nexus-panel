'use strict';

const assert = require('node:assert/strict');
const { requireLaunchIsolation } = require('../backend/asf');
const { beginServerFileOperation, startServer } = require('../backend/runtime');

assert.throws(
  () => requireLaunchIsolation('win32', null, null),
  /no per-server OS isolation/,
);
assert.throws(
  () => requireLaunchIsolation('linux', { preflightPassed: true }, { available: false, reason: 'setfacl-missing' }),
  /per-server OS identity is unavailable/,
);
assert.throws(
  () => requireLaunchIsolation('linux', { preflightPassed: false }, { available: true }),
  /preflight did not pass/,
);
assert.doesNotThrow(() => requireLaunchIsolation('linux', { preflightPassed: true }, { available: true }));

const serverId = 987632;
const release = beginServerFileOperation(serverId);
assert.throws(
  () => startServer({ id: serverId, executable_path: '' }, {}),
  /file-manager operation is active/,
);
release();
release();
assert.throws(
  () => startServer({ id: serverId, executable_path: '' }, {}),
  /Install server software before starting/,
);
console.log('Fail-closed server isolation and file-operation locking tests passed.');
