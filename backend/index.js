const express = require('express');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { stdin, stdout } = require('node:process');
const { createZip } = require('./archive');
const { backupDatabase, db, getUserCount, verifyDatabase } = require('./db');
const { AdaptiveEngine } = require('./adaptive_engine');
const { getUserTimezone, setUserTimezone, getAllTimezones } = require('./timezone');
const { applyTweaks, optimizerStatus, planCommands } = require('./optimizer');
const { assertInside, backupsRoot, displayPath, ensureServerDirs, pluginTarget, serverPath, serversRoot, softwareRoot } = require('./paths');
const { clearSoftwareVersionCache, defaultSoftware, findSoftware, pluginKindForFile, resolveDownload, softwareCatalog, softwareVersions } = require('./software');
const { builtinTemplates, findTemplate, nexuExample, normalizeNexuTemplate } = require('./templates');
const { profileForServer, writeProfile } = require('./nexus_mark');
const { appendLog, consoleLogs, killServer, restartServer, runtimeDetails, runtimeStatus, sendCommand, setExitHandler, startServer, stopServer } = require('./runtime');
const { copyDirectoryContents, extractArchive, extractArchiveInto, findFile, isZipFile, zipCollisions } = require('./zip_utils');
const { hostCpuCount, hostCpuPercent, hostMemoryStats } = require('./system_info');
const { diagnoseRuntime, knowledgeStatus } = require('./repair_knowledge');
const {
  SESSION_COOKIE,
  authMiddleware,
  clearSession,
  clearSessionCookie,
  createSession,
  createUser,
  hashPassword,
  permissions,
  publicUser,
  requireAccess,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} = require('./auth');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataRoot = path.join(__dirname, '..', 'data');
const healthPath = path.join(dataRoot, 'panel_health.json');
const editionPath = path.join(dataRoot, 'edition');
const terminalSessions = new Map();
const wakeWatchers = new Map();
const passwordResetRequests = new Map();
const keyedOperations = new Map();
const crashHistory = new Map();
const crashRestartTimers = new Map();
const autoBackupInFlight = new Set();
const adaptiveEngine = new AdaptiveEngine();
let adaptiveMaintenanceStatus = { lastRunAt: 0, actions: [] };
let databaseHealthStatus = { ...verifyDatabase(), checkedAt: Date.now(), snapshotAt: 0 };
const FIXED_UPDATE_REPO = 'https://github.com/Sarvesh12341234/Nexus-panel.git';
const PANEL_VERSION = '1.2.0';
let updateStatus = {
  running: false,
  progress: 0,
  message: 'Idle',
  startedAt: 0,
  finishedAt: 0,
  exitCode: null,
};

app.set('trust proxy', true);

app.use('/api/servers/:id/files/upload-chunk', express.raw({ type: 'application/octet-stream', limit: '40mb' }));
app.use('/api/servers/:id/files/upload', express.raw({ type: 'application/octet-stream', limit: '40mb' }));
app.use('/api/network/upload-test', express.raw({ type: 'application/octet-stream', limit: '64mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use('/pictures', express.static(path.join(__dirname, '..', 'pictures'), {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/bootstrap', (_req, res) => {
  res.json({
    needsSetup: getUserCount() === 0,
    permissions,
  });
});

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0;
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1' ? 1 : 0;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function hostMemoryLimitMb() {
  const reserveMb = process.platform === 'win32' ? 512 : 384;
  return Math.max(256, Math.floor(os.totalmem() / 1024 / 1024) - reserveMb);
}

function clampMemoryMb(value, fallback = 1024) {
  return clampNumber(value, 256, hostMemoryLimitMb(), Math.min(fallback, hostMemoryLimitMb()));
}

function settingValue(key, fallback = '') {
  const row = db.prepare('SELECT value FROM panel_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function ensureSettingValue(key, factory) {
  const existing = settingValue(key, '');
  if (existing) return existing;
  const value = typeof factory === 'function' ? factory() : factory;
  setSettingValue(key, value);
  return value;
}

function panelEdition() {
  return (process.env.NEXUSPANEL_EDITION || (fs.existsSync(editionPath) ? fs.readFileSync(editionPath, 'utf8').trim() : '') || 'normal').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'normal';
}

function isHostEdition() {
  return panelEdition() === 'host';
}

function setSettingValue(key, value) {
  db.prepare(`
    INSERT INTO panel_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value ?? ''));
}

function panelSettingsPayload(user = null) {
  const edition = panelEdition();
  const hostToken = reqOwnerSafeHostToken();
  const defaultTag = edition === 'host' ? 'host-v1.2.0' : 'normal-v1.2.0';
  const configuredTag = settingValue('update_target_tag', defaultTag);
  return {
    version: PANEL_VERSION,
    terminalEnabled: settingValue('terminal_enabled', '0') === '1',
    timeZone: user ? getUserTimezone(user.id) : 'UTC',
    updateRepo: FIXED_UPDATE_REPO,
    publicBaseUrl: settingValue('public_base_url', process.env.NEXUSPANEL_PUBLIC_URL || ''),
    edition,
    updateTag: configuredTag,
    updateStatus,
    hostApiTokenPreview: edition === 'host' && user?.role === 'owner' ? `${hostToken.slice(0, 8)}....${hostToken.slice(-6)}` : '',
    nexusMarkEnabled: settingValue('nexus_mark_enabled', '1') === '1',
    maxAllocatableMemoryMb: hostMemoryLimitMb(),
    maxCpuCores: hostCpuCount(),
    platform: process.platform,
    nexuExample: edition === 'host' ? nexuExample() : null,
    hostMaintenanceMode: edition === 'host' && settingValue('host_maintenance_mode', '0') === '1',
    hostServerQuota: edition === 'host' ? clampNumber(settingValue('host_server_quota', '10'), 1, 500, 10) : 0,
  };
}

function normalizeCrashLine(line) {
  return String(line || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\b(password|token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[A-Fa-f0-9]{8,}/g, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/[A-Za-z]:\\[^\s]+|\/(?:[^\s/]+\/)+[^\s]+/g, '<path>')
    .trim()
    .slice(0, 240);
}

function crashSignature(server, software, code, signal) {
  const lines = consoleLogs(server.id)
    .slice(-24)
    .map(normalizeCrashLine)
    .filter((line) => line && !line.startsWith('[NexusPanel]'));
  const sample = lines.slice(-6).join(' | ') || `exit=${code ?? 'none'} signal=${signal ?? 'none'}`;
  const fingerprint = `${software?.key || server.software_key || server.type}|${code ?? 'none'}|${signal ?? 'none'}|${sample}`;
  return {
    signature: crypto.createHash('sha256').update(fingerprint).digest('hex'),
    sample,
  };
}

function rememberCrash(server, software, code, signal) {
  const crash = crashSignature(server, software, code, signal);
  db.prepare(`
    INSERT INTO repair_crash_state (server_id, signature, software_key, sample, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      signature = excluded.signature,
      software_key = excluded.software_key,
      sample = excluded.sample,
      last_seen_at = excluded.last_seen_at
  `).run(server.id, crash.signature, software?.key || server.software_key || '', crash.sample, Date.now());
  return crash;
}

function redactRepairCommand(command) {
  return String(command || '')
    .replace(/\b(password|token|secret|api[-_]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=<redacted>')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .slice(0, 800);
}

function safeReplayCommand(command, server) {
  const clean = String(command || '').trim();
  if (!clean || clean.length > 800 || /[\r\n;&|`$<>]/.test(clean)) return { safe: false, command: '' };
  const tokens = clean.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) || [];
  const executable = path.basename(tokens.shift() || '').toLowerCase();
  if (!['chmod', 'mkdir', 'touch', 'cp', 'dos2unix'].includes(executable)) return { safe: false, command: '' };
  if (executable === 'mkdir' && !tokens.includes('-p')) return { safe: false, command: '' };
  if (executable === 'cp' && !tokens.some((token) => /^-[A-Za-z]*f/.test(token))) return { safe: false, command: '' };
  const root = ensureServerDirs(server);
  const pathTokens = tokens.filter((token) => (
    !token.startsWith('-')
    && !/^[0-7]{3,4}$/.test(token)
    && !/^[ugoa]*[+-][rwxXst]+$/.test(token)
  ));
  if (!pathTokens.length) return { safe: false, command: '' };
  try {
    for (const token of pathTokens) {
      const candidate = path.isAbsolute(token) ? token : path.resolve(root, token);
      assertInside(root, candidate);
    }
  } catch {
    return { safe: false, command: '' };
  }
  return { safe: true, command: clean };
}

function recordTerminalRepairOutcome({ serverId, command, code }) {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(serverId));
  const crash = server && db.prepare('SELECT * FROM repair_crash_state WHERE server_id = ?').get(server.id);
  if (!server || !crash || Date.now() - Number(crash.last_seen_at) > 4 * 60 * 60 * 1000) return null;
  const safety = safeReplayCommand(command, server);
  const preview = redactRepairCommand(command);
  const commandHash = crypto.createHash('sha256').update(String(command)).digest('hex');
  db.prepare(`
    INSERT INTO repair_command_observations (
      server_id, signature, software_key, command_hash, command_text,
      command_preview, safe_to_replay, exit_code, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, signature, command_hash) DO UPDATE SET
      command_text = excluded.command_text,
      command_preview = excluded.command_preview,
      safe_to_replay = excluded.safe_to_replay,
      exit_code = excluded.exit_code,
      observed_at = excluded.observed_at
  `).run(
    server.id,
    crash.signature,
    crash.software_key,
    commandHash,
    safety.command,
    preview,
    safety.safe ? 1 : 0,
    Number(code),
    Date.now(),
  );
  appendLog(server.id, `[NexusPanel] Repair learner observed terminal command (${safety.safe ? 'eligible after stability validation' : 'evidence only'}): ${preview}`);
  return { safe: safety.safe, preview };
}

function validateStableTerminalRepairs() {
  const cutoff = Date.now() - 60 * 1000;
  const candidates = db.prepare(`
    SELECT observation.*
    FROM repair_command_observations observation
    JOIN repair_crash_state crash ON crash.server_id = observation.server_id AND crash.signature = observation.signature
    WHERE observation.exit_code = 0
      AND observation.observed_at <= ?
      AND observation.validated_at = 0
  `).all(cutoff);
  const validated = [];
  for (const candidate of candidates) {
    if (runtimeStatus(candidate.server_id) !== 'online') continue;
    db.prepare(`
      UPDATE repair_command_observations
      SET stable_success_count = stable_success_count + 1, validated_at = ?
      WHERE id = ?
    `).run(Date.now(), candidate.id);
    appendLog(candidate.server_id, `[NexusPanel] Repair learner validated terminal fix after stable runtime: ${candidate.command_preview}`);
    validated.push(candidate.id);
  }
  return validated;
}

function learnRepairPlaybook(server, report) {
  const crash = db.prepare('SELECT * FROM repair_crash_state WHERE server_id = ?').get(server.id);
  if (!crash || Date.now() - Number(crash.last_seen_at) > 7 * 24 * 60 * 60 * 1000) return null;
  const actions = Array.isArray(report.actions) ? report.actions.slice(0, 20) : [];
  db.prepare(`
    INSERT INTO repair_playbooks (
      signature, software_key, sample, actions_json, learned_from_server_id,
      success_count, last_learned_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(signature) DO UPDATE SET
      software_key = excluded.software_key,
      sample = excluded.sample,
      actions_json = excluded.actions_json,
      learned_from_server_id = excluded.learned_from_server_id,
      success_count = repair_playbooks.success_count + 1,
      last_learned_at = excluded.last_learned_at
  `).run(crash.signature, crash.software_key, crash.sample, JSON.stringify(actions), server.id, Date.now());
  return { signature: crash.signature.slice(0, 12), actions: actions.length };
}

async function replayLearnedRepair(server, software, crash) {
  const playbook = db.prepare(`
    SELECT * FROM repair_playbooks
    WHERE signature = ? AND software_key = ? AND success_count > 0
  `).get(crash.signature, software?.key || server.software_key || '');
  const learnedCommands = db.prepare(`
    SELECT * FROM repair_command_observations
    WHERE server_id = ? AND signature = ? AND software_key = ?
      AND safe_to_replay = 1 AND stable_success_count > 0 AND command_text != ''
    ORDER BY validated_at DESC
    LIMIT 5
  `).all(server.id, crash.signature, software?.key || server.software_key || '');
  if (!playbook && !learnedCommands.length) return null;
  appendLog(server.id, `[NexusPanel] Learned recovery matched ${crash.signature.slice(0, 12)}. Replaying previously validated repairs.`);
  const root = ensureServerDirs(server);
  for (const learned of learnedCommands) {
    await runShellCommand(learned.command_text, root);
    db.prepare(`
      UPDATE repair_command_observations
      SET replay_count = replay_count + 1, last_replayed_at = ?
      WHERE id = ?
    `).run(Date.now(), learned.id);
    appendLog(server.id, `[NexusPanel] Replayed validated terminal repair: ${learned.command_preview}`);
  }
  const report = await runServerRepair(server, software);
  if (playbook) {
    db.prepare(`
      UPDATE repair_playbooks
      SET replay_count = replay_count + 1, last_replayed_at = ?
      WHERE signature = ?
    `).run(Date.now(), crash.signature);
  }
  appendLog(server.id, `[NexusPanel] Learned recovery completed: ${report.summary}`);
  return report;
}

function backupIntervalMinutesFrom(server) {
  const minutes = Number(server.backup_interval_minutes || 0);
  if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes);
  return Math.max(1, Number(server.backup_interval_hours || 24)) * 60;
}

function parseBackupIntervalMinutes(body, fallbackMinutes = 1440) {
  if (body.backupIntervalMinutes !== undefined) return clampNumber(body.backupIntervalMinutes, 1, 5256000, fallbackMinutes);
  const amount = Number(body.backupIntervalValue ?? body.backupIntervalHours ?? fallbackMinutes / 60);
  const unit = String(body.backupIntervalUnit || (body.backupIntervalHours !== undefined ? 'hours' : 'minutes')).toLowerCase();
  const multiplier = unit.startsWith('hour') || unit === 'hr' || unit === 'hrs' ? 60 : 1;
  return clampNumber(amount * multiplier, 1, 5256000, fallbackMinutes);
}

function reqOwnerSafeHostToken() {
  return ensureSettingValue('host_api_token', () => crypto.randomBytes(32).toString('base64url'));
}

