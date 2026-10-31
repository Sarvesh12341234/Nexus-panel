'use strict';

/**
 * ASF native runtime functional test wrapper.
 *
 * The native sandbox is Linux-only, so this wrapper skips cleanly on other
 * platforms instead of failing the whole suite with a shell error.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'linux') {
  console.log('ASF native runtime tests require Linux; skipped.');
  process.exit(0);
}

const script = path.join(__dirname, '..', 'native', 'asf', 'tests', 'test.sh');
if (!fs.existsSync(script)) {
  console.error('ASF native runtime test script is missing.');
  process.exit(1);
}

const result = spawnSync('bash', [script], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
if (result.error) {
  console.error(`Unable to run the ASF native runtime tests: ${result.error.message}`);
  process.exit(1);
}
process.exit(Number(result.status || 0));
