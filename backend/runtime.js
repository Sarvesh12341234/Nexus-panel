const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { spawnOptions, wrapCommand } = require('./nexus_mark');
const { hostCpuCount } = require('./system_info');
const { ensureServerDirs } = require('./paths');

const processes = new Map();
const logs = new Map();
const players = new Map();
const intentionalStops = new Set();
let exitHandler = null;
const MAX_LOG_LINES = 600;

function appendLog(serverId, line) {
  const rows = logs.get(serverId) || [];
  rows.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  while (rows.length > MAX_LOG_LINES) rows.shift();
  logs.set(serverId, rows);
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
  return logs.get(serverId) || [];
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
  let command;
  let args;

  if (software.key === 'java-vanilla' || software.key === 'paper' || software.key === 'purpur') {
    assertCommandAvailable(
      'java',
      ['-version'],
      'Java runtime was not found in PATH. Install Java 21+ (Linux: apt install -y openjdk-21-jre-headless) then restart the server.',
    );
    command = 'java';
    args = [`-Xmx${server.max_memory_mb}M`, '-jar', executable, 'nogui'];
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
  const totalCpuCores = hostCpuCount();
  const cpuCores = Math.max(1, Math.min(totalCpuCores, Number(server.cpu_cores || storedProfile.cpuCores || 1)));
  const profile = {
    ...storedProfile,
    serverId: server.id,
    serverRoot: root,
    cpuCores,
    cpuQuotaPercent: cpuCores * 100,
    startupCpuQuotaPercent: cpuCores <= 3 ? Math.min(totalCpuCores, cpuCores * 4) * 100 : cpuCores * 100,
    memoryMaxMb: server.max_memory_mb || 1024,
    pathScope: storedProfile.pathScope || 'server-root-only',
  };
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
    appendLog(server.id, `[NexusPanel] Failed to start: ${error.message}`);
    processes.delete(server.id);
  });
  child.on('exit', (code, signal) => {
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
  appendLog(serverId, `> ${clean}`);
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
