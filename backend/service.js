const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serviceName = process.env.NEXUSPANEL_SERVICE_NAME || 'nexuspanel';
const hostAgentServiceName = `${serviceName}-host-agent`;
const nexusMarkServiceName = `${serviceName}-nexusmark`;
const repoRoot = path.resolve(__dirname, '..');
const nodePath = process.execPath;
const servicePath = `/etc/systemd/system/${serviceName}.service`;
const hostAgentServicePath = `/etc/systemd/system/${hostAgentServiceName}.service`;
const nexusMarkServicePath = `/etc/systemd/system/${nexusMarkServiceName}.service`;

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

function serviceGroup(user) {
  if (user === 'root') return 'root';
  const result = spawnSync('id', ['-gn', user], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || user : user;
}

function ensureRuntimePermissions() {
  if (process.platform !== 'linux') return;
  const user = serviceUser();
  const group = serviceGroup(user);
  const dirs = [
    path.join(repoRoot, 'data'),
    path.join(repoRoot, 'servers'),
    path.join(repoRoot, 'software'),
    path.join(repoRoot, 'backups'),
    path.join(repoRoot, 'backupfolder'),
    path.join(repoRoot, 'update', 'backups'),
    '/var/lib/nexuspanel',
    '/var/lib/nexuspanel/backups',
    '/var/lib/nexuspanel/logs',
    '/var/lib/nexuspanel/nexus-mark',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    try {
      fs.chmodSync(dir, 0o750);
    } catch {}
  }
  const updateScript = path.join(repoRoot, 'update', 'update.sh');
  if (fs.existsSync(updateScript)) {
    try {
      fs.chmodSync(updateScript, 0o755);
    } catch {}
  }
  if (user !== 'root') {
    for (const dir of dirs) {
      spawnSync('chown', ['-R', `${user}:${group}`, dir], { stdio: 'ignore' });
    }
  }
}

function serviceContent() {
  const user = serviceUser();
  const group = serviceGroup(user);
  const editionPath = path.join(repoRoot, 'data', 'edition');
  const edition = fs.existsSync(editionPath) ? fs.readFileSync(editionPath, 'utf8').trim() || 'normal' : 'normal';
  return `[Unit]
Description=NexusPanel Minecraft Server Panel
After=network-online.target
Wants=network-online.target
Wants=${hostAgentServiceName}.service ${nexusMarkServiceName}.service
After=${hostAgentServiceName}.service ${nexusMarkServiceName}.service

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${nodePath} ${path.join(repoRoot, 'backend', 'index.js')}
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=NEXUSPANEL_SERVICE=1
Environment=NEXUSPANEL_EDITION=${edition}
Environment=PORT=${Number(process.env.PORT || 3000)}
Environment=NEXUSPANEL_BACKUP_ROOT=/var/lib/nexuspanel/backups
Environment=NEXUSPANEL_X_ACCEL_ROOT=
Environment=NEXUSPANEL_X_ACCEL_PREFIX=
${user === 'root' ? '' : `User=${user}\nGroup=${group}\n`}

[Install]
WantedBy=multi-user.target
`;
}

function hostAgentServiceContent() {
  const user = serviceUser();
  const group = serviceGroup(user);
  return `[Unit]
Description=NexusPanel v3 Native Host Agent
After=local-fs.target
Before=${serviceName}.service

[Service]
Type=simple
User=root
Group=${group}
RuntimeDirectory=nexuspanel
RuntimeDirectoryMode=0750
ExecStart=/var/lib/nexuspanel/nexus-host-agent
Restart=on-failure
RestartSec=1
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
CapabilityBoundingSet=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@mount @module @obsolete @privileged @raw-io @reboot @swap

[Install]
WantedBy=multi-user.target
`;
}

function nexusMarkServiceContent() {
  return `[Unit]
Description=NexusMark Native Isolation Preflight
After=local-fs.target
Before=${serviceName}.service

[Service]
Type=oneshot
WorkingDirectory=${repoRoot}
ExecStart=${nodePath} ${path.join(repoRoot, 'backend', 'nexus_mark_native.js')}
RemainAfterExit=yes
NoNewPrivileges=no

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
  ensureRuntimePermissions();
  const { build: buildHostAgent } = require('./host_agent');
  buildHostAgent();
  fs.writeFileSync(servicePath, serviceContent(), 'utf8');
  fs.writeFileSync(hostAgentServicePath, hostAgentServiceContent(), 'utf8');
  fs.writeFileSync(nexusMarkServicePath, nexusMarkServiceContent(), 'utf8');
  installCliCommand();
  runSystemctl(['daemon-reload']);
  runSystemctl(['enable', hostAgentServiceName, nexusMarkServiceName, serviceName]);
  if (start) {
    runSystemctl(['restart', nexusMarkServiceName]);
    runSystemctl(['restart', hostAgentServiceName]);
    runSystemctl(['restart', serviceName]);
  }
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
  spawnSync('systemctl', ['stop', serviceName, hostAgentServiceName, nexusMarkServiceName], { stdio: 'inherit' });
  spawnSync('systemctl', ['disable', serviceName, hostAgentServiceName, nexusMarkServiceName], { stdio: 'inherit' });
  if (fs.existsSync(servicePath)) fs.rmSync(servicePath, { force: true });
  if (fs.existsSync(hostAgentServicePath)) fs.rmSync(hostAgentServicePath, { force: true });
  if (fs.existsSync(nexusMarkServicePath)) fs.rmSync(nexusMarkServicePath, { force: true });
  fs.rmSync('/usr/local/bin/nexuspanel', { force: true });
  runSystemctl(['daemon-reload']);
  console.log(`${serviceName} service removed.`);
}

function status({ quiet = false } = {}) {
  if (!hasSystemd()) {
    const result = { available: false, active: false, installed: false, serviceName, servicePath };
    if (!quiet) console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const installed = fs.existsSync(servicePath);
  const active = spawnSync('systemctl', ['is-active', '--quiet', serviceName], { stdio: 'ignore' }).status === 0;
  const enabled = spawnSync('systemctl', ['is-enabled', '--quiet', serviceName], { stdio: 'ignore' }).status === 0;
  const hostAgentActive = spawnSync('systemctl', ['is-active', '--quiet', hostAgentServiceName], { stdio: 'ignore' }).status === 0;
  const nexusMarkActive = spawnSync('systemctl', ['is-active', '--quiet', nexusMarkServiceName], { stdio: 'ignore' }).status === 0;
  if (!quiet) {
    console.log(JSON.stringify({ available: true, installed, active, enabled, hostAgentActive, nexusMarkActive, serviceName, servicePath }, null, 2));
  }
  return { available: true, installed, active, enabled, hostAgentActive, nexusMarkActive, serviceName, servicePath };
}

function componentAction(component, action) {
  requireLinuxSystemd();
  const units = { panel: serviceName, agent: hostAgentServiceName, nexusmark: nexusMarkServiceName };
  const unit = units[component];
  if (!unit || !['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('Use panel, agent, or nexusmark with start, stop, restart, or status.');
  if (action === 'status') return runSystemctl(['status', unit, '--no-pager']);
  runSystemctl([action, unit]);
}

function startService() {
  requireLinuxSystemd();
  if (!fs.existsSync(servicePath)) {
    requireRoot();
    return install({ start: true });
  }
  runSystemctl(['start', serviceName]);
  const result = status({ quiet: true });
  if (!result.active) throw new Error(`${serviceName} did not become active. Run: journalctl -u ${serviceName} -n 100 --no-pager`);
  console.log(`${serviceName} is running.`);
  return result;
}

function stopService() {
  requireLinuxSystemd();
  runSystemctl(['stop', serviceName]);
}

function restartService() {
  requireLinuxSystemd();
  if (!fs.existsSync(servicePath)) {
    requireRoot();
    return install({ start: true });
  }
  runSystemctl(['restart', serviceName]);
  const result = status({ quiet: true });
  if (!result.active) throw new Error(`${serviceName} restart failed. Run: journalctl -u ${serviceName} -n 100 --no-pager`);
  console.log(`${serviceName} restarted successfully.`);
  return result;
}

function changePort(nextPort) {
  requireLinuxSystemd();
  requireRoot();
  const port = Number(nextPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Panel port must be between 1 and 65535.');
  if (!fs.existsSync(servicePath)) install({ start: false });
  let content = fs.readFileSync(servicePath, 'utf8');
  if (content.includes('Environment=PORT=')) content = content.replace(/Environment=PORT=\d+/g, `Environment=PORT=${port}`);
  else content = content.replace('Environment=NEXUSPANEL_SERVICE=1\n', `Environment=NEXUSPANEL_SERVICE=1\nEnvironment=PORT=${port}\n`);
  fs.writeFileSync(servicePath, content, 'utf8');
  runSystemctl(['daemon-reload']);
  runSystemctl(['restart', serviceName]);
  console.log(`NexusPanel panel port changed to ${port}.`);
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
  if (command === 'component') return componentAction(process.argv[3], process.argv[4] || 'status');
  if (command === 'change' && process.argv[3] === 'panelport') return changePort(process.argv[4]);
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
  hostAgentServiceName,
  nexusMarkServiceName,
  startService,
  stopService,
  restartService,
  logsService,
  changePort,
  serviceContent,
  hostAgentServiceContent,
  nexusMarkServiceContent,
  status,
  componentAction,
};