function templateRows() {
  const custom = db.prepare('SELECT payload FROM nexu_templates ORDER BY name ASC').all()
    .map((row) => {
      try {
        const normalized = normalizeNexuTemplate(JSON.parse(row.payload));
        return {
          ...normalized,
          game: normalized.game.name,
          edition: normalized.game.edition,
          softwareKey: normalized.runtime.softwareKey,
          port: normalized.resources.ports[0]?.port || 25565,
          memoryMb: normalized.resources.ramMb,
          cpuCores: normalized.resources.cpuCores,
          diskMb: normalized.resources.diskMb,
          startArgs: normalized.runtime.start.args,
          propertyMode: normalized.properties.mode,
          nexu: normalized,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const seen = new Set();
  return [...builtinTemplates(), ...custom].filter((template) => {
    if (seen.has(template.key)) return false;
    seen.add(template.key);
    return true;
  });
}

function shellForPlatform(command) {
  return process.platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', command] }
    : { command: '/bin/sh', args: ['-lc', command] };
}

function ownerOnly(req) {
  return req.user && req.user.role === 'owner';
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function templateValue(text, server, root) {
  return String(text || '')
    .replaceAll('{{root}}', root)
    .replaceAll('{{port}}', String(server.port || 25565))
    .replaceAll('{{serverName}}', String(server.name || 'server').replace(/[^A-Za-z0-9_-]+/g, '-'));
}

function nexuSoftwareForServer(server) {
  const nexu = parseJsonObject(server.nexu_payload);
  if (!nexu || !nexu.runtime?.start?.executable) return null;
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const executable = templateValue(nexu.runtime.start.executable, server, root);
  const executablePath = path.isAbsolute(executable) ? executable : path.join(root, executable);
  return {
    key: nexu.runtime.softwareKey || server.software_key || nexu.key,
    name: nexu.name || server.software_key || 'Nexu Template',
    edition: server.type,
    executable: path.basename(executablePath),
    startArgs: (nexu.runtime.start.args || []).map((arg) => templateValue(arg, server, root)),
    stopCommand: nexu.runtime.start.stopCommand || 'stop',
    pluginKinds: [],
    nexu,
  };
}

function softwareForServer(server) {
  return findSoftware(server.software_key)
    || (server.type === 'java' || server.type === 'bedrock' ? defaultSoftware(server.type) : null)
    || nexuSoftwareForServer(server);
}

function nexuExecutablePath(server, software) {
  if (!software?.nexu) return server.executable_path;
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const executable = templateValue(software.nexu.runtime.start.executable, server, root);
  return path.isAbsolute(executable) ? executable : path.join(root, executable);
}

function safeAttachmentName(fileName) {
  return path.basename(String(fileName || 'download.bin')).replace(/[\\/:*?"<>|]+/g, '-');
}

function contentDisposition(fileName) {
  const safe = safeAttachmentName(fileName).replace(/["\\]/g, '_');
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

async function streamDownload(req, res, absolutePath, fileName) {
  const stats = await fs.promises.stat(absolutePath).catch(() => null);
  if (!stats || !stats.isFile()) return res.status(404).json({ error: 'Download file not found.' });

  const accelPrefix = process.env.NEXUSPANEL_X_ACCEL_PREFIX;
  const accelRoot = process.env.NEXUSPANEL_X_ACCEL_ROOT;
  if (accelPrefix && accelRoot && !req.headers.range) {
    const resolvedRoot = path.resolve(accelRoot);
    const resolvedFile = path.resolve(absolutePath);
    if (resolvedFile.startsWith(`${resolvedRoot}${path.sep}`) || resolvedFile === resolvedRoot) {
      const relative = path.relative(resolvedRoot, resolvedFile).split(path.sep).map(encodeURIComponent).join('/');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(fileName));
      res.setHeader('X-Accel-Redirect', `${accelPrefix.replace(/\/+$/, '')}/${relative}`);
      return res.end();
    }
  }

  const size = stats.size;
  const rangeHeader = String(req.headers.range || '');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(fileName));

  if (!rangeHeader) {
    res.setHeader('Content-Length', size);
    return fs.createReadStream(absolutePath, { highWaterMark: 1024 * 1024 }).pipe(res);
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  end = Math.min(end, size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  return fs.createReadStream(absolutePath, { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fileSha256Hex(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

function runShellCommand(command, cwd, onOutput) {
  return new Promise((resolve, reject) => {
    const shell = shellForPlatform(command);
    const child = spawn(shell.command, shell.args, { cwd, env: process.env, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-4000);
      if (onOutput) onOutput(String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-4000);
      if (onOutput) onOutput(String(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output.trim() || `Command failed with exit ${code}`));
    });
  });
}

async function installNexuTemplate(server) {
  const nexu = parseJsonObject(server.nexu_payload);
  if (!nexu?.runtime?.install?.commands?.length) throw new Error('This Nexu template has no installer commands.');
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  db.prepare(`
    UPDATE servers
    SET install_status = 'installing', install_progress = 8, install_message = ?
    WHERE id = ?
  `).run(`Running ${nexu.runtime.install.mode || 'nexu'} installer`, server.id);
  let progress = 12;
  if (nexu.runtime.install.mode === 'steamcmd' && process.platform === 'linux' && !commandWorks('steamcmd')) {
    db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?').run(progress, 'SteamCMD missing. Installing requirement...', server.id);
    installSteamcmdRequirement();
  }
  for (const rawCommand of nexu.runtime.install.commands) {
    const command = templateValue(rawCommand, server, root);
    appendLog(server.id, `[NexusPanel] Nexu install: ${command}`);
    await runShellCommand(command, root, (chunk) => {
      progress = Math.min(94, progress + 1);
      db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?')
        .run(progress, String(chunk).trim().slice(-180) || 'Installing Nexu template', server.id);
    });
  }
  const software = nexuSoftwareForServer(server);
  const executablePath = nexuExecutablePath(server, software);
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Nexu install finished but executable was not found: ${path.relative(root, executablePath)}`);
  }
  if (process.platform !== 'win32') await fs.promises.chmod(executablePath, 0o755).catch(() => {});
  db.prepare(`
    UPDATE servers
    SET executable_path = ?, install_status = 'installed', install_progress = 100, install_message = ?
    WHERE id = ?
  `).run(executablePath, `Installed ${nexu.name}`, server.id);
  appendLog(server.id, `[NexusPanel] Nexu template installed: ${nexu.name}.`);
}

function requestPublicHost(req) {
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const hostHeader = forwarded || String(req.headers.host || '').trim();
  const host = hostHeader.replace(/:\d+$/, '');
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) return host;
  const nets = os.networkInterfaces();
  for (const rows of Object.values(nets)) {
    for (const item of rows || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

async function networkStats() {
  if (process.platform === 'linux' && fs.existsSync('/proc/net/dev')) {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    const rows = lines.map((line) => {
      const [nameRaw, dataRaw] = line.split(':');
      if (!dataRaw) return null;
      const values = dataRaw.trim().split(/\s+/).map(Number);
      const name = nameRaw.trim();
      if (name === 'lo') return null;
      return { name, rxBytes: values[0] || 0, txBytes: values[8] || 0 };
    }).filter(Boolean);
    return {
      interfaces: rows,
      inboundBytes: rows.reduce((sum, row) => sum + row.rxBytes, 0),
      outboundBytes: rows.reduce((sum, row) => sum + row.txBytes, 0),
    };
  }
  return { interfaces: [], inboundBytes: 0, outboundBytes: 0 };
}

function otpHash(email, code) {
  return crypto.createHash('sha256').update(`${String(email).toLowerCase()}:${code}:${reqOwnerSafeHostToken()}`).digest('hex');
}

async function sendPasswordOtp(email, code) {
  const subject = 'NexusPanel password reset OTP';
  const text = `Your NexusPanel password reset OTP is ${code}. It expires in 10 minutes.`;
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#070b10;color:#f4f8fb;font-family:Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;color:transparent">Your NexusPanel reset code is ${code}.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#070b10;padding:32px 14px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#111820;border:1px solid #30404d;border-radius:8px;overflow:hidden">
        <tr><td style="height:5px;background:#41e69b"></td></tr>
        <tr><td style="padding:32px">
          <div style="display:inline-block;width:42px;height:42px;line-height:42px;text-align:center;background:#173c35;border:1px solid #41e69b;border-radius:8px;color:#9dffd0;font-size:20px;font-weight:800">N</div>
          <div style="margin-top:18px;color:#41e69b;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px">NexusPanel Security</div>
          <h1 style="margin:8px 0 10px;color:#ffffff;font-size:26px;line-height:1.2">Reset your password</h1>
          <p style="margin:0;color:#a9b7c5;font-size:15px;line-height:1.7">Enter this one-time code on the NexusPanel reset page. It expires in 10 minutes.</p>
          <div style="margin:26px 0;padding:22px 12px;background:#05080c;border:2px solid #41e69b;border-radius:8px;color:#b4ffdc;font-family:Consolas,Monaco,monospace;font-size:38px;font-weight:800;letter-spacing:10px;text-align:center">${code}</div>
          <div style="padding:14px;background:#0b1219;border-left:3px solid #5ed8ff;color:#9cabb8;font-size:13px;line-height:1.6">Never share this code. NexusPanel staff will not ask for it. If you did not request a reset, no action is required.</div>
        </td></tr>
        <tr><td style="padding:18px 32px;background:#0b1117;border-top:1px solid #26333e;color:#71808d;font-size:12px">Automated security message from your NexusPanel VPS.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const apiUrl = process.env.NEXUSPANEL_EMAIL_API_URL;
  const apiKey = process.env.NEXUSPANEL_EMAIL_API_KEY;
  if (apiUrl && globalThis.fetch) {
    const provider = String(process.env.NEXUSPANEL_EMAIL_PROVIDER || '').toLowerCase();
    const isResend = provider === 'resend' || apiUrl.includes('api.resend.com');
    const isBrevo = provider === 'brevo' || apiUrl.includes('api.brevo.com');
    const isSendGrid = provider === 'sendgrid' || apiUrl.includes('api.sendgrid.com');
    const from = process.env.NEXUSPANEL_EMAIL_FROM;
    if (isResend && !from) throw new Error('NEXUSPANEL_EMAIL_FROM is required for Resend.');
    if ((isBrevo || isSendGrid) && !from) throw new Error('NEXUSPANEL_EMAIL_FROM is required for this email provider.');
    const body = isResend
      ? { from, to: [email], subject, text, html }
      : isBrevo
        ? { sender: { email: from, name: 'NexusPanel' }, to: [{ email }], subject, textContent: text, htmlContent: html }
        : isSendGrid
          ? {
            personalizations: [{ to: [{ email }] }],
            from: { email: from, name: 'NexusPanel' },
            subject,
            content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
          }
          : { to: email, from: from || undefined, subject, text, html, textContent: text, htmlContent: html };
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? (isBrevo ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }) : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 240);
      throw new Error(`Email API failed with ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return 'OTP sent by configured email API.';
  }

  if (process.platform !== 'win32' && fs.existsSync('/usr/sbin/sendmail')) {
    const boundary = `nexus-${crypto.randomBytes(12).toString('hex')}`;
    const from = process.env.NEXUSPANEL_EMAIL_FROM || 'noreply@nexuspanel.local';
    const message = [
      `To: ${email}`,
      `From: NexusPanel <${from}>`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const result = spawnSync('/usr/sbin/sendmail', ['-t'], { input: message, encoding: 'utf8' });
    if (result.status === 0) return 'OTP sent by local sendmail.';
  }

  const logPath = path.join(dataRoot, 'password-reset-otp.log');
  await fs.promises.mkdir(dataRoot, { recursive: true });
  await fs.promises.appendFile(logPath, `${new Date().toISOString()} ${email} ${code}\n`, { mode: 0o600 });
  return 'No email provider configured. Owner can read data/password-reset-otp.log on the VPS.';
}

function recoverServerFolders() {
  if (!fs.existsSync(serversRoot)) return [];
  const recovered = [];
  const existingIds = new Set(db.prepare('SELECT id FROM servers').all().map((row) => Number(row.id)));
  for (const entry of fs.readdirSync(serversRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(\d+)-(.+)$/);
    if (!match) continue;
    const id = Number(match[1]);
    if (!id || existingIds.has(id)) continue;
    const root = path.join(serversRoot, entry.name);
    const propertiesPath = path.join(root, 'server.properties');
    const properties = fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, 'utf8') : '';
    const portMatch = properties.match(/(?:server-port|server-portv4)\s*=\s*(\d+)/i);
    const jar = fs.readdirSync(root).find((name) => name.toLowerCase().endsWith('.jar'));
    const hasBedrock = fs.existsSync(path.join(root, 'bedrock_server')) || fs.existsSync(path.join(root, 'bedrock_server.exe'));
    const hasPocketMine = fs.existsSync(path.join(root, 'PocketMine-MP.phar'));
    const type = hasBedrock || hasPocketMine ? 'bedrock' : 'java';
    const softwareKey = hasPocketMine ? 'pocketmine' : hasBedrock ? 'bedrock-vanilla' : jar?.toLowerCase().includes('purpur') ? 'purpur' : jar?.toLowerCase().includes('paper') ? 'paper' : 'java-vanilla';
    const executable = hasPocketMine
      ? path.join(root, 'PocketMine-MP.phar')
      : hasBedrock
        ? path.join(root, process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server')
        : jar ? path.join(root, jar) : '';
    const name = entry.name.slice(match[1].length + 1).replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) || `Server ${id}`;
    db.prepare(`
      INSERT OR IGNORE INTO servers (
        id, name, type, port, max_memory_mb, auto_restart, crash_backup,
        scheduled_backups, backup_retention, server_path, software_key,
        executable_path, install_status, install_progress, install_message, cpu_cores
      )
      VALUES (?, ?, ?, ?, 1024, 1, 1, 1, 4, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id,
      name,
      type,
      clampNumber(portMatch?.[1], 1, 65535, type === 'java' ? 25565 : 19132),
      root,
      softwareKey,
      executable,
      executable ? 'installed' : 'missing',
      executable ? 100 : 0,
      executable ? 'Recovered from server folder.' : 'Recovered folder; executable missing.',
    );
    recovered.push({ id, name, root });
  }
  return recovered;
}

function serverPayload(server, req = null) {
  const software = softwareForServer(server);
  const status = runtimeStatus(server.id);
  const host = server.host && server.host !== '127.0.0.1' ? server.host : (req ? requestPublicHost(req) : server.host);
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    host,
    port: server.port,
    status,
    maxMemoryMb: server.max_memory_mb,
    cpuCores: server.cpu_cores || 1,
    diskLimitMb: server.disk_limit_mb || 0,
    templateKey: server.template_key || '',
    ownerUserId: server.owner_user_id || null,
    nexusMarkProfile: server.nexus_mark_profile || '',
    nexusMark: profileForServer(server, parseJsonObject(server.nexu_payload)),
    autoStart: Boolean(server.auto_start),
    autoRestart: Boolean(server.auto_restart),
    crashBackup: Boolean(server.crash_backup),
    scheduledBackups: Boolean(server.scheduled_backups),
    backupIntervalMinutes: backupIntervalMinutesFrom(server),
    backupIntervalHours: server.backup_interval_hours,
    lastBackupAt: server.last_backup_at,
    backupRetention: server.backup_retention,
    wakeOnJoin: Boolean(server.wake_on_join),
    whitelist: Boolean(server.whitelist),
    tunnelProvider: 'none',
    publicAlias: server.public_alias,
    startupDelaySec: server.startup_delay_sec,
    serverPath: server.server_path ? displayPath(server.server_path) : '',
    softwareKey: software ? software.key : server.software_key || '',
    softwareName: software ? software.name : 'Unconfigured',
    softwareVersion: server.software_version || 'latest',
    executablePath: server.executable_path ? displayPath(server.executable_path) : '',
    installStatus: server.install_status,
    installProgress: server.install_progress,
    installMessage: server.install_message,
    eulaAgreed: hasJavaEula(server),
    createdAt: server.created_at,
  };
}

function userRows() {
  db.prepare('DELETE FROM users WHERE role != ? AND expires_at > 0 AND expires_at <= ?').run('owner', Date.now());
  return db.prepare(`
    SELECT id, email, name, role, access_level, expires_at, created_at
    FROM users
    ORDER BY role DESC, email ASC
  `).all().map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    accessLevel: user.access_level,
    expiresAt: user.expires_at || 0,
    createdAt: user.created_at,
  }));
}

function adminExpiresAt(body) {
  const mode = String(body.adminDurationMode || 'permanent').toLowerCase();
  if (mode === 'permanent') return 0;
  const value = clampNumber(body.adminDurationValue, 1, 525600, 60);
  const unit = String(body.adminDurationUnit || 'minutes').toLowerCase();
  const minutes = unit.startsWith('year') ? value * 525600
    : unit.startsWith('day') ? value * 1440
      : unit.startsWith('hour') ? value * 60
        : value;
  return Date.now() + Math.max(1, minutes) * 60 * 1000;
}

function durationMs(body, fallbackMinutes = 60, maxMinutes = 1440) {
  const value = clampNumber(body.durationValue ?? body.accessDurationValue ?? body.adminDurationValue, 1, maxMinutes, fallbackMinutes);
  const unit = String(body.durationUnit || body.accessDurationUnit || body.adminDurationUnit || 'minutes').toLowerCase();
  const minutes = unit.startsWith('day') ? value * 1440
    : unit.startsWith('hour') ? value * 60
      : value;
  return Math.max(1, Math.min(minutes, maxMinutes)) * 60 * 1000;
}

function randomSixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function withKeyedOperation(key, task) {
  const previous = keyedOperations.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  keyedOperations.set(key, queued);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (keyedOperations.get(key) === queued) keyedOperations.delete(key);
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(value)) {
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd')
      || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
  }
  return true;
}

async function validatePublicBackupUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Enter a valid public backup URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP or HTTPS backup URLs are allowed.');
  }
  if (!url.pathname.includes('/api/public/backups/')) {
    throw new Error('This is not a NexusPanel public backup URL.');
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Backup imports cannot connect to local or private network addresses.');
  }
  return url;
}

function ensureBackupShareCode(server, body = {}) {
  const ttl = durationMs(body, 60, 24 * 60);
  const existing = db.prepare('SELECT * FROM backup_share_codes WHERE server_id = ?').get(server.id);
  if (existing && existing.expires_at > Date.now()) return existing;
  let code = randomSixDigitCode();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const used = db.prepare('SELECT server_id FROM backup_share_codes WHERE code = ? AND server_id != ?').get(code, server.id);
    if (!used) break;
    code = randomSixDigitCode();
  }
  db.prepare(`
    INSERT INTO backup_share_codes (server_id, code, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP
  `).run(server.id, code, Date.now() + ttl);
  return db.prepare('SELECT * FROM backup_share_codes WHERE server_id = ?').get(server.id);
}

function browserFromUserAgent(userAgent) {
  const ua = String(userAgent || '');
  if (/Edg\//i.test(ua)) return 'Microsoft Edge';
  if (/OPR\//i.test(ua)) return 'Opera';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
  if (/curl\//i.test(ua)) return 'curl';
  return 'Unknown';
}

function deviceFromUserAgent(userAgent) {
  const ua = String(userAgent || '');
  const osName = /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
        : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
          : /Linux/i.test(ua) ? 'Linux'
            : 'Unknown OS';
  const form = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobile|Android|iPhone/i.test(ua) ? 'Phone' : 'Desktop';
  return `${form} Â· ${osName}`;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket.remoteAddress || '';
}

function recordLoginEvent(req, user) {
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 420);
  db.prepare(`
    INSERT INTO login_events (user_id, email, ip, device, browser, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, user.email, clientIp(req).slice(0, 80), deviceFromUserAgent(userAgent), browserFromUserAgent(userAgent), userAgent);
  db.prepare('DELETE FROM login_events WHERE id NOT IN (SELECT id FROM login_events ORDER BY id DESC LIMIT 10)').run();
}

function loginEventRows(limit = 10) {
  return db.prepare(`
    SELECT id, user_id, email, ip, device, browser, user_agent, created_at
    FROM login_events
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map((event) => ({
    id: event.id,
    userId: event.user_id,
    email: event.email,
    ip: event.ip,
    device: event.device,
    browser: event.browser,
    userAgent: event.user_agent,
    createdAt: event.created_at,
  }));
}

function readHealthFile() {
  try {
    return JSON.parse(fs.readFileSync(healthPath, 'utf8'));
  } catch {
    return null;
  }
}

async function runHealthCheck(force = false) {
  const previous = fs.existsSync(healthPath) ? readHealthFile() : null;
  const now = Date.now();
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  if (!force && previous && now - Number(previous.checkedAt || 0) < fiveDaysMs) return previous;

  const checks = [];
  const add = (name, ok, message) => checks.push({ name, ok: Boolean(ok), message });
  fs.mkdirSync(dataRoot, { recursive: true });

  const databaseVerification = verifyDatabase();
  databaseHealthStatus = { ...databaseVerification, checkedAt: now, snapshotAt: databaseHealthStatus.snapshotAt || 0 };
  add('SQLite database', databaseVerification.ok, databaseVerification.ok
    ? 'quick_check passed and foreign keys are consistent'
    : `${databaseVerification.quickCheck}; ${databaseVerification.foreignKeyErrors} foreign-key issue(s)`);
  add('Servers folder', fs.existsSync(serversRoot), displayPath(serversRoot));
  add('Backups folder', fs.existsSync(backupsRoot), displayPath(backupsRoot));
  fs.mkdirSync(softwareRoot, { recursive: true });
  add('Software cache', fs.existsSync(softwareRoot), displayPath(softwareRoot));

  const servers = db.prepare('SELECT * FROM servers ORDER BY id ASC').all();
  for (const server of servers) {
    const software = softwareForServer(server);
    const root = server.server_path || serverPath(server.id, server.name);
    add(`Server ${server.name}`, fs.existsSync(root), displayPath(root));
    if (software) {
      const existing = executableCandidates(server, software).find((candidate) => fs.existsSync(candidate));
      if (existing) {
        if (existing !== server.executable_path) {
          db.prepare('UPDATE servers SET executable_path = ? WHERE id = ?').run(existing, server.id);
        }
        add(`${server.name} executable`, true, displayPath(existing));
      } else if (force) {
        try {
          const repair = await repairMissingExecutable(server, software);
          add(`${server.name} executable`, true, repair.message);
        } catch (error) {
          add(`${server.name} executable`, false, `Missing. Auto-repair failed: ${error.message}`);
        }
      } else {
        add(`${server.name} executable`, false, 'Missing. Run Security â†’ Run check now to auto-repair, or reinstall software.');
      }
    }
  }

  const hasJavaServer = servers.some((server) => {
    const software = findSoftware(server.software_key) || defaultSoftware(server.type);
    return software && software.edition === 'java';
  });
  if (hasJavaServer) {
    const java = spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true });
    add('Java runtime', !java.error && java.status === 0, java.error ? 'Java is not in PATH' : 'Java responds');
  }

  const okCount = checks.filter((check) => check.ok).length;
  const payload = {
    checkedAt: now,
    checkedAtText: new Date(now).toISOString(),
    status: okCount === checks.length ? 'healthy' : 'attention',
    summary: `${okCount}/${checks.length} checks passed`,
    checks,
  };
  await fs.promises.writeFile(healthPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function visibleServerDatabaseRows(user) {
  return user?.role === 'owner' || !isHostEdition()
    ? db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM servers WHERE owner_user_id = ? ORDER BY created_at DESC').all(user?.id || 0);
}

function serverRows(user, req = null) {
  return visibleServerDatabaseRows(user).map((server) => serverPayload(server, req));
}

function canUseServer(user, server) {
  if (!user || !server) return false;
  if (user.role === 'owner') return true;
  if (!isHostEdition()) return true;
  return Number(server.owner_user_id) === Number(user.id);
}

function canOwnServerShare(user, server) {
  if (!user || !server) return false;
  if (user.role === 'owner') return true;
  if (!isHostEdition()) return canUseServer(user, server);
  return Number(server.owner_user_id) === Number(user.id);
}

function resolveServerOwnerUserId(req, requestedValue, fallback = null) {
  if (!ownerOnly(req)) return fallback;
  if (requestedValue === undefined || requestedValue === null || requestedValue === '') return null;
  const id = Number(requestedValue);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Assigned user is invalid.');
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!user || user.role === 'owner') throw new Error('Assign servers to a valid admin user, or leave unassigned for owner-only.');
  return id;
}

function isHostApiAuthorized(req) {
  if (ownerOnly(req)) return true;
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-nexuspanel-token'] || '').trim();
  const expected = reqOwnerSafeHostToken();
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  return token && expected && tokenBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(tokenBuffer, expectedBuffer);
}

function pluginRows(serverId = null) {
  if (Array.isArray(serverId)) {
    if (!serverId.length) return [];
    const placeholders = serverId.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM plugins WHERE server_id IN (${placeholders}) ORDER BY created_at DESC`).all(...serverId).map((plugin) => ({
      id: plugin.id,
      serverId: plugin.server_id,
      name: plugin.name,
      kind: plugin.kind,
      fileName: plugin.file_name,
      relativePath: plugin.relative_path,
      enabled: Boolean(plugin.enabled),
      createdAt: plugin.created_at,
    }));
  }
  const rows = serverId
    ? db.prepare('SELECT * FROM plugins WHERE server_id = ? ORDER BY created_at DESC').all(serverId)
    : db.prepare('SELECT * FROM plugins ORDER BY created_at DESC').all();

  return rows.map((plugin) => ({
    id: plugin.id,
    serverId: plugin.server_id,
    name: plugin.name,
    kind: plugin.kind,
    fileName: plugin.file_name,
    relativePath: plugin.relative_path,
    enabled: Boolean(plugin.enabled),
    createdAt: plugin.created_at,
  }));
}

function getServerOr404(id) {
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(id));
  if (!target) throw new Error('Server not found.');
  return target;
}

function safeServerFile(server, relative = '') {
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const cleaned = String(relative || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (cleaned === 'runtime' || cleaned.startsWith('runtime/')) throw new Error('NexusPanel runtime files are protected.');
  return {
    root,
    relative: cleaned,
    absolute: assertInside(root, path.join(root, cleaned)),
  };
}

function uploadRows(serverId) {
  return db.prepare('SELECT relative_path, file_name, size, uploaded_bytes, status, message, chunks_json, updated_at FROM upload_sessions WHERE server_id = ? ORDER BY updated_at DESC LIMIT 25')
    .all(serverId)
    .map((row) => ({
      path: row.relative_path,
      name: row.file_name,
      size: row.size,
      uploadedBytes: row.uploaded_bytes,
      progress: row.size ? Math.min(100, Math.round((row.uploaded_bytes / row.size) * 100)) : 0,
      status: row.status,
      message: row.message,
      chunks: parseJsonObject(row.chunks_json) || [],
      updatedAt: row.updated_at,
    }));
}

function parseChunkRanges(value) {
  const parsed = Array.isArray(value) ? value : parseJsonObject(value);
  const ranges = Array.isArray(parsed) ? parsed : [];
  return ranges
    .map((range) => ({ start: Number(range.start), end: Number(range.end) }))
    .filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start)
    .sort((a, b) => a.start - b.start);
}

function mergeChunkRanges(ranges, next = null) {
  const sorted = parseChunkRanges(next ? [...ranges, next] : ranges);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function uploadedRangeBytes(ranges) {
  return mergeChunkRanges(ranges).reduce((sum, range) => sum + range.end - range.start, 0);
}

function uploadSession(serverId, relativePath) {
  return db.prepare('SELECT * FROM upload_sessions WHERE server_id = ? AND relative_path = ?').get(serverId, relativePath);
}

function upsertUploadSession(serverId, relativePath, size, uploadedBytes, status = 'active', message = '', chunks = null) {
  const chunksJson = JSON.stringify(mergeChunkRanges(chunks || []));
  db.prepare(`
    INSERT INTO upload_sessions (server_id, relative_path, file_name, size, uploaded_bytes, status, message, chunks_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, relative_path)
    DO UPDATE SET
      size = excluded.size,
      uploaded_bytes = excluded.uploaded_bytes,
      status = excluded.status,
      message = excluded.message,
      chunks_json = excluded.chunks_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(serverId, relativePath, path.basename(relativePath), size, uploadedBytes, status, message, chunksJson);
}

function hasJavaEula(server) {
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  if (!software || software.edition !== 'java') return true;
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  return fs.existsSync(path.join(root, 'eula.txt'))
    && fs.readFileSync(path.join(root, 'eula.txt'), 'utf8').toLowerCase().includes('eula=true');
}

async function agreeJavaEula(server) {
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  await fs.promises.writeFile(
    path.join(root, 'eula.txt'),
    '# Agreed from NexusPanel. Make sure you accept Mojang/Minecraft EULA before running.\neula=true\n',
    'utf8',
  );
}

function tunnelRows(serverId) {
  return db.prepare('SELECT provider, token, remote_host FROM tunnel_tokens WHERE server_id = ? ORDER BY provider')
    .all(serverId)
    .map((row) => ({
      provider: row.provider,
      hasToken: Boolean(row.token),
      tokenPreview: row.token ? `${row.token.slice(0, 4)}â€¢â€¢â€¢â€¢${row.token.slice(-4)}` : '',
      remoteHost: row.remote_host,
    }));
}

const propertySchema = [
  { key: 'server-name', label: 'Server Name', type: 'text', editions: ['bedrock'] },
  { key: 'motd', label: 'MOTD', type: 'text', editions: ['java'] },
  { key: 'level-name', label: 'World Name', type: 'text', editions: ['bedrock'] },
  { key: 'level-seed', label: 'World Seed', type: 'text', editions: ['bedrock'] },
  { key: 'level-type', label: 'World Type', type: 'select', options: ['DEFAULT', 'FLAT', 'LEGACY'], editions: ['bedrock'] },
  { key: 'gamemode', label: 'Gamemode', type: 'select', options: ['survival', 'creative', 'adventure'], editions: ['java', 'bedrock'] },
  { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'], editions: ['java', 'bedrock'] },
  { key: 'max-players', label: 'Max Players', type: 'number', editions: ['java', 'bedrock'] },
  { key: 'server-port', label: 'IPv4 Port', type: 'number', editions: ['java', 'bedrock'] },
  { key: 'server-portv6', label: 'IPv6 Port', type: 'number', editions: ['bedrock'] },
  { key: 'online-mode', label: 'Online Mode', type: 'boolean', editions: ['java'] },
  { key: 'white-list', label: 'Whitelist', type: 'boolean', editions: ['java'] },
  { key: 'allow-list', label: 'Allowlist', type: 'boolean', editions: ['bedrock'] },
  { key: 'allow-cheats', label: 'Allow Cheats', type: 'boolean', editions: ['bedrock'] },
  { key: 'pvp', label: 'PVP', type: 'boolean', editions: ['java', 'bedrock'] },
  { key: 'force-gamemode', label: 'Force Gamemode', type: 'boolean', editions: ['bedrock'] },
  { key: 'hardcore', label: 'Hardcore', type: 'boolean', editions: ['java', 'bedrock'] },
  { key: 'spawn-protection', label: 'Spawn Protection', type: 'number', editions: ['java'] },
  { key: 'spawn-animals', label: 'Spawn Animals', type: 'boolean', editions: ['java'] },
  { key: 'spawn-monsters', label: 'Spawn Monsters', type: 'boolean', editions: ['java'] },
  { key: 'spawn-npcs', label: 'Spawn NPCs', type: 'boolean', editions: ['java'] },
  { key: 'view-distance', label: 'View Distance', type: 'number', editions: ['java', 'bedrock'] },
  { key: 'simulation-distance', label: 'Simulation Distance', type: 'number', editions: ['java'] },
  { key: 'tick-distance', label: 'Tick Distance', type: 'number', editions: ['bedrock'] },
  { key: 'max-threads', label: 'Max Threads', type: 'number', editions: ['bedrock'] },
  { key: 'player-idle-timeout', label: 'Idle Timeout', type: 'number', editions: ['java', 'bedrock'] },
  { key: 'default-player-permission-level', label: 'Default Permission', type: 'select', options: ['visitor', 'member', 'operator'], editions: ['bedrock'] },
  { key: 'texturepack-required', label: 'Require Texture Pack', type: 'boolean', editions: ['bedrock'] },
  { key: 'server-authoritative-movement', label: 'Authoritative Movement', type: 'select', options: ['client-auth', 'server-auth', 'server-auth-with-rewind'], editions: ['bedrock'] },
  { key: 'correct-player-movement', label: 'Correct Player Movement', type: 'boolean', editions: ['bedrock'] },
  { key: 'enable-command-block', label: 'Command Blocks', type: 'boolean', editions: ['java'] },
  { key: 'command-blocks-enabled', label: 'Command Blocks', type: 'boolean', editions: ['bedrock'] },
  { key: 'enable-lan-visibility', label: 'LAN Visibility', type: 'boolean', editions: ['bedrock'] },
  { key: 'enable-status', label: 'Enable Status', type: 'boolean', editions: ['java'] },
  { key: 'enable-rcon', label: 'Enable RCON', type: 'boolean', editions: ['java'] },
  { key: 'rcon.port', label: 'RCON Port', type: 'number', editions: ['java'] },
  { key: 'rcon.password', label: 'RCON Password', type: 'password', editions: ['java'] },
];

function propertiesPath(server) {
  const root = ensureServerDirs(server);
  if (path.resolve(server.server_path || '') !== path.resolve(root)) {
    db.prepare('UPDATE servers SET server_path = ? WHERE id = ?').run(root, server.id);
    server.server_path = root;
    appendLog(server.id, `[NexusPanel] Recovered properties path: ${displayPath(root)}`);
  }
  return path.join(root, 'server.properties');
}

function parseProperties(content) {
  const values = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function defaultPropertyValues(server) {
  return {
    'server-name': server.name,
    motd: server.name,
    'max-players': '20',
    gamemode: 'survival',
    difficulty: 'normal',
    pvp: 'true',
    'white-list': 'false',
    'allow-list': 'false',
    'allow-cheats': 'false',
    'force-gamemode': 'false',
    hardcore: 'false',
    'command-blocks-enabled': 'false',
    'texturepack-required': 'false',
    'enable-lan-visibility': 'true',
    'default-player-permission-level': 'member',
    'server-port': String(server.port),
  };
}

function inspectProperties(content, server) {
  const values = {};
  const issues = [];
  const cleanContent = String(content || '').replaceAll('\0', '');
  if (cleanContent !== String(content || '')) issues.push('Removed null bytes.');
  cleanContent.split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separator = line.indexOf('=');
    if (separator < 1) {
      issues.push(`Ignored malformed line ${lineIndex + 1}.`);
      return;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      issues.push(`Ignored invalid key on line ${lineIndex + 1}.`);
      return;
    }
    if (Object.hasOwn(values, key)) issues.push(`Collapsed duplicate key ${key}.`);
    values[key] = value;
  });

  const schema = new Map(propertySchema.map((item) => [item.key, item]));
  const numberRanges = {
    'server-port': [1, 65535],
    'server-portv6': [1, 65535],
    'rcon.port': [1, 65535],
    'max-players': [1, 10000],
    'view-distance': [2, 64],
    'simulation-distance': [2, 64],
    'tick-distance': [4, 32],
    'max-threads': [0, 1024],
    'spawn-protection': [0, 100000],
    'player-idle-timeout': [0, 100000],
  };
  for (const [key, value] of Object.entries(values)) {
    const item = schema.get(key);
    if (!item) continue;
    if (item.type === 'boolean') {
      if (/^(?:true|1|yes|on)$/i.test(value)) values[key] = 'true';
      else if (/^(?:false|0|no|off)$/i.test(value)) values[key] = 'false';
      else {
        values[key] = defaultPropertyValues(server)[key] || 'false';
        issues.push(`Reset invalid boolean ${key}.`);
      }
    }
    if (item.type === 'number') {
      const parsed = Math.trunc(Number(value));
      const [minimum, maximum] = numberRanges[key] || [-2147483648, 2147483647];
      if (!Number.isFinite(parsed)) {
        values[key] = defaultPropertyValues(server)[key] || '0';
        issues.push(`Reset invalid number ${key}.`);
      } else {
        const clamped = Math.max(minimum, Math.min(maximum, parsed));
        values[key] = String(clamped);
        if (clamped !== parsed) issues.push(`Clamped ${key} to ${clamped}.`);
      }
    }
    if (item.type === 'select' && !item.options.includes(value)) {
      const match = item.options.find((option) => option.toLowerCase() === value.toLowerCase());
      values[key] = match || defaultPropertyValues(server)[key] || item.options[0];
      issues.push(`Normalized invalid option ${key}.`);
    }
  }
  if (values['server-port'] !== undefined && values['server-port'] !== String(server.port)) {
    issues.push(`Synchronized server-port to ${server.port}.`);
  }
  values['server-port'] = String(server.port);
  return { values, issues };
}

async function atomicWriteText(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(temporary, content, 'utf8');
  try {
    await fs.promises.rename(temporary, filePath);
  } catch {
    await fs.promises.copyFile(temporary, filePath);
    await fs.promises.rm(temporary, { force: true });
  }
}

async function repairPropertiesFile(server, { create = true } = {}) {
  const filePath = propertiesPath(server);
  const existing = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  const inspected = inspectProperties(existing, server);
  if (/^\s*#\s*NexusPanel\b/im.test(existing)) {
    inspected.issues.push('Removed legacy NexusPanel header.');
  }
  const values = { ...defaultPropertyValues(server), ...inspected.values };
  if (!existing && !create) return { values, issues: [], repaired: false, filePath };
  const needsWrite = !existing || inspected.issues.length > 0 || values['server-port'] !== String(server.port);
  if (!needsWrite) return { values, issues: [], repaired: false, filePath };

  if (existing) {
    const recoveryDir = path.join(path.dirname(filePath), 'runtime', 'property-recovery');
    await fs.promises.mkdir(recoveryDir, { recursive: true });
    await fs.promises.writeFile(path.join(recoveryDir, `server.properties.${Date.now()}.bak`), existing, 'utf8');
  }
  const content = [
    ...Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ')}`),
    '',
  ].join('\n');
  await atomicWriteText(filePath, content);
  if (process.platform !== 'win32') await fs.promises.chmod(filePath, 0o644);
  const verified = await fs.promises.readFile(filePath, 'utf8');
  if (!verified.includes('server-port=')) throw new Error('server.properties verification failed after repair.');
  appendLog(server.id, `[NexusPanel] Properties self-heal: ${inspected.issues.join(' ') || 'created missing server.properties'}`);
  return { values, issues: inspected.issues, repaired: true, filePath };
}

async function readProperties(server) {
  return (await repairPropertiesFile(server)).values;
}

async function writeProperties(server, values) {
  const current = await readProperties(server);
  const merged = { ...current, ...values, 'server-port': String(server.port) };
  const content = [
    ...Object.entries(merged).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
  const filePath = propertiesPath(server);
  await atomicWriteText(filePath, content);
  if (process.platform !== 'win32') await fs.promises.chmod(filePath, 0o644);
}

async function javaUuidForName(name) {
  const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
    headers: { 'User-Agent': 'NexusPanel/1.0' },
  }).catch(() => null);
  if (!response || response.status === 204 || !response.ok) return '00000000-0000-0000-0000-000000000000';
  const profile = await response.json();
  const raw = profile.id || '';
  return raw.length === 32 ? `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}` : '00000000-0000-0000-0000-000000000000';
}

async function whitelistPath(server) {
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  return path.join(ensureServerDirs(server), software.edition === 'java' ? 'whitelist.json' : 'allowlist.json');
}

async function readWhitelist(server) {
  const filePath = await whitelistPath(server);
  try {
    const rows = JSON.parse(await fs.promises.readFile(filePath, 'utf8').catch(() => '[]'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeWhitelist(server, rows) {
  await fs.promises.writeFile(await whitelistPath(server), JSON.stringify(rows, null, 2), 'utf8');
}

function reloadWhitelistIfRunning(server, software) {
  if (runtimeStatus(server.id) !== 'online') return;
  try {
    sendCommand(server.id, software.edition === 'java' ? 'whitelist reload' : 'allowlist reload');
    appendLog(server.id, '[NexusPanel] Whitelist reloaded live.');
  } catch (error) {
    appendLog(server.id, `[NexusPanel] Live whitelist reload failed: ${error.message}`);
  }
}

async function createServerBackup(server, reason = 'manual') {
  return withKeyedOperation(`backup:${server.id}`, () => createServerBackupUnlocked(server, reason));
}

function assertHostServerQuota(ownerUserId) {
  if (!isHostEdition() || !ownerUserId) return;
  const quota = clampNumber(settingValue('host_server_quota', '10'), 1, 500, 10);
  const count = db.prepare('SELECT COUNT(*) AS count FROM servers WHERE owner_user_id = ?').get(ownerUserId).count;
  if (count >= quota) throw new Error(`This host account reached its ${quota}-server quota.`);
}

function adaptiveInsights(user, req) {
  if (!user) return [];
  const servers = serverRows(user, req);
  const rawServers = servers.map((server) => db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id)).filter(Boolean);
  const now = Date.now();
  const activeUploads = rawServers.flatMap((server) => uploadRows(server.id)).filter((upload) => ['active', 'paused', 'waiting'].includes(upload.status));
  const overdueRatios = rawServers.filter((server) => server.scheduled_backups).map((server) => {
    const interval = backupIntervalMinutesFrom(server) * 60 * 1000;
    return interval ? Math.max(0, now - Number(server.last_backup_at || now)) / interval : 0;
  });
  const memory = hostMemoryStats();
  return [
    adaptiveEngine.observe('servers', {
      onlineRatio: servers.length ? servers.filter((server) => server.status === 'online').length / servers.length : 0,
      averageInstallProgress: servers.length ? servers.reduce((sum, server) => sum + Number(server.installProgress || 0), 0) / servers.length : 100,
    }),
    adaptiveEngine.observe('backups', {
      maximumOverdueRatio: overdueRatios.length ? Math.max(...overdueRatios) : 0,
      scheduledServers: overdueRatios.length,
    }),
    adaptiveEngine.observe('uploads', {
      activeUploads: activeUploads.length,
      averageProgress: activeUploads.length ? activeUploads.reduce((sum, upload) => sum + upload.progress, 0) / activeUploads.length : 100,
      stalledUploads: activeUploads.filter((upload) => now - new Date(`${upload.updatedAt}Z`).getTime() > 2 * 60 * 1000).length,
    }),
    adaptiveEngine.observe('resources', {
      cpuPercent: hostCpuPercent(),
      memoryPercent: Math.round((memory.used / Math.max(1, memory.total)) * 100),
    }),
  ];
}

function repairBrainPayload() {
  const playbooks = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(success_count), 0) AS learned, COALESCE(SUM(replay_count), 0) AS replays
    FROM repair_playbooks
  `).get();
  const commands = db.prepare(`
    SELECT
      COUNT(*) AS observed,
      COALESCE(SUM(CASE WHEN safe_to_replay = 1 THEN 1 ELSE 0 END), 0) AS safe,
      COALESCE(SUM(CASE WHEN stable_success_count > 0 THEN 1 ELSE 0 END), 0) AS validated,
      COALESCE(SUM(replay_count), 0) AS replays
    FROM repair_command_observations
  `).get();
  const recent = db.prepare(`
    SELECT observation.server_id, observation.command_preview, observation.safe_to_replay,
      observation.exit_code, observation.stable_success_count, observation.replay_count,
      observation.observed_at, server.name AS server_name
    FROM repair_command_observations observation
    JOIN servers server ON server.id = observation.server_id
    ORDER BY observation.observed_at DESC
    LIMIT 8
  `).all().map((row) => ({
    serverId: row.server_id,
    serverName: row.server_name,
    commandPreview: row.command_preview,
    safeToReplay: Boolean(row.safe_to_replay),
    exitCode: row.exit_code,
    validated: row.stable_success_count > 0,
    replayCount: row.replay_count,
    observedAt: row.observed_at,
  }));
  return {
    knowledge: knowledgeStatus(),
    playbooks,
    commands,
    recent,
    database: databaseHealthStatus,
  };
}

function backupTimezone(server) {
  const configured = settingValue(`server_backup_timezone_${server.id}`, '');
  if (configured) return configured;
  const assignedUserId = Number(server.owner_user_id || 0);
  const owner = assignedUserId
    ? db.prepare('SELECT id FROM users WHERE id = ?').get(assignedUserId)
    : db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id ASC LIMIT 1").get();
  return owner ? getUserTimezone(owner.id) : 'UTC';
}

function backupTimestamp(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const zone = String(parts.timeZoneName || timeZone).replace(/^GMT/, 'UTC').replace(/[^A-Za-z0-9+-]/g, '-');
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}_${zone}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function holdBedrockWorldForBackup(server) {
  if (server.software_key !== 'bedrock-vanilla' || runtimeStatus(server.id) !== 'online') return false;
  const marker = `backup snapshot ${Date.now()}`;
  appendLog(server.id, `[NexusPanel] Pausing Bedrock world writes for a consistent ${marker}...`);
  sendCommand(server.id, 'save hold');
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(attempt === 0 ? 500 : 750);
      sendCommand(server.id, 'save query');
      await wait(250);
      const rows = consoleLogs(server.id);
      const markerIndex = rows.findLastIndex((line) => line.includes(marker));
      const recent = rows.slice(markerIndex >= 0 ? markerIndex + 1 : -120).join('\n');
      if (/files are (?:now )?ready to be copied|data saved\..*ready to be copied/i.test(recent)) {
        appendLog(server.id, '[NexusPanel] Bedrock snapshot is stable and ready to archive.');
        return true;
      }
    }
    throw new Error('Bedrock did not confirm a stable save snapshot within 12 seconds.');
  } catch (error) {
    try { sendCommand(server.id, 'save resume'); } catch {}
    throw error;
  }
}

async function createServerBackupUnlocked(server, reason = 'manual') {
  const root = ensureServerDirs(server);
  const backupsDir = assertInside(backupsRoot, path.join(backupsRoot, String(server.id)));
  await fs.promises.mkdir(backupsDir, { recursive: true });
  const now = new Date();
  const timeZone = backupTimezone(server);
  const serverName = server.name
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'server';
  const archiveName = `${serverName}-backup-${reason}-${backupTimestamp(now, timeZone)}.zip`;
  const archivePath = path.join(backupsDir, archiveName);

  // ===== EXISTING BACKUP LOGIC =====
  const excludedTopLevel = new Set(['archives', 'backup', 'backups', 'backupfolder', 'software', 'runtime']);
  const entries = (await fs.promises.readdir(root, { withFileTypes: true }))
    .filter((entry) => !excludedTopLevel.has(entry.name.toLowerCase()))
    .filter((entry) => !entry.isFile() || !entry.name.toLowerCase().endsWith('.zip'))
    .filter((entry) => !entry.name.endsWith('.download') && !entry.name.endsWith('.uploading'))
    .map((entry) => entry.name);

  const heldBedrockWorld = await holdBedrockWorldForBackup(server);
  let archiveResult;
  try {
    archiveResult = await createZip(root, entries, archivePath);
  } finally {
    if (heldBedrockWorld) {
      try {
        sendCommand(server.id, 'save resume');
        appendLog(server.id, '[NexusPanel] Bedrock world writes resumed after backup snapshot.');
      } catch (error) {
        appendLog(server.id, `[NexusPanel] Warning: save resume failed after backup: ${error.message}`);
      }
    }
  }

  const retention = Math.max(1, Number(server.backup_retention) || 4);
  const backups = (await fs.promises.readdir(backupsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
    .map((entry) => ({ name: entry.name, path: path.join(backupsDir, entry.name), mtime: fs.statSync(path.join(backupsDir, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of backups.slice(retention)) await fs.promises.rm(old.path, { force: true });

  db.prepare('UPDATE servers SET last_backup_at = ? WHERE id = ?').run(Date.now(), server.id);
  if (archiveResult.skipped) {
    appendLog(server.id, `[NexusPanel] Backup snapshot skipped ${archiveResult.skipped} transient file(s) that disappeared during compaction.`);
  }
  appendLog(server.id, `[NexusPanel] Backup created: ${archiveName} (${timeZone})`);

  return { name: archiveName, path: archiveName, size: fs.statSync(archivePath).size, createdAt: now.getTime(), timeZone };
}

async function backupRows(server) {
  const backupsDir = assertInside(backupsRoot, path.join(backupsRoot, String(server.id)));
  await fs.promises.mkdir(backupsDir, { recursive: true });
  return (await fs.promises.readdir(backupsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
    .map((entry) => {
      const absolute = path.join(backupsDir, entry.name);
      const stats = fs.statSync(absolute);
      return {
        name: entry.name,
        path: entry.name,
        size: stats.size,
        createdAt: stats.mtimeMs,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function executableCandidates(server, software) {
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  if (path.resolve(server.server_path || '') !== path.resolve(root)) {
    db.prepare('UPDATE servers SET server_path = ? WHERE id = ?').run(root, server.id);
    server.server_path = root;
    appendLog(server.id, `[NexusPanel] Recovered server root: ${displayPath(root)}`);
  }
  return [
    server.executable_path,
    path.join(root, 'software', software.executable),
    path.join(root, software.executable),
    findFile(root, software.executable),
  ].filter(Boolean);
}

function preferredExecutablePath(server, software) {
  if (software?.nexu) return nexuExecutablePath(server, software);
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  return software.key === 'bedrock-vanilla'
    ? path.join(root, software.executable)
    : path.join(root, 'software', software.executable);
}

function resolveInstalledExecutable(server, software) {
  const found = executableCandidates(server, software).find((candidate) => fs.existsSync(candidate));
  if (!found) {
    const status = server.install_status || 'missing';
    const message = server.install_message ? ` ${server.install_message}` : '';
    throw new Error(`Install server software before starting. Status: ${status}.${message}`);
  }

  if (found !== server.executable_path) {
    db.prepare('UPDATE servers SET executable_path = ? WHERE id = ?').run(found, server.id);
    appendLog(server.id, `[NexusPanel] Fixed executable path: ${displayPath(found)}`);
  }

  if (process.platform !== 'win32' && (software.key === 'bedrock-vanilla' || software.nexu)) {
    fs.chmodSync(found, 0o755);
  }

  return db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
}

async function repairMissingExecutable(server, software) {
  const existing = executableCandidates(server, software).find((candidate) => fs.existsSync(candidate));
  if (existing) {
    if (existing !== server.executable_path) {
      db.prepare('UPDATE servers SET executable_path = ? WHERE id = ?').run(existing, server.id);
    }
    return { repaired: false, path: existing, message: `Executable found at ${displayPath(existing)}` };
  }

  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const targetPath = preferredExecutablePath(server, software);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  const version = String(server.software_version || 'latest').trim() || 'latest';
  const download = await resolveDownload(software, version);
  const repairDir = path.join(root, 'runtime', 'repair-download');
  await fs.promises.rm(repairDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.mkdir(repairDir, { recursive: true });

  if (software.key === 'pocketmine') {
    const metaPath = path.join(root, 'runtime', 'pocketmine-php.json');
    if (!fs.existsSync(metaPath)) {
      await installPocketMineRuntime(root, server.id, () => {});
    }
  }

  if (download.archive || software.key === 'bedrock-vanilla') {
    const archivePath = path.join(repairDir, `${software.key}-repair.zip`);
    const extractDir = path.join(repairDir, 'extract');
    await downloadToFile(download.url, archivePath, () => {});
    extractArchive(archivePath, extractDir);
    const found = findFile(extractDir, software.executable);
    if (!found) throw new Error(`Downloaded ${software.name}, but ${software.executable} was not found inside it.`);
    await fs.promises.copyFile(found, targetPath);
  } else {
    await downloadToFile(download.url, targetPath, () => {});
  }

  if (process.platform !== 'win32' && (software.key === 'bedrock-vanilla' || software.key === 'pocketmine')) {
    await fs.promises.chmod(targetPath, 0o755).catch(() => {});
  }

  await fs.promises.rm(repairDir, { recursive: true, force: true }).catch(() => {});
  db.prepare(`
    UPDATE servers
    SET executable_path = ?, install_status = 'installed', install_progress = 100, install_message = ?
    WHERE id = ?
  `).run(targetPath, `Repaired missing executable from ${software.name} ${download.version || version}`, server.id);
  appendLog(server.id, `[NexusPanel] Repaired missing executable: ${displayPath(targetPath)}`);
  return { repaired: true, path: targetPath, message: `Repaired executable at ${displayPath(targetPath)}` };
}

async function runServerRepair(server, software) {
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const actions = [];
  const warnings = [];
  const checks = [];
  const diagnostics = diagnoseRuntime(consoleLogs(server.id));
  const knowledge = knowledgeStatus();
  checks.push({
    name: 'Crash intelligence',
    ok: true,
    detail: diagnostics.length
      ? `${diagnostics.length} likely cause(s) matched from ${knowledge.diagnosticSignals} signals.`
      : `No known crash signature matched across ${knowledge.diagnosticSignals} signals.`,
  });
  diagnostics.forEach((diagnostic) => {
    warnings.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.summary} ${diagnostic.techniques[0]}`);
  });

  const repair = await repairMissingExecutable(server, software);
  actions.push(repair.message);
  checks.push({ name: 'Executable', ok: true, detail: displayPath(repair.path) });
  if (['java', 'bedrock'].includes(server.type)) {
    const properties = await repairPropertiesFile(server);
    checks.push({
      name: 'Server properties',
      ok: true,
      detail: properties.repaired ? `Repaired ${properties.issues.length || 1} issue(s).` : 'Syntax and values validated.',
    });
    if (properties.repaired) actions.push(`Repaired server.properties (${properties.issues.join(' ') || 'created missing file'}).`);
  }

  const queue = [root];
  const staleTransfers = [];
  let scanned = 0;
  while (queue.length && scanned < 10000) {
    const directory = queue.shift();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      const absolute = assertInside(root, path.join(directory, entry.name));
      if (entry.isDirectory()) {
        if (!['backups', 'archives'].includes(entry.name.toLowerCase())) queue.push(absolute);
      } else if (/\.(?:download|uploading)$/i.test(entry.name)) {
        const stats = await fs.promises.stat(absolute).catch(() => null);
        if (stats && Date.now() - stats.mtimeMs > 60 * 60 * 1000) staleTransfers.push(absolute);
      }
      if (scanned >= 10000) break;
    }
  }
  for (const file of staleTransfers) await fs.promises.rm(file, { force: true });
  actions.push(`Removed ${staleTransfers.length} stale partial transfer(s).`);
  checks.push({ name: 'Path boundary', ok: true, detail: displayPath(root) });

  const likelyWorlds = server.type === 'java'
    ? [path.join(root, 'world', 'level.dat')]
    : [path.join(root, 'worlds')];
  const worldFound = likelyWorlds.some((candidate) => fs.existsSync(candidate));
  checks.push({ name: 'World data', ok: worldFound, detail: worldFound ? 'World storage detected.' : 'No standard world data detected yet.' });
  if (!worldFound) {
    const backups = await backupRows(server);
    warnings.push(backups.length
      ? `World data was not detected. ${backups.length} backup(s) are available for a confirmed restore.`
      : 'World data was not detected and no backup is available.');
  }

  const profile = writeProfile(db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id), root, parseJsonObject(server.nexu_payload));
  db.prepare("UPDATE servers SET status = 'offline', nexus_mark_profile = ? WHERE id = ?")
    .run(JSON.stringify(profile), server.id);
  actions.push('Rebuilt the Nexus-Mark resource profile and cleared stale runtime status.');

  if (typeof fs.statfsSync === 'function') {
    try {
      const disk = fs.statfsSync(root);
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      checks.push({ name: 'Free disk', ok: freeBytes >= 1024 * 1024 * 1024, detail: `${Math.round(freeBytes / 1024 / 1024)} MB free` });
      if (freeBytes < 1024 * 1024 * 1024) warnings.push('Less than 1 GB of disk space is free.');
    } catch (error) {
      warnings.push(`Disk check failed: ${error.message}`);
    }
  }

  return {
    repair,
    checks,
    actions,
    warnings,
    diagnostics,
    knowledge,
    summary: `${checks.filter((check) => check.ok).length}/${checks.length} checks passed, ${actions.length} repair action(s), ${warnings.length} warning(s).`,
  };
}

async function restoreServerBackup(server, backupName) {
  if (runtimeStatus(server.id) === 'online') throw new Error('Stop the server before restoring a backup.');
  const name = String(backupName || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!name.endsWith('.zip') || name.includes('/')) throw new Error('Choose a backup ZIP to restore.');
  return restoreBackupFileIntoServer(server, server.id, name);
}

async function restoreBackupFileIntoServer(server, sourceServerId, backupName) {
  if (runtimeStatus(server.id) === 'online') throw new Error('Stop the server before restoring a backup.');
  const name = String(backupName || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!name.endsWith('.zip') || name.includes('/')) throw new Error('Choose a backup ZIP to restore.');
  const backupPath = assertInside(backupsRoot, path.join(backupsRoot, String(sourceServerId), name));
  const stats = await fs.promises.stat(backupPath).catch(() => null);
  if (!stats || !stats.isFile()) throw new Error('Backup file not found.');

  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const protectedNames = new Set(['software', 'runtime']);
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (protectedNames.has(entry.name)) continue;
    await fs.promises.rm(assertInside(root, path.join(root, entry.name)), { recursive: true, force: true });
  }

  extractArchiveInto(backupPath, root);
  appendLog(server.id, `[NexusPanel] Restored backup: ${name}`);
  return { restored: name };
}

async function downloadToFile(url, filePath, onProgress) {
  const tmpPath = `${filePath}.download`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    try {
      const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'NexusPanel/1.0' } });
      if (response.status === 404) throw new Error(`Download URL returned 404: ${url}`);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      const writer = fs.createWriteStream(tmpPath);
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (!writer.write(chunk)) await new Promise((resolve) => writer.once('drain', resolve));
        if (total) onProgress(Math.min(98, Math.round((received / total) * 100)));
      }
      await new Promise((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
      if (total && received !== total) throw new Error(`Download incomplete: ${received}/${total} bytes`);
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
      await fs.promises.rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  throw lastError;
}

async function fetchGithubLatestAsset(repo, matcher) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'NexusPanel/1.0' },
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
  const release = await response.json();
  const asset = (release.assets || []).find((item) => matcher(item.name));
  if (!asset) throw new Error(`No compatible asset found in ${repo} latest release.`);
  return { version: release.tag_name, url: asset.browser_download_url, name: asset.name };
}

async function installPocketMineRuntime(root, serverId, onProgress) {
  const platformMatcher = process.platform === 'win32'
    ? (name) => /^PHP-.*-Windows-x64-PM5\.zip$/i.test(name)
    : process.platform === 'linux'
      ? (name) => /^PHP-.*-Linux-x86_64-PM5\.tar\.gz$/i.test(name)
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? (name) => /^PHP-.*-MacOS-arm64-PM5\.tar\.gz$/i.test(name)
        : (name) => /^PHP-.*-MacOS-x86_64-PM5\.tar\.gz$/i.test(name);
  const asset = await fetchGithubLatestAsset('pmmp/PHP-Binaries', platformMatcher);
  const runtimeDir = path.join(root, 'runtime', 'pocketmine-php');
  const archivePath = path.join(root, 'runtime', asset.name);
  onProgress(8, `Downloading bundled PHP ${asset.version}`);
  await downloadToFile(asset.url, archivePath, (progress) => onProgress(Math.max(8, Math.min(45, Math.round(progress * 0.45))), `Downloading bundled PHP ${asset.version}`));
  onProgress(48, 'Extracting bundled PHP');
  extractArchive(archivePath, runtimeDir);
  const phpBinary = findFile(runtimeDir, process.platform === 'win32' ? 'php.exe' : 'php');
  if (!phpBinary) throw new Error('Bundled PHP extraction finished but php binary was not found.');
  if (process.platform !== 'win32') await fs.promises.chmod(phpBinary, 0o755).catch(() => {});
  await fs.promises.writeFile(path.join(root, 'runtime', 'pocketmine-php.json'), JSON.stringify({
    version: asset.version,
    phpBinary,
    installedAt: new Date().toISOString(),
  }, null, 2));
  appendLog(serverId, `[NexusPanel] Bundled PHP ready: ${asset.version}`);
  return phpBinary;
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

function runRequirementCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed. ${(result.stderr || result.stdout || result.error?.message || '').slice(-600)}`);
  }
}

function installLinuxPackage(candidates) {
  if (process.platform !== 'linux') return false;
  if (commandWorks('apt-get', ['--version'])) {
    runRequirementCommand('apt-get', ['update']);
    runRequirementCommand('apt-get', ['install', '-y', ...candidates.apt]);
    return true;
  }
  if (commandWorks('dnf', ['--version'])) {
    runRequirementCommand('dnf', ['install', '-y', ...candidates.dnf]);
    return true;
  }
  if (commandWorks('yum', ['--version'])) {
    runRequirementCommand('yum', ['install', '-y', ...candidates.dnf]);
    return true;
  }
  if (commandWorks('pacman', ['--version'])) {
    runRequirementCommand('pacman', ['-Sy', '--noconfirm', ...candidates.pacman]);
    return true;
  }
  return false;
}

function installSteamcmdRequirement() {
  if (process.platform !== 'linux') throw new Error('SteamCMD auto-install is only supported on Linux.');
  if (commandWorks('apt-get', ['--version'])) {
    runRequirementCommand('bash', ['-lc', 'dpkg --add-architecture i386 >/dev/null 2>&1 || true; apt-get update && apt-get install -y steamcmd lib32gcc-s1']);
    return;
  }
  if (commandWorks('dnf', ['--version'])) {
    runRequirementCommand('dnf', ['install', '-y', 'steamcmd']);
    return;
  }
  if (commandWorks('yum', ['--version'])) {
    runRequirementCommand('yum', ['install', '-y', 'steamcmd']);
    return;
  }
  throw new Error('SteamCMD is required but no supported package manager was found.');
}

function ensureSoftwareRequirements(software, serverId, onProgress) {
  if (software.edition === 'java') {
    if (commandWorks('java', ['-version'])) return { ok: true, message: 'Java already installed.' };
    if (process.platform !== 'linux') {
      throw new Error('Java runtime was not found. On Windows install Java 21+ manually, then restart NexusPanel.');
    }
    onProgress(6, 'Java missing. Installing Java 21 runtime');
    const installed = installLinuxPackage({
      apt: ['openjdk-21-jre-headless'],
      dnf: ['java-21-openjdk-headless'],
      pacman: ['jdk21-openjdk'],
    });
    if (!installed || !commandWorks('java', ['-version'])) {
      throw new Error('Java auto-install did not complete. Install Java 21+ and retry.');
    }
    appendLog(serverId, '[NexusPanel] Requirement installed: Java 21 runtime.');
    return { ok: true, message: 'Java 21 runtime installed.' };
  }
  if (software.key === 'pocketmine') {
    return { ok: true, message: 'PocketMine uses bundled PHP.' };
  }
  return { ok: true, message: 'No external runtime required.' };
}

app.get('/api/overview', (req, res) => {
  const payload = {
    needsSetup: getUserCount() === 0,
    permissions,
    user: req.user ? publicUser(req.user) : null,
    servers: req.user ? serverRows(req.user, req) : [],
    plugins: req.user && req.user.access_level >= permissions.MANAGE_FILES
      ? pluginRows(req.user.role === 'owner' ? null : serverRows(req.user, req).map((server) => server.id))
      : [],
    softwareCatalog: req.user && req.user.access_level >= permissions.MANAGE_SERVERS ? softwareCatalog() : [],
    templates: req.user && req.user.access_level >= permissions.MANAGE_SERVERS && isHostEdition() ? templateRows() : [],
    settings: req.user ? panelSettingsPayload(req.user) : null,
    users: req.user && req.user.access_level >= permissions.MANAGE_ADMINS ? userRows() : [],
    loginEvents: req.user && req.user.access_level >= permissions.MANAGE_ADMINS ? loginEventRows(10) : [],
    health: req.user && req.user.access_level >= permissions.MANAGE_ADMINS ? (fs.existsSync(healthPath) ? readHealthFile() : null) : null,
    optimizer: req.user && req.user.access_level >= permissions.MANAGE_SERVERS ? optimizerStatus() : null,
    adaptiveInsights: req.user ? adaptiveInsights(req.user, req) : [],
    repairBrain: req.user && req.user.access_level >= permissions.MANAGE_ADMINS ? repairBrainPayload() : null,
  };

  res.json(payload);
});

app.get('/api/live', requireAuth, (req, res) => {
  res.json({
    servers: visibleServerDatabaseRows(req.user).map((server) => ({
      id: server.id,
      status: runtimeStatus(server.id),
      installStatus: server.install_status,
      installProgress: server.install_progress,
      installMessage: server.install_message,
    })),
    updateStatus,
  });
});

app.get('/api/user/timezone', requireAuth, (req, res) => {
  try {
    const timezone = getUserTimezone(req.user.id);
    res.json({ timezone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/timezone', requireAuth, (req, res) => {
  try {
    const { timezone } = req.body;
    if (!timezone) return res.status(400).json({ error: 'Timezone is required' });
    // Validate timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return res.status(400).json({ error: 'Invalid timezone' });
    }
    setUserTimezone(req.user.id, timezone);
    const ownedServers = req.user.role === 'owner'
      ? db.prepare('SELECT id FROM servers WHERE owner_user_id IS NULL OR owner_user_id = ?').all(req.user.id)
      : db.prepare('SELECT id FROM servers WHERE owner_user_id = ?').all(req.user.id);
    for (const server of ownedServers) setSettingValue(`server_backup_timezone_${server.id}`, timezone);
    res.json({ success: true, timezone });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/timezones', requireAuth, (req, res) => {
  try {
    const timezones = [...new Set([...getAllTimezones(), 'UTC', 'Asia/Kolkata', 'Asia/Calcutta'])].sort();
    res.json({ timezones });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use('/api/servers/:id', (req, res, next) => {
  if (!req.user) return next();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server) return next();
  if (!canUseServer(req.user, server)) return res.status(403).json({ error: 'No permission for this server.' });
  next();
});

app.get('/api/optimizer/status', requireAccess(permissions.MANAGE_SERVERS), (_req, res) => {
  res.json(optimizerStatus());
});

app.post('/api/adaptive/heal', requireAccess(permissions.MANAGE_ADMINS), asyncRoute(async (_req, res) => {
  res.json(await runAdaptiveMaintenance());
}));

app.get('/api/optimizer/plan', requireAccess(permissions.MANAGE_SERVERS), (_req, res) => {
  res.json(planCommands());
});

app.get('/api/network/metrics', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (_req, res) => {
  res.json({ network: await networkStats() });
}));

app.get('/api/network/download-test', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const size = clampNumber(req.query.size, 1024 * 1024, 64 * 1024 * 1024, 8 * 1024 * 1024);
  const block = Buffer.allocUnsafe(256 * 1024).fill(0x5a);
  let remaining = size;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'no-store');
  function writeMore() {
    while (remaining > 0) {
      const chunk = remaining >= block.length ? block : block.subarray(0, remaining);
      remaining -= chunk.length;
      if (!res.write(chunk)) return res.once('drain', writeMore);
    }
    res.end();
  }
  writeMore();
});

app.post('/api/network/upload-test', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  res.json({ bytes: Buffer.isBuffer(req.body) ? req.body.length : 0, receivedAt: Date.now() });
});

app.get('/api/nginx/accel-config', requireAccess(permissions.MANAGE_ADMINS), (_req, res) => {
  res.type('text/plain').send(`# NexusPanel optional X-Accel download offload
# Put this in your Nginx server block, then set:
# NEXUSPANEL_X_ACCEL_ROOT=${serversRoot.replace(/\\/g, '/')}
# NEXUSPANEL_X_ACCEL_PREFIX=/protected-nexuspanel
location /protected-nexuspanel/ {
  internal;
  alias ${serversRoot.replace(/\\/g, '/')}/;
}

location / {
  proxy_pass http://127.0.0.1:${port};
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 0;
}`);
});

app.post('/api/optimizer/apply', requireAccess(permissions.MANAGE_ADMINS), (_req, res) => {
  const result = applyTweaks();
  if (!result.applied) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/setup', asyncRoute(async (req, res) => {
  res.status(410).json({ error: 'Owner setup is terminal-only. Restart NexusPanel to create the first owner.' });
}));

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !verifyPassword(req.body.password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  recordLoginEvent(req, user);
  setSessionCookie(res, createSession(user.id));
  res.json({ user: publicUser(user) });
});

app.post('/api/password/forgot', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!email.includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
  const requestKey = `${clientIp(req)}:${email}`;
  const lastRequest = passwordResetRequests.get(requestKey) || 0;
  if (Date.now() - lastRequest < 60 * 1000) {
    return res.status(429).json({ error: 'Wait one minute before requesting another code.' });
  }
  if (isHostEdition() && user.role !== 'owner' && settingValue('host_maintenance_mode', '0') === '1') {
    return res.status(503).json({ error: 'Host maintenance is active. Only the panel owner can sign in.' });
  }
  passwordResetRequests.set(requestKey, Date.now());
  if (user) {
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare(`
      INSERT INTO password_reset_otps (email, code_hash, expires_at, attempts)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = CURRENT_TIMESTAMP
    `).run(email, otpHash(email, code), Date.now() + 10 * 60 * 1000);
    let delivery = 'If that email exists, an OTP was sent or logged for the owner.';
    await sendPasswordOtp(email, code).then((message) => {
      delivery = message;
    }).catch(async (error) => {
      console.error(`Password reset OTP delivery failed: ${error.message}`);
      await fs.promises.appendFile(path.join(dataRoot, 'password-reset-otp.log'), `${new Date().toISOString()} ${email} ${code}\n`, { mode: 0o600 }).catch(() => {});
      delivery = 'Email delivery failed. Owner can read data/password-reset-otp.log on the VPS.';
    });
    return res.json({ ok: true, message: delivery });
  }
  res.json({ ok: true, message: 'If that email exists, an OTP was sent or logged for the owner.' });
}));

app.post('/api/password/reset', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const otp = String(req.body.otp || '').trim();
  const password = String(req.body.password || '');
  if (!email.includes('@') || !/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Email and 6-digit OTP are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const row = db.prepare('SELECT * FROM password_reset_otps WHERE email = ?').get(email);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'OTP expired. Request a new code.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many OTP attempts. Request a new code.' });
  if (row.code_hash !== otpHash(email, otp)) {
    db.prepare('UPDATE password_reset_otps SET attempts = attempts + 1 WHERE email = ?').run(email);
    return res.status(401).json({ error: 'Invalid OTP.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?').run(hashPassword(password), email);
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(email);
  db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
  res.json({ ok: true, message: 'Password reset. You can log in now.' });
});

app.post('/api/logout', (req, res) => {
  const rawCookie = String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${SESSION_COOKIE}=`));

  if (rawCookie) clearSession(decodeURIComponent(rawCookie.slice(SESSION_COOKIE.length + 1)));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/users', requireAccess(permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ users: userRows() });
});

app.get('/api/audit/logins', requireAccess(permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ events: loginEventRows(10) });
});

