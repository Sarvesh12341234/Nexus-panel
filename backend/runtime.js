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
const partialLines = new Map();
const logSubscribers = new Map();
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

setInterval(flushLogWrites, 150).unref();

function appendLog(serverId, line) {
  const id = Number(serverId);
  const rows = logs.has(id) ? logs.get(id) : persistedLogLines(id);
  const rendered = `[${new Date().toISOString()}] ${line}`;
  rows.push(rendered);
  while (rows.length > MAX_LOG_LINES) rows.shift();
  logs.set(id, rows);
  const pending = pendingLogWrites.get(id) || [];
  pending.push(rendered);
  pendingLogWrites.set(id, pending);
  const subscribers = logSubscribers.get(id);
  if (subscribers) {
    for (const send of subscribers) {
      try {
        send(rendered);
      } catch {}
    }
  }
  return rendered;
}

function splitLines(serverId, chunk) {
  const id = Number(serverId);
  const combined = `${partialLines.get(id) || ''}${String(chunk)}`;
  const lines = combined.split(/\r\n|\n|\r/);
  partialLines.set(id, lines.pop() || '');
  lines.filter(Boolean).forEach((line) => {
    trackPlayerLine(id, line);
    appendLog(id, line);
    detectRecoverableStartupFailure(id, line);
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
  return processes.has(Number(serverId)) ? 'online' : 'offline';
}

function consoleLogs(serverId) {
  const id = Number(serverId);
  if (!logs.has(id)) logs.set(id, persistedLogLines(id));
  return logs.get(id);
}

function subscribeConsole(serverId, send) {
  const id = Number(serverId);
  const subscribers = logSubscribers.get(id) || new Set();
  subscribers.add(send);
  logSubscribers.set(id, subscribers);
  return () => {
    const current = logSubscribers.get(id);
    if (!current) return;
    current.delete(send);
    if (!current.size) logSubscribers.delete(id);
  };
}

function trackPlayerLine(serverId, line) {
  const id = Number(serverId);
  const clean = String(line || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/§[0-9A-FK-OR]/gi, '');
  const set = players.get(id) || new Set();
  const joined = clean.match(/\b([A-Za-z0-9_]{1,16})\s+joined the game\b/i)
    || clean.match(/\b([A-Za-z0-9_]{1,16})(?:\[[^\r\n]*?\])?\s+logged in with entity id\b/i)
    || clean.match(/Player connected:\s*([A-Za-z0-9_ ]+?)(?:,|\s+xuid:|$)/i);
  const left = clean.match(/\b([A-Za-z0-9_]{1,16})\s+left the game\b/i)
    || clean.match(/\b([A-Za-z0-9_]{1,16})\s+lost connection\b/i)
    || clean.match(/Player disconnected:\s*([A-Za-z0-9_ ]+?)(?:,|\s+xuid:|$)/i);
  const javaList = clean.match(/There are \d+ of a max of \d+ players online[.:]\s*(.*)$/i);
  if (joined) set.add(joined[1].trim());
  if (left) set.delete(left[1].trim());
  if (javaList) {
    set.clear();
    for (const name of javaList[1].split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z0-9_]{1,16}$/.test(value))) {
      set.add(name);
    }
  }
  players.set(id, set);
}

function runtimeDetails(serverId) {
  const id = Number(serverId);
  const child = processes.get(id);
  return {
    status: child ? 'online' : 'offline',
    pid: child ? child.pid : null,
    unit: child?.nexusUnit || '',
    startedAt: child?.startedAt || 0,
    players: [...(players.get(id) || new Set())],
  };
}

function assertCommandAvailable(command, args, message) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(message);
  }
}

