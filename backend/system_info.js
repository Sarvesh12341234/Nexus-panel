const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function commandNumber(command, args = []) {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const number = Number(output.split(/\s+/)[0]);
    return Number.isFinite(number) && number > 0 ? number : 0;
  } catch {
    return 0;
  }
}

function linuxCpuCount() {
  const nproc = commandNumber('nproc', ['--all']);
  if (nproc) return nproc;

  try {
    const text = execFileSync('lscpu', ['-p=CPU'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ids = new Set(text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
    if (ids.size) return ids.size;
  } catch {}

  try {
    const text = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const matches = text.match(/^processor\s*:/gm);
    if (matches?.length) return matches.length;
  } catch {}

  return 0;
}

function windowsCpuCount() {
  const powershell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
  return commandNumber(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum',
  ]);
}

function hostCpuCount() {
  const override = Number(process.env.NEXUSPANEL_CPU_CORES || 0);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const detected = process.platform === 'linux'
    ? linuxCpuCount()
    : process.platform === 'win32'
      ? windowsCpuCount()
      : 0;
  const nodeDetected = Number(os.availableParallelism?.() || os.cpus()?.length || 1);
  return Math.max(1, detected || nodeDetected || 1);
}

function hostMemoryStats() {
  if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
    const values = {};
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const match = line.match(/^([^:]+):\s+(\d+)/);
      if (match) values[match[1]] = Number(match[2]) * 1024;
    }
    const total = values.MemTotal || os.totalmem();
    const available = values.MemAvailable || os.freemem();
    return { total, free: available, used: Math.max(0, total - available) };
  }
  const total = os.totalmem();
  const free = os.freemem();
  return { total, free, used: Math.max(0, total - free) };
}

let lastCpuSnapshot = null;

function readProcCpuSnapshot() {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/stat')) return null;
  const first = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0] || '';
  const values = first.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4) return null;
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + (Number(value) || 0), 0);
  return { idle, total };
}

function hostCpuPercent() {
  const current = readProcCpuSnapshot();
  if (current) {
    if (!lastCpuSnapshot) {
      lastCpuSnapshot = current;
      return Math.min(100, Math.round(((os.loadavg()[0] || 0) / hostCpuCount()) * 100));
    }
    const idleDelta = current.idle - lastCpuSnapshot.idle;
    const totalDelta = current.total - lastCpuSnapshot.total;
    lastCpuSnapshot = current;
    if (totalDelta > 0) return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  }
  return Math.min(100, Math.round(((os.loadavg()[0] || 0) / hostCpuCount()) * 100));
}

module.exports = {
  hostCpuCount,
  hostCpuPercent,
  hostMemoryStats,
};