app.get('/api/host/token', requireAuth, (req, res) => {
  if (!isHostEdition()) return res.status(404).json({ error: 'Host API is available only in host edition.' });
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only owner can view host API token.' });
  res.json({ token: reqOwnerSafeHostToken() });
});

app.post('/api/host/token/regenerate', requireAuth, (req, res) => {
  if (!isHostEdition()) return res.status(404).json({ error: 'Host API is available only in host edition.' });
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only owner can regenerate host API token.' });
  setSettingValue('host_api_token', crypto.randomBytes(32).toString('base64url'));
  res.json({ token: reqOwnerSafeHostToken() });
});

app.get('/api/health', requireAccess(permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  res.json({ health: await runHealthCheck(req.query.force === '1') });
}));

app.get('/api/repair/bundle', requireAccess(permissions.MANAGE_ADMINS), (_req, res) => {
  const crashes = db.prepare(`
    SELECT crash.server_id, crash.signature, crash.software_key, crash.sample, crash.last_seen_at, server.name
    FROM repair_crash_state crash
    JOIN servers server ON server.id = crash.server_id
    ORDER BY crash.last_seen_at DESC
    LIMIT 30
  `).all();
  res.json({
    generatedAt: new Date().toISOString(),
    panelVersion: PANEL_VERSION,
    knowledge: knowledgeStatus(),
    database: databaseHealthStatus,
    crashes,
    brain: repairBrainPayload(),
  });
});

