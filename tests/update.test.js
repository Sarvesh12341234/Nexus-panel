'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-update-test-'));
const source = path.join(root, 'source');
const remote = path.join(root, 'remote.git');
const install = path.join(root, 'install');
const gitInstall = path.join(root, 'git-install');
const updater = path.resolve(__dirname, '../update/update.sh');

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'pipe', ...options });
}

try {
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(source, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(source, 'update'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'nexuspanel-update-fixture',
    version: '1.0.4',
  }));
  fs.writeFileSync(path.join(source, 'backend', 'marker.js'), 'module.exports = "new";\n');
  fs.writeFileSync(path.join(source, 'update', 'update.sh'), '# fixture update script\n');

  run('git', ['init', '-q', source]);
  run('git', ['-C', source, 'config', 'user.email', 'test@example.invalid']);
  run('git', ['-C', source, 'config', 'user.name', 'NexusPanel update test']);
  run('git', ['-C', source, 'add', '.']);
  run('git', ['-C', source, 'commit', '-qm', 'fixture release']);
  run('git', ['-C', source, 'tag', 'v1.0.4']);
  run('git', ['init', '--bare', '-q', remote]);
  run('git', ['-C', source, 'remote', 'add', 'origin', remote]);
  run('git', ['-C', source, 'push', '-q', 'origin', 'HEAD:main', '--tags']);

  fs.mkdirSync(path.join(install, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(install, 'update'), { recursive: true });
  fs.mkdirSync(path.join(install, 'data'), { recursive: true });
  fs.mkdirSync(path.join(install, 'servers', 'world'), { recursive: true });
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'nexuspanel-old', version: '1.0.0' }));
  fs.writeFileSync(path.join(install, 'backend', 'marker.js'), 'module.exports = "old";\n');
  fs.writeFileSync(path.join(install, 'update', 'update.sh'), fs.readFileSync(updater));
  fs.writeFileSync(path.join(install, 'data', 'nexuspanel.sqlite'), 'keep database');
  fs.writeFileSync(path.join(install, 'servers', 'world', 'level.dat'), 'keep world');
  fs.writeFileSync(path.join(install, '.env'), 'SECRET=keep\n');
  fs.writeFileSync(path.join(install, 'local-config.json'), '{"keep":true}\n');

  run('bash', [updater, remote], {
    cwd: install,
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      NEXUSPANEL_DIR: install,
      NEXUSPANEL_UPDATE_TAG: 'v1.0.4',
      NEXUSPANEL_UPDATE_BACKUP_DIR: path.join(install, 'update', 'backups'),
    },
  });

  assert.equal(JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8')).version, '1.0.4');
  assert.equal(fs.readFileSync(path.join(install, 'backend', 'marker.js'), 'utf8'), 'module.exports = "new";\n');
  assert.equal(fs.readFileSync(path.join(install, 'data', 'nexuspanel.sqlite'), 'utf8'), 'keep database');
  assert.equal(fs.readFileSync(path.join(install, 'servers', 'world', 'level.dat'), 'utf8'), 'keep world');
  assert.equal(fs.readFileSync(path.join(install, '.env'), 'utf8'), 'SECRET=keep\n');
  assert.equal(fs.readFileSync(path.join(install, 'local-config.json'), 'utf8'), '{"keep":true}\n');

  const snapshot = fs.readdirSync(path.join(install, 'update', 'backups'))
    .find((name) => name.startsWith('code-') && name.endsWith('.tar.gz'));
  assert.ok(snapshot, 'updater should keep a timestamped code snapshot');
  const snapshotEntries = run('tar', ['-tzf', path.join(install, 'update', 'backups', snapshot)], { encoding: 'utf8' }).toString();
  assert.match(snapshotEntries, /backend\/marker\.js/);
  assert.doesNotMatch(snapshotEntries, /(^|\/)(data|servers|\.env)(\/|$)/);

  fs.mkdirSync(path.join(gitInstall, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(gitInstall, 'update'), { recursive: true });
  fs.writeFileSync(path.join(gitInstall, 'package.json'), JSON.stringify({ name: 'nexuspanel-old', version: '1.0.0' }));
  fs.writeFileSync(path.join(gitInstall, 'backend', 'marker.js'), 'module.exports = "old";\n');
  fs.writeFileSync(path.join(gitInstall, 'update', 'update.sh'), fs.readFileSync(updater));
  run('git', ['init', '-q', gitInstall]);
  run('git', ['-C', gitInstall, 'config', 'user.email', 'test@example.invalid']);
  run('git', ['-C', gitInstall, 'config', 'user.name', 'NexusPanel update test']);
  run('git', ['-C', gitInstall, 'add', '.']);
  run('git', ['-C', gitInstall, 'commit', '-qm', 'old installation']);
  run('git', ['-C', gitInstall, 'remote', 'add', 'origin', remote]);

  const gitOutput = run('bash', [updater, remote], {
    cwd: gitInstall,
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      NEXUSPANEL_DIR: gitInstall,
      NEXUSPANEL_UPDATE_TAG: 'v1.0.4',
      NEXUSPANEL_UPDATE_BACKUP_DIR: path.join(gitInstall, 'update', 'backups'),
    },
  }).toString();

  assert.match(gitOutput, /Panel code verified .* \(1\.0\.4\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(gitInstall, 'package.json'), 'utf8')).version, '1.0.4');
  assert.equal(fs.readFileSync(path.join(gitInstall, 'backend', 'marker.js'), 'utf8'), 'module.exports = "new";\n');

  console.log('Update test passed: bare GitHub version tags and non-Git updates work while user data is preserved.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
