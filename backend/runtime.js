const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { spawnOptions, wrapCommand } = require('./nexus_mark');
const { hostCpuCount } = require('./system_info');
const { ensureServerDirs, externalDataRoot } = require('./paths');
const { processTreeMetrics } = require('./process_metrics');
const { installedJavaMajor, requiredJavaMajorForMinecraftVersion } = require('./software');

const processes = new Map();
const logs = new Map();
const players = new Map();
const intentionalStops = new Set();
const pendingLogWrites = new Map();
const logWriteChains = new Map();
let exitHandler = null;
const MAX_LOG_LINES = 600;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const logRoot = path.join(externalDataRoot, 'logs');
fs.mkdirSync(logRoot, { recursive: true });

function logPath(serverId) {
  return path.join(logRoot, `server-${Number(serverId)}.log`);
}

function persistedLogLines(serverId) {
  const filePath = logPath(serverId);
  try {
    const stats = fs.statSync(filePath);
    const bytes = Math.min(stats.size, 512 * 1024);
    const buffer = Buffer.alloc(bytes);
    const file = fs.openSync(filePath, 'r');
    fs.readSync(file, buffer, 0, bytes, Math.max(0, stats.size - bytes));
    fs.closeSync(file);
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_LOG_LINES);
  } catch {
    return [];
  }
}

function flushLogWrites() {
  for (const [serverId, lines] of pendingLogWrites) {
    pendingLogWrites.delete(serverId);
    const filePath = logPath(serverId);
    const chunk = `${lines.join('\n')}\n`;
    const previous = logWriteChains.get(serverId) || Promise.resolve();
    const next = previous.then(async () => {
      const stats = await fs.promises.stat(filePath).catch(() => null);
      if (stats?.size > MAX_LOG_BYTES) {
        await fs.promises.rm(`${filePath}.1`, { force: true }).catch(() => {});
        await fs.promises.rename(filePath, `${filePath}.1`).catch(() => {});
      }
      await fs.promises.appendFile(filePath, chunk, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => {});
    logWriteChains.set(serverId, next);
  }
}

setInterval(flushLogWrites, 750).unref();

function appendLog(serverId, line) {
  const rows = logs.has(serverId) ? logs.get(serverId) : persistedLogLines(serverId);
  const rendered = `[${new Date().toISOString()}] ${line}`;
  rows.push(rendered);
  while (rows.length > MAX_LOG_LINES) rows.shift();
  logs.set(serverId, rows);
  const pending = pendingLogWrites.get(serverId) || [];
  pending.push(rendered);
  pendingLogWrites.set(serverId, pending);
  return rendered;
}

function splitLines(serverId, chunk) {
  String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => {
    trackPlayerLine(serverId, line);
    appendLog(serverId, line);
    detectRecoverableStartupFailure(serverId, line);
  });
}

function detectRecoverableStartupFailure(serverId, line) {
  if (!/(?:error opening file:\s*server\.properties|failed to (?:open|load|read).*server\.properties|server\.properties.*(?:invalid|permission denied|is a directory))/i.test(line)) return;
  const child = processes.get(serverId);
  if (!child || child.recoveryReason) return;
  child.recoveryReason = 'server-properties';
  appendLog(serverId, '[NexusPanel] Auto-heal detected an unreadable server.properties file. Stopping the failed launch for a clean rebuild.');
  if (child.nexusUnit && process.platform === 'linux') {
    spawnSync('systemctl', ['kill', child.nexusUnit], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function runtimeStatus(serverId) {
  return processes.has(serverId) ? 'online' : 'offline';
}

function consoleLogs(serverId) {
  if (!logs.has(serverId)) logs.set(serverId, persistedLogLines(serverId));
  return logs.get(serverId);
}

function trackPlayerLine(serverId, line) {
  const set = players.get(serverId) || new Set();
  const joined = line.match(/(?:INFO\]: )?([A-Za-z0-9_]{2,16}) joined the game/i)
    || line.match(/Player connected:\s*([A-Za-z0-9_ ]+)/i);
  const left = line.match(/(?:INFO\]: )?([A-Za-z0-9_]{2,16}) left the game/i)
    || line.match(/Player disconnected:\s*([A-Za-z0-9_ ]+)/i);
  if (joined) set.add(joined[1].trim());
  if (left) set.delete(left[1].trim());
  players.set(serverId, set);
}

function runtimeDetails(serverId) {
  const child = processes.get(serverId);
  return {
    status: child ? 'online' : 'offline',
    pid: child ? child.pid : null,
    unit: child?.nexusUnit || '',
    startedAt: child?.startedAt || 0,
    players: [...(players.get(serverId) || new Set())],
  };
}

function assertCommandAvailable(command, args, message) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(message);
  }
}

