'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractJavaRuntimeArchive } = require('../backend/java_runtime_archive');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-java-archive-test-'));
const source = path.join(root, 'source');
const archive = path.join(root, 'java-runtime.tar.gz');
const destination = path.join(root, 'runtime');

try {
  const javaDirectory = path.join(source, 'temurin', 'bin');
  const licenseDirectory = path.join(source, 'temurin', 'legal');
  fs.mkdirSync(javaDirectory, { recursive: true });
  fs.mkdirSync(path.join(licenseDirectory, 'java.se'), { recursive: true });
  fs.mkdirSync(path.join(licenseDirectory, 'java.base'), { recursive: true });
  fs.writeFileSync(path.join(javaDirectory, 'java'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(licenseDirectory, 'java.base', 'LICENSE'), 'runtime license\n');
  fs.symlinkSync('../java.base/LICENSE', path.join(licenseDirectory, 'java.se', 'LICENSE'));
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);

  extractJavaRuntimeArchive(archive, destination);
  const extractedJava = path.join(destination, 'temurin', 'bin', 'java');
  assert.equal(fs.readFileSync(extractedJava, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.notEqual(fs.statSync(extractedJava).mode & 0o100, 0);
  assert.equal(
    fs.readFileSync(path.join(destination, 'temurin', 'legal', 'java.se', 'LICENSE'), 'utf8'),
    'runtime license\n',
  );
  assert.equal(
    fs.readlinkSync(path.join(destination, 'temurin', 'legal', 'java.se', 'LICENSE')),
    '../java.base/LICENSE',
  );

  fs.rmSync(path.join(source, 'temurin', 'legal', 'java.se', 'LICENSE'));
  fs.symlinkSync('../../../../outside', path.join(source, 'temurin', 'legal', 'java.se', 'LICENSE'));
  const maliciousArchive = path.join(root, 'malicious-runtime.tar.gz');
  execFileSync('tar', ['-czf', maliciousArchive, '-C', source, '.']);
  const blockedDestination = path.join(root, 'blocked-runtime');
  assert.throws(
    () => extractJavaRuntimeArchive(maliciousArchive, blockedDestination),
    /link outside its extraction folder/,
  );
  assert.equal(fs.existsSync(blockedDestination), false);
  assert.equal(fs.existsSync(path.join(root, 'outside')), false);

  console.log('Bundled Java extraction accepts internal symlinks and blocks escaping links.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
