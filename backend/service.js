const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serviceName = process.env.NEXUSPANEL_SERVICE_NAME || 'nexuspanel';
const repoRoot = path.resolve(__dirname, '..');
const nodePath = process.execPath;
const servicePath = `/etc/systemd/system/${serviceName}.service`;

function hasSystemd() {
  return process.platform === 'linux'
    && fs.existsSync('/run/systemd/system')
    && spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
}

function runSystemctl(args) {
  run('systemctl', args);
}

function serviceUser() {
  if (process.env.NEXUSPANEL_SERVICE_USER) return process.env.NEXUSPANEL_SERVICE_USER;
  if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') return process.env.SUDO_USER;
  return os.userInfo().username;
}

function serviceContent() {
  const user = serviceUser();
  return `[Unit]
Description=NexusPanel Minecraft Server Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${nodePath} ${path.join(repoRoot, 'backend', 'index.js')}
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=NEXUSPANEL_SERVICE=1
Environment=NEXUSPANEL_BACKUP_ROOT=/var/lib/nexuspanel/backups
Environment=NEXUSPANEL_X_ACCEL_ROOT=
Environment=NEXUSPANEL_X_ACCEL_PREFIX=
${user === 'root' ? '' : `User=${user}\n`}

[Install]
WantedBy=multi-user.target
`;
}

function requireLinuxSystemd() {
  if (!hasSystemd()) throw new Error('Systemd is required for VPS background service mode.');
}

function requireRoot() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error(`Root is required. Run: sudo npm run service:install`);
  }
}

function install({ start = true } = {}) {
  requireLinuxSystemd();
  requireRoot();
  fs.writeFileSync(servicePath, serviceContent(), 'utf8');
  installCliCommand();
  runSystemctl(['daemon-reload']);
  runSystemctl(['enable', serviceName]);
  if (start) runSystemctl(['restart', serviceName]);
  console.log(`${serviceName} installed and ${start ? 'started' : 'enabled'}.`);
}

function installCliCommand() {
  const cliPath = path.join(repoRoot, 'backend', 'cli.js');
  const target = '/usr/local/bin/nexuspanel';
  if (!fs.existsSync(cliPath)) return;
  fs.writeFileSync(target, `#!/usr/bin/env sh\nexec "${nodePath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
}

function uninstall() {
  requireLinuxSystemd();
  requireRoot();
  spawnSync('systemctl', ['stop', serviceName], { stdio: 'inherit' });
  spawnSync('systemctl', ['disable', serviceName], { stdio: 'inherit' });
  if (fs.existsSync(servicePath)) fs.rmSync(servicePath, { force: true });
  fs.rmSync('/usr/local/bin/nexuspanel', { force: true });
  runSystemctl(['daemon-reload']);
  console.log(`${serviceName} service removed.`);
}

function status({ quiet = false } = {}) {
  if (!hasSystemd()) return { available: false, active: false, installed: false };
  const installed = fs.existsSync(servicePath);
  const active = spawnSync('systemctl', ['is-active', '--quiet', serviceName], { stdio: 'ignore' }).status === 0;
  const enabled = spawnSync('systemctl', ['is-enabled', '--quiet', serviceName], { stdio: 'ignore' }).status === 0;
  if (!quiet) {
    console.log(JSON.stringify({ available: true, installed, active, enabled, serviceName, servicePath }, null, 2));
  }
  return { available: true, installed, active, enabled, serviceName, servicePath };
}

function startService() {
  requireLinuxSystemd();
  runSystemctl(['start', serviceName]);
}

function stopService() {
  requireLinuxSystemd();
  runSystemctl(['stop', serviceName]);
}

function restartService() {
  requireLinuxSystemd();
  runSystemctl(['restart', serviceName]);
}

function logsService() {
  requireLinuxSystemd();
  run('journalctl', ['-u', serviceName, '-f']);
}

function main() {
  const command = process.argv[2] || 'status';
  if (command === 'install') return install({ start: !process.argv.includes('--no-start') });
  if (command === 'uninstall') return uninstall();
  if (command === 'status') return status();
  if (command === 'start') return startService();
  if (command === 'stop') return stopService();
  if (command === 'restart') return restartService();
  if (command === 'logs') return logsService();
  throw new Error(`Unknown service command: ${command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  hasSystemd,
  install,
  serviceName,
  startService,
  stopService,
  restartService,
  logsService,
  status,
};
