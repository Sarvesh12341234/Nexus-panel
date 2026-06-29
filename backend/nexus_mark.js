const fs = require('node:fs');
const path = require('node:path');
const { externalDataRoot } = require('./paths');
const { hostCpuCount } = require('./system_info');

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

function profileForServer(server, nexu = null) {
  const cpuCores = Math.max(1, Math.min(hostCpuCount(), Number(server.cpu_cores || nexu?.resources?.cpuCores || 1)));
  const ramMb = Math.max(256, Number(server.max_memory_mb || nexu?.resources?.ramMb || 1024));
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
    hardening: [
      'absolute-path-sandbox',
      'per-server-root',
      'owner-only-terminal-gate',
      'ram-allocation-guard',
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
        protectSystem: 'strict-planned',
      }
      : { note: 'Windows/macOS use path sandbox + process guard only.' },
  };
}

function wrapCommand(command, args, profile) {
  if (process.platform !== 'linux' || process.env.NEXUSPANEL_CGROUPS === '0' || !fs.existsSync('/run/systemd/system')) {
    return { command, args, unit: '' };
  }
  const probe = require('node:child_process').spawnSync('systemd-run', ['--version'], { stdio: 'ignore' });
  if (probe.status !== 0) return { command, args, unit: '' };
  const unit = `nexusmark-${String(profile.serverId).replace(/[^a-z0-9_.-]/gi, '-')}`;
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
