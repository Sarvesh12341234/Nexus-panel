const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { externalDataRoot } = require('./paths');
const { hostCpuCount } = require('./system_info');
const { nativeStatus } = require('./nexus_mark_native');
const { ensureServerIdentity, identitySupportStatus } = require('./nexus_mark_identity');
let launchSequence = 0;
let kernelStatusCache = { expiresAt: 0, value: null };

function cpuLimitPercent(cpuCores = 1) {
  const total = Math.max(1, hostCpuCount());
  const requested = Math.max(1, Math.min(total, Number(cpuCores) || 1));
  return requested * 100;
}

function startupCpuLimitPercent(cpuCores = 1) {
  const total = Math.max(1, hostCpuCount());
  const requested = Math.max(1, Math.min(total, Number(cpuCores) || 1));
  return requested <= 3 ? Math.min(total, requested * 2) * 100 : requested * 100;
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
    version: 2,
    mode: process.platform === 'linux' ? 'native-kernel-isolated' : 'direct-isolated',
    platform: process.platform,
    serverId: server.id,
    port: Number(server.port || nexu?.network?.port || 25565),
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
      'native-landlock-filesystem-lsm',
      'native-seccomp-bpf',
      'native-zero-resident-exec-runtime',
      'assigned-game-port-bind-only',
      'landlock-cross-domain-signal-scope',
      'landlock-unix-socket-scope',
      'automatic-compatible-policy-preflight',
      'verified-native-binary-rollback',
      'dedicated-locked-system-user',
      'inherited-per-server-posix-acl',
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
        memoryHigh: `${Math.max(256, Math.floor(ramMb * 0.95))}M`,
        memorySwapMax: '64M',
        cpuQuota: `${cpuLimitPercent(cpuCores)}%`,
        startupCpuQuota: `${startupCpuLimitPercent(cpuCores)}%`,
        noNewPrivileges: true,
        privateTmp: true,
        privateDevices: advancedIsolation,
        protectSystem: 'strict',
        protectProc: 'invisible-when-supported',
        capabilityBoundingSet: advancedIsolation ? '' : 'systemd-default',
        addressFamilies: advancedIsolation ? ['AF_INET', 'AF_INET6'] : ['systemd-default'],
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

function readCgroupControllers() {
  try {
    return fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8').trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function systemdProperties(profile, status, tier = 'maximum') {
  const root = profile.serverRoot;
  const properties = [
    `MemoryMax=${profile.memoryMaxMb}M`,
    `CPUQuota=${profile.startupCpuQuotaPercent || profile.cpuQuotaPercent}%`,
    'TasksMax=512',
    `WorkingDirectory=${root}`,
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    `ReadWritePaths=${root}`,
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'UMask=0077',
    'LimitCORE=0',
    'CapabilityBoundingSet=',
    'RestrictAddressFamilies=AF_INET AF_INET6',
    'KillMode=control-group',
    'OOMScoreAdjust=500',
  ];
  if (profile.nexusIdentity?.available) {
    properties.push(`User=${profile.nexusIdentity.name}`, `Group=${profile.nexusIdentity.group}`);
  }
  if (status.systemdVersion >= 243) properties.push('OOMPolicy=stop');
  if (status.controllers.includes('memory')) {
    properties.push(`MemoryHigh=${Math.max(256, Math.floor(profile.memoryMaxMb * 0.95))}M`);
    if (status.cgroupV2) properties.push('MemorySwapMax=64M');
  }
  if (status.controllers.includes('cpu')) properties.push('CPUWeight=100');
  if (status.controllers.includes('io')) properties.push('IOAccounting=yes', 'IOWeight=100');
  if (tier === 'core') return properties;

  properties.push(
    'PrivateDevices=yes',
    'ProtectHome=yes',
    'ProtectClock=yes',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    status.systemdVersion >= 258 ? 'ProtectControlGroups=strict' : 'ProtectControlGroups=yes',
    'ProtectHostname=yes',
    'RestrictNamespaces=yes',
    'RestrictRealtime=yes',
    'KeyringMode=private',
    'PrivateIPC=yes',
    'RemoveIPC=yes',
    'PrivateMounts=yes',
  );
  if (status.systemdVersion >= 247) properties.push('ProtectProc=invisible');
  if (tier === 'compatible') return properties;

  properties.push(
    'SystemCallArchitectures=native',
    'SystemCallFilter=~@mount @swap @reboot @raw-io @privileged',
    'PrivateUsers=yes',
  );
  if (status.systemdVersion >= 254) properties.push('MemoryKSM=no');
  if (status.systemdVersion >= 257) properties.push('PrivatePIDs=yes');
  if (status.systemdVersion >= 249 && Number(profile.port) > 0) {
    properties.push(
      'SocketBindDeny=any',
      `SocketBindAllow=tcp:${Number(profile.port)}`,
      `SocketBindAllow=udp:${Number(profile.port)}`,
    );
  }
  return properties;
}

function propertyArgs(properties) {
  return properties.flatMap((property) => ['--property', property]);
}

function kernelStatus({ refresh = false } = {}) {
  if (process.platform !== 'linux') {
    return { platform: process.platform, available: false, tier: 'process-guard', native: nativeStatus({ build: false }) };
  }
  if (!refresh && kernelStatusCache.value && kernelStatusCache.expiresAt > Date.now()) return kernelStatusCache.value;

  const native = nativeStatus({ build: true });
  const controllers = readCgroupControllers();
  const cgroupV2 = fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
  const systemdActive = process.env.NEXUSPANEL_CGROUPS !== '0' && fs.existsSync('/run/systemd/system');
  const versionProbe = systemdActive
    ? spawnSync('systemd-run', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    : { status: 1, stdout: '', stderr: 'systemd is not active' };
  const systemdVersion = Number(String(versionProbe.stdout || '').match(/systemd\s+(\d+)/i)?.[1] || 0);
  const base = {
    platform: 'linux',
    kernel: String(require('node:os').release()),
    native,
    cgroupV2,
    controllers,
    systemdActive,
    systemdVersion,
    identitySupport: identitySupportStatus(),
    testedAt: Date.now(),
  };
  if (versionProbe.status !== 0) {
    const value = {
      ...base,
      available: native.available,
      tier: native.available ? 'native-only' : 'process-guard',
      reason: String(versionProbe.error?.message || versionProbe.stderr || 'systemd-run unavailable').trim().slice(0, 500),
    };
    kernelStatusCache = { value, expiresAt: Date.now() + 10 * 60 * 1000 };
    return value;
  }

  const preflightParent = path.join(externalDataRoot, 'nexus-mark');
  const preflightRoot = path.join(preflightParent, `preflight-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(preflightParent, { recursive: true, mode: 0o750 });
    fs.mkdirSync(preflightRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    const value = {
      ...base,
      available: native.available,
      tier: native.available ? 'native-only' : 'process-guard',
      preflightPassed: false,
      reason: `preflight storage unavailable: ${error.message}`,
      failures: [],
    };
    kernelStatusCache = { value, expiresAt: Date.now() + 60 * 1000 };
    return value;
  }
  const testProfile = {
    serverRoot: preflightRoot,
    serverId: 'preflight',
    port: 65535,
    memoryMaxMb: 256,
    cpuQuotaPercent: 100,
    startupCpuQuotaPercent: 100,
  };
  let selected = '';
  const failures = [];
  try {
    for (const tier of ['maximum', 'compatible', 'core']) {
      const unit = `nexusmark-preflight-${process.pid}-${tier}-${Date.now().toString(36)}`;
      const payloadCommand = fs.existsSync('/usr/bin/java') ? '/usr/bin/java' : '/bin/true';
      const payloadArgs = payloadCommand.endsWith('/java') ? ['-version'] : [];
      const testCommand = native.available ? native.binary : payloadCommand;
      const testArgs = native.available
        ? ['--root', preflightRoot, '--port', '65535', '--', payloadCommand, ...payloadArgs]
        : payloadArgs;
      const result = spawnSync('systemd-run', [
        '--quiet', '--wait', '--collect', '--no-ask-password', `--unit=${unit}`,
        ...propertyArgs(systemdProperties(testProfile, base, tier)),
        '--', testCommand, ...testArgs,
      ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (result.status === 0) {
        selected = tier;
        break;
      }
      failures.push({ tier, detail: String(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500) });
    }
  } finally {
    if (path.dirname(preflightRoot) === preflightParent) {
      fs.rmSync(preflightRoot, { recursive: true, force: true });
    }
  }
  const value = {
    ...base,
    available: Boolean(selected || native.available),
    tier: selected || (native.available ? 'native-only' : 'process-guard'),
    preflightPassed: Boolean(selected),
    failures,
  };
  kernelStatusCache = { value, expiresAt: Date.now() + 10 * 60 * 1000 };
  return value;
}

function wrapCommand(command, args, profile) {
  if (process.platform !== 'linux') return { command, args, unit: '', engine: 'process-guard', policyTier: 'process-guard' };

  const status = kernelStatus();
  const native = status.native;
  const identity = ensureServerIdentity(profile, native.available ? native.binary : '');
  const launchProfile = { ...profile, nexusIdentity: identity };
  const nativeCommand = native.available ? native.binary : command;
  const nativeArgs = native.available
    ? [
      '--root', profile.serverRoot,
      '--port', String(Number(profile.port) || 25565),
      ...(identity.available ? ['--uid', String(identity.uid), '--gid', String(identity.gid)] : []),
      '--', command, ...args,
    ]
    : args;
  if (!status.preflightPassed) {
    return {
      command: nativeCommand,
      args: nativeArgs,
      unit: '',
      engine: native.available ? 'native-landlock-seccomp' : 'process-guard',
      policyTier: status.tier,
      nativeDetail: native.detail || native.reason || '',
      compatibilityDetail: status.failures?.[0]?.detail || status.reason || '',
      identity,
    };
  }

  clearStaleUnits(profile.serverId, spawnSync);
  launchSequence = (launchSequence + 1) % 1000000;
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
      ...propertyArgs(systemdProperties(launchProfile, status, status.tier)),
      '--',
      nativeCommand,
      ...nativeArgs,
    ],
    unit: `${unit}.service`,
    engine: native.available ? 'native-kernel+cgroup-v2' : 'systemd-kernel-fallback',
    policyTier: status.tier,
    nativeDetail: native.detail || native.reason || '',
    identity,
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
  const environment = { ...process.env };
  for (const variable of [
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_PROFILE',
    'GLIBC_TUNABLES', 'GCONV_PATH', 'BASH_ENV', 'ENV', 'PYTHONPATH',
    'PYTHONHOME', 'PERL5LIB', 'PERLLIB', 'RUBYLIB', 'NODE_OPTIONS',
  ]) delete environment[variable];
  return {
    ...baseOptions,
    env: {
      ...environment,
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
  nativeStatus,
  kernelStatus,
};