app.post('/api/database/snapshot', requireAccess(permissions.MANAGE_ADMINS), (_req, res) => {
  const snapshot = backupDatabase({ force: true });
  databaseHealthStatus = { ...snapshot.verification, checkedAt: Date.now(), snapshotAt: Date.now() };
  res.json({ ok: true, created: snapshot.created, file: path.basename(snapshot.path), database: databaseHealthStatus });
});

app.post('/api/servers/:id/repair-preview', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id);
  const diagnostics = diagnoseRuntime(consoleLogs(server.id));
  res.json({
    server: server.name,
    signature: crashSignature(server, softwareForServer(server), null, null).signature.slice(0, 12),
    diagnostics,
    knowledge: knowledgeStatus(),
    changesApplied: false,
  });
});

app.post('/api/host/provision', asyncRoute(async (req, res) => {
  if (!isHostApiAuthorized(req)) return res.status(401).json({ error: 'Host API token required.' });
  const account = req.body.account || {};
  const serverInput = req.body.server || req.body;
  const email = account.email || req.body.email;
  const password = account.password || req.body.password;
  const name = account.name || email;
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user) {
    createUser({ email, name, password, role: 'admin', accessLevel: clampNumber(account.accessLevel ?? 5, 0, 100, 5) });
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  }
  const type = serverInput.type === 'java' ? 'java' : 'bedrock';
  const selectedSoftware = findSoftware(serverInput.softwareKey) || defaultSoftware(type);
  const maxCpu = hostCpuCount();
  const cpuCores = clampNumber(serverInput.cpuCores, 1, maxCpu, 1);
  const memoryMb = clampMemoryMb(serverInput.ramMb || serverInput.maxMemoryMb, 1024);
  const backupIntervalMinutes = parseBackupIntervalMinutes(serverInput, 1440);
  const result = db.prepare(`
    INSERT INTO servers (
      name, type, port, max_memory_mb, auto_start, auto_restart, crash_backup,
      scheduled_backups, backup_interval_hours, backup_interval_minutes, backup_retention, wake_on_join, whitelist,
      tunnel_provider, public_alias, startup_delay_sec, software_key, software_version, cpu_cores, disk_limit_mb, owner_user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', '', 0, ?, ?, ?, ?, ?)
  `).run(
    String(serverInput.name || `${name} Server`).trim().slice(0, 80),
    type,
    clampNumber(serverInput.port, 1024, 65535, type === 'java' ? 25565 : 19132),
    memoryMb,
    toBool(serverInput.autoStart),
    toBool(serverInput.autoRestart, true),
    toBool(serverInput.crashBackup, true),
    toBool(serverInput.scheduledBackups, true),
    Math.max(1, Math.round(backupIntervalMinutes / 60)),
    backupIntervalMinutes,
    clampNumber(serverInput.backupRetention, 1, 20, 4),
    toBool(serverInput.wakeOnJoin),
    toBool(serverInput.whitelist),
    selectedSoftware.key,
    String(serverInput.softwareVersion || 'latest').slice(0, 32),
    cpuCores,
    clampNumber(serverInput.diskLimitMb, 0, 1048576, 0),
    user.id,
  );
  const inserted = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
  setSettingValue(`server_backup_timezone_${inserted.id}`, getUserTimezone(user.id));
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
  const executablePath = path.join(root, 'software', selectedSoftware.executable);
  const mark = writeProfile({ ...inserted, server_path: root }, root, null);
  db.prepare('UPDATE servers SET server_path = ?, executable_path = ?, nexus_mark_profile = ? WHERE id = ?')
    .run(root, executablePath, JSON.stringify(mark), inserted.id);
  res.status(201).json({ user: publicUser(user), server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(inserted.id), req) });
}));

