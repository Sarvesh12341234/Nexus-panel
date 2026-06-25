const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { spawnOptions } = require('./nexus_mark');

const processes = new Map();
const logs = new Map();
const players = new Map();
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
  });
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

  const root = server.server_path;
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
  const child = spawn(command, args, spawnOptions({
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }, mark || { cpuCores: 1, memoryMaxMb: server.max_memory_mb || 1024, pathScope: 'server-root-only' }));

  processes.set(server.id, child);
  child.stopCommand = software.stopCommand || 'stop';
  child.stdout.on('data', (chunk) => splitLines(server.id, chunk));
  child.stderr.on('data', (chunk) => splitLines(server.id, chunk));
  child.on('error', (error) => {
    appendLog(server.id, `[NexusPanel] Failed to start: ${error.message}`);
    processes.delete(server.id);
  });
  child.on('exit', (code, signal) => {
    appendLog(server.id, `[NexusPanel] Process exited code=${code ?? 'none'} signal=${signal ?? 'none'}`);
    processes.delete(server.id);
    players.delete(server.id);
  });

  return { ok: true, message: 'Server start requested.' };
}

function restartServer(server, software) {
  const child = processes.get(server.id);
  if (!child) return startServer(server, software);
  appendLog(server.id, '[NexusPanel] Restart requested.');
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
  child.stdin.write(`${child.stopCommand || 'stop'}\n`);
  appendLog(serverId, '[NexusPanel] Sent graceful stop.');
  return { ok: true, message: 'Stop command sent.' };
}

function killServer(serverId) {
  const child = processes.get(serverId);
  if (!child) return { ok: true, message: 'Server is already offline.' };
  child.kill('SIGTERM');
  appendLog(serverId, '[NexusPanel] Kill requested.');
  return { ok: true, message: 'Kill requested.' };
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
  stopServer,
};
