'use strict';

const assert = require('node:assert/strict');
const { requireLaunchIsolation } = require('../backend/asf');
const { beginServerFileOperation, startServer } = require('../backend/runtime');
const { traversalPaths } = require('../backend/asf_identity');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const aclTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-acl-traversal-test-'));
try {
  const serverRoot = path.join(aclTestRoot, 'servers', '1-test');
  const javaBinary = path.join(serverRoot, 'runtime', 'java', 'bin', 'java');
  fs.mkdirSync(path.dirname(javaBinary), { recursive: true });
  fs.writeFileSync(javaBinary, '');
  const traversal = traversalPaths([serverRoot, javaBinary], serverRoot);
  assert.ok(traversal.includes(aclTestRoot), 'the isolated account needs execute permission on parent directories');
  assert.ok(!traversal.includes(serverRoot), 'traversal ACLs must not replace server-root read/write permissions');
  assert.ok(!traversal.includes(path.dirname(javaBinary)), 'traversal ACLs must not replace runtime-directory permissions');
} finally {
  fs.rmSync(aclTestRoot, { recursive: true, force: true });
}

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