app.post('/api/users', requireAccess(permissions.MANAGE_ADMINS), (req, res) => {
  const user = createUser({
    email: req.body.email,
    name: req.body.name,
    password: req.body.password,
    role: 'admin',
    accessLevel: req.body.accessLevel,
    expiresAt: adminExpiresAt(req.body),
  });
  const assignedServerId = Number(req.body.assignedServerId || 0);
  if (assignedServerId && user.role !== 'owner') {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(assignedServerId);
    if (!server) return res.status(404).json({ error: 'Assigned server not found.' });
    db.prepare('UPDATE servers SET owner_user_id = ? WHERE id = ?').run(user.id, server.id);
  }

  res.status(201).json({ user });
});

app.patch('/api/users/:id', requireAccess(permissions.MANAGE_ADMINS), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'owner' && req.user.id !== target.id) {
    return res.status(403).json({ error: 'Owner account cannot be edited by another user.' });
  }

  const accessLevel = target.role === 'owner'
    ? 100
    : Math.max(0, Math.min(100, Number(req.body.accessLevel ?? target.access_level) || 0));
  const name = String(req.body.name || target.name).trim();

  db.prepare(`
    UPDATE users
    SET name = ?, access_level = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, accessLevel, id);

  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

app.delete('/api/users/:id', requireAccess(permissions.MANAGE_ADMINS), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Owner account cannot be deleted.' });

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/servers', requireAuth, (req, res) => {
  res.json({ servers: serverRows(req.user, req) });
});

app.get('/api/servers/:id', requireAuth, (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (!server) return res.status(404).json({ error: 'Server not found.' });

  const minutes = backupIntervalMinutesFrom(server);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  res.json({
    ...serverPayload(server, req),
    backup_interval_hours: hours,
    backup_interval_minutes: mins,
    backup_interval_formatted: hours > 0 && mins > 0 ? `${hours}h ${mins}m` : hours > 0 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${mins} minute${mins > 1 ? 's' : ''}`,
    next_backup_at: server.last_backup_at ? new Date(server.last_backup_at + (minutes * 60 * 1000)).toISOString() : null
  });
});

app.get('/api/software/catalog', requireAuth, (_req, res) => {
  res.json({ software: softwareCatalog() });
});

app.get('/api/software/:key/versions', requireAuth, asyncRoute(async (req, res) => {
  res.json({ versions: await softwareVersions(req.params.key) });
}));

app.post('/api/software/check-updates', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (_req, res) => {
  clearSoftwareVersionCache();
  const versions = {};
  for (const item of softwareCatalog()) {
    versions[item.key] = await softwareVersions(item.key).catch(() => []);
  }
  res.json({ checkedAt: Date.now(), versions });
}));

app.get('/api/templates', requireAuth, (_req, res) => {
  res.json({ templates: templateRows(), nexuSchemaVersion: 1, example: nexuExample() });
});

app.post('/api/templates/import', requireAccess(permissions.MANAGE_ADMINS), (req, res) => {
  const normalized = normalizeNexuTemplate(req.body || {});
  const key = normalized.key;
  const name = normalized.name;
  const safePayload = JSON.stringify(normalized);
  db.prepare(`
    INSERT INTO nexu_templates (key, name, payload)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, payload = excluded.payload
  `).run(key, name, safePayload);
  res.status(201).json({ ok: true, template: normalized });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: panelSettingsPayload(req.user) });
});

app.get('/api/settings/update-status', requireAccess(permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ update: updateStatus });
});

app.get('/api/servers/:id/nexus-mark', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id);
  const nexu = parseJsonObject(server.nexu_payload);
  res.json({ profile: profileForServer(server, nexu), nexu });
});

app.put('/api/settings', requireAccess(permissions.MANAGE_ADMINS), (req, res) => {
  setSettingValue('terminal_enabled', toBool(req.body.terminalEnabled) ? '1' : '0');
  setSettingValue('nexus_mark_enabled', toBool(req.body.nexusMarkEnabled, true) ? '1' : '0');
  if (req.body.timeZone) setUserTimezone(req.user.id, String(req.body.timeZone));
  const publicBaseUrl = String(req.body.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (publicBaseUrl) {
    const parsed = new URL(publicBaseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return res.status(400).json({ error: 'Public panel URL must be HTTP or HTTPS without embedded credentials.' });
    }
  }
  setSettingValue('public_base_url', publicBaseUrl);
  if (isHostEdition()) {
    setSettingValue('host_maintenance_mode', toBool(req.body.hostMaintenanceMode) ? '1' : '0');
    setSettingValue('host_server_quota', clampNumber(req.body.hostServerQuota, 1, 500, 10));
  }
  const updateTag = String(req.body.updateTargetTag || req.body.updateTag || panelSettingsPayload(req.user).updateTag).trim();
  if (/^(normal|host)-v\d+\.\d+(?:\.\d+)?$/.test(updateTag)) setSettingValue('update_target_tag', updateTag);
  setSettingValue('update_repo', FIXED_UPDATE_REPO);
  res.json({ settings: panelSettingsPayload(req.user) });
});

app.post('/api/settings/update', requireAccess(permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  const repo = FIXED_UPDATE_REPO;
  setSettingValue('update_repo', repo);
  if (updateStatus.running) return res.status(409).json({ error: 'Update is already running.' });
  if (process.platform === 'win32') {
    return res.status(400).json({ error: 'Panel self-update button is Linux/systemd focused. Use git pull or update/update.sh on the VPS.' });
  }
  const script = path.join(__dirname, '..', 'update', 'update.sh');
  if (!fs.existsSync(script)) return res.status(404).json({ error: 'update/update.sh was not found.' });
  updateStatus = {
    running: true,
    progress: 5,
    message: 'Starting updater...',
    startedAt: Date.now(),
    finishedAt: 0,
    exitCode: null,
  };
  const requestedTag = String(req.body.updateTargetTag || req.body.updateTag || settingValue('update_target_tag', panelSettingsPayload(req.user).updateTag)).trim();
  const updateTag = /^(normal|host)-v\d+\.\d+(?:\.\d+)?$/.test(requestedTag) ? requestedTag : panelSettingsPayload(req.user).updateTag;
  setSettingValue('update_target_tag', updateTag);
  const child = spawn('bash', [script, repo], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NEXUSPANEL_WEB_UPDATE: '1', NEXUSPANEL_UPDATE_TAG: updateTag },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const capture = (chunk) => {
    const text = String(chunk);
    output = `${output}${text}`.slice(-12000);
    const lastLine = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const reportedProgress = [...text.matchAll(/\[(\d{1,3})%\]/g)].at(-1);
    updateStatus = {
      ...updateStatus,
      progress: reportedProgress
        ? Math.max(0, Math.min(100, Number(reportedProgress[1])))
        : Math.min(95, updateStatus.progress + 2),
      message: lastLine ? lastLine.slice(-220) : updateStatus.message,
    };
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code) => {
    fs.promises.writeFile(path.join(dataRoot, 'last_update.log'), output.slice(-12000), 'utf8').catch(() => {});
    updateStatus = {
      running: false,
      progress: code === 0 ? 100 : updateStatus.progress,
      message: code === 0 ? 'Update complete. Restarting service if configured.' : `Update failed with exit ${code}. Check data/last_update.log.`,
      startedAt: updateStatus.startedAt,
      finishedAt: Date.now(),
      exitCode: code,
    };
    if (code !== 0) console.error(`NexusPanel update failed with code ${code}`);
  });
  res.json({ ok: true, message: `Update started for ${panelSettingsPayload(req.user).updateTag}. Protected folders stay untouched.`, repo });
}));

app.post('/api/terminal/run', requireAccess(permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner account can open terminal.' });
  if (settingValue('terminal_enabled', '0') !== '1') return res.status(403).json({ error: 'Terminal is disabled in Settings.' });
  const owner = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.user.id, 'owner');
  if (!owner || !verifyPassword(req.body.password, owner.password_hash)) {
    return res.status(401).json({ error: 'Owner password is required for terminal access.' });
  }
  const commandText = String(req.body.command || '').trim();
  if (!commandText) return res.status(400).json({ error: 'Command is empty.' });
  if (commandText.length > 1000) return res.status(400).json({ error: 'Command is too long.' });
  const shell = shellForPlatform(commandText);
  const result = await new Promise((resolve) => {
    const child = spawn(shell.command, shell.args, {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      timeout: 15000,
    });
    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (chunk) => { stdoutData += String(chunk); });
    child.stderr.on('data', (chunk) => { stderrData += String(chunk); });
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code, output: `${stdoutData}${stderrData}`.slice(-12000) }));
  });
  res.json(result);
}));

function terminalShell() {
  if (process.platform === 'win32') return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit'] };
  const shell = process.env.SHELL || (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  return { command: shell, args: shell.endsWith('bash') ? ['-l'] : [] };
}

function wrappedTerminalInput(input, token) {
  if (process.platform === 'win32') {
    return `${input}\n$__nexusCode = if ($?) { 0 } else { 1 }\nWrite-Output "__NEXUS_CMD_END_${token}:$($__nexusCode)__"\n`;
  }
  return `${input}\n__nexus_code=$?\nprintf '__NEXUS_CMD_END_${token}:%s__\\n' "$__nexus_code"\n`;
}

function closeWakeWatcher(serverId) {
  const watcher = wakeWatchers.get(serverId);
  if (!watcher) return;
  try { watcher.close(); } catch {}
  wakeWatchers.delete(serverId);
}

function refreshWakeWatchers() {
  const servers = db.prepare('SELECT * FROM servers WHERE wake_on_join = 1 AND auto_start = 0').all();
  const wanted = new Set();
  for (const server of servers) {
    wanted.add(server.id);
    if (runtimeStatus(server.id) === 'online') {
      closeWakeWatcher(server.id);
      continue;
    }
    if (wakeWatchers.has(server.id)) continue;
    const software = softwareForServer(server);
    if (!software) continue;
    const protocol = server.type === 'java' ? 'tcp' : 'udp';
    const start = async () => {
      closeWakeWatcher(server.id);
      try {
        appendLog(server.id, '[NexusPanel] Wake-on-join packet detected. Starting server...');
        if (['java', 'bedrock'].includes(server.type)) await repairPropertiesFile(server);
        startServer(resolveInstalledExecutable(server, software), software);
      } catch (error) {
        appendLog(server.id, `[NexusPanel] Wake-on-join failed: ${error.message}`);
      }
    };
    if (protocol === 'udp') {
      const socket = require('node:dgram').createSocket('udp4');
      socket.once('message', start);
      socket.on('error', (error) => {
        appendLog(server.id, `[NexusPanel] Wake UDP listener failed: ${error.message}`);
        closeWakeWatcher(server.id);
      });
      socket.bind(server.port, '0.0.0.0');
      wakeWatchers.set(server.id, socket);
    } else {
      const listener = require('node:net').createServer((socket) => {
        socket.destroy();
        start();
      });
      listener.on('error', (error) => {
        appendLog(server.id, `[NexusPanel] Wake TCP listener failed: ${error.message}`);
        closeWakeWatcher(server.id);
      });
      listener.listen(server.port, '0.0.0.0');
      wakeWatchers.set(server.id, listener);
    }
  }
  for (const id of [...wakeWatchers.keys()]) {
    if (!wanted.has(id)) closeWakeWatcher(id);
  }
}

function terminalSessionPayload(session) {
  return {
    id: session.id,
    cursor: session.buffer.length,
    active: !session.closed,
    cwd: session.cwd,
  };
}

function requireTerminalSession(req, res) {
  const session = terminalSessions.get(req.params.sessionId);
  if (!session || session.userId !== req.user.id) {
    res.status(404).json({ error: 'Terminal session not found.' });
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of terminalSessions) {
    if (session.closed || now - session.lastSeen > 15 * 60 * 1000) {
      session.child.kill();
      terminalSessions.delete(id);
    }
  }
}, 60 * 1000).unref();

app.post('/api/terminal/session', requireAuth, (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner account can open terminal.' });
  if (settingValue('terminal_enabled', '0') !== '1') return res.status(403).json({ error: 'Terminal is disabled in Settings.' });
  const owner = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.user.id, 'owner');
  if (!owner || !verifyPassword(req.body.password, owner.password_hash)) {
    return res.status(401).json({ error: 'Owner password is required for terminal access.' });
  }
  const existing = [...terminalSessions.values()].find((session) => session.userId === req.user.id && !session.closed);
  if (existing) return res.json({ session: terminalSessionPayload(existing) });

  const shell = terminalShell();
  const cwd = path.join(__dirname, '..');
  const child = spawn(shell.command, shell.args, { cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const session = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    child,
    buffer: [],
    markerBuffer: '',
    pendingCommands: new Map(),
    cwd,
    closed: false,
    lastSeen: Date.now(),
  };
  const push = (chunk) => {
    const clean = String(chunk).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    session.markerBuffer = `${session.markerBuffer}${clean}`.slice(-12000);
    const markerPattern = /__NEXUS_CMD_END_([a-f0-9]+):(\d+)__/g;
    let marker;
    while ((marker = markerPattern.exec(session.markerBuffer))) {
      const pending = session.pendingCommands.get(marker[1]);
      if (pending) {
        recordTerminalRepairOutcome({ ...pending, code: Number(marker[2]) });
        session.pendingCommands.delete(marker[1]);
      }
    }
    session.markerBuffer = session.markerBuffer.replace(markerPattern, '').slice(-4000);
    const visible = clean.replace(markerPattern, '');
    if (visible) session.buffer.push(visible);
    if (session.buffer.length > 2000) session.buffer.splice(0, session.buffer.length - 2000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (error) => { push(`\n[NexusPanel terminal error] ${error.message}\n`); session.closed = true; });
  child.on('close', (code) => { push(`\n[NexusPanel terminal closed] exit=${code}\n`); session.closed = true; });
  terminalSessions.set(session.id, session);
  res.status(201).json({ session: terminalSessionPayload(session) });
});

app.get('/api/terminal/session/:sessionId/output', requireAuth, (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner account can open terminal.' });
  const session = requireTerminalSession(req, res);
  if (!session) return;
  const cursor = clampNumber(req.query.cursor, 0, session.buffer.length, 0);
  res.json({ output: session.buffer.slice(cursor).join(''), cursor: session.buffer.length, active: !session.closed });
});

app.post('/api/terminal/session/:sessionId/input', requireAuth, (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner account can open terminal.' });
  const session = requireTerminalSession(req, res);
  if (!session) return;
  if (session.closed) return res.status(410).json({ error: 'Terminal session is closed.' });
  const input = String(req.body.input || '');
  if (input.length > 4000) return res.status(400).json({ error: 'Terminal input is too long.' });
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.body.serverId));
  const crash = server && db.prepare('SELECT * FROM repair_crash_state WHERE server_id = ?').get(server.id);
  const canObserve = Boolean(
    server
    && crash
    && Date.now() - Number(crash.last_seen_at) <= 4 * 60 * 60 * 1000
    && !input.includes('\n')
    && !/^\s*(?:exit|logout)\b/i.test(input),
  );
  if (canObserve) {
    const token = crypto.randomBytes(8).toString('hex');
    session.pendingCommands.set(token, { serverId: server.id, command: input.trim() });
    session.child.stdin.write(wrappedTerminalInput(input, token));
  } else {
    session.child.stdin.write(input.endsWith('\n') ? input : `${input}\n`);
  }
  res.json({ ok: true, learning: canObserve, serverId: server?.id || null });
});

app.delete('/api/terminal/session/:sessionId', requireAuth, (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner account can open terminal.' });
  const session = requireTerminalSession(req, res);
  if (!session) return;
  session.child.kill();
  terminalSessions.delete(session.id);
  res.json({ ok: true });
});

