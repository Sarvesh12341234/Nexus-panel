const express = require('express');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { createZip } = require('./archive');
const { db, getUserCount } = require('./db');
const { applyTweaks, optimizerStatus, planCommands } = require('./optimizer');
const { assertInside, backupsRoot, displayPath, ensureServerDirs, pluginTarget, serverPath, serversRoot } = require('./paths');
const { clearSoftwareVersionCache, defaultSoftware, findSoftware, pluginKindForFile, resolveDownload, softwareCatalog, softwareVersions } = require('./software');
const { builtinTemplates, findTemplate, nexuExample, normalizeNexuTemplate } = require('./templates');
const { profileForServer, writeProfile } = require('./nexus_mark');
const { appendLog, consoleLogs, killServer, restartServer, runtimeDetails, runtimeStatus, sendCommand, startServer, stopServer } = require('./runtime');
const { copyDirectoryContents, extractArchive, extractArchiveInto, findFile } = require('./zip_utils');
const {
  SESSION_COOKIE,
  authMiddleware,
  clearSession,
  clearSessionCookie,
  createSession,
  createUser,
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

app.set('trust proxy', true);

app.use('/api/servers/:id/files/upload-chunk', express.raw({ type: 'application/octet-stream', limit: '40mb' }));
app.use('/api/servers/:id/files/upload', express.raw({ type: 'application/octet-stream', limit: '40mb' }));
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

function setSettingValue(key, value) {
  db.prepare(`
    INSERT INTO panel_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value ?? ''));
}

function panelSettingsPayload() {
  return {
    terminalEnabled: settingValue('terminal_enabled', '0') === '1',
    updateRepo: settingValue('update_repo', 'https://github.com/Sarvesh12341234/Nexus-panel.git'),
    nexusMarkEnabled: settingValue('nexus_mark_enabled', '1') === '1',
    maxAllocatableMemoryMb: hostMemoryLimitMb(),
    platform: process.platform,
    nexuExample: nexuExample(),
  };
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

function serverPayload(server) {
  const software = findSoftware(server.software_key) || (server.type === 'java' || server.type === 'bedrock' ? defaultSoftware(server.type) : null);
  const status = runtimeStatus(server.id);
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    host: server.host,
    port: server.port,
    status,
    maxMemoryMb: server.max_memory_mb,
    cpuCores: server.cpu_cores || 1,
    diskLimitMb: server.disk_limit_mb || 0,
    templateKey: server.template_key || '',
    nexusMarkProfile: server.nexus_mark_profile || '',
    nexusMark: profileForServer(server, parseJsonObject(server.nexu_payload)),
    autoStart: Boolean(server.auto_start),
    autoRestart: Boolean(server.auto_restart),
    crashBackup: Boolean(server.crash_backup),
    scheduledBackups: Boolean(server.scheduled_backups),
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
  return db.prepare(`
    SELECT id, email, name, role, access_level, created_at
    FROM users
    ORDER BY role DESC, email ASC
  `).all().map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    accessLevel: user.access_level,
    createdAt: user.created_at,
  }));
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
  return `${form} · ${osName}`;
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

  add('SQLite database', Boolean(db.prepare('SELECT 1 AS ok').get().ok), 'Database responds');
  add('Servers folder', fs.existsSync(serversRoot), displayPath(serversRoot));
  add('Backups folder', fs.existsSync(backupsRoot), displayPath(backupsRoot));
  add('Software folder', fs.existsSync(path.join(__dirname, '..', 'software')), 'Software cache exists');

  const servers = db.prepare('SELECT * FROM servers ORDER BY id ASC').all();
  for (const server of servers) {
    const software = findSoftware(server.software_key) || defaultSoftware(server.type);
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
        add(`${server.name} executable`, false, 'Missing. Run Security → Run check now to auto-repair, or reinstall software.');
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

function serverRows() {
  return db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all().map(serverPayload);
}

function pluginRows(serverId = null) {
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
  return {
    root,
    relative: cleaned,
    absolute: assertInside(root, path.join(root, cleaned)),
  };
}

function uploadRows(serverId) {
  return db.prepare('SELECT relative_path, file_name, size, uploaded_bytes, status, message, updated_at FROM upload_sessions WHERE server_id = ? ORDER BY updated_at DESC LIMIT 25')
    .all(serverId)
    .map((row) => ({
      path: row.relative_path,
      name: row.file_name,
      size: row.size,
      uploadedBytes: row.uploaded_bytes,
      progress: row.size ? Math.min(100, Math.round((row.uploaded_bytes / row.size) * 100)) : 0,
      status: row.status,
      message: row.message,
      updatedAt: row.updated_at,
    }));
}

function upsertUploadSession(serverId, relativePath, size, uploadedBytes, status = 'active', message = '') {
  db.prepare(`
    INSERT INTO upload_sessions (server_id, relative_path, file_name, size, uploaded_bytes, status, message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, relative_path)
    DO UPDATE SET
      size = excluded.size,
      uploaded_bytes = excluded.uploaded_bytes,
      status = excluded.status,
      message = excluded.message,
      updated_at = CURRENT_TIMESTAMP
  `).run(serverId, relativePath, path.basename(relativePath), size, uploadedBytes, status, message);
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
      tokenPreview: row.token ? `${row.token.slice(0, 4)}••••${row.token.slice(-4)}` : '',
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
  return path.join(ensureServerDirs(server), 'server.properties');
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

async function readProperties(server) {
  const filePath = propertiesPath(server);
  const existing = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  const values = parseProperties(existing);
  if (!existing) {
    values['server-name'] = server.name;
    values.motd = server.name;
    values['max-players'] = '20';
    values.gamemode = 'survival';
    values.difficulty = 'normal';
    values.pvp = 'true';
    values['white-list'] = 'false';
    values['allow-list'] = 'false';
    values['allow-cheats'] = 'false';
    values['force-gamemode'] = 'false';
    values['hardcore'] = 'false';
    values['command-blocks-enabled'] = 'false';
    values['texturepack-required'] = 'false';
    values['enable-lan-visibility'] = 'true';
    values['default-player-permission-level'] = 'member';
    values['server-port'] = String(server.port);
  }
  return values;
}

async function writeProperties(server, values) {
  const current = await readProperties(server);
  const merged = { ...current, ...values, 'server-port': String(server.port) };
  const content = [
    '# NexusPanel managed server.properties',
    ...Object.entries(merged).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
  await fs.promises.writeFile(propertiesPath(server), content, 'utf8');
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
  const root = ensureServerDirs(server);
  const backupsDir = assertInside(backupsRoot, path.join(backupsRoot, String(server.id)));
  await fs.promises.mkdir(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `${server.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'server'}-${reason}-${stamp}.zip`;
  const archivePath = path.join(backupsDir, archiveName);
  const excludedTopLevel = new Set(['archives', 'backup', 'backups', 'backupfolder', 'software', 'runtime']);
  const entries = (await fs.promises.readdir(root, { withFileTypes: true }))
    .filter((entry) => !excludedTopLevel.has(entry.name.toLowerCase()))
    .filter((entry) => !entry.isFile() || !entry.name.toLowerCase().endsWith('.zip'))
    .filter((entry) => !entry.name.endsWith('.download') && !entry.name.endsWith('.uploading'))
    .map((entry) => entry.name);
  await createZip(root, entries, archivePath);
  const retention = Math.max(1, Number(server.backup_retention) || 4);
  const backups = (await fs.promises.readdir(backupsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
    .map((entry) => ({ name: entry.name, path: path.join(backupsDir, entry.name), mtime: fs.statSync(path.join(backupsDir, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(retention)) await fs.promises.rm(old.path, { force: true });
  db.prepare('UPDATE servers SET last_backup_at = ? WHERE id = ?').run(Date.now(), server.id);
  appendLog(server.id, `[NexusPanel] Backup created: ${archiveName}`);
  return { name: archiveName, path: archiveName, size: fs.statSync(archivePath).size };
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
  return [
    server.executable_path,
    path.join(root, 'software', software.executable),
    path.join(root, software.executable),
    findFile(root, software.executable),
  ].filter(Boolean);
}

function preferredExecutablePath(server, software) {
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

  if (process.platform !== 'win32' && software.key === 'bedrock-vanilla') {
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

async function restoreServerBackup(server, backupName) {
  if (runtimeStatus(server.id) === 'online') throw new Error('Stop the server before restoring a backup.');
  const name = String(backupName || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!name.endsWith('.zip') || name.includes('/')) throw new Error('Choose a backup ZIP to restore.');
  const backupPath = assertInside(backupsRoot, path.join(backupsRoot, String(server.id), name));
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
  const response = await fetch(url, { headers: { 'User-Agent': 'NexusPanel/1.0' } });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const total = Number(response.headers.get('content-length')) || 0;
  const tmpPath = `${filePath}.download`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const writer = fs.createWriteStream(tmpPath);
  let received = 0;

  for await (const chunk of response.body) {
    received += chunk.length;
    writer.write(chunk);
    if (total) onProgress(Math.min(98, Math.round((received / total) * 100)));
  }

  await new Promise((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
  await fs.promises.rename(tmpPath, filePath);
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
    servers: req.user ? serverRows() : [],
    plugins: req.user ? pluginRows() : [],
    softwareCatalog: req.user ? softwareCatalog() : [],
    templates: req.user ? templateRows() : [],
    settings: req.user ? panelSettingsPayload() : null,
    users: req.user && req.user.access_level >= permissions.MANAGE_ADMINS ? userRows() : [],
    loginEvents: req.user && req.user.access_level >= permissions.MANAGE_ADMINS ? loginEventRows(10) : [],
    health: req.user && req.user.access_level >= permissions.MANAGE_ADMINS ? (fs.existsSync(healthPath) ? readHealthFile() : null) : null,
    optimizer: req.user && req.user.access_level >= permissions.MANAGE_SERVERS ? optimizerStatus() : null,
  };

  res.json(payload);
});

app.get('/api/optimizer/status', requireAccess(permissions.MANAGE_SERVERS), (_req, res) => {
  res.json(optimizerStatus());
});

app.get('/api/optimizer/plan', requireAccess(permissions.MANAGE_SERVERS), (_req, res) => {
  res.json(planCommands());
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

app.get('/api/health', requireAccess(permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  res.json({ health: await runHealthCheck(req.query.force === '1') });
}));

app.post('/api/users', requireAccess(permissions.MANAGE_ADMINS), (req, res) => {
  const user = createUser({
    email: req.body.email,
    name: req.body.name,
    password: req.body.password,
    role: 'admin',
    accessLevel: req.body.accessLevel,
  });

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

app.get('/api/servers', requireAuth, (_req, res) => {
  res.json({ servers: serverRows() });
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

app.get('/api/settings', requireAuth, (_req, res) => {
  res.json({ settings: panelSettingsPayload() });
});

app.get('/api/servers/:id/nexus-mark', requireAuth, (req, res) => {
  const server = getServerOr404(req.params.id);
  const nexu = parseJsonObject(server.nexu_payload);
  res.json({ profile: profileForServer(server, nexu), nexu });
});

app.put('/api/settings', requireAccess(permissions.MANAGE_ADMINS), (req, res) => {
  setSettingValue('terminal_enabled', toBool(req.body.terminalEnabled) ? '1' : '0');
  setSettingValue('nexus_mark_enabled', toBool(req.body.nexusMarkEnabled, true) ? '1' : '0');
  const repo = String(req.body.updateRepo || panelSettingsPayload().updateRepo).trim();
  if (repo) setSettingValue('update_repo', repo.slice(0, 240));
  res.json({ settings: panelSettingsPayload() });
});

app.post('/api/settings/update', requireAccess(permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  const repo = String(req.body.repo || panelSettingsPayload().updateRepo).trim();
  if (repo) setSettingValue('update_repo', repo.slice(0, 240));
  if (process.platform === 'win32') {
    return res.status(400).json({ error: 'Panel self-update button is Linux/systemd focused. Use git pull or update/update.sh on the VPS.' });
  }
  const script = path.join(__dirname, '..', 'update', 'update.sh');
  if (!fs.existsSync(script)) return res.status(404).json({ error: 'update/update.sh was not found.' });
  const child = spawn('bash', [script, repo], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NEXUSPANEL_WEB_UPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk).slice(-6000); });
  child.stderr.on('data', (chunk) => { output += String(chunk).slice(-6000); });
  child.on('exit', (code) => {
    fs.promises.writeFile(path.join(dataRoot, 'last_update.log'), output.slice(-12000), 'utf8').catch(() => {});
    if (code !== 0) console.error(`NexusPanel update failed with code ${code}`);
  });
  res.json({ ok: true, message: 'Update started in background. Protected folders stay untouched.', repo });
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

app.post('/api/servers', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Server name is required.' });
  const type = req.body.type === 'java' ? 'java' : 'bedrock';
  const selectedSoftware = findSoftware(req.body.softwareKey) || defaultSoftware(type);
  if (!selectedSoftware || selectedSoftware.edition !== type) {
    return res.status(400).json({ error: 'Selected software is not compatible with this server type.' });
  }

  const result = db.prepare(`
    INSERT INTO servers (
      name, type, port, max_memory_mb, auto_start, auto_restart, crash_backup,
      scheduled_backups, backup_retention, wake_on_join, whitelist,
      tunnel_provider, public_alias, startup_delay_sec, software_key, software_version, cpu_cores, disk_limit_mb
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    type,
    clampNumber(req.body.port, 1024, 65535, type === 'java' ? 25565 : 19132),
    clampMemoryMb(req.body.maxMemoryMb, 1024),
    toBool(req.body.autoStart),
    toBool(req.body.autoRestart, true),
    toBool(req.body.crashBackup, true),
    toBool(req.body.scheduledBackups, true),
    clampNumber(req.body.backupRetention, 1, 20, 4),
    toBool(req.body.wakeOnJoin),
    toBool(req.body.whitelist),
    'none',
    '',
    clampNumber(req.body.startupDelaySec, 0, 600, 0),
    selectedSoftware.key,
    String(req.body.softwareVersion || 'latest').trim().slice(0, 32) || 'latest',
    clampNumber(req.body.cpuCores, 1, os.cpus().length || 1, 1),
    0,
  );

  const inserted = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
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
  const cpuCores = clampNumber(req.body.cpuCores || nexu.resources.cpuCores, 1, os.cpus().length || 1, nexu.resources.cpuCores || 1);
  const type = nexu.game.edition === 'java' || nexu.game.edition === 'bedrock' ? nexu.game.edition : 'custom';
  const selectedSoftware = findSoftware(nexu.runtime.softwareKey);

  const result = db.prepare(`
    INSERT INTO servers (
      name, type, port, max_memory_mb, auto_start, auto_restart, crash_backup,
      scheduled_backups, backup_retention, wake_on_join, whitelist,
      tunnel_provider, public_alias, startup_delay_sec, software_key, software_version, install_status, install_message,
      cpu_cores, disk_limit_mb, template_key, nexu_payload, nexus_mark_profile
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    type,
    portValue,
    memoryMb,
    0,
    1,
    1,
    1,
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
  );

  const inserted = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
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

  db.prepare(`
    UPDATE servers
    SET name = ?, type = ?, port = ?, max_memory_mb = ?, auto_start = ?,
        auto_restart = ?, crash_backup = ?, scheduled_backups = ?,
        backup_retention = ?, wake_on_join = ?, whitelist = ?,
        tunnel_provider = ?, public_alias = ?, startup_delay_sec = ?,
        server_path = ?, software_key = ?, software_version = ?, executable_path = ?
    WHERE id = ?
  `).run(
    name,
    type,
    clampNumber(req.body.port, 1024, 65535, target.port),
    clampMemoryMb(req.body.maxMemoryMb, target.max_memory_mb),
    toBool(req.body.autoStart, Boolean(target.auto_start)),
    toBool(req.body.autoRestart, Boolean(target.auto_restart)),
    toBool(req.body.crashBackup, Boolean(target.crash_backup)),
    toBool(req.body.scheduledBackups, Boolean(target.scheduled_backups)),
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
    id,
  );

  res.json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(id)) });
});

app.delete('/api/servers/:id', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  if (runtimeStatus(server.id) === 'online') return res.status(400).json({ error: 'Stop the server before deleting it.' });
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  await fs.promises.rm(assertInside(serversRoot, root), { recursive: true, force: true });
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

app.get('/api/servers/:id/plugins', requireAuth, (req, res) => {
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

app.get('/api/servers/:id/console', requireAuth, (req, res) => {
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
  const total = os.totalmem();
  const free = os.freemem();
  const load = os.loadavg()[0] || 0;
  const cores = os.cpus().length || 1;
  res.json({
    cpuPercent: Math.min(100, Math.round((load / cores) * 100)),
    ramUsedMb: Math.round((total - free) / 1024 / 1024),
    ramTotalMb: Math.round(total / 1024 / 1024),
    load: Number(load.toFixed(2)),
  });
});

app.post('/api/servers/:id/start', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!hasJavaEula(server)) return res.status(409).json({ error: 'Agree to the Minecraft EULA first.' });
  const software = findSoftware(server.software_key) || (server.type === 'java' || server.type === 'bedrock' ? defaultSoftware(server.type) : null);
  if (!software) return res.status(400).json({ error: 'This Nexu template needs an installer/runtime before it can start.' });
  res.json(startServer(resolveInstalledExecutable(server, software), software));
});

app.post('/api/servers/:id/eula', requireAccess(permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  await agreeJavaEula(server);
  appendLog(server.id, '[NexusPanel] EULA accepted from panel.');
  res.json({ ok: true, eulaAgreed: true });
}));

app.post('/api/servers/:id/stop', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  res.json(stopServer(Number(req.params.id)));
});

app.post('/api/servers/:id/restart', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id);
  if (!hasJavaEula(server)) return res.status(409).json({ error: 'Agree to the Minecraft EULA first.' });
  const software = findSoftware(server.software_key) || (server.type === 'java' || server.type === 'bedrock' ? defaultSoftware(server.type) : null);
  if (!software) return res.status(400).json({ error: 'This Nexu template needs an installer/runtime before it can restart.' });
  res.json(restartServer(resolveInstalledExecutable(server, software), software));
});

app.post('/api/servers/:id/kill', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  res.json(killServer(Number(req.params.id)));
});

app.post('/api/servers/:id/command', requireAccess(permissions.SEND_COMMANDS), (req, res) => {
  sendCommand(Number(req.params.id), req.body.command);
  res.json({ ok: true });
});

app.get('/api/servers/:id/properties', requireAuth, asyncRoute(async (req, res) => {
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

app.get('/api/servers/:id/whitelist', requireAuth, asyncRoute(async (req, res) => {
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

app.get('/api/servers/:id/backups', requireAuth, asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  res.json({ backups: await backupRows(server) });
}));

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

app.get('/api/servers/:id/backups/download', requireAuth, asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const name = String(req.query.name || '').replaceAll('\\', '/');
  if (!name.endsWith('.zip') || name.includes('/')) return res.status(400).json({ error: 'Choose a backup file.' });
  const target = assertInside(backupsRoot, path.join(backupsRoot, String(server.id), name));
  await streamDownload(req, res, target, name);
}));

app.post('/api/servers/:id/backups/restore', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const result = await restoreServerBackup(server, req.body.name);
  res.json({ ok: true, ...result, backups: await backupRows(server) });
}));

app.put('/api/servers/:id/backups/settings', requireAccess(permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id);
  const interval = clampNumber(req.body.backupIntervalHours, 1, 168, server.backup_interval_hours || 24);
  const retention = clampNumber(req.body.backupRetention, 1, 50, server.backup_retention || 4);
  db.prepare('UPDATE servers SET scheduled_backups = ?, backup_interval_hours = ?, backup_retention = ? WHERE id = ?')
    .run(toBool(req.body.scheduledBackups, Boolean(server.scheduled_backups)), interval, retention, server.id);
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

app.get('/api/servers/:id/files', requireAuth, asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  const stats = await fs.promises.stat(target.absolute).catch(() => null);
  if (!stats) return res.status(404).json({ error: 'Path not found.' });

  if (stats.isDirectory()) {
    const entries = await fs.promises.readdir(target.absolute, { withFileTypes: true });
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
  if (complete && totalSize && complete.size === totalSize) {
    if (expectedFileHash) {
      const actual = await fileSha256Hex(target.absolute);
      if (actual !== expectedFileHash) {
        await fs.promises.rm(target.absolute, { force: true }).catch(() => {});
        upsertUploadSession(server.id, target.relative, totalSize, 0, 'failed', 'Checksum mismatch; retry upload');
        return res.status(409).json({ error: 'Existing upload checksum mismatch. Retry the file.' });
      }
    }
    upsertUploadSession(server.id, target.relative, totalSize, complete.size, 'complete', 'Uploaded');
    return res.json({ uploadedBytes: complete.size, complete: true, sha256: expectedFileHash || '' });
  }
  const uploadedBytes = partial ? partial.size : 0;
  upsertUploadSession(server.id, target.relative, totalSize, uploadedBytes, uploadedBytes ? 'paused' : 'waiting', uploadedBytes ? 'Ready to resume' : 'Waiting for upload');
  res.json({ uploadedBytes, complete: false });
}));

app.post('/api/servers/:id/files/upload-chunk', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a destination file path.' });
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
  const existing = db.prepare('SELECT status FROM upload_sessions WHERE server_id = ? AND relative_path = ?').get(server.id, target.relative);
  if (existing && existing.status === 'canceled') return res.status(409).json({ error: 'Upload was canceled.' });
  const handle = await fs.promises.open(partialPath, 'a+');
  try {
    await handle.write(req.body, 0, req.body.length, offset);
  } finally {
    await handle.close();
  }
  const uploadedBytes = offset + req.body.length;
  if (uploadedBytes >= totalSize && req.query.finalize === '1') {
    const stats = await fs.promises.stat(partialPath);
    if (stats.size !== totalSize) return res.status(409).json({ error: 'Upload size mismatch. Retry the file.' });
    const finalHash = await fileSha256Hex(partialPath);
    if (expectedFileHash && finalHash !== expectedFileHash) {
      upsertUploadSession(server.id, target.relative, totalSize, totalSize, 'failed', 'Final checksum mismatch; retry upload');
      return res.status(409).json({ error: 'Final file checksum mismatch. Retry the upload.' });
    }
    await fs.promises.rename(partialPath, target.absolute);
    upsertUploadSession(server.id, target.relative, totalSize, totalSize, 'complete', expectedFileHash ? `Uploaded sha256:${finalHash}` : 'Uploaded');
    return res.status(201).json({ ok: true, path: target.relative, uploadedBytes: totalSize, complete: true, sha256: finalHash });
  }
  upsertUploadSession(server.id, target.relative, totalSize, uploadedBytes, 'active', 'Uploading');
  res.json({ ok: true, path: target.relative, uploadedBytes, complete: false });
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
  if (!Number.isSafeInteger(totalSize) || stats.size !== totalSize) {
    upsertUploadSession(server.id, target.relative, totalSize || stats.size, stats.size, 'failed', 'Upload size mismatch');
    return res.status(409).json({ error: 'Upload size mismatch. Retry missing chunks.' });
  }
  const finalHash = await fileSha256Hex(partialPath);
  if (expectedFileHash && finalHash !== expectedFileHash) {
    upsertUploadSession(server.id, target.relative, totalSize, totalSize, 'failed', 'Final checksum mismatch; retry upload');
    return res.status(409).json({ error: 'Final file checksum mismatch. Retry the upload.' });
  }
  await fs.promises.rename(partialPath, target.absolute);
  upsertUploadSession(server.id, target.relative, totalSize, totalSize, 'complete', expectedFileHash ? `Uploaded sha256:${finalHash}` : 'Uploaded');
  res.status(201).json({ ok: true, path: target.relative, uploadedBytes: totalSize, complete: true, sha256: finalHash });
}));

app.post('/api/servers/:id/files/upload-pause', requireAccess(permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose an upload path.' });
  const partial = await fs.promises.stat(`${target.absolute}.uploading`).catch(() => null);
  upsertUploadSession(server.id, target.relative, Number(req.body.size || partial?.size || 0), partial ? partial.size : 0, 'paused', 'Paused');
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
  const extracted = [];
  for (const relative of requested) {
    const source = safeServerFile(server, relative);
    if (!source.relative || !source.relative.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ error: 'Select one or more .zip files to unzip.' });
    }
    const stats = await fs.promises.stat(source.absolute).catch(() => null);
    if (!stats || !stats.isFile()) return res.status(404).json({ error: `${source.relative} is not a file.` });
    extractArchiveInto(source.absolute, destinationDir.absolute);
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

app.get('/api/servers/:id/files/download', requireAuth, asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id);
  const target = safeServerFile(server, req.query.path || '');
  await streamDownload(req, res, target.absolute, path.basename(target.absolute));
}));

app.patch('/api/plugins/:id', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found.' });

  db.prepare('UPDATE plugins SET enabled = ? WHERE id = ?').run(toBool(req.body.enabled, Boolean(plugin.enabled)), id);
  res.json({ plugin: pluginRows(plugin.server_id).find((row) => row.id === id) });
});

app.delete('/api/plugins/:id', requireAccess(permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found.' });

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
    const intervalMs = Math.max(1, server.backup_interval_hours || 24) * 60 * 60 * 1000;
    if (now - Number(server.last_backup_at || 0) < intervalMs) continue;
    createServerBackup(server, 'auto').catch((error) => appendLog(server.id, `[NexusPanel] Auto backup failed: ${error.message}`));
  }
}

function startSchedulers() {
  setInterval(runAutoBackups, 5 * 60 * 1000).unref();
  setInterval(() => runHealthCheck(false).catch(() => {}), 24 * 60 * 60 * 1000).unref();
  runAutoBackups().catch(() => {});
  runHealthCheck(false).catch(() => {});
}

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
  startSchedulers();
  app.listen(port, () => {
    console.log(`NexusPanel running at http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
