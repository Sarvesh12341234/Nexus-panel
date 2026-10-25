const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.join(__dirname, '..');
const installer = fs.readFileSync(path.join(projectRoot, 'installers', 'nexuspanel-normal-v1.0.0-linux-installer.sh'), 'utf8');
const currentInstaller = fs.readFileSync(path.join(projectRoot, 'installers', 'nexuspanel-normal-v1.0.3-linux-installer.sh'), 'utf8');
const index = fs.readFileSync(path.join(projectRoot, 'backend', 'index.js'), 'utf8');
const setupPage = fs.readFileSync(path.join(projectRoot, 'frontend', 'setup.html'), 'utf8');
const setupScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'js', 'setup.js'), 'utf8');
const windowsService = fs.readFileSync(path.join(projectRoot, 'windows', 'install-service.ps1'), 'utf8');
const windowsInstaller = fs.readFileSync(path.join(projectRoot, 'install.ps1'), 'utf8');

assert.match(installer, /setup_token/);
assert.match(installer, /First-run setup:/);
assert.match(installer, /setup_owner\(\)/);
assert.match(installer, /Web account setup is ready/);
assert.doesNotMatch(installer, /Owner Setup.*\n.*read -r/si);
assert.match(currentInstaller, /node_supported\(\)/);
assert.match(currentInstaller, /major < 25/);
assert.match(windowsInstaller, /\[version\]'25\.0\.0'/);
assert.match(index, /app\.post\('\/api\/setup'/);
assert.match(setupScript, /X-NexusPanel-Setup-Token/);
assert.match(windowsService, /no longer installs a SYSTEM startup task/);
assert.match(windowsService, /per-server OS isolation/);
assert.match(index, /finishInitialSetup\(\)/);
assert.match(setupPage, /id="setupForm"/);
assert.match(setupScript, /\/api\/setup/);
assert.match(setupScript, /X-NexusPanel-Setup-Token/);

const token = crypto.randomBytes(32).toString('base64url');
assert.equal(token.length, 43);
assert.match(token, /^[A-Za-z0-9_-]{43}$/);

console.log('First-run setup architecture test passed.');