app.post('/api/servers', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Server name is required.' });
  const type = req.body.type === 'java' ? 'java' : 'bedrock';
  const selectedSoftware = findSoftware(req.body.softwareKey) || defaultSoftware(type);
  if (!selectedSoftware || selectedSoftware.edition !== type) {
    return res.status(400).json({ error: 'Selected software is not compatible with this server type.' });
  }

  const ownerUserId = ownerOnly(req) ? resolveServerOwnerUserId(req, req.body.ownerUserId, null) : req.user.id;
  assertHostServerQuota(ownerUserId);
  const result = db.prepare(`
    INSERT INTO servers (
      name, type, port, max_memory_mb, auto_start, auto_restart, crash_backup,
      scheduled_backups, backup_interval_hours, backup_interval_minutes, backup_retention, wake_on_join, whitelist,
      tunnel_provider, public_alias, startup_delay_sec, software_key, software_version, cpu_cores, disk_limit_mb, owner_user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    type,
    clampNumber(req.body.port, 1024, 65535, type === 'java' ? 25565 : 19132),
    clampMemoryMb(req.body.maxMemoryMb, 1024),
    toBool(req.body.autoStart),
    toBool(req.body.autoRestart, true),
    toBool(req.body.crashBackup, true),
    toBool(req.body.scheduledBackups, true),
    Math.max(1, Math.round(parseBackupIntervalMinutes(req.body, 1440) / 60)),
    parseBackupIntervalMinutes(req.body, 1440),
    clampNumber(req.body.backupRetention, 1, 20, 4),
    toBool(req.body.wakeOnJoin),
    toBool(req.body.whitelist),
    'none',
    '',
    clampNumber(req.body.startupDelaySec, 0, 600, 0),
    selectedSoftware.key,
    String(req.body.softwareVersion || 'latest').trim().slice(0, 32) || 'latest',
    clampNumber(req.body.cpuCores, 1, hostCpuCount(), 1),
    0,
    ownerUserId,
  );

  const inserted = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
  setSettingValue(`server_backup_timezone_${inserted.id}`, getUserTimezone(req.user.id));
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
  const executablePath = path.join(root, 'software', selectedSoftware.executable);
  const mark = writeProfile({ ...inserted, server_path: root }, root, null);
  db.prepare('UPDATE servers SET server_path = ?, executable_path = ?, nexus_mark_profile = ? WHERE id = ?').run(root, executablePath, JSON.stringify(mark), inserted.id);

  res.status(201).json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(inserted.id)) });
});

app.post('/api/templates/:key/create', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const template = findTemplate(req.params.key) || templateRows().find((item) => item.key === req.params.key);
  if (!template) return res.status(404).json({ error: 'Template not found.' });
  const nexu = normalizeNexuTemplate(template.nexu || template);
  const name = String(req.body.name || template.name).trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Server name is required.' });
  const memoryMb = clampMemoryMb(req.body.maxMemoryMb || nexu.resources.ramMb, nexu.resources.ramMb);
  const portValue = clampNumber(req.body.port || nexu.resources.ports[0]?.port, 1, 65535, nexu.resources.ports[0]?.port || 25565);
  const cpuCores = clampNumber(req.body.cpuCores || nexu.resources.cpuCores, 1, hostCpuCount(), nexu.resources.cpuCores || 1);
  const type = nexu.game.edition === 'java' || nexu.game.edition === 'bedrock' ? nexu.game.edition : 'custom';
  const selectedSoftware = findSoftware(nexu.runtime.softwareKey);
  const ownerUserId = ownerOnly(req) ? resolveServerOwnerUserId(req, req.body.ownerUserId, null) : req.user.id;
  assertHostServerQuota(ownerUserId);

  const result = db.prepare(`
    INSERT INTO servers (
      name, type, port, max_memory_mb, auto_start, auto_restart, crash_backup,
      scheduled_backups, backup_interval_hours, backup_interval_minutes, backup_retention, wake_on_join, whitelist,
      tunnel_provider, public_alias, startup_delay_sec, software_key, software_version, install_status, install_message,
      cpu_cores, disk_limit_mb, template_key, nexu_payload, nexus_mark_profile, owner_user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    type,
    portValue,
    memoryMb,
    0,
    1,
    1,
    1,
    24,
    1440,
    4,
    0,
    0,
    0,
    nexu.runtime.softwareKey,
    nexu.runtime.install.version || 'latest',
    selectedSoftware ? 'missing' : 'template',
    selectedSoftware ? 'Software not installed' : 'Nexu template imported. Add an installer command before start.',
    cpuCores,
    nexu.resources.diskMb,
    nexu.key,
    JSON.stringify(nexu),
    '',
    ownerUserId,
  );

  const inserted = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
  setSettingValue(`server_backup_timezone_${inserted.id}`, getUserTimezone(req.user.id));
  const executablePath = selectedSoftware ? path.join(root, 'software', selectedSoftware.executable) : '';
  const mark = writeProfile({ ...inserted, server_path: root, max_memory_mb: memoryMb, cpu_cores: cpuCores, disk_limit_mb: nexu.resources.diskMb }, root, nexu);
  db.prepare('UPDATE servers SET server_path = ?, executable_path = ?, nexus_mark_profile = ? WHERE id = ?').run(root, executablePath, JSON.stringify(mark), inserted.id);
  appendLog(inserted.id, `[NexusPanel] Created from Nexu template: ${nexu.name}. Nexus-Mark profile ready.`);
  res.status(201).json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(inserted.id)) });
});

app.patch('/api/servers/:id', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });

  const name = String(req.body.name ?? target.name).trim();
  if (name.length < 2) return res.status(400).json({ error: 'Server name is required.' });
  const type = req.body.type === 'java' ? 'java' : req.body.type === 'bedrock' ? 'bedrock' : target.type;
  const selectedSoftware = findSoftware(req.body.softwareKey ?? target.software_key)
    || (type === 'java' || type === 'bedrock' ? defaultSoftware(type) : null);
  if ((type === 'java' || type === 'bedrock') && (!selectedSoftware || selectedSoftware.edition !== type)) {
    return res.status(400).json({ error: 'Selected software is not compatible with this server type.' });
  }
  const root = ensureServerDirs({ ...target, name, type, server_path: target.server_path || serverPath(target.id, name) });
  const softwareChanged = (selectedSoftware ? selectedSoftware.key : target.software_key) !== target.software_key || type !== target.type;
  const executablePath = selectedSoftware && softwareChanged
    ? path.join(root, 'software', selectedSoftware.executable)
    : target.executable_path || (selectedSoftware ? path.join(root, 'software', selectedSoftware.executable) : '');
  const memoryMb = ownerOnly(req)
    ? clampMemoryMb(req.body.maxMemoryMb, target.max_memory_mb)
    : target.max_memory_mb;
  const ownerUserId = ownerOnly(req)
    ? resolveServerOwnerUserId(req, req.body.ownerUserId, target.owner_user_id)
    : target.owner_user_id;

  db.prepare(`
    UPDATE servers
    SET name = ?, type = ?, port = ?, max_memory_mb = ?, auto_start = ?,
        auto_restart = ?, crash_backup = ?, scheduled_backups = ?,
        backup_interval_hours = ?, backup_interval_minutes = ?, backup_retention = ?, wake_on_join = ?, whitelist = ?,
        tunnel_provider = ?, public_alias = ?, startup_delay_sec = ?,
        server_path = ?, software_key = ?, software_version = ?, executable_path = ?,
        owner_user_id = ?
    WHERE id = ?
  `).run(
    name,
    type,
    clampNumber(req.body.port, 1024, 65535, target.port),
    memoryMb,
    toBool(req.body.autoStart, Boolean(target.auto_start)),
    toBool(req.body.autoRestart, Boolean(target.auto_restart)),
    toBool(req.body.crashBackup, Boolean(target.crash_backup)),
    toBool(req.body.scheduledBackups, Boolean(target.scheduled_backups)),
    Math.max(1, Math.round(parseBackupIntervalMinutes(req.body, backupIntervalMinutesFrom(target)) / 60)),
    parseBackupIntervalMinutes(req.body, backupIntervalMinutesFrom(target)),
    clampNumber(req.body.backupRetention, 1, 20, target.backup_retention),
    toBool(req.body.wakeOnJoin, Boolean(target.wake_on_join)),
    toBool(req.body.whitelist, Boolean(target.whitelist)),
    'none',
    '',
    clampNumber(req.body.startupDelaySec, 0, 600, target.startup_delay_sec),
    root,
    selectedSoftware ? selectedSoftware.key : target.software_key,
    String(req.body.softwareVersion ?? target.software_version ?? 'latest').trim().slice(0, 32) || 'latest',
    executablePath,
    ownerUserId,
    id,
  );
  setSettingValue(`server_backup_timezone_${id}`, getUserTimezone(ownerUserId || req.user.id));

  res.json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(id)) });
});

app.delete('/api/servers/:id', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  if (runtimeStatus(server.id) === 'online') return res.status(400).json({ error: 'Stop the server before deleting it.' });
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  await fs.promises.rm(assertInside(serversRoot, root), { recursive: true, force: true });
  db.prepare('DELETE FROM panel_settings WHERE key = ?').run(`server_backup_timezone_${server.id}`);
  await fs.promises.rm(assertInside(backupsRoot, path.join(backupsRoot, String(server.id))), { recursive: true, force: true }).catch(() => {});
  db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
  appendLog(server.id, '[NexusPanel] Server deleted.');
  res.json({ ok: true });
}));

app.patch('/api/servers/:id/software', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });

  const selectedSoftware = findSoftware(req.body.softwareKey);
  if (!selectedSoftware || selectedSoftware.edition !== target.type) {
    return res.status(400).json({ error: 'Selected software is not compatible with this server.' });
  }

  const root = ensureServerDirs({ ...target, server_path: target.server_path || serverPath(target.id, target.name) });
  const executablePath = path.join(root, 'software', selectedSoftware.executable);
  const version = String(req.body.softwareVersion || target.software_version || 'latest').trim().slice(0, 32) || 'latest';
  db.prepare('UPDATE servers SET server_path = ?, software_key = ?, software_version = ?, executable_path = ? WHERE id = ?')
    .run(root, selectedSoftware.key, version, executablePath, id);

  res.json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(id)) });
});

app.post('/api/servers/:id/software/install', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });

  const selectedSoftware = findSoftware(req.body.softwareKey || target.software_key) || defaultSoftware(target.type);
  if (!selectedSoftware && target.nexu_payload) {
    installNexuTemplate(target)
      .catch((error) => {
        db.prepare(`
          UPDATE servers
          SET install_status = 'failed', install_progress = 0, install_message = ?
          WHERE id = ?
        `).run(error.message, id);
        appendLog(id, `[NexusPanel] Nexu install failed: ${error.message}`);
      });
    return res.json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(id)) });
  }
  if (!selectedSoftware || selectedSoftware.edition !== target.type) {
    return res.status(400).json({ error: 'Selected software is not compatible with this server.' });
  }

  const root = ensureServerDirs({ ...target, server_path: target.server_path || serverPath(target.id, target.name) });
  const executablePath = path.join(root, 'software', selectedSoftware.executable);
  const downloadPath = selectedSoftware.key === 'bedrock-vanilla'
    ? path.join(root, 'software', `${selectedSoftware.folder}.zip`)
    : executablePath;
  const version = String(req.body.softwareVersion || target.software_version || 'latest').trim().slice(0, 32) || 'latest';
  db.prepare(`
    UPDATE servers
    SET server_path = ?, software_key = ?, software_version = ?, executable_path = ?,
        install_status = 'installing', install_progress = 10,
        install_message = 'Resolving downloadable version'
    WHERE id = ?
  `).run(root, selectedSoftware.key, version, executablePath, id);

  resolveDownload(selectedSoftware, version)
    .then(async (download) => {
      ensureSoftwareRequirements(selectedSoftware, id, (progress, message) => {
        db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?').run(progress, message, id);
      });
      if (selectedSoftware.key === 'pocketmine') {
        await installPocketMineRuntime(root, id, (progress, message) => {
          db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?').run(progress, message, id);
        });
      }
      const baseProgress = selectedSoftware.key === 'pocketmine' ? 55 : 18;
      db.prepare('UPDATE servers SET software_version = ?, install_progress = ?, install_message = ? WHERE id = ?')
        .run(download.version, baseProgress, `Downloading ${selectedSoftware.name} ${download.version}`, id);
      await downloadToFile(download.url, downloadPath, (progress) => {
        db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?')
          .run(selectedSoftware.key === 'pocketmine' ? Math.max(55, Math.min(98, 55 + Math.round(progress * 0.43))) : Math.max(18, progress), `Downloading ${selectedSoftware.name} ${download.version}`, id);
      });
      if (selectedSoftware.key === 'bedrock-vanilla' && download.archive) {
        const extractDir = path.join(root, 'software', 'bedrock-extract');
        db.prepare('UPDATE servers SET install_progress = 96, install_message = ? WHERE id = ?').run('Extracting Bedrock server zip', id);
        extractArchive(downloadPath, extractDir);
        copyDirectoryContents(extractDir, root);
        const bedrockBinary = findFile(root, selectedSoftware.executable);
        if (!bedrockBinary) throw new Error('Bedrock archive extracted but server executable was not found.');
        await fs.promises.rm(downloadPath, { force: true }).catch(() => {});
        await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        db.prepare('UPDATE servers SET executable_path = ? WHERE id = ?').run(bedrockBinary, id);
      }
      if (process.platform !== 'win32' && selectedSoftware.key === 'bedrock-vanilla') {
        await fs.promises.chmod(db.prepare('SELECT executable_path FROM servers WHERE id = ?').get(id).executable_path, 0o755).catch(() => {});
      }
      if (selectedSoftware.key === 'pocketmine') {
        const runtimeMeta = JSON.parse(await fs.promises.readFile(path.join(root, 'runtime', 'pocketmine-php.json'), 'utf8'));
        await fs.promises.writeFile(
          path.join(root, process.platform === 'win32' ? 'start-pocketmine.bat' : 'start-pocketmine.sh'),
          process.platform === 'win32'
            ? `@echo off\r\n"${runtimeMeta.phpBinary}" "${executablePath}" --no-wizard --disable-ansi\r\npause\r\n`
            : `#!/bin/sh\n"${runtimeMeta.phpBinary}" "${executablePath}" --no-wizard --disable-ansi\n`,
          'utf8',
        );
      }
      db.prepare(`
        UPDATE servers
        SET install_status = 'installed', install_progress = 100, install_message = ?
        WHERE id = ?
      `).run(`Installed ${selectedSoftware.name} ${download.version}`, id);
      appendLog(id, `[NexusPanel] Installed ${selectedSoftware.name} ${download.version}.`);
    })
    .catch((error) => {
      db.prepare(`
        UPDATE servers
        SET install_status = 'failed', install_progress = 0, install_message = ?
        WHERE id = ?
      `).run(error.message, id);
      appendLog(id, `[NexusPanel] Install failed: ${error.message}`);
    });

  res.json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(id)) });
}));

app.get('/api/servers/:id/plugins', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });
  res.json({ plugins: pluginRows(id) });
});

app.post('/api/servers/:id/plugins', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });

  const software = findSoftware(target.software_key) || defaultSoftware(target.type);
  const fileName = String(req.body.fileName || '').trim();
  const kind = req.body.kind || pluginKindForFile(fileName);
  if (!kind) return res.status(400).json({ error: 'Unsupported plugin or pack extension.' });
  if (!software.pluginKinds.includes(kind)) {
    return res.status(400).json({ error: `${kind} is not compatible with ${software.name}.` });
  }

  const targetPath = pluginTarget(target, kind, fileName);
  const name = String(req.body.name || fileName.replace(/\.[^.]+$/, '')).trim().slice(0, 80);
  const result = db.prepare(`
    INSERT INTO plugins (server_id, name, kind, file_name, relative_path, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, kind, fileName, targetPath.relativePath, toBool(req.body.enabled, true));

  res.status(201).json({
    plugin: pluginRows(id).find((plugin) => plugin.id === result.lastInsertRowid),
    targetPath: displayPath(targetPath.absolutePath),
  });
});

app.get('/api/modrinth/search', requireAuth, asyncRoute(async (req, res) => {
  const server = req.query.serverId ? getServerOr404(req.query.serverId) : null;
  const software = server ? (findSoftware(server.software_key) || defaultSoftware(server.type)) : null;
  if (software && !['paper', 'purpur'].includes(software.key)) {
    return res.json({ hits: [], source: 'modrinth', message: 'Modrinth plugins are available for Paper/Purpur Java servers.' });
  }
  const loader = req.query.loader || (software && ['paper', 'purpur'].includes(software.key) ? 'paper' : '');
  const version = String(req.query.version || server?.software_version || '').trim();
  const query = String(req.query.query || '').trim();
  const facets = [['project_type:plugin'], ['server_side:required', 'server_side:optional']];
  if (loader) facets.push([`categories:${loader}`]);
  if (version && !['latest', 'manual'].includes(version) && req.query.strictVersion === '1') facets.push([`versions:${version}`]);

  const params = new URLSearchParams({
    query,
    limit: '24',
    index: 'downloads',
    facets: JSON.stringify(facets),
  });
  const response = await fetch(`https://api.modrinth.com/v2/search?${params}`, {
    headers: { 'User-Agent': 'NexusPanel/1.0' },
  });
  if (!response.ok) throw new Error(`Modrinth search failed: ${response.status}`);
  const data = await response.json();
  res.json({
    source: 'modrinth',
    hits: (data.hits || []).map((project) => ({
      projectId: project.project_id,
      slug: project.slug,
      title: project.title,
      description: project.description,
      downloads: project.downloads,
      follows: project.follows,
      iconUrl: project.icon_url,
      categories: project.categories,
      versions: project.versions,
    })),
  });
}));

async function poggitReleases() {
  const response = await fetch('https://poggit.pmmp.io/releases.min.json', {
    headers: { 'User-Agent': 'NexusPanel/1.0' },
  });
  if (!response.ok) throw new Error(`Poggit search failed: ${response.status}`);
  return response.json();
}

app.get('/api/poggit/search', requireAuth, asyncRoute(async (req, res) => {
  const server = req.query.serverId ? getServerOr404(req.query.serverId) : null;
  const software = server ? (findSoftware(server.software_key) || defaultSoftware(server.type)) : null;
  if (software && software.key !== 'pocketmine') {
    return res.json({ hits: [], source: 'poggit', message: 'Poggit plugins are available for PocketMine servers.' });
  }
  const query = String(req.query.query || '').trim().toLowerCase();
  const releases = await poggitReleases();
  const seen = new Set();
  const hits = releases
    .filter((plugin) => !query
      || String(plugin.name || '').toLowerCase().includes(query)
      || String(plugin.project_name || '').toLowerCase().includes(query)
      || String(plugin.tagline || '').toLowerCase().includes(query))
    .filter((plugin) => {
      const key = String(plugin.project_name || plugin.name || '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30)
    .map((plugin) => ({
      projectId: plugin.project_id,
      name: plugin.project_name || plugin.name,
      title: plugin.project_name || plugin.name,
      version: plugin.version,
      description: plugin.tagline || '',
      downloads: plugin.downloads || 0,
      iconUrl: plugin.icon_url || '',
      fileName: `${plugin.project_name || plugin.name}.phar`.replace(/[\\/:*?"<>|]+/g, '-'),
      downloadUrl: plugin.artifact_url,
      pageUrl: plugin.html_url,
    }));
  res.json({ source: 'poggit', hits });
}));

app.post('/api/servers/:id/modrinth/install', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  if (!['paper', 'purpur'].includes(software.key)) {
    return res.status(400).json({ error: 'Modrinth plugin install currently supports Paper/Purpur Java servers.' });
  }

  const projectId = String(req.body.projectId || '').trim();
  if (!projectId) return res.status(400).json({ error: 'Modrinth project id is required.' });
  const gameVersion = String(req.body.gameVersion || server.software_version || '').trim();
  const loaders = ['paper'];
  const params = new URLSearchParams({ loaders: JSON.stringify(loaders) });
  if (gameVersion && !['latest', 'manual'].includes(gameVersion)) params.set('game_versions', JSON.stringify([gameVersion]));

  const versionResponse = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${params}`, {
    headers: { 'User-Agent': 'NexusPanel/1.0' },
  });
  if (!versionResponse.ok) throw new Error(`Modrinth versions failed: ${versionResponse.status}`);
  const versions = await versionResponse.json();
  const selected = versions[0];
  const file = selected?.files?.find((item) => item.primary) || selected?.files?.[0];
  if (!file?.url || !file?.filename) throw new Error('No compatible plugin file found on Modrinth.');

  const target = pluginTarget(server, 'jar-plugin', file.filename);
  await downloadToFile(file.url, target.absolutePath, () => {});
  const name = String(req.body.name || selected.name || file.filename.replace(/\.jar$/i, '')).trim().slice(0, 80);
  const result = db.prepare(`
    INSERT INTO plugins (server_id, name, kind, file_name, relative_path, enabled)
    VALUES (?, ?, 'jar-plugin', ?, ?, 1)
  `).run(server.id, name, file.filename, target.relativePath);
  appendLog(server.id, `[NexusPanel] Installed Modrinth plugin ${name}. Restart server to load it.`);

  res.status(201).json({
    plugin: pluginRows(server.id).find((plugin) => plugin.id === result.lastInsertRowid),
    targetPath: displayPath(target.absolutePath),
  });
}));

app.post('/api/servers/:id/poggit/install', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  if (software.key !== 'pocketmine') {
    return res.status(400).json({ error: 'Poggit plugins can only be installed on PocketMine servers.' });
  }
  const downloadUrl = String(req.body.downloadUrl || '').trim();
  if (!downloadUrl.startsWith('https://poggit.pmmp.io/')) return res.status(400).json({ error: 'Invalid Poggit download URL.' });
  const fileName = String(req.body.fileName || `${req.body.name || 'plugin'}.phar`).replace(/[\\/:*?"<>|]+/g, '-');
  const target = pluginTarget(server, 'phar-plugin', fileName.endsWith('.phar') ? fileName : `${fileName}.phar`);
  await downloadToFile(downloadUrl, target.absolutePath, () => {});
  const name = String(req.body.name || fileName.replace(/\.phar$/i, '')).trim().slice(0, 80);
  const result = db.prepare(`
    INSERT INTO plugins (server_id, name, kind, file_name, relative_path, enabled)
    VALUES (?, ?, 'phar-plugin', ?, ?, 1)
  `).run(server.id, name, path.basename(target.absolutePath), target.relativePath);
  appendLog(server.id, `[NexusPanel] Installed Poggit plugin ${name}. Restart server to load it.`);
  res.status(201).json({
    plugin: pluginRows(server.id).find((plugin) => plugin.id === result.lastInsertRowid),
    targetPath: displayPath(target.absolutePath),
  });
}));

app.get('/api/servers/:id/console', requireAccess(permissions.VIEW_CONSOLE), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });
  res.json({ status: runtimeStatus(id), lines: consoleLogs(id) });
});

app.get('/api/servers/:id/metrics', requireAuth, (req, res) => {
  const server = getServerOr404(req.params.id);
  const details = runtimeDetails(server.id);
  let rssMb = 0;
  let cpuPercent = 0;
  if (details.pid && process.platform !== 'win32') {
    const result = spawnSync('ps', ['-p', String(details.pid), '-o', '%cpu=,rss='], { encoding: 'utf8' });
    const [cpu, rss] = String(result.stdout || '').trim().split(/\s+/).map(Number);
    cpuPercent = Number.isFinite(cpu) ? Math.round(cpu) : 0;
    rssMb = Number.isFinite(rss) ? Math.round(rss / 1024) : 0;
  } else if (details.pid && process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$p=Get-Process -Id ${Number(details.pid)} -ErrorAction SilentlyContinue; if($p){ [Console]::WriteLine("{0} {1}", [Math]::Round($p.WorkingSet64/1MB), [Math]::Round($p.CPU,2)) }`,
    ], { encoding: 'utf8', windowsHide: true });
    const [rss] = String(result.stdout || '').trim().split(/\s+/).map(Number);
    rssMb = Number.isFinite(rss) ? Math.round(rss) : 0;
  }
  res.json({
    status: details.status,
    pid: details.pid,
    players: details.players,
    playerCount: details.players.length,
    maxMemoryMb: server.max_memory_mb,
    rssMb,
    cpuPercent,
  });
});

app.get('/api/system/metrics', requireAuth, (_req, res) => {
  const memory = hostMemoryStats();
  const load = os.loadavg()[0] || 0;
  res.json({
    cpuPercent: hostCpuPercent(),
    ramUsedMb: Math.round(memory.used / 1024 / 1024),
    ramTotalMb: Math.round(memory.total / 1024 / 1024),
    load: Number(load.toFixed(2)),
    cores: hostCpuCount(),
  });
});

app.post('/api/servers/:id/start', requireAccess(permissions.POWER_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!hasJavaEula(server)) return res.status(409).json({ error: 'Agree to the Minecraft EULA first.' });
  const software = softwareForServer(server);
  if (!software) return res.status(400).json({ error: 'This Nexu template needs an installer/runtime before it can start.' });
  if (['java', 'bedrock'].includes(server.type)) await repairPropertiesFile(server);
  try {
    return res.json(startServer(resolveInstalledExecutable(server, software), software));
  } catch (error) {
    if (!/install server software|executable/i.test(error.message)) throw error;
    appendLog(server.id, `[NexusPanel] Smart fix: ${error.message}`);
    const repaired = await repairMissingExecutable(server, software);
    const fixedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    const result = startServer(resolveInstalledExecutable(fixedServer, software), software);
    return res.json({ ...result, repaired });
  }
}));