function startServer(server, software) {
  if (processes.has(server.id)) return { ok: true, message: 'Server already running.' };
  if (!server.executable_path || !fs.existsSync(server.executable_path)) {
    throw new Error('Install server software before starting.');
  }

  const root = ensureServerDirs(server);
  appendLog(server.id, `[NexusPanel] Working directory: ${root}`);
  const executable = server.executable_path;
  const totalCpuCores = hostCpuCount();
  const dbMemoryMb = Math.max(256, Math.round(Number(server.max_memory_mb) || 1024));
  const dbCpuCores = Math.max(1, Math.min(totalCpuCores, Math.round(Number(server.cpu_cores) || 1)));
  let command;
  let args;

  if (software.key === 'java-vanilla' || software.key === 'paper' || software.key === 'purpur' || software.key === 'fabric') {
    assertCommandAvailable(
      'java',
      ['-version'],
      'Java runtime was not found in PATH. Install Java 21+ (Linux: apt install -y openjdk-21-jre-headless) then restart the server.',
    );
    const javaMajor = installedJavaMajor();
    const requiredMajor = requiredJavaMajorForMinecraftVersion(server.software_version || 'latest');
    if (javaMajor && requiredMajor > javaMajor) {
      throw new Error(`${software.name} ${server.software_version || 'latest'} requires Java ${requiredMajor}, but this VPS is running Java ${javaMajor}. Reinstall with an older Minecraft version or install Java ${requiredMajor}+ on the VPS.`);
    }
    command = 'java';
    args = [`-Xmx${dbMemoryMb}M`, '-jar', executable, 'nogui'];
  } else if (software.key === 'pocketmine') {
    const header = fs.readFileSync(executable, { encoding: 'utf8', flag: 'r' }).slice(0, 80);
    if (!header.includes('<?php')) {
      throw new Error('PocketMine file is not a valid PHAR. Reinstall PocketMine from the Software tab.');
    }
    const runtimeMetaPath = path.join(root, 'runtime', 'pocketmine-php.json');
    let phpBinary = 'php';
    if (fs.existsSync(runtimeMetaPath)) {
      phpBinary = JSON.parse(fs.readFileSync(runtimeMetaPath, 'utf8')).phpBinary || phpBinary;
    }
    const phpCheck = spawnSync(phpBinary, ['-v'], { windowsHide: true, encoding: 'utf8' });
    if (phpCheck.error || phpCheck.status !== 0) {
      throw new Error('PocketMine bundled PHP is missing or broken. Reinstall PocketMine from the Software tab.');
    }
    command = phpBinary;
    args = [executable, '--no-wizard', '--disable-ansi'];
  } else {
    command = executable;
    args = Array.isArray(software.startArgs) ? software.startArgs : [];
  }

  appendLog(server.id, `[NexusPanel] Starting ${server.name} with ${software.name}...`);
  let mark = null;
  try {
    mark = JSON.parse(server.nexus_mark_profile || '{}');
  } catch {
    mark = null;
  }
  const storedProfile = mark || {};
  const profile = {
    ...storedProfile,
    serverId: server.id,
    serverRoot: root,
    cpuCores: dbCpuCores,
    cpuQuotaPercent: dbCpuCores * 100,
    startupCpuQuotaPercent: dbCpuCores <= 3 ? Math.min(totalCpuCores, dbCpuCores * 4) * 100 : dbCpuCores * 100,
    memoryMaxMb: dbMemoryMb,
    diskLimitMb: Number(server.disk_limit_mb || 0),
    pathScope: 'server-root-only',
    sourceOfTruth: 'sqlite-allocation',
  };
  appendLog(server.id, `[NexusPanel] Nexus-Mark allocation enforced from database: ${dbMemoryMb} MB RAM, ${dbCpuCores} CPU core(s).`);
  const wrapped = wrapCommand(command, args, profile);
  const child = spawn(wrapped.command, wrapped.args, spawnOptions({
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }, profile));

  processes.set(server.id, child);
  child.startedAt = Date.now();
  child.stopCommand = software.stopCommand || 'stop';
  child.nexusUnit = wrapped.unit;
  child.nexusGuardTimer = startAllocationGuard(server.id, child, profile);
  if (wrapped.unit) {
    if (profile.startupCpuQuotaPercent > profile.cpuQuotaPercent) {
      appendLog(server.id, `[NexusPanel] Cgroup active: startup ${profile.startupCpuQuotaPercent}% CPU, then ${profile.cpuQuotaPercent}% CPU.`);
      const throttleTimer = setTimeout(() => {
        if (!processes.has(server.id)) return;
        const result = spawnSync('systemctl', ['set-property', wrapped.unit, `CPUQuota=${profile.cpuQuotaPercent}%`], {
          encoding: 'utf8',
          windowsHide: true,
        });
        if (result.status === 0) appendLog(server.id, `[NexusPanel] Startup CPU burst ended. Limit is now ${profile.cpuCores} core(s).`);
        else appendLog(server.id, `[NexusPanel] CPU throttle update failed: ${String(result.stderr || '').trim() || 'systemctl error'}`);
      }, 90 * 1000);
      throttleTimer.unref();
    } else {
      appendLog(server.id, `[NexusPanel] Cgroup active: steady limit ${profile.cpuQuotaPercent}% CPU (${profile.cpuCores} cores); startup burst is disabled for allocations above 3 cores.`);
    }
  }
  child.stdout.on('data', (chunk) => splitLines(server.id, chunk));
  child.stderr.on('data', (chunk) => splitLines(server.id, chunk));
  child.on('error', (error) => {
    if (child.nexusGuardTimer) clearInterval(child.nexusGuardTimer);
    appendLog(server.id, `[NexusPanel] Failed to start: ${error.message}`);
    processes.delete(server.id);
  });
  child.on('exit', (code, signal) => {
    if (child.nexusGuardTimer) clearInterval(child.nexusGuardTimer);
    const intentional = intentionalStops.delete(server.id);
    appendLog(server.id, `[NexusPanel] Process exited code=${code ?? 'none'} signal=${signal ?? 'none'}`);
    processes.delete(server.id);
    players.delete(server.id);
    if (exitHandler) {
      Promise.resolve(exitHandler({
        server,
        software,
        code,
        signal,
        intentional,
        uptimeMs: Date.now() - child.startedAt,
        recoveryReason: child.recoveryReason || '',
      }))
        .catch((error) => appendLog(server.id, `[NexusPanel] Exit recovery failed: ${error.message}`));
    }
  });

  return { ok: true, message: 'Server start requested.' };
}

