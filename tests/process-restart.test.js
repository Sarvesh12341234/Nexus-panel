'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'linux') {
  console.log('Recovered systemd restart test requires Linux; skipped.');
  process.exit(0);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restart-test-'));
  const bin = path.join(root, 'bin');
  const marker = path.join(root, 'recovered-unit-active');
  const systemctl = path.join(bin, 'systemctl');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(marker, 'active');
  fs.writeFileSync(systemctl, `#!/bin/sh
case "$1" in
  list-units)
    if [ -f "$NEXUSPANEL_TEST_UNIT_MARKER" ]; then
      printf 'asf-987654-test.service loaded active running NexusPanel test unit\\n'
    fi
    ;;
  kill) rm -f "$NEXUSPANEL_TEST_UNIT_MARKER" ;;
  *) exit 0 ;;
esac
`);
  fs.chmodSync(systemctl, 0o755);
  process.env.NEXUSPANEL_DATA_ROOT = path.join(root, 'data');
  process.env.NEXUSPANEL_TEST_UNIT_MARKER = marker;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`;
  const listed = spawnSync('systemctl', ['list-units'], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /asf-987654-test\.service loaded active running/);

  const runtime = require('../backend/runtime');
  try {
    const response = runtime.restartServer(
      { id: 987654, executable_path: '' },
      { key: 'paper', name: 'Paper' },
    );
    assert.match(response.message, /waiting for the recovered systemd process to stop/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(fs.existsSync(marker), false, 'recovered unit should receive a stop signal');
    assert.ok(
      runtime.consoleLogs(987654).some((line) => line.includes('Restart failed: Install server software before starting.')),
      'restart must wait until the old systemd unit disappears before attempting a new launch',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Recovered systemd process restart sequencing test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