app.post('/api/servers/:id/fix', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  if (runtimeStatus(server.id) === 'online') return res.status(409).json({ error: 'Stop the server before running Fix Server.' });
  const software = softwareForServer(server);
  if (!software) return res.status(400).json({ error: 'This server has no repairable software runtime.' });
  const report = await runServerRepair(server, software);
  const learned = learnRepairPlaybook(server, report);
  appendLog(server.id, `[NexusPanel] Repair & Diagnose completed: ${report.summary}`);
  if (learned) appendLog(server.id, `[NexusPanel] Learned repair playbook ${learned.signature} from this successful fix.`);
  res.json({ ok: true, ...report, learned, server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id), req) });
}));

app.post('/api/servers/:id/eula', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  await agreeJavaEula(server);
  appendLog(server.id, '[NexusPanel] EULA accepted from panel.');
  res.json({ ok: true, eulaAgreed: true });
}));

app.post('/api/servers/:id/stop', requireAccess(permissions.POWER_SERVERS), (req, res) => {
  res.json(stopServer(Number(req.params.id)));
});

app.post('/api/servers/:id/restart', requireAccess(permissions.POWER_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!hasJavaEula(server)) return res.status(409).json({ error: 'Agree to the Minecraft EULA first.' });
  const software = softwareForServer(server);
  if (!software) return res.status(400).json({ error: 'This Nexu template needs an installer/runtime before it can restart.' });
  if (['java', 'bedrock'].includes(server.type)) await repairPropertiesFile(server);
  res.json(restartServer(resolveInstalledExecutable(server, software), software));
}));

app.post('/api/servers/:id/kill', requireAccess(permissions.POWER_SERVERS), (req, res) => {
  res.json(killServer(Number(req.params.id)));
});

app.post('/api/servers/:id/command', requireAccess(permissions.SEND_COMMANDS), (req, res) => {
  sendCommand(Number(req.params.id), req.body.command);
  res.json({ ok: true });
});

app.get('/api/servers/:id/properties', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const values = await readProperties(server);
  const schema = propertySchema.filter((item) => item.editions.includes(server.type));
  res.json({ schema, values });
}));

app.put('/api/servers/:id/properties', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const allowed = new Set(propertySchema.filter((item) => item.editions.includes(server.type)).map((item) => item.key));
  const values = {};
  for (const [key, value] of Object.entries(req.body.values || {})) {
    if (allowed.has(key)) values[key] = String(value);
  }
  await writeProperties(server, values);
  appendLog(server.id, '[NexusPanel] server.properties updated. Restart may be required.');
  res.json({ values: await readProperties(server) });
}));

app.get('/api/servers/:id/whitelist', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  res.json({ players: await readWhitelist(server) });
}));

app.post('/api/servers/:id/whitelist', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Player name is required.' });
  const rows = await readWhitelist(server);
  if (rows.some((row) => String(row.name || '').toLowerCase() === name.toLowerCase())) {
    return res.json({ players: rows });
  }
  rows.push(software.edition === 'java'
    ? { uuid: await javaUuidForName(name), name }
    : { name, xuid: String(req.body.xuid || ''), ignoresPlayerLimit: Boolean(req.body.ignoresPlayerLimit) });
  await writeWhitelist(server, rows);
  const key = software.edition === 'java' ? 'white-list' : 'allow-list';
  await writeProperties(server, { [key]: 'true' });
  reloadWhitelistIfRunning(server, software);
  appendLog(server.id, `[NexusPanel] Whitelisted ${name}.`);
  res.status(201).json({ players: rows });
}));

app.delete('/api/servers/:id/whitelist/:name', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  const name = String(req.params.name || '').toLowerCase();
  const rows = (await readWhitelist(server)).filter((row) => String(row.name || '').toLowerCase() !== name);
  await writeWhitelist(server, rows);
  reloadWhitelistIfRunning(server, software);
  appendLog(server.id, `[NexusPanel] Removed whitelist entry ${req.params.name}.`);
  res.json({ players: rows });
}));

app.delete('/api/servers/:id/whitelist', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  await writeWhitelist(server, []);
  reloadWhitelistIfRunning(server, software);
  appendLog(server.id, '[NexusPanel] Cleared whitelist.');
  res.json({ players: [] });
}));

app.get('/api/servers/:id/backups', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const canShareOwner = canOwnServerShare(req.user, server);
  const code = canShareOwner ? db.prepare('SELECT code, expires_at FROM backup_share_codes WHERE server_id = ? AND expires_at > ?').get(server.id, Date.now()) : null;
  const incoming = canShareOwner ? db.prepare(`
    SELECT r.id, r.status, r.expires_at, r.created_at, s.name AS target_name, u.email AS requester_email
    FROM backup_share_requests r
    JOIN servers s ON s.id = r.target_server_id
    JOIN users u ON u.id = r.requester_user_id
    WHERE r.source_server_id = ?
    ORDER BY r.updated_at DESC
  `).all(server.id) : [];
  const sharedSources = db.prepare(`
    SELECT r.id, r.source_server_id, r.expires_at, s.name AS source_name
    FROM backup_share_requests r
    JOIN servers s ON s.id = r.source_server_id
    WHERE r.target_server_id = ? AND r.status = 'approved' AND (r.expires_at = 0 OR r.expires_at > ?)
    ORDER BY s.name ASC
  `).all(server.id, Date.now());
  const sharedBackups = [];
  for (const source of sharedSources) {
    const sourceServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(source.source_server_id);
    if (!sourceServer) continue;
    sharedBackups.push({
      requestId: source.id,
      sourceServerId: source.source_server_id,
      sourceName: source.source_name,
      expiresAt: source.expires_at,
      backups: await backupRows(sourceServer),
    });
  }
  const intervalMs = backupIntervalMinutesFrom(server) * 60 * 1000;
  const nextBackupAt = server.scheduled_backups
    ? Number(server.last_backup_at || 0) > 0 ? Number(server.last_backup_at) + intervalMs : Date.now()
    : 0;
  res.json({
    backups: await backupRows(server),
    canManageShare: canShareOwner,
    shareCode: code || null,
    shareRequests: incoming,
    sharedBackups,
    schedule: {
      enabled: Boolean(server.scheduled_backups),
      intervalMinutes: backupIntervalMinutesFrom(server),
      lastBackupAt: Number(server.last_backup_at || 0),
      nextBackupAt,
      schedulerResolutionSeconds: 30,
      fileNameTimeZone: backupTimezone(server),
    },
  });
}));

app.post('/api/servers/:id/backups/public-link', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the server owner can publish backup links.' });
  const expiresAt = Date.now() + durationMs(req.body || {}, 60, 24 * 60);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE backup_public_links SET revoked_at = ? WHERE server_id = ? AND revoked_at = 0').run(Date.now(), server.id);
  db.prepare('INSERT INTO backup_public_links (server_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(server.id, tokenHash(token), expiresAt);
  const configuredBase = settingValue('public_base_url', process.env.NEXUSPANEL_PUBLIC_URL || '').replace(/\/+$/, '');
  const base = configuredBase || `${req.protocol}://${req.get('host')}`;
  let backups = await backupRows(server);
  if (!backups.length) {
    await createServerBackup(server, 'share');
    backups = await backupRows(server);
  }
  const archives = backups.map((backup) => ({
    ...backup,
    url: `${base}/api/public/backups/${encodeURIComponent(token)}/${encodeURIComponent(backup.name)}`,
  }));
  res.status(201).json({ expiresAt, archives });
}));

app.delete('/api/servers/:id/backups/public-link', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the server owner can revoke backup links.' });
  db.prepare('UPDATE backup_public_links SET revoked_at = ? WHERE server_id = ? AND revoked_at = 0').run(Date.now(), server.id);
  res.json({ ok: true });
});

app.get('/api/public/backups/:token/:name', (_req, res) => {
  res.status(403).json({ error: 'Direct browser downloads are disabled. Paste this URL into NexusPanel Import Backup.' });
});

app.post('/api/public/backups/:token/:name', asyncRoute(async (req, res) => {
  if (req.get('x-nexuspanel-transfer') !== 'backup-v1') {
    return res.status(403).json({ error: 'This backup can only be transferred by NexusPanel.' });
  }
  const share = db.prepare(`
    SELECT * FROM backup_public_links
    WHERE token_hash = ? AND revoked_at = 0 AND expires_at > ?
  `).get(tokenHash(req.params.token), Date.now());
  if (!share) return res.status(404).json({ error: 'Public backup link is invalid, expired, or revoked.' });
  const name = String(req.params.name || '').replaceAll('\\', '/');
  if (!name.endsWith('.zip') || name.includes('/')) return res.status(400).json({ error: 'Choose a backup archive.' });
  const target = assertInside(backupsRoot, path.join(backupsRoot, String(share.server_id), name));
  res.setHeader('Cache-Control', 'private, no-store');
  return streamDownload(req, res, target, name);
}));

