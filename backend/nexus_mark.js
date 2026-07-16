const fs = require('node:fs');
const path = require('node:path');
const { externalDataRoot } = require('./paths');
const { hostCpuCount } = require('./system_info');
let launchSequence = 0;

function cpuLimitPercent(cpuCores = 1) {
  const total = Math.max(1, hostCpuCount());
  const requested = Math.max(1, Math.min(total, Number(cpuCores) || 1));
  return requested * 100;
}

function startupCpuLimitPercent(cpuCores = 1) {
  const total = Math.max(1, hostCpuCount());
  const requested = Math.max(1, Math.min(total, Number(cpuCores) || 1));
  return requested <= 3 ? Math.min(total, requested * 4) * 100 : requested * 100;
}

function clearStaleUnits(serverId, spawnSync) {
  const safeId = String(serverId).replace(/[^a-z0-9_.-]/gi, '-');
  const prefix = `nexusmark-${safeId}`;
  const listed = spawnSync('systemctl', [
    'list-units',
    '--all',
    '--plain',
    '--no-legend',
    `${prefix}*.service`,
  ], { encoding: 'utf8', windowsHide: true });
  const units = String(listed.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => unit === `${prefix}.service` || unit.startsWith(`${prefix}-`));
  if (!units.includes(`${prefix}.service`)) units.push(`${prefix}.service`);
  for (const unit of [...new Set(units)]) {
    spawnSync('systemctl', ['stop', unit], { stdio: 'ignore', windowsHide: true });
    spawnSync('systemctl', ['reset-failed', unit], { stdio: 'ignore', windowsHide: true });
  }
}

function profileForServer(server, nexu = null) {
  const cpuCores = Math.max(1, Math.min(hostCpuCount(), Number(server.cpu_cores || nexu?.resources?.cpuCores || 1)));
  const ramMb = Math.max(256, Number(server.max_memory_mb || nexu?.resources?.ramMb || 1024));
  const windowsHardGuardMb = Math.max(ramMb + 384, Math.ceil(ramMb * 1.35));
  const advancedIsolation = process.env.NEXUSPANEL_ADVANCED_ISOLATION !== '0';
  return {
    engine: 'nexus-mark',
    version: 1,
    mode: 'direct-isolated',
    platform: process.platform,
    serverId: server.id,
    cpuCores,
    cpuQuotaPercent: cpuLimitPercent(cpuCores),
    startupCpuQuotaPercent: startupCpuLimitPercent(cpuCores),
    memoryMaxMb: ramMb,
    diskLimitMb: Number(server.disk_limit_mb || nexu?.resources?.diskMb || 0),
    pathScope: 'server-root-only',
    networkScope: nexu?.security?.nexusMark?.network || 'game-only',
    writeScope: nexu?.security?.nexusMark?.writeScope || 'server-root',
    sourceOfTruth: 'sqlite-allocation',
    advancedIsolation,
    hardening: [
      'absolute-path-sandbox',
      'per-server-root',
      'owner-only-terminal-gate',
      'ram-allocation-guard',
      'systemd-memorymax',
      'systemd-cpuquota',
      'systemd-readwritepaths',
      'systemd-private-tmp',
      ...(advancedIsolation ? [
        'systemd-private-devices',
        'systemd-capability-drop',
        'systemd-syscall-filter',
      ] : []),
      'safe-backup-exclusion',
      'no-docker-daemon',
    ],
    linuxPlan: process.platform === 'linux'
      ? {
        systemdUnit: `nexusmark-${server.id}.service`,
        memoryMax: `${ramMb}M`,
        cpuQuota: `${cpuLimitPercent(cpuCores)}%`,
        startupCpuQuota: `${startupCpuLimitPercent(cpuCores)}%`,
        noNewPrivileges: true,
        privateTmp: true,
        privateDevices: advancedIsolation,
        protectSystem: 'strict',
        protectProc: 'default',
        capabilityBoundingSet: advancedIsolation ? '' : 'systemd-default',
        addressFamilies: advancedIsolation ? ['AF_INET', 'AF_INET6', 'AF_UNIX'] : ['systemd-default'],
        systemCallFilter: advancedIsolation ? ['@system-service', '~@mount', '~@swap', '~@reboot', '~@raw-io', '~@privileged'] : ['systemd-default'],
      }
      : { note: 'Windows/macOS use path sandbox + process guard only.' },
    windowsPlan: process.platform === 'win32'
      ? {
        processTreeGuard: true,
        hardGuardMb: windowsHardGuardMb,
        taskKillOnViolation: true,
        hiddenWindows: true,
        pathScope: 'server-root-only',
        sourceOfTruth: 'SQLite server allocation',
      }
      : null,
  };
}