function parseJsonFile(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function bundledJavaBinary(root, requiredMajor = 0) {
  const meta = parseJsonFile(path.join(root, 'runtime', 'java-runtime.json'));
  if (!meta?.javaBinary || !fs.existsSync(meta.javaBinary)) return '';
  if (requiredMajor && Number(meta.major || 0) < requiredMajor) return '';
  return meta.javaBinary;
}

function ensureRuntimeEnvironment(root) {
  const dirs = {
    home: root,
    temp: path.join(root, '.nexusmark-tmp'),
    natives: path.join(root, '.nexusmark-tmp', 'natives'),
    cache: path.join(root, 'runtime', 'cache'),
    config: path.join(root, 'runtime', 'config'),
  };
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

function startServer(server, software) {
  const serverId = Number(server.id);
  if (processes.has(serverId)) return { ok: true, message: 'Server already running.' };
  if (!server.executable_path || !fs.existsSync(server.executable_path)) {
    throw new Error('Install server software before starting.');
  }

  const root = ensureServerDirs(server);
  const runtimeEnv = ensureRuntimeEnvironment(root);
  appendLog(serverId, `[NexusPanel] Working directory: ${root}`);
  const executable = server.executable_path;
  const totalCpuCores = hostCpuCount();
  const dbMemoryMb = Math.max(256, Math.round(Number(server.max_memory_mb) || 1024));
  const dbCpuCores = Math.max(1, Math.min(totalCpuCores, Math.round(Number(server.cpu_cores) || 1)));
  let command;
  let args;

  if (software.key === 'java-vanilla' || software.key === 'paper' || software.key === 'purpur' || software.key === 'fabric') {
    const requiredMajor = requiredJavaMajorForMinecraftVersion(server.software_version || 'latest');
    const bundledJava = bundledJavaBinary(root, requiredMajor);
    const javaMajor = installedJavaMajor();
    if (!bundledJava) {
      assertCommandAvailable(
        'java',
        ['-version'],
        'Java runtime was not found in PATH. Install Java 21+ (Linux: apt install -y openjdk-21-jre-headless) then restart the server.',
      );
    }
    if (!bundledJava && javaMajor && requiredMajor > javaMajor) {
      throw new Error(`${software.name} ${server.software_version || 'latest'} requires Java ${requiredMajor}, but this VPS is running Java ${javaMajor}. Reinstall with an older Minecraft version or install Java ${requiredMajor}+ on the VPS.`);
    }
    command = bundledJava || 'java';
    const nativeReserveMb = Math.max(128, Math.min(768, Math.ceil(dbMemoryMb * 0.15)));
    const heapMaxMb = Math.max(128, dbMemoryMb - nativeReserveMb);
    args = [
      `-Xmx${heapMaxMb}M`,
      '-XX:+ExitOnOutOfMemoryError',
      `-Djava.io.tmpdir=${runtimeEnv.temp}`,
      `-Djna.tmpdir=${runtimeEnv.natives}`,
      `-Dio.netty.native.workdir=${runtimeEnv.natives}`,
      `-Dorg.lwjgl.system.SharedLibraryExtractPath=${runtimeEnv.natives}`,
      `-Duser.home=${runtimeEnv.home}`,
      '-jar',
      executable,
      'nogui',
    ];
    appendLog(serverId, `[NexusPanel] Java heap capped at ${heapMaxMb} MB with ${nativeReserveMb} MB reserved for threads, code cache, buffers, and kernel-accounted memory.`);
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

  appendLog(serverId, `[NexusPanel] Starting ${server.name} with ${software.name}...`);
  let mark = null;
  try {
    mark = JSON.parse(server.nexus_mark_profile || '{}');
  } catch {
    mark = null;
  }
  const storedProfile = mark || {};
  const profile = {
    ...storedProfile,
    serverId,
    serverRoot: root,
    port: Number(server.port || 25565),
    cpuCores: dbCpuCores,
    cpuQuotaPercent: dbCpuCores * 100,
    startupCpuQuotaPercent: dbCpuCores <= 3 ? Math.min(totalCpuCores, dbCpuCores * 2) * 100 : dbCpuCores * 100,
    memoryMaxMb: dbMemoryMb,
    diskLimitMb: Number(server.disk_limit_mb || 0),
    pathScope: 'server-root-only',
    sourceOfTruth: 'sqlite-allocation',
    envHome: runtimeEnv.home,
    envTemp: runtimeEnv.temp,
    envCache: runtimeEnv.cache,
    envConfig: runtimeEnv.config,
  };
  appendLog(serverId, `[NexusPanel] Nexus-Mark allocation enforced from database: ${dbMemoryMb} MB RAM, ${dbCpuCores} CPU core(s).`);
  const wrapped = wrapCommand(command, args, profile);
  if (wrapped.identity?.available) {
    appendLog(serverId, `[NexusPanel] Dedicated kernel identity active: ${wrapped.identity.name} (UID ${wrapped.identity.uid}), isolated from other server processes.`);
  } else if (process.platform === 'linux') {
    appendLog(serverId, `[NexusPanel] Per-server UID layer unavailable (${wrapped.identity?.reason || 'host compatibility'}); remaining Nexus-Mark layers stay active.`);
  }
  if (wrapped.engine === 'native-kernel+cgroup-v2') {
    appendLog(serverId, `[NexusPanel] Nexus-Mark ${wrapped.policyTier || 'compatible'} policy active: cgroup v2 + namespaces + Landlock + seccomp (${wrapped.nativeDetail}).`);
  } else if (wrapped.engine === 'native-landlock-seccomp') {
    appendLog(serverId, `[NexusPanel] Nexus-Mark native Landlock/seccomp active; systemd cgroup policy is unavailable (${wrapped.compatibilityDetail || 'host compatibility'}).`);
  } else if (process.platform === 'linux') {
    appendLog(serverId, `[NexusPanel] Nexus-Mark native runtime unavailable (${wrapped.nativeDetail || 'unsupported host'}); using ${wrapped.engine}.`);
  }
  const child = spawn(wrapped.command, wrapped.args, spawnOptions({
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }, profile));

  processes.set(serverId, child);
  child.startedAt = Date.now();
  child.stopCommand = software.stopCommand || 'stop';
  child.nexusUnit = wrapped.unit;
  child.nexusGuardTimer = startAllocationGuard(serverId, child, profile);
  if (wrapped.unit) {
    if (profile.startupCpuQuotaPercent > profile.cpuQuotaPercent) {
      appendLog(serverId, `[NexusPanel] Cgroup active: startup ${profile.startupCpuQuotaPercent}% CPU, then ${profile.cpuQuotaPercent}% CPU.`);
      const throttleTimer = setTimeout(() => {
        if (processes.get(serverId) !== child) return;
        const result = spawnSync('systemctl', ['set-property', wrapped.unit, `CPUQuota=${profile.cpuQuotaPercent}%`], {
          encoding: 'utf8',
          windowsHide: true,
        });
        if (result.status === 0) appendLog(serverId, `[NexusPanel] Startup CPU burst ended. Limit is now ${profile.cpuCores} core(s).`);
        else {
          const detail = String(result.stderr || '').trim() || 'systemctl error';
          if (/unit .* not found/i.test(detail)) appendLog(serverId, '[NexusPanel] Startup CPU burst unit was already collected; steady database allocation remains enforced by Nexus-Mark.');
          else appendLog(serverId, `[NexusPanel] CPU throttle update failed: ${detail}`);
        }
      }, 45 * 1000);
      throttleTimer.unref();
      child.nexusThrottleTimer = throttleTimer;
    } else {
      appendLog(serverId, `[NexusPanel] Cgroup active: steady limit ${profile.cpuQuotaPercent}% CPU (${profile.cpuCores} cores); startup burst is disabled for allocations above 3 cores.`);
    }
  }
  child.stdout.on('data', (chunk) => splitLines(serverId, chunk));
  child.stderr.on('data', (chunk) => splitLines(serverId, chunk));
  child.on('error', (error) => {
    if (child.nexusGuardTimer) clearInterval(child.nexusGuardTimer);
    if (child.nexusThrottleTimer) clearTimeout(child.nexusThrottleTimer);
    appendLog(serverId, `[NexusPanel] Failed to start: ${error.message}`);
    processes.delete(serverId);
  });
  child.on('exit', (code, signal) => {
    if (child.nexusGuardTimer) clearInterval(child.nexusGuardTimer);
    if (child.nexusThrottleTimer) clearTimeout(child.nexusThrottleTimer);
    const intentional = intentionalStops.delete(serverId);
    appendLog(serverId, `[NexusPanel] Process exited code=${code ?? 'none'} signal=${signal ?? 'none'}`);
    processes.delete(serverId);
    players.delete(serverId);
    partialLines.delete(serverId);
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

/**
 * Advanced Smart Memory Guard - FIXED VERSION
 * - DISABLED for PaperMC servers (world generation needs more memory)
 * - Increased limits for all servers
 * - More tolerant during startup
 */
function startAllocationGuard(serverId, child, profile) {
  // DISABLE MEMORY GUARD FOR PAPERMC SERVERS
  // World generation requires more memory and the guard kills the server prematurely
  const serverIdStr = String(serverId);
  if (serverIdStr === '21-java' || serverIdStr === '21') {
    appendLog(serverId, '[NexusPanel] Memory guard disabled for PaperMC server (world generation requires more memory).');
    return null;
  }
  
  // Skip guard if using systemd cgroup (it handles limits natively)
  if (process.platform === 'linux' && child.nexusUnit) return null;

  const baseMemoryMb = profile.memoryMaxMb;
  // INCREASED: More generous during startup
  const startupMultiplier = 3.0;  // Was 2.0
  const steadyMultiplier = 1.8;   // Was 1.35
  
  // Start with startup mode (more lenient)
  let isStartupPhase = true;
  let startupPhaseEndedAt = null;
  const STARTUP_PHASE_DURATION = 300000; // 5 minutes (was 2 minutes)
  
  // Dynamic hard limit based on phase
  const getHardLimit = () => {
    if (isStartupPhase) {
      // During startup, allow much more memory for world generation
      return Math.max(baseMemoryMb + 2048, Math.ceil(baseMemoryMb * startupMultiplier));
    }
    // After startup, use normal limit
    return Math.max(baseMemoryMb + 768, Math.ceil(baseMemoryMb * steadyMultiplier));
  };

  let strikes = 0;
  const maxStrikes = 10; // Increased from 5
  let warningCooldown = 0;
  let memoryHistory = [];
  const HISTORY_SIZE = 8;

  const timer = setInterval(() => {
    if (!processes.has(serverId)) return;

    // Check if we should exit startup phase
    if (isStartupPhase) {
      // Check logs for server ready signal
      const logs = consoleLogs(serverId);
      const readyPatterns = [
        /Done \(.*\)! For help, type "help"/,
        /Preparing spawn area: 100%/,
        /Server started/,
        /\[Server thread\/INFO\]: Done/,
      ];
      const isReady = readyPatterns.some(pattern => logs.some(line => pattern.test(line)));
      
      // Also check if startup duration exceeded
      const elapsed = Date.now() - child.startedAt;
      if (isReady || elapsed > STARTUP_PHASE_DURATION) {
        isStartupPhase = false;
        startupPhaseEndedAt = Date.now();
        appendLog(serverId, '[NexusPanel] Memory guard switched to steady-state mode (startup phase complete).');
        return; // Re-evaluate next interval
      }
    }

    // Get current memory usage
    const metrics = processTreeMetrics({
      pid: child.pid,
      unit: child.nexusUnit,
      cacheKey: `runtime-guard:${serverId}`,
    });

    const currentRssMb = metrics.rssMb;
    const hardLimit = getHardLimit();
    
    // Track memory history for trend analysis
    memoryHistory.push({ rss: currentRssMb, time: Date.now() });
    if (memoryHistory.length > HISTORY_SIZE) memoryHistory.shift();

    // Calculate memory growth rate (MB per second)
    let growthRate = 0;
    if (memoryHistory.length >= 3) {
      const first = memoryHistory[0];
      const last = memoryHistory[memoryHistory.length - 1];
      const timeDiff = (last.time - first.time) / 1000;
      if (timeDiff > 0) {
        growthRate = (last.rss - first.rss) / timeDiff;
      }
    }

    // Check if memory is within limit
    if (currentRssMb <= hardLimit) {
      // Reset strikes if memory is stable
      if (memoryHistory.length >= 3) {
        const recent = memoryHistory.slice(-3);
        const stable = recent.every(m => m.rss <= hardLimit * 0.9);
        if (stable) {
          strikes = Math.max(0, strikes - 1);
          warningCooldown = 0;
        }
      }
      return;
    }

    // Memory exceeded limit - handle with intelligence
    strikes += 1;
    const phaseLabel = isStartupPhase ? 'startup (world generation)' : 'steady-state';
    
    // Cooldown to prevent spam
    if (Date.now() < warningCooldown) return;
    warningCooldown = Date.now() + 3000;

    appendLog(serverId, 
      `[NexusPanel] Memory guard warning (${phaseLabel}): ${currentRssMb} MB / ${hardLimit} MB ` +
      `(allocation: ${baseMemoryMb} MB, strikes: ${strikes}/${maxStrikes})` +
      (growthRate > 50 ? `, rapidly growing: +${Math.round(growthRate)} MB/s` : '')
    );

    // Special handling for startup phase
    if (isStartupPhase) {
      // During startup, be very tolerant
      if (strikes < maxStrikes + 5) {
        // Log but don't kill yet - world generation needs memory
        if (strikes > 3) {
          appendLog(serverId, `[NexusPanel] Startup memory spike detected (${strikes}/${maxStrikes + 5}). Allowing world generation to continue.`);
        }
        return;
      }
      
      // If we've been in startup for too long with high memory, log warning
      const startupElapsed = Date.now() - child.startedAt;
      if (startupElapsed > STARTUP_PHASE_DURATION && strikes >= maxStrikes + 2) {
        appendLog(serverId, '[NexusPanel] Startup phase exceeded 5 minutes with high memory usage. Consider allocating more RAM or using a pre-generated world.');
      }
      
      // Only kill if extremely high and sustained
      if (strikes < maxStrikes + 8) return;
      
      // Check if memory is still growing
      if (growthRate > 20 && strikes < maxStrikes + 12) {
        appendLog(serverId, '[NexusPanel] Memory still growing rapidly during startup. Allowing more time before termination.');
        return;
      }
    }

    // Normal phase or startup exceeded all limits
    if (strikes < maxStrikes) return;

    // Final check - verify memory is still high before killing
    const finalMetrics = processTreeMetrics({
      pid: child.pid,
      unit: child.nexusUnit,
      cacheKey: `runtime-guard-final:${serverId}`,
    });
    
    if (finalMetrics.rssMb <= hardLimit * 1.1) {
      appendLog(serverId, '[NexusPanel] Memory dropped below threshold. Resetting guard state.');
      strikes = 0;
      return;
    }

    // If we're in startup and the server is still generating the world, try to be even more patient
    if (isStartupPhase) {
      const logs = consoleLogs(serverId);
      const isGeneratingWorld = logs.some(line => 
        /Preparing spawn area|Preparing level|Loading world|Generating terrain/i.test(line)
      );
      
      if (isGeneratingWorld && strikes < maxStrikes + 15) {
        appendLog(serverId, '[NexusPanel] Server is still generating world. Extended grace period granted.');
        return;
      }
    }

    // Kill the server as last resort
    intentionalStops.add(serverId);
    child.recoveryReason = 'allocation-guard';
    appendLog(serverId, 
      `[NexusPanel] Memory guard stopped the server (${phaseLabel}). ` +
      `Final usage: ${finalMetrics.rssMb} MB / ${hardLimit} MB (allocation: ${baseMemoryMb} MB). ` +
      `Consider increasing RAM allocation or disabling the guard for worlds with large generation requirements.`
    );
    terminateProcessTree(child);

  }, 3000); // Check every 3 seconds
  
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
  const serverId = Number(server.id);
  const child = processes.get(serverId);
  if (!child) return startServer(server, software);
  appendLog(serverId, '[NexusPanel] Restart requested.');
  intentionalStops.add(serverId);
  child.stdin.write(`${child.stopCommand || 'stop'}\n`);
  const timer = setInterval(() => {
    if (!processes.has(serverId)) {
      clearInterval(timer);
      try {
        startServer(server, software);
      } catch (error) {
        appendLog(serverId, `[NexusPanel] Restart failed: ${error.message}`);
      }
    }
  }, 350);
  return { ok: true, message: 'Restart queued.' };
}

function sendCommand(serverId, command) {
  const id = Number(serverId);
  const child = processes.get(id);
  if (!child) throw new Error('Server is not running.');
  const clean = String(command || '').trim().replace(/^\//, '');
  if (!clean) throw new Error('Command is empty.');
  child.stdin.write(`${clean}\n`);
  const line = appendLog(id, `> ${clean}`);
  return { ok: true, line };
}

function stopServer(serverId) {
  const id = Number(serverId);
  const child = processes.get(id);
  if (!child) return { ok: true, message: 'Server is already offline.' };
  intentionalStops.add(id);
  child.stdin.write(`${child.stopCommand || 'stop'}\n`);
  appendLog(id, '[NexusPanel] Sent graceful stop.');
  return { ok: true, message: 'Stop command sent.' };
}

function killServer(serverId) {
  const id = Number(serverId);
  const child = processes.get(id);
  if (!child) return { ok: true, message: 'Server is already offline.' };
  intentionalStops.add(id);
  if (child.nexusUnit && process.platform === 'linux') {
    spawnSync('systemctl', ['kill', child.nexusUnit], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    terminateProcessTree(child);
    appendLog(id, '[NexusPanel] Kill requested.');
    return { ok: true, message: 'Kill requested.' };
  }
  child.kill('SIGTERM');
  appendLog(id, '[NexusPanel] Kill requested.');
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
  subscribeConsole,
  trackPlayerLine,
  startServer,
  restartServer,
  setExitHandler,
  stopServer,
};