app.post('/api/servers/:id/backups/import-url', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const url = await validatePublicBackupUrl(req.body.url);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'X-NexusPanel-Transfer': 'backup-v1',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok || !response.body) throw new Error(`Remote panel returned HTTP ${response.status}.`);
  const maxBytes = Math.max(1, Number(process.env.NEXUSPANEL_MAX_REMOTE_BACKUP_GB || 20)) * 1024 * 1024 * 1024;
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('Remote backup is larger than the configured import limit.');
  const rawName = decodeURIComponent(url.pathname.split('/').pop() || 'shared-backup.zip');
  let name = safeAttachmentName(rawName).endsWith('.zip') ? safeAttachmentName(rawName) : `${safeAttachmentName(rawName)}.zip`;
  const backupsDir = assertInside(backupsRoot, path.join(backupsRoot, String(server.id)));
  await fs.promises.mkdir(backupsDir, { recursive: true });
  if (fs.existsSync(path.join(backupsDir, name))) {
    name = `${name.slice(0, -4)}-import-${Date.now()}.zip`;
  }
  const target = assertInside(backupsDir, path.join(backupsDir, name));
  const temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.download`;
  let received = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    if (received > maxBytes) source.destroy(new Error('Remote backup exceeded the configured import limit.'));
  });
  try {
    await pipeline(source, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (!isZipFile(temporary)) throw new Error('Remote file is not a valid ZIP backup.');
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  appendLog(server.id, `[NexusPanel] Imported public backup: ${name}`);
  res.status(201).json({ ok: true, name, size: received, backups: await backupRows(server) });
}));

app.post('/api/servers/:id/backups/share-code', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can create backup codes.' });
  const code = ensureBackupShareCode(server, req.body || {});
  res.json({ code: code.code, expiresAt: code.expires_at });
});

app.delete('/api/servers/:id/backups/share-code', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can hide backup codes.' });
  db.prepare('DELETE FROM backup_share_codes WHERE server_id = ?').run(server.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/backups/share-request', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const target = getServerOr404(req.params.id);
  const code = String(req.body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter a 6-digit backup code.' });
  const share = db.prepare('SELECT * FROM backup_share_codes WHERE code = ? AND expires_at > ?').get(code, Date.now());
  if (!share) return res.status(404).json({ error: 'Backup code not found or expired.' });
  if (Number(share.server_id) === Number(target.id)) return res.status(400).json({ error: 'This code belongs to the selected server.' });
  db.prepare(`
    INSERT INTO backup_share_requests (source_server_id, target_server_id, requester_user_id, status, expires_at)
    VALUES (?, ?, ?, 'pending', 0)
    ON CONFLICT(source_server_id, target_server_id) DO UPDATE SET requester_user_id = excluded.requester_user_id, status = 'pending', expires_at = 0, updated_at = CURRENT_TIMESTAMP
  `).run(share.server_id, target.id, req.user.id);
  res.status(201).json({ ok: true, message: 'Backup access request sent to the source server owner.' });
});

app.post('/api/servers/:id/backups/share-requests/:requestId/approve', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can approve backup access.' });
  const request = db.prepare('SELECT * FROM backup_share_requests WHERE id = ? AND source_server_id = ?').get(Number(req.params.requestId), server.id);
  if (!request) return res.status(404).json({ error: 'Share request not found.' });
  const expiresAt = Date.now() + durationMs(req.body || {}, 60, 24 * 60);
  db.prepare('UPDATE backup_share_requests SET status = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', expiresAt, request.id);
  res.json({ ok: true, expiresAt });
});

app.delete('/api/servers/:id/backups/share-requests/:requestId', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can remove backup access.' });
  const request = db.prepare('SELECT * FROM backup_share_requests WHERE id = ? AND source_server_id = ?').get(Number(req.params.requestId), server.id);
  if (!request) return res.status(404).json({ error: 'Share request not found.' });
  db.prepare('UPDATE backup_share_requests SET status = ?, expires_at = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('revoked', request.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/backups', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  res.status(201).json({ backup: await createServerBackup(server, 'manual'), backups: await backupRows(server) });
}));

app.delete('/api/servers/:id/backups', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const backupPath = String(req.query.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!backupPath.endsWith('.zip') || backupPath.includes('/')) {
    return res.status(400).json({ error: 'Choose a backup file to delete.' });
  }
  const target = assertInside(backupsRoot, path.join(backupsRoot, String(server.id), backupPath));
  await fs.promises.rm(target, { force: true });
  res.json({ ok: true, backups: await backupRows(server) });
}));

app.get('/api/servers/:id/backups/download', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const name = String(req.query.name || '').replaceAll('\\', '/');
  if (!name.endsWith('.zip') || name.includes('/')) return res.status(400).json({ error: 'Choose a backup file.' });
  const target = assertInside(backupsRoot, path.join(backupsRoot, String(server.id), name));
  await streamDownload(req, res, target, name);
}));

app.post('/api/servers/:id/backups/restore', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const sourceServerId = Number(req.body.sourceServerId || server.id);
  if (sourceServerId !== Number(server.id)) {
    const access = db.prepare(`
      SELECT * FROM backup_share_requests
      WHERE source_server_id = ? AND target_server_id = ? AND status = 'approved' AND (expires_at = 0 OR expires_at > ?)
    `).get(sourceServerId, server.id, Date.now());
    if (!access) return res.status(403).json({ error: 'No active shared backup access for this server.' });
  }
  const result = sourceServerId === Number(server.id)
    ? await restoreServerBackup(server, req.body.name)
    : await restoreBackupFileIntoServer(server, sourceServerId, req.body.name);
  res.json({ ok: true, ...result, backups: await backupRows(server) });
}));

app.put('/api/servers/:id/backups/settings', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id);
  const intervalMinutes = parseBackupIntervalMinutes(req.body, backupIntervalMinutesFrom(server));
  const intervalHours = Math.max(1, Math.round(intervalMinutes / 60));
  const retention = clampNumber(req.body.backupRetention, 1, 50, server.backup_retention || 4);
  db.prepare('UPDATE servers SET scheduled_backups = ?, backup_interval_hours = ?, backup_interval_minutes = ?, backup_retention = ? WHERE id = ?')
    .run(toBool(req.body.scheduledBackups, Boolean(server.scheduled_backups)), intervalHours, intervalMinutes, retention, server.id);
  res.json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id)) });
});

app.get('/api/servers/:id/tunnels', requireAuth, (req, res) => {
  getServerOr404(req.params.id);
  res.status(410).json({ error: 'Tunnels were removed. Use Templates or your VPS reverse proxy setup instead.' });
});

app.put('/api/servers/:id/tunnels', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  getServerOr404(req.params.id);
  res.status(410).json({ error: 'Tunnels were removed. Use Templates or your VPS reverse proxy setup instead.' });
});

app.get('/api/servers/:id/files', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  const stats = await fs.promises.stat(target.absolute).catch(() => null);
  if (!stats) return res.status(404).json({ error: 'Path not found.' });

  if (stats.isDirectory()) {
    const entries = (await fs.promises.readdir(target.absolute, { withFileTypes: true }))
      .filter((entry) => !(target.relative === '' && entry.name.toLowerCase() === 'runtime'));
    const payloadEntries = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(target.absolute, entry.name);
      const entryStats = await fs.promises.stat(entryPath).catch(() => null);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: path.posix.join(target.relative.replaceAll('\\', '/'), entry.name).replace(/^\/+/, ''),
        size: entryStats && entryStats.isFile() ? entryStats.size : 0,
        modifiedAt: entryStats ? entryStats.mtimeMs : 0,
      };
    }));
    return res.json({
      path: target.relative,
      type: 'directory',
      entries: payloadEntries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1),
    });
  }

  if (stats.size > 1024 * 1024) return res.status(413).json({ error: 'File is larger than 1MB. Use upload/SFTP for huge files.' });
  res.json({
    path: target.relative,
    type: 'file',
    content: await fs.promises.readFile(target.absolute, 'utf8'),
  });
}));

app.put('/api/servers/:id/files', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a file path inside the server folder.' });
  await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.promises.writeFile(target.absolute, String(req.body.content ?? ''), 'utf8');
  res.json({ ok: true, path: target.relative });
}));

app.post('/api/servers/:id/files/upload', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a destination file path.' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Upload body must be binary.' });
  await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.promises.writeFile(target.absolute, req.body);
  res.status(201).json({ ok: true, path: target.relative, size: req.body.length });
}));

app.get('/api/servers/:id/files/uploads', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id);
  res.json({ uploads: uploadRows(server.id) });
});

app.get('/api/servers/:id/files/upload-status', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a destination file path.' });
  const totalSize = Number(req.query.size || 0);
  const partialPath = `${target.absolute}.uploading`;
  const partial = await fs.promises.stat(partialPath).catch(() => null);
  const complete = await fs.promises.stat(target.absolute).catch(() => null);
  const expectedFileHash = String(req.query.sha256 || '').trim().toLowerCase();
  const session = uploadSession(server.id, target.relative);
  const chunks = mergeChunkRanges(parseChunkRanges(session?.chunks_json));
  if (complete && totalSize && complete.size === totalSize) {
    if (expectedFileHash) {
      const actual = await fileSha256Hex(target.absolute);
      if (actual !== expectedFileHash) {
        await fs.promises.rm(target.absolute, { force: true }).catch(() => {});
        upsertUploadSession(server.id, target.relative, totalSize, 0, 'failed', 'Checksum mismatch; retry upload');
        return res.status(409).json({ error: 'Existing upload checksum mismatch. Retry the file.' });
      }
    }
    const fullChunk = [{ start: 0, end: complete.size }];
    upsertUploadSession(server.id, target.relative, totalSize, complete.size, 'complete', 'Uploaded', fullChunk);
    return res.json({ uploadedBytes: complete.size, uploadedChunks: fullChunk, complete: true, sha256: expectedFileHash || '' });
  }
  const uploadedBytes = partial ? uploadedRangeBytes(chunks) : 0;
  upsertUploadSession(server.id, target.relative, totalSize, uploadedBytes, uploadedBytes ? 'paused' : 'waiting', uploadedBytes ? 'Ready to resume exact chunks' : 'Waiting for upload', chunks);
  res.json({ uploadedBytes, uploadedChunks: chunks, complete: false });
}));

app.post('/api/servers/:id/files/upload-chunk', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a destination file path.' });
  return withKeyedOperation(`upload:${server.id}:${target.relative}`, async () => {
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Upload chunk body must be binary.' });
  const offset = Number(req.query.offset || 0);
  const totalSize = Number(req.query.size || 0);
  const expectedChunkHash = String(req.query.chunkSha256 || '').trim().toLowerCase();
  const expectedFileHash = String(req.query.fileSha256 || '').trim().toLowerCase();
  if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: 'Invalid upload offset.' });
  if (!Number.isSafeInteger(totalSize) || totalSize < req.body.length) return res.status(400).json({ error: 'Invalid upload size.' });
  if (offset + req.body.length > totalSize) return res.status(400).json({ error: 'Chunk exceeds declared upload size.' });
  if (expectedChunkHash && sha256Hex(req.body) !== expectedChunkHash) {
    return res.status(409).json({ error: 'Chunk checksum mismatch. Retrying this chunk is safe.' });
  }
  await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
  const partialPath = `${target.absolute}.uploading`;
  const existing = uploadSession(server.id, target.relative);
  if (existing && existing.status === 'canceled') return res.status(409).json({ error: 'Upload was canceled.' });
  if (!fs.existsSync(partialPath)) await fs.promises.writeFile(partialPath, Buffer.alloc(0));
  const handle = await fs.promises.open(partialPath, 'r+');
  try {
    await handle.write(req.body, 0, req.body.length, offset);
  } finally {
    await handle.close();
  }
  const chunks = mergeChunkRanges(parseChunkRanges(existing?.chunks_json), { start: offset, end: offset + req.body.length });
  const uploadedBytes = uploadedRangeBytes(chunks);
  if (uploadedBytes >= totalSize && req.query.finalize === '1') {
    const stats = await fs.promises.stat(partialPath);
    if (stats.size !== totalSize) return res.status(409).json({ error: 'Upload size mismatch. Retry the file.' });
    const finalHash = await fileSha256Hex(partialPath);
    if (expectedFileHash && finalHash !== expectedFileHash) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => {});
      upsertUploadSession(server.id, target.relative, totalSize, 0, 'failed', 'Final checksum mismatch; clean retry required', []);
      return res.status(409).json({ error: 'Final file checksum mismatch. Retry the upload.' });
    }
    await fs.promises.rename(partialPath, target.absolute);
    upsertUploadSession(server.id, target.relative, totalSize, totalSize, 'complete', expectedFileHash ? `Uploaded sha256:${finalHash}` : 'Uploaded', [{ start: 0, end: totalSize }]);
    return res.status(201).json({ ok: true, path: target.relative, uploadedBytes: totalSize, complete: true, sha256: finalHash });
  }
  upsertUploadSession(server.id, target.relative, totalSize, uploadedBytes, 'active', 'Uploading', chunks);
  res.json({ ok: true, path: target.relative, uploadedBytes, complete: false });
  });
}));

app.post('/api/servers/:id/files/upload-complete', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a destination file path.' });
  const totalSize = Number(req.body.size || 0);
  const expectedFileHash = String(req.body.sha256 || '').trim().toLowerCase();
  const partialPath = `${target.absolute}.uploading`;
  const stats = await fs.promises.stat(partialPath).catch(() => null);
  if (!stats || !stats.isFile()) return res.status(404).json({ error: 'Upload session file was not found.' });
  const session = uploadSession(server.id, target.relative);
  const chunks = mergeChunkRanges(parseChunkRanges(session?.chunks_json));
  if (chunks.length !== 1 || chunks[0].start !== 0 || chunks[0].end !== totalSize) {
    upsertUploadSession(server.id, target.relative, totalSize || stats.size, uploadedRangeBytes(chunks), 'paused', 'Missing chunks; resume upload', chunks);
    return res.status(409).json({ error: 'Upload has missing chunks. Reselect the same file to resume.' });
  }
  if (!Number.isSafeInteger(totalSize) || stats.size !== totalSize) {
    upsertUploadSession(server.id, target.relative, totalSize || stats.size, uploadedRangeBytes(chunks), 'failed', 'Upload size mismatch', chunks);
    return res.status(409).json({ error: 'Upload size mismatch. Retry missing chunks.' });
  }
  const finalHash = await fileSha256Hex(partialPath);
  if (expectedFileHash && finalHash !== expectedFileHash) {
    await fs.promises.rm(partialPath, { force: true }).catch(() => {});
    upsertUploadSession(server.id, target.relative, totalSize, 0, 'failed', 'Final checksum mismatch; clean retry required', []);
    return res.status(409).json({ error: 'Final file checksum mismatch. Retry the upload.' });
  }
  await fs.promises.rename(partialPath, target.absolute);
  upsertUploadSession(server.id, target.relative, totalSize, totalSize, 'complete', expectedFileHash ? `Uploaded sha256:${finalHash}` : 'Uploaded', [{ start: 0, end: totalSize }]);
  res.status(201).json({ ok: true, path: target.relative, uploadedBytes: totalSize, complete: true, sha256: finalHash });
}));

app.post('/api/servers/:id/files/upload-pause', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose an upload path.' });
  const partial = await fs.promises.stat(`${target.absolute}.uploading`).catch(() => null);
  const session = uploadSession(server.id, target.relative);
  const chunks = mergeChunkRanges(parseChunkRanges(session?.chunks_json));
  upsertUploadSession(server.id, target.relative, Number(req.body.size || partial?.size || 0), uploadedRangeBytes(chunks), 'paused', 'Paused', chunks);
  res.json({ uploads: uploadRows(server.id) });
}));

app.delete('/api/servers/:id/files/upload-session', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose an upload path.' });
  await fs.promises.rm(`${target.absolute}.uploading`, { force: true }).catch(() => {});
  db.prepare('DELETE FROM upload_sessions WHERE server_id = ? AND relative_path = ?').run(server.id, target.relative);
  res.json({ uploads: uploadRows(server.id) });
}));

app.post('/api/servers/:id/files/mkdir', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Folder name is required.' });
  await fs.promises.mkdir(target.absolute, { recursive: true });
  res.json({ ok: true, path: target.relative });
}));

app.delete('/api/servers/:id/files', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Cannot delete the server root.' });
  await fs.promises.rm(target.absolute, { recursive: true, force: true });
  res.json({ ok: true });
}));

app.post('/api/servers/:id/files/copy', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const destinationDir = safeServerFile(server, req.body.destination || '');
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const copied = [];
  for (const relative of requested) {
    const source = safeServerFile(server, relative);
    if (!source.relative) return res.status(400).json({ error: 'Cannot copy the server root.' });
    const destination = safeServerFile(server, path.posix.join(destinationDir.relative.replaceAll('\\', '/'), path.basename(source.relative)));
    if (source.absolute === destination.absolute) continue;
    await fs.promises.cp(source.absolute, destination.absolute, { recursive: true, force: true });
    copied.push(destination.relative);
  }
  res.json({ ok: true, paths: copied });
}));

app.post('/api/servers/:id/files/move', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const destinationDir = safeServerFile(server, req.body.destination || '');
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const moved = [];
  for (const relative of requested) {
    const source = safeServerFile(server, relative);
    if (!source.relative) return res.status(400).json({ error: 'Cannot move the server root.' });
    const destination = safeServerFile(server, path.posix.join(destinationDir.relative.replaceAll('\\', '/'), path.basename(source.relative)));
    if (source.absolute === destination.absolute) continue;
    await fs.promises.mkdir(path.dirname(destination.absolute), { recursive: true });
    await fs.promises.rename(source.absolute, destination.absolute).catch(async (error) => {
      if (error.code !== 'EXDEV') throw error;
      await fs.promises.cp(source.absolute, destination.absolute, { recursive: true, force: true });
      await fs.promises.rm(source.absolute, { recursive: true, force: true });
    });
    moved.push(destination.relative);
  }
  res.json({ ok: true, paths: moved });
}));

app.post('/api/servers/:id/files/extract', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const destinationDir = safeServerFile(server, req.body.destination || '');
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const mode = ['replace', 'skip', 'fail'].includes(req.body.mode) ? req.body.mode : 'fail';
  const extracted = [];
  for (const relative of requested) {
    const source = safeServerFile(server, relative);
    if (!source.relative || !source.relative.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ error: 'Select one or more .zip files to unzip.' });
    }
    const stats = await fs.promises.stat(source.absolute).catch(() => null);
    if (!stats || !stats.isFile()) return res.status(404).json({ error: `${source.relative} is not a file.` });
    if (!isZipFile(source.absolute)) {
      return res.status(422).json({ error: `${source.relative} is not a complete valid ZIP. It may be an unfinished upload/download. Re-upload it or use a fresh backup/archive.` });
    }
    if (mode === 'fail') {
      const collisions = zipCollisions(source.absolute, destinationDir.absolute);
      if (collisions.length) {
        return res.status(409).json({
          error: `Extract would replace ${collisions.length} existing file(s). Choose Replace all or Skip existing.`,
          collisions,
        });
      }
    }
    extractArchiveInto(source.absolute, destinationDir.absolute, { mode });
    extracted.push(source.relative);
  }
  res.json({ ok: true, paths: extracted, destination: destinationDir.relative });
}));

app.post('/api/servers/:id/files/archive', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const relativePaths = requested
    .map((item) => String(item || '').replaceAll('\\', '/').replace(/^\/+/, ''))
    .filter((item, index, list) => list.indexOf(item) === index);

  for (const relative of relativePaths) safeServerFile(server, relative);
  const archiveName = `${server.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'server'}-${Date.now()}.zip`;
  const archivePath = assertInside(root, path.join(root, 'archives', archiveName));
  await createZip(root, relativePaths, archivePath);
  res.json({
    archive: path.posix.join('archives', archiveName),
    downloadUrl: `/api/servers/${server.id}/files/download?path=${encodeURIComponent(path.posix.join('archives', archiveName))}`,
  });
}));

app.get('/api/servers/:id/files/download', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  await streamDownload(req, res, target.absolute, path.basename(target.absolute));
}));

app.patch('/api/plugins/:id', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found.' });
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(plugin.server_id);
  if (!canUseServer(req.user, server)) return res.status(403).json({ error: 'No permission for this server.' });

  db.prepare('UPDATE plugins SET enabled = ? WHERE id = ?').run(toBool(req.body.enabled, Boolean(plugin.enabled)), id);
  res.json({ plugin: pluginRows(plugin.server_id).find((row) => row.id === id) });
});

app.delete('/api/plugins/:id', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found.' });
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(plugin.server_id);
  if (!canUseServer(req.user, server)) return res.status(403).json({ error: 'No permission for this server.' });

  db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Something went wrong.' });
});

async function runAutoBackups() {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM servers WHERE scheduled_backups = 1').all();
  for (const server of rows) {
    const intervalMs = backupIntervalMinutesFrom(server) * 60 * 1000;
    if (now - Number(server.last_backup_at || 0) < intervalMs || autoBackupInFlight.has(server.id)) continue;
    autoBackupInFlight.add(server.id);
    createServerBackup(server, 'auto')
      .catch((error) => appendLog(server.id, `[NexusPanel] Auto backup failed: ${error.message}`))
      .finally(() => autoBackupInFlight.delete(server.id));
  }
}

async function runAdaptiveMaintenance() {
  const actions = [];
  const now = Date.now();
  const uploads = db.prepare('SELECT * FROM upload_sessions').all();
  for (const upload of uploads) {
    const ranges = mergeChunkRanges(parseChunkRanges(upload.chunks_json));
    const uploadedBytes = uploadedRangeBytes(ranges);
    const normalized = JSON.stringify(ranges);
    if (normalized !== upload.chunks_json || uploadedBytes !== upload.uploaded_bytes) {
      db.prepare('UPDATE upload_sessions SET chunks_json = ?, uploaded_bytes = ?, message = ? WHERE server_id = ? AND relative_path = ?')
        .run(normalized, uploadedBytes, 'Adaptive engine normalized upload ranges', upload.server_id, upload.relative_path);
      actions.push(`Normalized upload ${upload.relative_path}`);
    }
    const updatedAt = new Date(`${upload.updated_at}Z`).getTime();
    if (upload.status === 'active' && Number.isFinite(updatedAt) && now - updatedAt > 10 * 60 * 1000) {
      db.prepare("UPDATE upload_sessions SET status = 'paused', message = 'Paused after inactivity' WHERE server_id = ? AND relative_path = ?")
        .run(upload.server_id, upload.relative_path);
      actions.push(`Paused stalled upload ${upload.relative_path}`);
    }
  }
  const expiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
  const expiredOtps = db.prepare('DELETE FROM password_reset_otps WHERE expires_at <= ?').run(now).changes;
  const expiredLinks = db.prepare('UPDATE backup_public_links SET revoked_at = ? WHERE revoked_at = 0 AND expires_at <= ?').run(now, now).changes;
  if (expiredSessions) actions.push(`Removed ${expiredSessions} expired session(s)`);
  if (expiredOtps) actions.push(`Removed ${expiredOtps} expired reset code(s)`);
  if (expiredLinks) actions.push(`Revoked ${expiredLinks} expired public backup link(s)`);
  const validatedRepairs = validateStableTerminalRepairs();
  if (validatedRepairs.length) actions.push(`Validated ${validatedRepairs.length} learned terminal repair(s)`);
  if (now - Number(databaseHealthStatus.checkedAt || 0) >= 5 * 60 * 1000) {
    const verification = verifyDatabase();
    databaseHealthStatus = { ...verification, checkedAt: now, snapshotAt: databaseHealthStatus.snapshotAt || 0 };
    if (!verification.ok) actions.push(`Database integrity warning: ${verification.quickCheck}`);
    if (verification.ok) {
      const snapshot = backupDatabase();
      if (snapshot.created) {
        databaseHealthStatus.snapshotAt = now;
        actions.push('Created and verified SQLite recovery snapshot');
      }
    }
  }
  await runAutoBackups();
  refreshWakeWatchers();
  adaptiveMaintenanceStatus = { lastRunAt: now, actions };
  return { ok: true, ...adaptiveMaintenanceStatus };
}

function startSchedulers() {
  setInterval(runAutoBackups, 30 * 1000).unref();
  setInterval(() => runAdaptiveMaintenance().catch(() => {}), 2 * 60 * 1000).unref();
  setInterval(() => runHealthCheck(false).catch(() => {}), 24 * 60 * 60 * 1000).unref();
  runAutoBackups().catch(() => {});
  runAdaptiveMaintenance().catch(() => {});
  runHealthCheck(false).catch(() => {});
}

function startConfiguredServers() {
  const servers = db.prepare('SELECT * FROM servers WHERE auto_start = 1').all();
  for (const server of servers) {
    const delayMs = Math.max(0, Number(server.startup_delay_sec || 0)) * 1000;
    const timer = setTimeout(async () => {
      try {
        if (runtimeStatus(server.id) === 'online') return;
        if (!hasJavaEula(server)) throw new Error('Minecraft EULA has not been accepted.');
        const software = softwareForServer(server);
        if (!software) throw new Error('No installed runtime is configured.');
        if (['java', 'bedrock'].includes(server.type)) await repairPropertiesFile(server);
        startServer(resolveInstalledExecutable(server, software), software);
        appendLog(server.id, '[NexusPanel] Auto-start completed.');
      } catch (error) {
        appendLog(server.id, `[NexusPanel] Auto-start failed: ${error.message}`);
      }
    }, delayMs);
    timer.unref();
  }
}

setExitHandler(async ({ server, software, code, signal, intentional, uptimeMs = 0, recoveryReason = '' }) => {
  if (intentional) {
    crashHistory.delete(server.id);
    const pendingRestart = crashRestartTimers.get(server.id);
    if (pendingRestart) clearTimeout(pendingRestart);
    crashRestartTimers.delete(server.id);
    return;
  }
  const current = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
  if (!current) return;
  const now = Date.now();
  const recent = (crashHistory.get(server.id) || []).filter((time) => now - time < 2 * 60 * 1000);
  recent.push(now);
  crashHistory.set(server.id, recent);
  const launchFailure = uptimeMs < 10 * 1000;
  const crash = rememberCrash(current, software, code, signal);
  const crashDiagnostics = diagnoseRuntime(consoleLogs(current.id), { limit: 5 });
  if (crashDiagnostics.length) {
    crashDiagnostics.forEach((diagnostic) => {
      appendLog(current.id, `[NexusPanel] Crash intelligence (${diagnostic.severity}): ${diagnostic.summary} Next: ${diagnostic.techniques[0]}`);
    });
  } else {
    appendLog(current.id, `[NexusPanel] Crash intelligence recorded unknown signature ${crash.signature.slice(0, 12)} for learning.`);
  }
  if (current.crash_backup && !launchFailure) {
    await createServerBackup(current, 'crash')
      .catch((error) => appendLog(current.id, `[NexusPanel] Crash backup failed: ${error.message}`));
  } else if (launchFailure) {
    appendLog(current.id, `[NexusPanel] Launch failed after ${Math.round(uptimeMs / 1000)}s; skipped crash backup because the game never became stable.`);
  }
  const targetedPropertyHeal = recoveryReason === 'server-properties';
  let targetedPropertyHealSucceeded = true;
  if (targetedPropertyHeal) {
    await repairPropertiesFile(current)
      .then((result) => appendLog(current.id, `[NexusPanel] Auto-heal rebuilt and verified server.properties${result.issues.length ? `: ${result.issues.join(' ')}` : '.'}`))
      .catch((error) => {
        targetedPropertyHealSucceeded = false;
        appendLog(current.id, `[NexusPanel] Auto-heal could not rebuild server.properties: ${error.message}`);
      });
  }
  if (!targetedPropertyHealSucceeded) return;
  if (!current.auto_restart && !targetedPropertyHeal) return;
  if (recent.length >= 3) {
    appendLog(current.id, '[NexusPanel] Restart storm stopped after 3 failures in 2 minutes. Run Repair & Diagnose, then start manually.');
    return;
  }
  const learnedRecovery = targetedPropertyHeal
    ? null
    : await replayLearnedRepair(current, software, crash)
      .catch((error) => {
        appendLog(current.id, `[NexusPanel] Learned recovery could not complete: ${error.message}`);
        return null;
      });
  if (!learnedRecovery && !targetedPropertyHeal) {
    await runServerRepair(current, software)
      .then((report) => appendLog(current.id, `[NexusPanel] Proactive crash repair completed: ${report.summary}`))
      .catch((error) => appendLog(current.id, `[NexusPanel] Proactive crash repair warning: ${error.message}`));
  }
  const restartDelaySeconds = launchFailure ? 10 * recent.length : 5;
  appendLog(current.id, `[NexusPanel] Unexpected exit detected. Restarting in ${restartDelaySeconds} seconds...`);
  const previousTimer = crashRestartTimers.get(current.id);
  if (previousTimer) clearTimeout(previousTimer);
  const timer = setTimeout(async () => {
    crashRestartTimers.delete(current.id);
    try {
      if (runtimeStatus(current.id) === 'offline') {
        if (['java', 'bedrock'].includes(current.type)) await repairPropertiesFile(current);
        startServer(resolveInstalledExecutable(current, software), software);
      }
    } catch (error) {
      appendLog(current.id, `[NexusPanel] Auto-restart failed: ${error.message}`);
    }
  }, restartDelaySeconds * 1000);
  crashRestartTimers.set(current.id, timer);
  timer.unref();
});

async function ensureInitialOwner() {
  if (getUserCount() > 0) return;

  const envEmail = process.env.NEXUSPANEL_OWNER_EMAIL;
  const envPassword = process.env.NEXUSPANEL_OWNER_PASSWORD;
  if (envEmail && envPassword) {
    createUser({
      email: envEmail,
      name: process.env.NEXUSPANEL_OWNER_NAME || 'Owner',
      password: envPassword,
      role: 'owner',
      accessLevel: 100,
    });
    console.log('Created owner account from NEXUSPANEL_OWNER_EMAIL.');
    return;
  }

  if (!stdin.isTTY) {
    throw new Error('No owner account exists. Run NexusPanel in a terminal or set NEXUSPANEL_OWNER_EMAIL and NEXUSPANEL_OWNER_PASSWORD.');
  }

  console.log('\nNexusPanel first run: create the owner account before opening the web panel.');
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const name = (await rl.question('Owner name [Owner]: ')).trim() || 'Owner';
    const email = (await rl.question('Owner email: ')).trim();
    const password = await rl.question('Owner password (8+ chars): ');

    createUser({
      email,
      name,
      password,
      role: 'owner',
      accessLevel: 100,
    });
    console.log('Owner created. Open the web panel and log in.');
  } finally {
    rl.close();
  }
}

async function start() {
  await ensureInitialOwner();
  const recovered = recoverServerFolders();
  if (recovered.length) console.log(`Recovered ${recovered.length} server folder(s) into the database.`);
  startSchedulers();
  startConfiguredServers();
  refreshWakeWatchers();
  setInterval(refreshWakeWatchers, 15000).unref();
  app.listen(port, () => {
    console.log(`NexusPanel running at http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

