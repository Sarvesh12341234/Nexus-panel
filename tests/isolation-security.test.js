'use strict';

const assert = require('node:assert/strict');
const { requireLaunchIsolation } = require('../backend/asf');
const { beginServerFileOperation, startServer } = require('../backend/runtime');
const { mutableServerFiles, traversalPaths } = require('../backend/asf_identity');
const { bundledJavaBinary } = require('../backend/java_runtime');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

assert.throws(
  () => requireLaunchIsolation('win32', null, null),
  /no per-server OS isolation/,
);
assert.throws(
  () => requireLaunchIsolation('linux', { preflightPassed: true }, {
    available: false,
    reason: 'identity-file-access-failed',
    path: '/servers/1-test/server.properties',
  }),
  /per-server OS identity is unavailable \(identity-file-access-failed\): file: \/servers\/1-test\/server\.properties/,
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
  fs.writeFileSync(path.join(serverRoot, 'server.properties'), 'motd=test\n');
  fs.writeFileSync(path.join(serverRoot, 'paper.jar'), 'jar');
  fs.mkdirSync(path.join(serverRoot, 'plugins'));
  const traversal = traversalPaths([serverRoot, javaBinary], serverRoot);
  assert.ok(traversal.includes(aclTestRoot), 'the isolated account needs execute permission on parent directories');
  assert.ok(!traversal.includes(serverRoot), 'traversal ACLs must not replace server-root read/write permissions');
  assert.ok(!traversal.includes(path.dirname(javaBinary)), 'traversal ACLs must not replace runtime-directory permissions');
  assert.deepEqual(mutableServerFiles(serverRoot), [path.join(serverRoot, 'server.properties')]);
} finally {
  fs.rmSync(aclTestRoot, { recursive: true, force: true });
}

const relocatedServerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-java-relocation-test-'));
try {
  const javaRelativePath = path.join('runtime', 'java-25', 'jdk-25.0.4.1+1-jre', 'bin', 'java');
  const javaBinary = path.join(relocatedServerRoot, javaRelativePath);
  fs.mkdirSync(path.dirname(javaBinary), { recursive: true });
  fs.writeFileSync(javaBinary, '', { mode: 0o755 });
  fs.mkdirSync(path.join(relocatedServerRoot, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(relocatedServerRoot, 'runtime', 'java-runtime.json'), JSON.stringify({
    major: 25,
    javaBinary: `/root/Nexus-panel/servers/1-skyfallen/${javaRelativePath}`,
  }));
  assert.equal(bundledJavaBinary(relocatedServerRoot, 21), javaBinary);
  assert.equal(bundledJavaBinary(relocatedServerRoot, 26), '');
  const escapedJava = path.join(relocatedServerRoot, 'runtime', 'java-25', 'jdk-escape', 'bin', 'java');
  fs.mkdirSync(path.dirname(escapedJava), { recursive: true });
  const outsideJava = path.join(relocatedServerRoot, 'outside-java');
  fs.writeFileSync(outsideJava, '', { mode: 0o755 });
  fs.symlinkSync(outsideJava, escapedJava);
  fs.writeFileSync(path.join(relocatedServerRoot, 'runtime', 'java-runtime.json'), JSON.stringify({
    major: 25,
    javaBinary: escapedJava,
  }));
  assert.equal(bundledJavaBinary(relocatedServerRoot, 21), javaBinary);
} finally {
  fs.rmSync(relocatedServerRoot, { recursive: true, force: true });
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
