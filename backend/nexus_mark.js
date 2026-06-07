const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function cpuLimitPercent(cpuCores = 1) {
  const total = Math.max(1, os.cpus().length || 1);
  const requested = Math.max(1, Math.min(total, Number(cpuCores) || 1));
  return Math.max(1, Math.round((requested / total) * 100));
}

function profileForServer(server, nexu = null) {
  const cpuCores = Math.max(1, Math.min(os.cpus().length || 1, Number(server.cpu_cores || nexu?.resources?.cpuCores || 1)));
  const ramMb = Math.max(256, Number(server.max_memory_mb || nexu?.resources?.ramMb || 1024));
  return {
    engine: 'nexus-mark',
    version: 1,
    mode: 'direct-isolated',
    platform: process.platform,
    serverId: server.id,
    cpuCores,
    cpuQuotaPercent: cpuLimitPercent(cpuCores),
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
        systemdScope: `nexusmark-${server.id}.scope`,
        memoryMax: `${ramMb}M`,
        cpuQuota: `${cpuLimitPercent(cpuCores)}%`,
        noNewPrivileges: true,
        privateTmp: true,
        protectSystem: 'strict-planned',
      }
      : { note: 'Windows/macOS use path sandbox + process guard only.' },
  };
}

function writeProfile(server, root, nexu = null) {
  const profile = profileForServer(server, nexu);
  const dir = path.join(root, 'runtime', 'nexus-mark');
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
  writeProfile,
};
