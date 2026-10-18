'use strict';

const assert = require('node:assert/strict');
const { preflightTiers, requireLaunchIsolation } = require('../backend/asf');
const { beginLiveServerFileOperation, beginServerFileOperation, startServer } = require('../backend/runtime');
const { directoryTree, serverTreeAccessFindArgs, traversalPaths } = require('../backend/asf_identity');
const { bundledJavaBinary } = require('../backend/java_runtime');
const { diagnoseRuntime } = require('../backend/repair_knowledge');
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
assert.deepEqual(preflightTiers(true), ['maximum', 'compatible', 'core']);
assert.deepEqual(preflightTiers(false), ['compatible', 'core']);
assert.throws(
  () => beginLiveServerFileOperation(987632),
  /Live file operations require the server to be running/,
);

const syscallDiagnostics = diagnoseRuntime([
  'asf-test.service: Main process exited, code=killed, status=31/SYS',
]);
assert.ok(syscallDiagnostics.some((diagnostic) => diagnostic.id === 'syscall-filter'));
assert.ok(!syscallDiagnostics.some((diagnostic) => diagnostic.id === 'java-heap'));
const worldSettingsDiagnostics = diagnoseRuntime([
  'Unable to read or access the world gen settings file for dimension minecraft:overworld.',
]);
assert.ok(worldSettingsDiagnostics.some((diagnostic) => diagnostic.id === 'world-gen-settings'));

const aclTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-acl-traversal-test-'));
try {
  const serverRoot = path.join(aclTestRoot, 'servers', '1-test');
  const javaBinary = path.join(serverRoot, 'runtime', 'java', 'bin', 'java');
  fs.mkdirSync(path.dirname(javaBinary), { recursive: true });
  fs.writeFileSync(javaBinary, '', { mode: 0o755 });
  fs.writeFileSync(path.join(serverRoot, 'server.properties'), 'motd=test\n', { mode: 0o650 });
  const worldSettingsPath = path.join(serverRoot, 'world', 'dimensions', 'minecraft', 'overworld', 'data', 'minecraft', 'world_gen_settings.dat');
  fs.mkdirSync(path.dirname(worldSettingsPath), { recursive: true });
  fs.writeFileSync(worldSettingsPath, 'world settings');
  fs.writeFileSync(path.join(serverRoot, 'paper.jar'), 'jar');
  fs.mkdirSync(path.join(serverRoot, 'plugins'));
  const traversal = traversalPaths([serverRoot, javaBinary], serverRoot);
  assert.ok(traversal.includes(aclTestRoot), 'the isolated account needs execute permission on parent directories');
  assert.ok(!traversal.includes(serverRoot), 'traversal ACLs must not replace server-root read/write permissions');
  assert.ok(!traversal.includes(path.dirname(javaBinary)), 'traversal ACLs must not replace runtime-directory permissions');
  const tree = directoryTree(serverRoot);
  assert.ok(tree.executables.includes(javaBinary), 'owner-executable runtime binaries must receive execute ACLs');
  assert.ok(!tree.executables.includes(path.join(serverRoot, 'server.properties')), 'group execute permissions must not classify config files as executables');
  const accessCheckArgs = serverTreeAccessFindArgs(serverRoot);
  assert.equal(accessCheckArgs[0], serverRoot, 'recursive identity verification must scan from the server root');
  assert.ok(accessCheckArgs.includes('-type') && accessCheckArgs.includes('d') && accessCheckArgs.includes('f'));
  assert.ok(accessCheckArgs.includes('/u=x'), 'write checks must identify executables by the owner execute bit, not the ACL mask');
  assert.ok(accessCheckArgs.includes(path.join(serverRoot, 'runtime')));
  assert.ok(accessCheckArgs.includes(`${path.join(serverRoot, 'runtime')}${path.sep}*`), 'static runtime assets must not require write access');
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