function wrapCommand(command, args, profile) {
  if (process.platform !== 'linux' || process.env.NEXUSPANEL_CGROUPS === '0' || !fs.existsSync('/run/systemd/system')) {
    return { command, args, unit: '' };
  }
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync('systemd-run', ['--version'], { stdio: 'ignore' });
  if (probe.status !== 0) return { command, args, unit: '' };
  clearStaleUnits(profile.serverId, spawnSync);
  launchSequence = (launchSequence + 1) % 1000000;
  const advancedIsolation = process.env.NEXUSPANEL_ADVANCED_ISOLATION !== '0' && profile.advancedIsolation !== false;
  const advancedProperties = advancedIsolation
    ? [
      '--property',
      'PrivateDevices=yes',
      '--property',
      'ProtectHome=read-only',
      '--property',
      'ProtectClock=yes',
      '--property',
      'ProtectKernelTunables=yes',
      '--property',
      'ProtectKernelModules=yes',
      '--property',
      'ProtectKernelLogs=yes',
      '--property',
      'ProtectControlGroups=yes',
      '--property',
      'CapabilityBoundingSet=',
      '--property',
      'SystemCallArchitectures=native',
      '--property',
      'SystemCallFilter=@system-service ~@mount ~@swap ~@reboot ~@raw-io ~@privileged',
      '--property',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    ]
    : [];
  const unit = [
    'nexusmark',
    String(profile.serverId).replace(/[^a-z0-9_.-]/gi, '-'),
    process.pid,
    Date.now().toString(36),
    launchSequence,
  ].join('-');
  return {
    command: 'systemd-run',
    args: [
      '--quiet',
      '--pipe',
      '--wait',
      '--collect',
      `--unit=${unit}`,
      '--property',
      `MemoryMax=${profile.memoryMaxMb}M`,
      '--property',
      `CPUQuota=${profile.startupCpuQuotaPercent || profile.cpuQuotaPercent}%`,
      '--property',
      'TasksMax=512',
      '--property',
      `WorkingDirectory=${profile.serverRoot}`,
      '--property',
      'NoNewPrivileges=yes',
      '--property',
      'PrivateTmp=yes',
      '--property',
      'ProtectSystem=strict',
      '--property',
      `ReadWritePaths=${profile.serverRoot}`,
      '--property',
      'RestrictSUIDSGID=yes',
      '--property',
      'LockPersonality=yes',
      ...advancedProperties,
      '--',
      command,
      ...args,
    ],
    unit: `${unit}.service`,
  };
}

function writeProfile(server, root, nexu = null) {
  const profile = profileForServer(server, nexu);
  const dir = path.join(externalDataRoot, 'nexus-mark', String(server.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  return profile;
}

function spawnOptions(baseOptions, profile) {
  return {
    ...baseOptions,
    env: {
      ...process.env,
      NEXUS_MARK: '1',
      NEXUS_MARK_CPU_CORES: String(profile.cpuCores),
      NEXUS_MARK_MEMORY_MB: String(profile.memoryMaxMb),
      NEXUS_MARK_SCOPE: profile.pathScope,
    },
    windowsHide: true,
  };
}

module.exports = {
  profileForServer,
  spawnOptions,
  wrapCommand,
  writeProfile,
};