function startAllocationGuard(serverId, child, profile) {
  if (process.platform === 'linux' && child.nexusUnit) return null;
  const hardLimitMb = Math.max(profile.memoryMaxMb + 384, Math.ceil(profile.memoryMaxMb * 1.35));
  let strikes = 0;
  const timer = setInterval(() => {
    if (!processes.has(serverId)) return;
    const metrics = processTreeMetrics({
      pid: child.pid,
      unit: child.nexusUnit,
      cacheKey: `runtime-guard:${serverId}`,
    });
    if (metrics.rssMb <= hardLimitMb) {
      strikes = 0;
      return;
    }
    strikes += 1;
    appendLog(serverId, `[NexusPanel] Nexus-Mark guard warning: process tree is using ${metrics.rssMb} MB over hard guard ${hardLimitMb} MB (allocation ${profile.memoryMaxMb} MB).`);
    if (strikes < 3) return;
    intentionalStops.add(serverId);
    child.recoveryReason = 'allocation-guard';
    appendLog(serverId, '[NexusPanel] Nexus-Mark guard stopped the server for exceeding its database RAM allocation. File-edited metadata cannot raise this limit.');
    terminateProcessTree(child);
  }, 5000);
  timer.unref();
  return timer;
}

function terminateProcessTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
}

function restartServer(server, software) {
  const child = processes.get(server.id);
  if (!child) return startServer(server, software);
  appendLog(server.id, '[NexusPanel] Restart requested.');
  intentionalStops.add(server.id);
  child.stdin.write(`${child.stopCommand || 'stop'}\n`);
  const timer = setInterval(() => {
    if (!processes.has(server.id)) {
      clearInterval(timer);
      try {
        startServer(server, software);
      } catch (error) {
        appendLog(server.id, `[NexusPanel] Restart failed: ${error.message}`);
      }
    }
  }, 350);
  return { ok: true, message: 'Restart queued.' };
}

function sendCommand(serverId, command) {
  const child = processes.get(serverId);
  if (!child) throw new Error('Server is not running.');
  const clean = String(command || '').trim().replace(/^\//, '');
  if (!clean) throw new Error('Command is empty.');
  child.stdin.write(`${clean}\n`);
  const line = appendLog(serverId, `> ${clean}`);
  return { ok: true, line };
}

function stopServer(serverId) {
  const child = processes.get(serverId);
  if (!child) return { ok: true, message: 'Server is already offline.' };
  intentionalStops.add(serverId);
  child.stdin.write(`${child.stopCommand || 'stop'}\n`);
  appendLog(serverId, '[NexusPanel] Sent graceful stop.');
  return { ok: true, message: 'Stop command sent.' };
}

function killServer(serverId) {
  const child = processes.get(serverId);
  if (!child) return { ok: true, message: 'Server is already offline.' };
  intentionalStops.add(serverId);
  if (child.nexusUnit && process.platform === 'linux') {
    spawnSync('systemctl', ['kill', child.nexusUnit], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    terminateProcessTree(child);
    appendLog(serverId, '[NexusPanel] Kill requested.');
    return { ok: true, message: 'Kill requested.' };
  }
  child.kill('SIGTERM');
  appendLog(serverId, '[NexusPanel] Kill requested.');
  return { ok: true, message: 'Kill requested.' };
}

function setExitHandler(handler) {
  exitHandler = typeof handler === 'function' ? handler : null;
}

module.exports = {
  appendLog,
  consoleLogs,
  killServer,
  runtimeDetails,
  runtimeStatus,
  sendCommand,
  startServer,
  restartServer,
  setExitHandler,
  stopServer,
};
