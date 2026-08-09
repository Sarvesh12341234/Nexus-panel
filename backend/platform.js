'use strict';
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function commandExists(name) {
  const probe = process.platform === 'win32' ? spawnSync('where.exe', [name], { stdio: 'ignore', windowsHide: true }) : spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
  return probe.status === 0;
}
function distro() {
  if (process.platform !== 'linux') return process.platform === 'win32' ? 'windows' : process.platform;
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    return (text.match(/^ID=(.*)$/m)?.[1] || 'linux').replace(/^"|"$/g, '').toLowerCase();
  } catch { return 'linux'; }
}
function capabilities() {
  const linux = process.platform === 'linux';
  const windows = process.platform === 'win32';
  const systemd = linux && fs.existsSync('/run/systemd/system') && commandExists('systemctl');
  return {
    platform: process.platform,
    os: os.type(),
    release: os.release(),
    arch: process.arch,
    distro: distro(),
    linux, windows,
    systemd,
    nativeNexusMark: linux,
    processGuard: linux || windows,
    pathSandbox: true,
    resourceGuard: linux || windows,
    serviceMode: systemd ? 'systemd' : windows ? 'windows-service-or-foreground' : 'foreground',
    supported: ['linux', 'win32'].includes(process.platform),
  };
}
function doctor() {
  const c = capabilities();
  return {
    ...c,
    cpu: os.availableParallelism?.() || os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 1048576),
    checks: {
      node: process.versions.node,
      shell: c.windows ? commandExists('powershell') : commandExists('sh'),
      systemd: c.systemd,
      nativeSandbox: c.nativeNexusMark,
    },
    isolationTier: c.nativeNexusMark ? 'native-linux' : c.windows ? 'windows-process-guard' : 'portable-path-guard',
  };
}
module.exports = { capabilities, doctor, commandExists, distro };
