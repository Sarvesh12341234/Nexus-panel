const express = require('express');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const { stdin, stdout } = require('node:process');
const { createZip } = require('./archive');
const { extractJavaRuntimeArchive } = require('./java_runtime_archive');
const { bundledJavaBinary } = require('./java_runtime');
const { backupDatabase, db, getUserCount, verifyDatabase } = require('./db');
const { backupIntervalMinutesFrom, backupScheduleAnchor, nextScheduledBackupAt } = require('./backup_schedule');
const { audit: auditPermissions, repair: repairPermissions } = require('./permission_repair');
const worldConverter = require('./world_converter');
const { getUserTimezone, setUserTimezone, getAllTimezones } = require('./timezone');
const { applyTweaks, optimizerStatus, planCommands } = require('./optimizer');
const { assertInside, backupsRoot, displayPath, ensureServerDirs, findServerRoot, pluginTarget, serverPath, serversRoot, softwareRoot } = require('./paths');
const { clearSoftwareVersionCache, defaultSoftware, findSoftware, installedJavaMajor, pluginKindForFile, requiredJavaMajorForMinecraftVersion, resolveDownload, softwareCatalog, softwareVersions } = require('./software');
const { builtinTemplates, findTemplate, nexuExample, normalizeNexuTemplate } = require('./templates');
const { kernelStatus, nativeStatus, profileForServer, writeProfile } = require('./asf');
const { removeServerIdentity } = require('./asf_identity');
const { appendLog, beginLiveServerFileOperation, beginServerFileOperation, consoleLogs, killServer, restartServer, runtimeDetails, runtimeStatus, sendCommand, setExitHandler, startServer, stopServer, subscribeConsole } = require('./runtime');
const { archiveCollisions, archiveEntries, archiveFormat, copyDirectoryContents, extractArchive, extractArchiveInto, findFile, isZipFile } = require('./zip_utils');
const { hostCpuCount, hostCpuPercent, hostMemoryStats } = require('./system_info');
const { processTreeMetrics } = require('./process_metrics');
const { parseJavaStartupFlags } = require('./startup_flags');
const { diagnoseRuntime, knowledgeStatus } = require('./repair_knowledge');
const needle2Agent = require('./needle2_agent');
const { DDOS_PARAMETER_COUNT, collectDdosEvidence } = require('./ddos_guard');
const tebex = require('./tebex');
const hosting = require('./hosting');
const hostAgent = require('./host_agent');
const { requestSecurityError } = require('./request_security');
const { PerformanceMonitor } = require('./performance_monitor');
const {
  SESSION_COOKIE,
  authMiddleware,
  capabilities,
  clearSession,
  clearSessionCookie,
  createSession,
  createUser,
  emailPolicyError,
  hashPassword,
  hasPermission,
  normalizePermissionKeys,
  passwordPolicyError,
  permissionKeysForUser,
  permissions,
  publicUser,
  requireAuth,
  requirePermission,
  setSessionCookie,
  verifyPassword,
} = require('./auth');

const app = express();
const requestActorStorage = new AsyncLocalStorage();
const port = Number(process.env.PORT || 3000);
const dataRoot = path.join(__dirname, '..', 'data');
const healthPath = path.join(dataRoot, 'panel_health.json');
const editionPath = path.join(dataRoot, 'edition');
const setupTokenPath = path.join(dataRoot, 'setup_token');
const wakeWatchers = new Map();
const wakeStarting = new Set();
const tunnelProcesses = new Map();
const passwordResetRequests = new Map();
const keyedOperations = new Map();
const repairJobs = new Map();
const fileOperationJobs = new Map();
const backupProgressJobs = new Map();
const crashHistory = new Map();
const crashRestartTimers = new Map();
const autoBackupInFlight = new Set();
const serverSizeCache = new Map();
const liveUploadProgress = new Map();
const performanceMonitor = new PerformanceMonitor();
const { HealthEngine, IncidentEngine, DependencyGraph, ChangePlanner } = require('./advanced/operations');
const { NeuralGraph } = require('./advanced/neural_graph');
const { AutonomousActivity } = require('./advanced/autonomous_activity');
const { classify: classifyAutonomy } = require('./advanced/autonomy_policy');
const healthEngine = new HealthEngine();
const incidentEngine = new IncidentEngine(300);
const dependencyGraph = new DependencyGraph();
const changePlanner = new ChangePlanner();
const neuralGraph = new NeuralGraph(1000);
const autonomousActivity = new AutonomousActivity(500);
let adaptiveMaintenanceStatus = { lastRunAt: 0, actions: [] };
let databaseHealthStatus = { ...verifyDatabase(), checkedAt: Date.now(), snapshotAt: 0 };
const dummyPasswordHash = hashPassword(crypto.randomBytes(24).toString('base64url'));
const FIXED_UPDATE_REPO = 'https://github.com/Sarvesh12341234/Nexus-panel.git';
const PANEL_VERSION = require('../package.json').version;
let updateStatus = {
  running: false,
  progress: 0,
  message: 'Idle',
  startedAt: 0,
  finishedAt: 0,
  exitCode: null,
};

app.set('trust proxy', process.env.NEXUSPANEL_TRUST_PROXY === '1' ? 1 : 'loopback');

app.use('/api/servers/:id/files/upload-chunk', express.raw({ type: 'application/octet-stream', limit: '40mb' }));
app.use('/api/servers/:id/files/upload', express.raw({ type: 'application/octet-stream', limit: '40mb' }));
app.use('/api/network/upload-test', express.raw({ type: 'application/octet-stream', limit: '64mb' }));
// Tebex webhooks are signature-verified over the RAW body, so they must be
// captured as a buffer before JSON parsing — and they are exempt from the
// CSRF header gate because Tebex's servers cannot send our custom header.
app.use('/api/tebex/webhook/:serverId', express.raw({ type: '*/*', limit: '256kb' }));
app.use(express.json({ limit: '1mb' }));
app.use(performanceMonitor.middleware());
app.use((req, res, next) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  req.nexusRequestId = requestId;
  res.setHeader('X-Nexus-Request-Id', requestId);
  next();
});
app.use(authMiddleware);
app.use((req, res, next) => {
  const user = req.user;
  requestActorStorage.run(user ? { id: user.id, name: user.name, role: user.role } : null, next);
});
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const securityError = requestSecurityError(req);
  if (securityError) return res.status(403).json({ error: securityError });
  // Tebex webhook: authenticated by its own HMAC signature over the raw body,
  // not by session/CSRF. Tebex's servers cannot send our custom header.
  if (/^\/tebex\/webhook\//.test(req.path)) return next();
  if (req.headers['x-nexuspanel-request'] !== '1') return res.status(403).json({ error: 'Request verification failed.' });
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return res.status(403).json({ error: 'Cross-site request blocked.' });
  return next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use('/pictures', express.static(path.join(__dirname, '..', 'pictures'), {
  etag: true,
  maxAge: '1d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  },
}));
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function ensureSetupToken() {
  if (getUserCount() > 0) return '';
  try {
    const existing = fs.existsSync(setupTokenPath) ? fs.readFileSync(setupTokenPath, 'utf8').trim() : '';
    if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
    const token = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(setupTokenPath, token, { mode: 0o600 });
    try { fs.chmodSync(setupTokenPath, 0o600); } catch {}
    return token;
  } catch (error) {
    throw new Error(`Unable to prepare first-run setup token: ${error.message}`);
  }
}

function validSetupToken(candidate) {
  const expected = ensureSetupToken();
  const provided = String(candidate || '');
  if (!expected || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function finishInitialSetup() {
  try { fs.rmSync(setupTokenPath, { force: true }); } catch {}
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

function repairAgentSecret() {
  return ensureSettingValue('repair_agent_secret', () => crypto.randomBytes(32).toString('hex'));
}

function pruneFixedLogs() {
  db.prepare('DELETE FROM fixed_logs WHERE created_at < ?').run(Date.now() - 24 * 60 * 60 * 1000);
  pruneRepairHistory();
}

/**
 * Retention for the deterministic repair history tables. The AI/neural tables
 * were removed in 1.0.0; only crash state, playbooks, and command observations
 * remain, and they are pruned by age.
 */
function pruneRepairHistory() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM repair_command_observations WHERE observed_at < ?').run(cutoff);
  db.prepare('DELETE FROM repair_playbooks WHERE last_learned_at < ?').run(cutoff);
}

/**
 * Mirror panel activity into the read-only live widgets.
 *
 * The activity feed and neural graph are observability surfaces only: they
 * never execute an operation and never expose protected data.
 */
function recordAutonomousActivity({ category = 'panel', title = '', detail = '', source = 'panel', actorName = 'System', serverId = null }) {
  const kind = String(category || 'panel').slice(0, 40);
  const message = String(title || detail || 'Panel activity').slice(0, 300);
  try {
    autonomousActivity.add(kind, message, {
      source: String(source || 'panel').slice(0, 80),
      actor: String(actorName || 'System').slice(0, 100),
      serverId: serverId ? Number(serverId) : null,
    });
    neuralGraph.node('panel', 'panel', 'Panel');
    neuralGraph.node(`category:${kind}`, 'category', kind);
    neuralGraph.pulse('panel', `category:${kind}`, `activity.${kind}`, { source: String(source || 'panel').slice(0, 80) });
  } catch {
    // Live widgets must never break a panel action.
  }
}

function logFixed({ serverId = null, category = 'panel', title = '', detail = '', source = 'panel', actorName = '', actorUserId = null }) {
  pruneFixedLogs();
  const actor = requestActorStorage.getStore();
  const automated = /(?:\bai\b|needle|repair-agent)/i.test(String(source || ''));
  const cleanActorName = String(actorName || (automated ? 'AI' : actor?.name || 'System')).trim().slice(0, 100);
  const cleanActorId = actorUserId ?? (automated ? null : actor?.id ?? null);
  recordAutonomousActivity({ category, title, detail, source, actorName: cleanActorName, serverId });
  db.prepare(`
    INSERT INTO fixed_logs (server_id, category, title, detail, source, actor_user_id, actor_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId ? Number(serverId) : null,
    String(category || 'panel').slice(0, 40),
    String(title || '').slice(0, 160),
    String(detail || '').slice(0, 1200),
    String(source || 'panel').slice(0, 80),
    cleanActorId ? Number(cleanActorId) : null,
    cleanActorName || 'System',
    Date.now(),
  );
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
  const defaultTag = `v${PANEL_VERSION}`;
  let configuredTag = settingValue('update_target_tag', defaultTag);
  // Migrate any pre-1.0 tag (v1.x-v5.x) to the 1.0 scheme automatically.
  if (/^(?:normal|host)-v(?:[1-5]\.)\d/.test(configuredTag) || /^(?:(?:normal|host)-)?v1\.0\.3$/.test(configuredTag)) {
    configuredTag = defaultTag;
    setSettingValue('update_target_tag', configuredTag);
  }
  const asfNative = nativeStatus({ build: process.platform === 'linux' });
  return {
    version: PANEL_VERSION,
    timeZone: user ? getUserTimezone(user.id) : 'UTC',
    updateRepo: FIXED_UPDATE_REPO,
    publicBaseUrl: settingValue('public_base_url', process.env.NEXUSPANEL_PUBLIC_URL || ''),
    edition,
    updateTag: configuredTag,
    updateStatus,
    serverSwitcherVisibleCount: clampNumber(settingValue('server_switcher_visible_count', '3'), 1, 20, 3),
    maxBackupSizeGb: clampNumber(settingValue('backup_max_size_gb', '20'), 1, 100, 20),
    hostApiTokenPreview: edition === 'host' && user?.role === 'owner' ? `${hostToken.slice(0, 8)}....${hostToken.slice(-6)}` : '',
    asfEnabled: settingValue('asf_enabled', '1') === '1',
    hostAgent: hostAgent.localStatus(),
    asfNative: {
      available: Boolean(asfNative.available),
      detail: asfNative.detail || '',
      reason: asfNative.reason || '',
      landlockAbi: Number(asfNative.landlockAbi || 0),
      selfTestMs: Number(asfNative.selfTestMs || 0),
      staleBinary: Boolean(asfNative.staleBinary),
    },
    repairAgentTerminalEnabled: settingValue('repair_agent_terminal_enabled', '1') === '1',
    normalTunnelsEnabled: edition === 'normal',
    ngrokConfigured: edition === 'normal' && Boolean(settingValue('ngrok_auth_token', '')),
    ngrokAuthtokenPreview: edition === 'normal' && settingValue('ngrok_auth_token', '') ? `${settingValue('ngrok_auth_token', '').slice(0, 6)}....${settingValue('ngrok_auth_token', '').slice(-4)}` : '',
    playitEnabled: edition === 'normal' && settingValue('playit_enabled', '0') === '1',
    playitSetupUrl: 'https://playit.gg/account/agents',
    maxAllocatableMemoryMb: hostMemoryLimitMb(),
    maxCpuCores: hostCpuCount(),
    platform: process.platform,
    nexuExample: edition === 'host' ? nexuExample() : null,
    hostMaintenanceMode: edition === 'host' && settingValue('host_maintenance_mode', '0') === '1',
    hostServerQuota: edition === 'host' ? clampNumber(settingValue('host_server_quota', '10'), 1, 500, 10) : 0,
  };
}

function serverTombstoneKey(serverId) {
  return `deleted_server_${Number(serverId)}`;
}

function clearServerTombstone(serverId) {
  db.prepare('DELETE FROM panel_settings WHERE key = ?').run(serverTombstoneKey(serverId));
}

function isServerTombstoned(serverId) {
  return settingValue(serverTombstoneKey(serverId), '') !== '';
}

function prepareServerIdForCreation(serverId) {
  if (!isServerTombstoned(serverId)) return;
  if (fs.existsSync(serversRoot)) {
    for (const entry of fs.readdirSync(serversRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${Number(serverId)}-`)) {
        fs.rmSync(assertInside(serversRoot, path.join(serversRoot, entry.name)), { recursive: true, force: true });
      }
    }
  }
  clearServerTombstone(serverId);
}

function serverMetadataPath(root) {
  return path.join(root, '.nexus-server.json');
}

function readServerMetadata(root) {
  try {
    const value = JSON.parse(fs.readFileSync(serverMetadataPath(root), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeServerMetadata(server, root) {
  const filePath = serverMetadataPath(root);
  const temporary = `${filePath}.${process.pid}.tmp`;
  const payload = {
    version: 1,
    id: Number(server.id),
    name: server.name,
    type: server.type,
    maxMemoryMb: Number(server.max_memory_mb),
    cpuCores: Number(server.cpu_cores),
    port: Number(server.port),
    softwareKey: server.software_key || '',
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    fs.copyFileSync(temporary, filePath);
    fs.rmSync(temporary, { force: true });
  }
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
    if (!serverStableFor(candidate.server_id, 60 * 1000)) continue;
    db.prepare(`
      UPDATE repair_command_observations
      SET stable_success_count = stable_success_count + 1, validated_at = ?
      WHERE id = ?
    `).run(Date.now(), candidate.id);
    clearServerBackupPause(candidate.server_id);
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
      success_count, last_learned_at, pending_validation, validated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, 1, 0)
    ON CONFLICT(signature) DO UPDATE SET
      software_key = excluded.software_key,
      sample = excluded.sample,
      actions_json = excluded.actions_json,
      learned_from_server_id = excluded.learned_from_server_id,
      last_learned_at = excluded.last_learned_at,
      pending_validation = 1,
      validated_at = 0
  `).run(crash.signature, crash.software_key, crash.sample, JSON.stringify(actions), server.id, Date.now());
  return { signature: crash.signature.slice(0, 12), actions: actions.length };
}

function validateStableRepairPlaybooks() {
  const cutoff = Date.now() - 60 * 1000;
  const candidates = db.prepare(`
    SELECT playbook.signature, playbook.learned_from_server_id
    FROM repair_playbooks playbook
    JOIN repair_crash_state crash
      ON crash.server_id = playbook.learned_from_server_id
      AND crash.signature = playbook.signature
    WHERE playbook.pending_validation = 1 AND playbook.last_learned_at <= ?
  `).all(cutoff);
  const validated = [];
  for (const candidate of candidates) {
    if (!serverStableFor(candidate.learned_from_server_id, 60 * 1000)) continue;
    db.prepare(`
      UPDATE repair_playbooks
      SET success_count = success_count + 1, pending_validation = 0, validated_at = ?
      WHERE signature = ? AND pending_validation = 1
    `).run(Date.now(), candidate.signature);
    clearServerBackupPause(candidate.learned_from_server_id);
    appendLog(candidate.learned_from_server_id, `[NexusPanel] Repair learner validated playbook ${candidate.signature.slice(0, 12)} after 60 seconds of stable runtime.`);
    validated.push(candidate.signature);
  }
  return validated;
}

function validateStableAgentEpisodes() {
  // The neural repair agent was removed in 1.0.0. Deterministic playbook and
  // command validation (validateStableRepairPlaybooks / validateStableTerminalRepairs)
  // still runs; this hook is kept as a no-op so callers stay unchanged.
  return [];
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
    await runRepairArgv(learned.command_text, root);
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
    const child = spawn(shell.command, shell.args, { cwd, env: commandEnv(), windowsHide: true });
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

/**
 * Shell-free execution for learned repair commands.
 * The command was already validated by safeReplayCommand (allowlisted binary +
 * server-root-confined paths), so we exec the binary directly with an argv
 * array instead of piping through /bin/sh. This removes the shell-injection
 * surface entirely even if a stored command_text were ever tampered with.
 */
function runRepairArgv(command, cwd, onOutput) {
  return new Promise((resolve, reject) => {
    const tokens = String(command || '').match(/"(?:\\.|[^"])*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) || [];
    const executable = tokens.shift();
    if (!executable) return reject(new Error('Repair command is empty.'));
    const child = spawn(executable, tokens, { cwd, env: commandEnv(), windowsHide: true, shell: false });
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
  // Host-header injection defense: only accept a syntactically valid hostname.
  // Anything with a scheme, path, credentials, or control characters is dropped
  // so it can never poison generated public URLs.
  const hostValid = /^[A-Za-z0-9.-]{1,253}$/.test(host) && !host.startsWith('.') && !host.endsWith('.');
  if (hostValid && !['localhost', '127.0.0.1', '::1'].includes(host)) return host;
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
    if (isServerTombstoned(id)) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Deferred cleanup for deleted server ${id}: ${error.message}`);
      }
      continue;
    }
    const metadata = readServerMetadata(root);
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
        VALUES (?, ?, ?, ?, ?, 1, 1, 1, 4, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      type,
      clampNumber(portMatch?.[1], 1, 65535, type === 'java' ? 25565 : 19132),
      clampMemoryMb(metadata.maxMemoryMb, 1024),
      root,
      softwareKey,
      executable,
      executable ? 'installed' : 'missing',
      executable ? 100 : 0,
      executable ? 'Recovered from server folder.' : 'Recovered folder; executable missing.',
      clampNumber(metadata.cpuCores, 1, hostCpuCount(), 1),
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
    serverSizeBytes: cachedServerSizeBytes(server),
    templateKey: server.template_key || '',
    ownerUserId: server.owner_user_id || null,
    asfProfile: server.nexus_mark_profile || '',
    asf: profileForServer(server, parseJsonObject(server.nexu_payload)),
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
    startupFlags: server.startup_flags || '',
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
    SELECT id, email, name, role, access_level, permissions_json, expires_at, created_at
    FROM users
    ORDER BY role DESC, email ASC
  `).all().map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    accessLevel: user.access_level,
    permissionKeys: permissionKeysForUser(user),
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

function grantablePermissionKeys(actor, requested) {
  const normalized = normalizePermissionKeys(requested);
  if (normalized === null) return null;
  if (actor.role === 'owner') return normalized;
  const actorKeys = permissionKeysForUser(actor) || [];
  return normalized.filter((key) => actorKeys.includes(key));
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
  // DNS-rebinding defense: pin the validated address so the subsequent fetch
  // cannot be re-resolved to a private IP between the check and the request.
  url.__pinnedAddress = addresses[0].address;
  return url;
}

/**
 * Fetch a URL whose hostname was already validated, connecting to the pinned
 * IP address instead of re-resolving DNS. This closes the TOCTOU window where
 * an attacker flips the record to 127.0.0.1 between validation and fetch.
 */
async function fetchPinned(url, options = {}) {
  const pinned = url.__pinnedAddress;
  if (!pinned) return fetch(url, options);
  const hostname = url.hostname;
  const family = net.isIPv6(pinned) ? 6 : 4;
  const literal = family === 6 ? `[${pinned}]` : pinned;
  const pinnedUrl = new URL(url.toString());
  pinnedUrl.hostname = literal;
  return fetch(pinnedUrl, {
    ...options,
    headers: { ...(options.headers || {}), Host: url.host },
    // Node's fetch honours the URL host; the Host header preserves SNI/vhost.
    ...(family === 6 ? {} : {}),
  });
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
  return `${form} - ${osName}`;
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || '';
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
        add(`${server.name} executable`, false, 'Missing. Run Security -> Run check now to auto-repair, or reinstall software.');
      }
    }
  }

  for (const server of servers) {
    const software = findSoftware(server.software_key) || defaultSoftware(server.type);
    if (!software || software.edition !== 'java') continue;
    const requiredMajor = requiredJavaMajorForMinecraftVersion(server.software_version || 'latest');
    const root = server.server_path || serverPath(server.id, server.name);
    const bundled = bundledJavaBinary(root, requiredMajor);
    const java = bundled ? spawnSync(bundled, ['-version'], { encoding: 'utf8', windowsHide: true })
      : spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true });
    const systemMajor = bundled ? requiredMajor : installedJavaMajor();
    const javaWorks = !java.error && java.status === 0 && systemMajor >= requiredMajor;
    const source = bundled ? `Bundled Java responds (${displayPath(bundled)})` : `System Java ${systemMajor || 'not found'}`;
    const detail = java.error
      ? java.error.message
      : java.status !== 0
        ? String(java.stderr || java.stdout || `exit ${java.status}`).trim()
        : systemMajor < requiredMajor
          ? `Java ${requiredMajor}+ is required; found Java ${systemMajor || 'none'}.`
          : `${source}; Java ${requiredMajor}+ is compatible.`;
    add(`${server.name} Java runtime`, javaWorks, detail);
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
  return user?.role === 'owner'
    ? db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM servers WHERE owner_user_id IS NULL OR owner_user_id = ? ORDER BY created_at DESC').all(user?.id || 0);
}

function throttleKey(scope, value) {
  return `${scope}:${crypto.createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function throttleState(key) {
  const row = db.prepare('SELECT * FROM auth_throttle WHERE key = ?').get(key);
  if (!row) return { failures: 0, window_started_at: 0, blocked_until: 0 };
  if (Date.now() - Number(row.window_started_at || 0) > 15 * 60 * 1000) {
    db.prepare('DELETE FROM auth_throttle WHERE key = ?').run(key);
    return { failures: 0, window_started_at: 0, blocked_until: 0 };
  }
  return row;
}

function loginThrottle(req, email) {
  const keys = [throttleKey('account', email), throttleKey('ip', clientIp(req))];
  const retryMs = Math.max(0, ...keys.map((key) => Number(throttleState(key).blocked_until || 0) - Date.now()));
  return { keys, retryMs };
}

function recordLoginFailure(keys) {
  const now = Date.now();
  keys.forEach((key, index) => {
    const current = throttleState(key);
    const failures = Number(current.failures || 0) + 1;
    const threshold = index === 0 ? 5 : 10;
    const delayMs = failures >= threshold ? Math.min(60 * 60 * 1000, (2 ** Math.min(10, failures - threshold)) * 30 * 1000) : 0;
    db.prepare(`
      INSERT INTO auth_throttle (key, failures, window_started_at, blocked_until, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
        window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at
    `).run(key, failures, Number(current.window_started_at || 0) || now, now + delayMs, now);
  });
}

function clearLoginThrottle(keys) {
  for (const key of keys) db.prepare('DELETE FROM auth_throttle WHERE key = ?').run(key);
}

function serverRows(user, req = null) {
  return visibleServerDatabaseRows(user).map((server) => serverPayload(server, req));
}

function canUseServer(user, server) {
  if (!user || !server) return false;
  if (user.role === 'owner') return true;
  if (!server.owner_user_id) return true;
  return Number(server.owner_user_id) === Number(user.id);
}

function canOwnServerShare(user, server) {
  if (!user || !server) return false;
  if (user.role === 'owner') return true;
  if (!isHostEdition()) return canUseServer(user, server);
  if (!server.owner_user_id) return true;
  return Number(server.owner_user_id) === Number(user.id);
}

function resolveServerOwnerUserId(req, requestedValue, fallback = null) {
  if (!ownerOnly(req)) return fallback;
  if (['__everyone__', 'everyone', 'all'].includes(String(requestedValue || '').toLowerCase())) return null;
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

function reconcilePluginFiles(serverId) {
  const rows = db.prepare('SELECT id, relative_path FROM plugins WHERE server_id = ?').all(Number(serverId));
  const remove = db.prepare('DELETE FROM plugins WHERE id = ?');
  for (const row of rows) {
    const target = safeServerFile(getServerOr404(serverId), row.relative_path);
    const stats = fs.lstatSync(target.absolute, { throwIfNoEntry: false });
    if (!stats || !stats.isFile() || stats.isSymbolicLink()) remove.run(row.id);
  }
  return pluginRows(Number(serverId));
}

function startProgressJob(store, serverId, type, run) {
  const id = crypto.randomUUID();
  const job = { id, serverId: Number(serverId), type, status: 'running', progress: 0, message: 'Starting…', createdAt: Date.now(), updatedAt: Date.now() };
  store.set(id, job);
  setImmediate(async () => {
    try {
      job.result = await run((progress) => {
        job.progress = Math.max(0, Math.min(100, Number(progress.percent) || 0));
        job.message = String(progress.message || progress.phase || 'Working…').slice(0, 180);
        job.updatedAt = Date.now();
      });
      job.status = 'complete';
      job.progress = 100;
      job.message = 'Complete';
    } catch (error) {
      job.status = 'failed';
      job.message = String(error.message || 'Operation failed.').slice(0, 300);
    }
    job.updatedAt = Date.now();
    setTimeout(() => store.delete(id), 10 * 60 * 1000).unref?.();
  });
  return job;
}

function progressJobPayload(job) {
  return { id: job.id, serverId: job.serverId, type: job.type, status: job.status, progress: job.progress, message: job.message, updatedAt: job.updatedAt, result: job.status === 'complete' ? job.result : undefined };
}

function getServerOr404(id, user = null) {
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(id));
  if (!target) throw new Error('Server not found.');
  if (user && !canUseServer(user, target)) {
    const error = new Error('Server not found.');
    error.statusCode = 404;
    throw error;
  }
  return target;
}

function safeServerFile(server, relative = '') {
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const cleaned = String(relative || '').replaceAll('\\', '/').replace(/^\/+/, '');
  assertUserEditableServerPath(cleaned);
  const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (rootStats?.isSymbolicLink()) throw new Error('Server root symlinks are blocked.');
  let cursor = root;
  for (const part of cleaned.split('/').filter(Boolean)) {
    cursor = assertInside(root, path.join(cursor, part));
    const stats = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink()) throw new Error('Symlinks are blocked in the server file manager.');
  }
  return {
    root,
    relative: cleaned,
    absolute: assertInside(root, path.join(root, cleaned)),
  };
}

async function scanServerSize(root) {
  const queue = [root];
  let bytes = 0;
  let visited = 0;
  while (queue.length && visited < 200000) {
    const directory = queue.shift();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    visited += entries.length;
    const files = [];
    for (const entry of entries) {
      const absolute = assertInside(root, path.join(directory, entry.name));
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
    const sizes = await Promise.all(files.map((file) => fs.promises.stat(file).then((stats) => stats.size).catch(() => 0)));
    bytes += sizes.reduce((total, size) => total + size, 0);
  }
  return bytes;
}

function cachedServerSizeBytes(server) {
  const id = Number(server.id);
  const cached = serverSizeCache.get(id) || { bytes: 0, scannedAt: 0, promise: null };
  if (!cached.promise && Date.now() - cached.scannedAt >= 30000) {
    const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
    cached.promise = scanServerSize(root)
      .then((bytes) => {
        cached.bytes = bytes;
        cached.scannedAt = Date.now();
      })
      .finally(() => {
        cached.promise = null;
      });
  }
  serverSizeCache.set(id, cached);
  return cached.bytes;
}

function assertUserEditableServerPath(relative = '') {
  const cleaned = String(relative || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const lower = cleaned.toLowerCase();
  const parts = lower.split('/').filter(Boolean);
  if (!cleaned) return;
  if (parts[0] === 'runtime') throw new Error('NexusPanel runtime files are protected.');
  if (parts.some((part) => part === '.nexus-server.json' || part === '.nexus-mark.json' || part === '.nexuspanel' || part === '.nexus-mark')) {
    throw new Error('NexusPanel metadata files are protected. Resource limits are enforced from the database, not editable server files.');
  }
  if (parts.some((part) => part.endsWith('.nexus-server.json') || part.endsWith('.nexus-mark.json'))) {
    throw new Error('NexusPanel metadata files are protected.');
  }
}

function isUserVisibleServerEntry(relative = '') {
  try {
    assertUserEditableServerPath(relative);
    return true;
  } catch {
    return false;
  }
}

const editableFileExtensions = new Set(['txt', 'log', 'json', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'kts', 'py', 'sh', 'bat', 'cmd', 'ps1', 'md', 'csv', 'tsv', 'mcfunction', 'lang', 'sql']);
const fileTypeMap = {
  pdf: ['pdf', 'application/pdf'],
  doc: ['document', 'application/msword'], docx: ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['spreadsheet', 'application/vnd.ms-excel'], xlsx: ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['presentation', 'application/vnd.ms-powerpoint'], pptx: ['presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], bmp: ['image', 'image/bmp'],
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], ogg: ['audio', 'audio/ogg'], m4a: ['audio', 'audio/mp4'],
  mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'],
  zip: ['archive', 'application/zip'], jar: ['archive', 'application/java-archive'], gz: ['archive', 'application/gzip'], tar: ['archive', 'application/x-tar'], '7z': ['archive', 'application/x-7z-compressed'], rar: ['archive', 'application/vnd.rar'],
};

function fileDescriptor(relative, size = 0) {
  const extension = path.extname(String(relative || '')).slice(1).toLowerCase();
  if (editableFileExtensions.has(extension) || (!extension && Number(size) <= 1024 * 1024)) {
    return { extension, kind: 'text', mime: 'text/plain; charset=utf-8', editable: Number(size) <= 1024 * 1024, previewable: true };
  }
  const [kind, mime] = fileTypeMap[extension] || ['binary', 'application/octet-stream'];
  return { extension, kind, mime, editable: false, previewable: ['pdf', 'image', 'audio', 'video'].includes(kind) };
}

function validPreviewSignature(kind, header) {
  if (kind === 'pdf') return header.subarray(0, 5).toString('ascii') === '%PDF-';
  if (kind === 'image') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))
    || (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP')
    || header.subarray(0, 2).toString('ascii') === 'BM';
  if (kind === 'audio') return ['ID3', 'OggS', 'RIFF'].includes(header.subarray(0, 4).toString('ascii'))
    || header[0] === 0xff;
  if (kind === 'video') return header.subarray(4, 8).toString('ascii') === 'ftyp'
    || header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

async function firstProtectedServerTreeEntry(root, relative = '') {
  const cleaned = String(relative || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!isUserVisibleServerEntry(cleaned)) return cleaned;
  const start = assertInside(root, path.join(root, cleaned));
  const stats = await fs.promises.lstat(start).catch(() => null);
  if (!stats?.isDirectory()) return '';
  const queue = [cleaned];
  while (queue.length) {
    const current = queue.shift();
    const absolute = assertInside(root, path.join(root, current));
    const entries = await fs.promises.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const nested = path.posix.join(current.replaceAll('\\', '/'), entry.name).replace(/^\/+/, '');
      if (!isUserVisibleServerEntry(nested)) return nested;
      if (entry.isDirectory()) queue.push(nested);
    }
  }
  return '';
}

function uploadRows(serverId) {
  return db.prepare("SELECT relative_path, file_name, size, uploaded_bytes, status, message, chunks_json, updated_at FROM upload_sessions WHERE server_id = ? AND status != 'complete' ORDER BY updated_at DESC LIMIT 25")
    .all(serverId)
    .map((row) => {
      const key = `${Number(serverId)}:${row.relative_path}`;
      const live = liveUploadProgress.get(key);
      if (live && Date.now() - live.updatedAt > 15000) liveUploadProgress.delete(key);
      const activeLive = live && Date.now() - live.updatedAt <= 15000 ? live : null;
      const uploadedBytes = Math.min(
        Number(row.size || 0),
        Math.max(Number(row.uploaded_bytes || 0), Number(activeLive?.uploadedBytes || 0)),
      );
      return {
        path: row.relative_path,
        name: row.file_name,
        size: row.size,
        uploadedBytes,
        progress: row.size ? Math.min(100, Math.round((uploadedBytes / row.size) * 100)) : 0,
        status: activeLive?.status || row.status,
        message: activeLive?.message || row.message,
        chunks: parseJsonObject(row.chunks_json) || [],
        updatedAt: activeLive?.updatedAt || row.updated_at,
      };
    });
}

function uploadProgressKey(serverId, relativePath) {
  return `${Number(serverId)}:${String(relativePath || '')}`;
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
      tokenPreview: row.token ? `${row.token.slice(0, 4)}****${row.token.slice(-4)}` : '',
      remoteHost: row.remote_host,
    }));
}

const propertySchema = [
  { key: 'server-name', label: 'Server Name', type: 'text', editions: ['bedrock'] },
  { key: 'motd', label: 'MOTD', type: 'text', editions: ['java'] },
  { key: 'level-name', label: 'World Name', type: 'text', editions: ['bedrock'] },
  { key: 'level-seed', label: 'World Seed', type: 'text', editions: ['bedrock'] },
  { key: 'level-type', label: 'World Type', type: 'select', options: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'DEFAULT', 'FLAT', 'LEGACY'], editions: ['java', 'bedrock'] },
  { key: 'gamemode', label: 'Gamemode', type: 'select', options: ['survival', 'creative', 'adventure'], editions: ['java', 'bedrock'] },
  { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'], editions: ['java', 'bedrock'] },
  { key: 'max-players', label: 'Max Players', type: 'number', editions: ['java', 'bedrock'] },
  { key: 'server-port', label: 'IPv4 Port', type: 'number', editions: ['java', 'bedrock'] },
  { key: 'server-portv6', label: 'IPv6 Port', type: 'number', editions: ['bedrock'] },
  { key: 'online-mode', label: 'Online Mode', type: 'boolean', editions: ['java', 'bedrock'] },
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
    'online-mode': 'true',
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

async function serverTimelineManifest(server) {
  const root = ensureServerDirs(server);
  const files = ['server.properties', 'permissions.json', 'whitelist.json', 'allowlist.json', 'banned-players.json'];
  const fileEntries = [];
  for (const relative of files) {
    const absolute = path.join(root, relative);
    const stats = await fs.promises.stat(absolute).catch(() => null);
    if (!stats?.isFile()) continue;
    const content = await fs.promises.readFile(absolute).catch(() => null);
    fileEntries.push({
      path: relative,
      size: stats.size,
      mtimeMs: Math.round(stats.mtimeMs),
      sha256: content ? crypto.createHash('sha256').update(content).digest('hex') : '',
      content: relative === 'server.properties' && content && content.length < 128 * 1024 ? content.toString('utf8') : '',
    });
  }
  const pluginsDir = server.type === 'bedrock' ? path.join(root, 'plugins') : path.join(root, 'plugins');
  const plugins = fs.existsSync(pluginsDir)
    ? (await fs.promises.readdir(pluginsDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .slice(0, 200)
      .map((entry) => entry.name)
      .sort()
    : [];
  return {
    version: 1,
    server: {
      id: server.id,
      name: server.name,
      type: server.type,
      port: server.port,
      maxMemoryMb: server.max_memory_mb,
      cpuCores: server.cpu_cores,
      softwareKey: server.software_key,
      softwareVersion: server.software_version,
    },
    files: fileEntries,
    plugins,
  };
}

async function createTimelineEvent(server, { type = 'snapshot', title = 'Snapshot', detail = '', userId = null } = {}) {
  const manifest = await serverTimelineManifest(server);
  const result = db.prepare(`
    INSERT INTO server_timeline_events (server_id, event_type, title, detail, manifest_json, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(server.id, type, title, detail, JSON.stringify(manifest), userId, Date.now());
  return { id: result.lastInsertRowid, ...manifest };
}

async function safeTimelinePoint(server, req, title, detail = '') {
  if (process.env.NEXUSPANEL_AUTO_TIMELINE !== '1') return;
  try {
    await createTimelineEvent(server, {
      type: 'auto',
      title,
      detail,
      userId: req?.user?.id || null,
    });
  } catch (error) {
    appendLog(server.id, `[NexusPanel] Timeline warning: ${error.message}`);
  }
}

function timelineRows(serverId) {
  return db.prepare(`
    SELECT event.id, event.server_id, event.event_type, event.title, event.detail, event.manifest_json,
           event.actor_user_id, event.created_at, user.email AS actor_email, user.name AS actor_name
    FROM server_timeline_events event
    LEFT JOIN users user ON user.id = event.actor_user_id
    WHERE event.server_id = ?
    ORDER BY event.created_at DESC
    LIMIT 80
  `).all(serverId).map((row) => {
    const manifest = parseJsonObject(row.manifest_json);
    return {
      id: row.id,
      serverId: row.server_id,
      type: row.event_type,
      title: row.title,
      detail: row.detail,
      createdAt: row.created_at,
      actor: row.actor_user_id ? { id: row.actor_user_id, email: row.actor_email, name: row.actor_name } : null,
      changedFiles: manifest.files || [],
      plugins: manifest.plugins || [],
      server: manifest.server || {},
    };
  });
}

function backupPauseKey(serverId) {
  return `server_backup_pause_until_${Number(serverId)}`;
}

function backupPausedUntil(serverId) {
  return Number(settingValue(backupPauseKey(serverId), '0')) || 0;
}

function pauseServerBackups(serverId, ms, reason = '') {
  const key = backupPauseKey(serverId);
  const until = Date.now() + Math.max(60 * 1000, Number(ms) || 0);
  const current = backupPausedUntil(serverId);
  if (until <= current) return;
  setSettingValue(key, String(until));
  if (reason) appendLog(Number(serverId), `[NexusPanel] Auto backups paused until stable runtime because ${reason}.`);
}

function clearServerBackupPause(serverId) {
  if (!backupPausedUntil(serverId)) return;
  db.prepare('DELETE FROM panel_settings WHERE key = ?').run(backupPauseKey(serverId));
  appendLog(Number(serverId), '[NexusPanel] Stable runtime detected. Scheduled backups resumed.');
}

function offlineBackupKey(serverId) {
  return `server_offline_backup_at_${Number(serverId)}`;
}

function lastOfflineBackupAt(serverId) {
  return Number(settingValue(offlineBackupKey(serverId), '0')) || 0;
}

function serverStableFor(serverId, ms = 60 * 1000) {
  const details = runtimeDetails(Number(serverId));
  return details.status === 'online' && Number(details.startedAt || 0) > 0 && Date.now() - Number(details.startedAt) >= ms;
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
  const merged = { ...current, ...values, 'server-port': String(values['server-port'] ?? server.port) };
  const content = [
    ...Object.entries(merged).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
  const filePath = propertiesPath(server);
  await atomicWriteText(filePath, content);
  if (process.platform !== 'win32') await fs.promises.chmod(filePath, 0o644);
}

function dashedUuid(raw) {
  const value = String(raw || '').replaceAll('-', '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(value)
    ? `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
    : '';
}

function offlineJavaUuid(name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return dashedUuid(bytes.toString('hex'));
}

async function javaUuidForName(name, onlineMode = true) {
  if (!onlineMode) return offlineJavaUuid(name);
  const endpoints = [
    `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(name)}`,
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
  ];
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'NexusPanel/3.0' },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!response || response.status === 204 || response.status === 404 || !response.ok) continue;
    const uuid = dashedUuid((await response.json().catch(() => null))?.id);
    if (uuid) return uuid;
  }
  return '';
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
  await atomicWriteText(await whitelistPath(server), `${JSON.stringify(rows, null, 2)}\n`);
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

async function createServerBackup(server, reason = 'manual', onProgress = null) {
  return withKeyedOperation(`backup:${server.id}`, () => createServerBackupUnlocked(server, reason, onProgress));
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
    {
      scope: 'servers',
      onlineRatio: servers.length ? servers.filter((server) => server.status === 'online').length / servers.length : 0,
      averageInstallProgress: servers.length ? servers.reduce((sum, server) => sum + Number(server.installProgress || 0), 0) / servers.length : 100,
    },
    {
      scope: 'backups',
      maximumOverdueRatio: overdueRatios.length ? Math.max(...overdueRatios) : 0,
      scheduledServers: overdueRatios.length,
    },
    {
      scope: 'uploads',
      activeUploads: activeUploads.length,
      averageProgress: activeUploads.length ? activeUploads.reduce((sum, upload) => sum + upload.progress, 0) / activeUploads.length : 100,
      stalledUploads: activeUploads.filter((upload) => now - new Date(`${upload.updatedAt}Z`).getTime() > 2 * 60 * 1000).length,
    },
    {
      scope: 'resources',
      cpuPercent: hostCpuPercent(),
      memoryPercent: Math.round((memory.used / Math.max(1, memory.total)) * 100),
    },
  ];
}

function repairBrainPayload() {
  const playbooks = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(success_count), 0) AS learned,
      COALESCE(SUM(replay_count), 0) AS replays,
      COALESCE(SUM(pending_validation), 0) AS pending
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
    agent: {
      engine: 'deterministic',
      terminal: {
        enabled: settingValue('repair_agent_terminal_enabled', '1') === '1',
      },
    },
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

async function createServerBackupUnlocked(server, reason = 'manual', onProgress = null) {
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

  const excludedTopLevel = new Set(['archives', 'backup', 'backups', 'backupfolder', 'software', 'runtime']);
  const entries = (await fs.promises.readdir(root, { withFileTypes: true }))
    .filter((entry) => !excludedTopLevel.has(entry.name.toLowerCase()))
    .filter((entry) => !entry.isFile() || !entry.name.toLowerCase().endsWith('.zip'))
    .filter((entry) => !entry.name.endsWith('.download') && !entry.name.endsWith('.uploading'))
    .map((entry) => entry.name);

  const heldBedrockWorld = await holdBedrockWorldForBackup(server);
  const maxBackupSizeGb = clampNumber(settingValue('backup_max_size_gb', '20'), 1, 100, 20);
  let archiveResult;
  try {
    archiveResult = await createZip(root, entries, archivePath, {
      maxOutputBytes: maxBackupSizeGb * 1024 * 1024 * 1024,
      onProgress: ({ completedEntries, totalEntries, percent, phase }) => {
        try { onProgress?.({ percent, message: `${phase === 'complete' ? 'Finalizing' : 'Archiving'} ${completedEntries}/${totalEntries} files` }); } catch {}
      },
    });
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

  if (reason === 'offline') setSettingValue(offlineBackupKey(server.id), String(Date.now()));
  else db.prepare('UPDATE servers SET last_backup_at = ? WHERE id = ?').run(Date.now(), server.id);
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

function backupCategory(name) {
  const value = String(name || '').toLowerCase();
  if (/-backup-manual-/.test(value)) return 'manual';
  if (/-backup-auto-/.test(value)) return 'automatic';
  if (/-backup-offline-/.test(value)) return 'offline';
  if (/-backup-crash-/.test(value)) return 'crash';
  return 'other';
}

function groupedBackups(backups) {
  const groups = {
    manual: [],
    automatic: [],
    offline: [],
    crash: [],
    other: [],
  };
  for (const backup of backups) {
    groups[backupCategory(backup.name)].push({ ...backup, category: backupCategory(backup.name) });
  }
  return groups;
}

async function advancedRepairContext(server, software, root) {
  const files = [];
  const queue = [{ absolute: root, relative: '' }];
  let scanned = 0;
  while (queue.length && scanned < 500 && files.length < 180) {
    const directory = queue.shift();
    const entries = await fs.promises.readdir(directory.absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      const relative = path.join(directory.relative, entry.name).replaceAll('\\', '/');
      if (/^(?:runtime|backups|archives|node_modules)(?:\/|$)/i.test(relative)) continue;
      const absolute = assertInside(root, path.join(directory.absolute, entry.name));
      if (entry.isDirectory()) {
        queue.push({ absolute, relative });
        continue;
      }
      const stats = await fs.promises.stat(absolute).catch(() => null);
      files.push({
        path: relative,
        size: stats?.size || 0,
        modifiedAt: stats ? Math.round(stats.mtimeMs) : 0,
      });
      if (scanned >= 500 || files.length >= 180) break;
    }
  }
  return {
    server: serverPayload(server),
    software: software ? {
      key: software.key,
      name: software.name,
      edition: software.edition,
      executable: software.executable,
      startArgs: software.startArgs || [],
    } : null,
    runtime: runtimeDetails(server.id),
    status: runtimeStatus(server.id),
    properties: ['java', 'bedrock'].includes(server.type)
      ? parseProperties(await fs.promises.readFile(path.join(root, 'server.properties'), 'utf8').catch(() => ''))
      : null,
    plugins: pluginRows(server.id),
    backups: await backupRows(server).catch(() => []),
    timeline: timelineRows(server.id).slice(0, 12),
    health: databaseHealthStatus,
    settings: {
      edition: panelEdition(),
      repairAgentTerminalEnabled: settingValue('repair_agent_terminal_enabled', '1') === '1',
      publicBaseUrl: settingValue('public_base_url', ''),
    },
    files,
    scanned,
  };
}

function logNeedleText(logs, diagnostics = []) {
  return [
    ...(Array.isArray(logs) ? logs : []),
    ...diagnostics.flatMap((item) => [item.id, item.summary, ...(item.techniques || [])]),
  ].join('\n').toLowerCase();
}

async function quarantinePluginFile(server, root, plugin, reason) {
  const relative = String(plugin.relativePath || plugin.relative_path || plugin.fileName || plugin.file_name || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!relative) return null;
  const source = assertInside(root, path.join(root, relative));
  const stats = await fs.promises.stat(source).catch(() => null);
  if (!stats?.isFile()) {
    if (plugin.id) db.prepare('UPDATE plugins SET enabled = 0 WHERE id = ?').run(plugin.id);
    return `Disabled plugin record ${plugin.name || plugin.fileName || plugin.id}; file was already absent.`;
  }
  const quarantineDir = assertInside(root, path.join(root, 'runtime', 'plugin-quarantine'));
  await fs.promises.mkdir(quarantineDir, { recursive: true });
  const safeName = `${Date.now()}-${path.basename(relative).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  const target = assertInside(quarantineDir, path.join(quarantineDir, safeName));
  await fs.promises.rename(source, target).catch(async () => {
    await fs.promises.copyFile(source, target);
    await fs.promises.rm(source, { force: true });
  });
  if (plugin.id) db.prepare('UPDATE plugins SET enabled = 0 WHERE id = ?').run(plugin.id);
  appendLog(server.id, `[NexusPanel] Advanced agent quarantined ${displayPath(source)} because ${reason}.`);
  return `Quarantined ${plugin.name || path.basename(relative)} to ${displayPath(target)}`;
}

async function applyAdvancedAgentActions(server, software, root, diagnostics, repairContext, logs) {
  const actions = [];
  const warnings = [];
  const ids = new Set(diagnostics.map((item) => item.id));
  const offline = runtimeStatus(server.id) === 'offline';
  const needle = logNeedleText(logs, diagnostics);
  const pluginProblem = [...ids].some((id) => [
    'plugin-exception',
    'plugin-archive-corrupt',
    'plugin-dependency',
    'duplicate-plugin',
    'plugin-api-version',
    'loader-mismatch',
    'mod-resolution',
    'mixin',
    'datapack',
  ].includes(id));

  if (offline && pluginProblem) {
    const candidates = (repairContext.plugins || []).filter((plugin) => {
      const names = [plugin.name, plugin.fileName, plugin.relativePath]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return names.some((name) => name && needle.includes(name.replace(/\.(?:jar|zip|mcpack|mcaddon)$/i, '')))
        || names.some((name) => name && needle.includes(path.basename(name).replace(/\.(?:jar|zip|mcpack|mcaddon)$/i, '')));
    }).slice(0, 3);
    if (candidates.length) {
      for (const plugin of candidates) {
        const action = await quarantinePluginFile(server, root, plugin, 'recent logs identified it as the likely failing plugin/mod/pack');
        if (action) actions.push(action);
      }
    } else {
      const corruptMatch = String(logs.join('\n')).match(/failed to open plugin jar\s+([^\r\n]+?\.jar)\b/i);
      const relative = corruptMatch?.[1]?.trim().replaceAll('\\', '/').replace(/^\.?\//, '');
      if (ids.has('plugin-archive-corrupt') && relative && !path.isAbsolute(relative)) {
        const action = await quarantinePluginFile(server, root, {
          name: path.basename(relative),
          relativePath: relative,
        }, 'Java reported that this plugin archive is corrupt');
        if (action) actions.push(action);
      } else {
        warnings.push('Plugin/mod diagnosis found, but logs did not name a registered plugin file clearly enough to quarantine automatically.');
      }
    }
  }

  if (offline && ids.has('archive-incomplete')) {
    const partials = (repairContext.files || [])
      .filter((file) => /\.(?:download|uploading|part|tmp)$/i.test(file.path))
      .slice(0, 20);
    for (const file of partials) {
      const target = assertInside(root, path.join(root, file.path));
      await fs.promises.rm(target, { force: true }).catch(() => {});
    }
    if (partials.length) actions.push(`Removed ${partials.length} partial transfer/archive file(s).`);
  }

  if (ids.has('java-missing') && software?.edition === 'java') {
    try {
      const requirement = await ensureSoftwareRequirements(
        software,
        server.id,
        () => {},
        server.software_version || 'latest',
        root,
      );
      actions.push(requirement.message);
    } catch (error) {
      warnings.push(`Java requirement repair needs owner/VPS package access: ${error.message}`);
    }
  }

  if (ids.has('missing-library')) {
    warnings.push('Native library issue detected. Install the missing system libraries on the VPS (for Bedrock: libstdc++6, libgcc-s1, libc6).');
  }

  return { actions, warnings };
}

function executableCandidates(server, software) {
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  if (path.resolve(server.server_path || '') !== path.resolve(root)) {
    db.prepare('UPDATE servers SET server_path = ? WHERE id = ?').run(root, server.id);
    server.server_path = root;
    appendLog(server.id, `[NexusPanel] Recovered server root: ${displayPath(root)}`);
  }
  const preferred = [
    path.join(root, 'software', software.executable),
    path.join(root, software.executable),
    findFile(root, software.executable),
  ].filter(Boolean);
  const stored = server.executable_path && path.basename(server.executable_path) === software.executable
    ? [server.executable_path]
    : [];
  return [...preferred, ...stored].filter(Boolean);
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

function publicAgentAnalysis(analysis) {
  const { featureVector: _featureVector, ...payload } = analysis;
  return payload;
}

/**
 * Deterministic repair analysis. The neural repair agent and web research were
 * removed in 1.0.0; this builds the same analysis shape from the deterministic
 * knowledge engine so every caller (repair, live maintenance, crash recovery)
 * keeps working.
 */
async function analyzeServerWithAgent(server, software, diagnostics) {
  const root = findServerRoot({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const knowledge = knowledgeStatus();
  const modelSuggestion = diagnostics?.length
    ? null
    : await needle2Agent.classify(server.id, consoleLogs(server.id).join('\n'));
  return {
    engine: 'deterministic',
    serverId: server.id,
    softwareKey: software?.key || server.software_key || '',
    runtime: runtimeStatus(server.id),
    root,
    featureCount: knowledge.diagnosticSignals,
    diagnoses: (diagnostics || []).map((item) => ({
      id: item.id,
      summary: item.summary,
      severity: item.severity,
      confidence: Number(item.confidence || 0.8),
      source: 'knowledge',
      techniques: item.techniques || [],
    })),
    modelSuggestion,
    model: needle2Agent.status(),
    webResearch: {
      query: '',
      results: [],
      cached: false,
      errors: [],
      matchedDiagnoses: [],
      trust: 'disabled',
      executable: false,
    },
  };
}

async function collectAgentTerminalTelemetry(server) {
  if (settingValue('repair_agent_terminal_enabled', '1') !== '1') {
    return { enabled: false, commands: [], summary: 'Terminal diagnostics are disabled.' };
  }
  const secret = repairAgentSecret();
  const probes = [
    { command: 'whoami', args: [], purpose: 'panel-user-for-repair' },
    { command: 'id', args: [], purpose: 'panel-user-groups-for-repair' },
    { command: 'uname', args: ['-a'], purpose: 'kernel-platform-for-repair' },
    { command: 'df', args: ['-h', '.'], purpose: 'disk-free-for-repair' },
    { command: 'df', args: ['-i', '.'], purpose: 'inode-free-for-repair' },
    { command: 'free', args: ['-m'], purpose: 'memory-free-for-repair' },
    { command: 'uptime', args: [], purpose: 'load-average-for-repair' },
    { command: 'java', args: ['-version'], purpose: 'java-runtime-for-repair' },
    { command: 'which', args: ['java'], purpose: 'java-path-for-repair' },
  ];
  if (process.platform === 'linux') {
    probes.push(
      { command: 'findmnt', args: ['-T', '.'], purpose: 'mount-info-for-server-root' },
      { command: 'lsblk', args: ['-f'], purpose: 'block-device-map' },
      { command: 'dmesg', args: ['--level', 'err'], purpose: 'kernel-error-scan' },
      { command: 'systemctl', args: ['list-units', '--all', 'asf-*.service', '--no-pager'], purpose: 'asf-unit-scan' },
      { command: 'ss', args: ['-lntu'], purpose: 'port-listen-scan' },
    );
  }
  const commands = [];
  for (const probe of probes) {
    try {
      const result = await runAgentTerminal(db, secret, { ...probe, server, timeoutMs: 8000 });
      commands.push({
        command: result.command,
        args: result.args,
        code: result.code,
        durationMs: result.durationMs,
        outputPreview: result.output.slice(-1200),
        accessHashPreview: result.accessHashPreview,
      });
    } catch (error) {
      commands.push({
        command: probe.command,
        args: probe.args,
        code: 1,
        durationMs: 0,
        outputPreview: error.message,
        accessHashPreview: '',
      });
    }
  }
  return {
    enabled: true,
    commands,
    summary: `${commands.filter((item) => item.code === 0).length}/${commands.length} terminal telemetry probe(s) passed.`,
  };
}

async function applyAgentOptimizations(server, root, analysis) {
  if (runtimeStatus(server.id) === 'online') {
    return { applied: [], skipped: ['Server is online; optimization changes require an offline server.'] };
  }
  if (!['java', 'bedrock'].includes(server.type)) return { applied: [], skipped: [] };
  const changes = {};
  for (const item of analysis.optimizations || []) {
    if (!['view-distance', 'simulation-distance', 'tick-distance'].includes(item.key)) continue;
    const current = Number(item.current);
    const suggested = Number(item.suggested);
    if (!Number.isFinite(current) || !Number.isFinite(suggested) || suggested >= current) continue;
    changes[item.key] = String(suggested);
  }
  if (!Object.keys(changes).length) return { applied: [], skipped: [] };
  const filePath = propertiesPath(server);
  const existing = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  if (existing) {
    const recoveryDir = assertInside(root, path.join(root, 'runtime', 'agent-optimization'));
    await fs.promises.mkdir(recoveryDir, { recursive: true });
    await fs.promises.writeFile(path.join(recoveryDir, `server.properties.${Date.now()}.bak`), existing, 'utf8');
  }
  await writeProperties(server, changes);
  const applied = Object.entries(changes).map(([key, value]) => `${key}=${value}`);
  appendLog(server.id, `[NexusPanel] Repair agent applied bounded optimization: ${applied.join(', ')}`);
  return { applied, skipped: [] };
}

async function ensureJsonFile(server, root, relativePath, fallbackValue) {
  const target = assertInside(root, path.join(root, relativePath));
  const exists = fs.existsSync(target);
  let repaired = false;
  if (exists) {
    try {
      JSON.parse(await fs.promises.readFile(target, 'utf8'));
    } catch {
      const recoveryDir = assertInside(root, path.join(root, 'runtime', 'config-recovery'));
      await fs.promises.mkdir(recoveryDir, { recursive: true });
      await fs.promises.copyFile(target, path.join(recoveryDir, `${path.basename(relativePath)}.${Date.now()}.broken`)).catch(() => {});
      repaired = true;
    }
  } else {
    repaired = true;
  }
  if (repaired) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, JSON.stringify(fallbackValue, null, 2), { encoding: 'utf8', mode: 0o644 });
    appendLog(server.id, `[NexusPanel] Repair agent rebuilt ${relativePath}.`);
  }
  return repaired ? `Rebuilt ${relativePath}` : '';
}

async function repairMissingSupportConfigs(server, root) {
  const actions = [];
  const warnings = [];
  if (server.type === 'bedrock') {
    for (const action of [
      await ensureJsonFile(server, root, 'allowlist.json', []),
      await ensureJsonFile(server, root, 'permissions.json', []),
      await ensureJsonFile(server, root, 'valid_known_packs.json', []),
      await ensureJsonFile(server, root, path.join('worlds', 'Bedrock level', 'world_behavior_packs.json'), []),
      await ensureJsonFile(server, root, path.join('worlds', 'Bedrock level', 'world_resource_packs.json'), []),
    ]) {
      if (action) actions.push(action);
    }
  }
  if (server.type === 'java') {
    for (const action of [
      await ensureJsonFile(server, root, 'whitelist.json', []),
      await ensureJsonFile(server, root, 'banned-players.json', []),
      await ensureJsonFile(server, root, 'banned-ips.json', []),
      await ensureJsonFile(server, root, 'ops.json', []),
    ]) {
      if (action) actions.push(action);
    }
  }
  return { actions, warnings };
}

function normalizePackUuid(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePackVersion(value) {
  return Array.isArray(value) ? value.map((part) => Number(part) || 0).join('.') : String(value || '').trim();
}

async function bedrockPackManifestIndex(root) {
  const folders = [
    path.join(root, 'behavior_packs'),
    path.join(root, 'resource_packs'),
    path.join(root, 'packs', 'behavior_packs'),
    path.join(root, 'packs', 'resource_packs'),
  ];
  const manifests = new Map();
  const invalid = [];
  for (const folder of folders) {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 500)) {
      if (!entry.isDirectory()) continue;
      const manifestPath = assertInside(root, path.join(folder, entry.name, 'manifest.json'));
      const raw = await fs.promises.readFile(manifestPath, 'utf8').catch(() => '');
      if (!raw) continue;
      try {
        const manifest = JSON.parse(raw);
        const uuid = normalizePackUuid(manifest?.header?.uuid);
        if (!uuid) {
          invalid.push({ path: manifestPath, reason: 'missing header.uuid' });
          continue;
        }
        const version = normalizePackVersion(manifest?.header?.version);
        manifests.set(`${uuid}:${version}`, { uuid, version, path: manifestPath });
        manifests.set(uuid, { uuid, version, path: manifestPath });
      } catch (error) {
        invalid.push({ path: manifestPath, reason: error.message });
      }
    }
  }
  return { manifests, invalid };
}

async function bedrockWorldDirectories(root) {
  const worldsRoot = assertInside(root, path.join(root, 'worlds'));
  const entries = await fs.promises.readdir(worldsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .slice(0, 120)
    .map((entry) => assertInside(root, path.join(worldsRoot, entry.name)));
}

async function repairBedrockPackReferenceFile(server, root, filePath, manifestIndex) {
  const relative = path.relative(root, filePath).replaceAll('\\', '/');
  const exists = fs.existsSync(filePath);
  if (!exists) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, '[]\n', { encoding: 'utf8', mode: 0o644 });
    appendLog(server.id, `[NexusPanel] Repair agent rebuilt missing ${relative}.`);
    return { action: `Rebuilt ${relative}`, warning: '' };
  }
  const raw = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  let rows;
  try {
    rows = JSON.parse(raw || '[]');
    if (!Array.isArray(rows)) throw new Error('root value is not an array');
  } catch (error) {
    const recoveryDir = assertInside(root, path.join(root, 'runtime', 'config-recovery'));
    await fs.promises.mkdir(recoveryDir, { recursive: true });
    await fs.promises.writeFile(path.join(recoveryDir, `${path.basename(filePath)}.${Date.now()}.broken`), raw, 'utf8').catch(() => {});
    await fs.promises.writeFile(filePath, '[]\n', { encoding: 'utf8', mode: 0o644 });
    appendLog(server.id, `[NexusPanel] Repair agent replaced malformed ${relative}: ${error.message}`);
    return { action: `Rebuilt malformed ${relative}`, warning: '' };
  }
  const kept = [];
  const removed = [];
  for (const row of rows) {
    const uuid = normalizePackUuid(row?.pack_id || row?.uuid);
    const version = normalizePackVersion(row?.version);
    if (!uuid) {
      removed.push(row);
      continue;
    }
    if (manifestIndex.has(`${uuid}:${version}`) || manifestIndex.has(uuid)) kept.push(row);
    else removed.push(row);
  }
  if (!removed.length) return { action: '', warning: '' };
  const recoveryDir = assertInside(root, path.join(root, 'runtime', 'config-recovery'));
  await fs.promises.mkdir(recoveryDir, { recursive: true });
  await fs.promises.writeFile(path.join(recoveryDir, `${path.basename(filePath)}.${Date.now()}.bak`), raw, 'utf8');
  await fs.promises.writeFile(filePath, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  appendLog(server.id, `[NexusPanel] Repair agent removed ${removed.length} missing Bedrock pack reference(s) from ${relative}.`);
  return { action: `Removed ${removed.length} missing pack reference(s) from ${relative}`, warning: '' };
}

async function repairBedrockPackReferences(server, root) {
  const actions = [];
  const warnings = [];
  if (server.type !== 'bedrock') return { actions, warnings };
  const { manifests, invalid } = await bedrockPackManifestIndex(root);
  for (const item of invalid.slice(0, 20)) {
    warnings.push(`Invalid Bedrock pack manifest ${path.relative(root, item.path).replaceAll('\\', '/')}: ${item.reason}`);
  }
  const worlds = await bedrockWorldDirectories(root);
  for (const worldDir of worlds) {
    for (const fileName of ['world_behavior_packs.json', 'world_resource_packs.json']) {
      const result = await repairBedrockPackReferenceFile(server, root, path.join(worldDir, fileName), manifests);
      if (result.action) actions.push(result.action);
      if (result.warning) warnings.push(result.warning);
    }
  }
  if (!worlds.length) warnings.push('No Bedrock world folder was found under worlds/.');
  if (!manifests.size) warnings.push('No installed Bedrock pack manifests were found; missing pack references will be removed from world pack JSON if present.');
  return { actions, warnings };
}

async function inspectVpsRepairReadiness(server, root) {
  const actions = [];
  const warnings = [];
  try {
    const permissionAudit = auditPermissions(root);
    const permissionProblems = permissionAudit.inaccessible.length > 0 || !permissionAudit.writableRoot;
    if (permissionProblems) {
      const repaired = repairPermissions(root, {
        owner: process.platform === 'win32' ? null : os.userInfo().username,
        dryRun: false,
      });
      actions.push(`Permission auditor repaired server-root access: ${repaired.auditBefore.inaccessible.length} inaccessible path(s) before, ${repaired.auditAfter.inaccessible.length} after.`);
      if (!repaired.ok) warnings.push(`Permission repair completed with remaining access issues: ${repaired.auditAfter.inaccessible.length} path(s).`);
    } else {
      actions.push(`Permission audit passed: ${permissionAudit.files} file(s), ${permissionAudit.dirs} directory(s).`);
    }
  } catch (error) {
    warnings.push(`Permission auditor failed: ${error.message}`);
  }

  try {
    const marker = assertInside(root, path.join(root, 'runtime', `.repair-write-test-${process.pid}`));
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    await fs.promises.writeFile(marker, 'ok', { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rm(marker, { force: true });
  } catch (error) {
    warnings.push(`Server root write test failed: ${error.message}`);
  }
  if (server.executable_path && fs.existsSync(server.executable_path)) {
    try {
      await fs.promises.access(server.executable_path, fs.constants.R_OK);
      if (process.platform !== 'win32') {
        const stats = await fs.promises.stat(server.executable_path);
        if ((stats.mode & 0o111) === 0 && server.type === 'bedrock') {
          await fs.promises.chmod(server.executable_path, stats.mode | 0o755);
          actions.push('Restored executable bit on Bedrock server binary.');
        }
      }
    } catch (error) {
      warnings.push(`Executable access check failed: ${error.message}`);
    }
  }
  if (typeof fs.statfsSync === 'function') {
    try {
      const stats = fs.statfsSync(root);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const freeMb = Math.round(freeBytes / 1024 / 1024);
      if (freeMb < 1024) warnings.push(`VPS disk reserve is low: ${freeMb} MB free.`);
      if (Number(stats.favail) >= 0 && Number(stats.files) > 0) {
        const inodeFreePercent = Math.round((Number(stats.favail) / Math.max(1, Number(stats.files))) * 100);
        if (inodeFreePercent < 5) warnings.push(`VPS inode reserve is low: ${inodeFreePercent}% free.`);
      }
    } catch (error) {
      warnings.push(`VPS filesystem check failed: ${error.message}`);
    }
  }
  return { actions, warnings };
}

function compareVersionParts(left, right) {
  const a = Array.isArray(left) ? left.map(Number) : String(left || '').split('.').map(Number);
  const b = Array.isArray(right) ? right.map(Number) : String(right || '').split('.').map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = Number.isFinite(a[index]) ? a[index] : 0;
    const bv = Number.isFinite(b[index]) ? b[index] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function acceptedBedrockEngineVersion(logs) {
  const text = (Array.isArray(logs) ? logs : []).join('\n');
  const accepted = text.match(/highest value we accept is ['"]?(\d+\.\d+\.\d+)['"]?/i)?.[1];
  if (accepted) return accepted;
  const version = text.match(/\bVersion:\s*(\d+\.\d+\.\d+)/i)?.[1];
  return version || '';
}

async function quarantineIncompatibleBedrockPacks(server, root, logs) {
  if (server.type !== 'bedrock' || runtimeStatus(server.id) === 'online') return { actions: [], warnings: [] };
  const accepted = acceptedBedrockEngineVersion(logs);
  if (!accepted) return { actions: [], warnings: ['Bedrock pack scan skipped because the accepted engine version was not visible in recent logs.'] };
  const actions = [];
  const warnings = [];
  const queue = [root];
  let scanned = 0;
  while (queue.length && scanned < 2500 && actions.length < 20) {
    const directory = queue.shift();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      const absolute = assertInside(root, path.join(directory, entry.name));
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (!['db', 'runtime', 'software', 'backups', 'logs'].includes(lower) && !lower.includes('.disabled-')) queue.push(absolute);
        continue;
      }
      if (entry.name !== 'manifest.json') continue;
      const manifest = parseJsonObject(await fs.promises.readFile(absolute, 'utf8').catch(() => '{}'));
      const required = manifest?.header?.min_engine_version;
      if (!Array.isArray(required) || compareVersionParts(required, accepted) <= 0) continue;
      const packDir = path.dirname(absolute);
      const disabled = assertInside(path.dirname(packDir), `${packDir}.disabled-${Date.now()}`);
      await fs.promises.rename(packDir, disabled);
      const requiredText = required.join('.');
      actions.push(`Quarantined incompatible Bedrock pack ${path.basename(packDir)} (${requiredText} > ${accepted}).`);
      appendLog(server.id, `[NexusPanel] Repair agent quarantined incompatible Bedrock pack: ${displayPath(packDir)} requires ${requiredText}, server accepts ${accepted}.`);
      break;
    }
  }
  if (!actions.length) warnings.push(`No incompatible Bedrock pack manifest was found for accepted engine ${accepted}.`);
  return { actions, warnings };
}

const REPAIR_TOOL_DIAGNOSTICS = {
  repair_server_properties: ['properties-path', 'properties-syntax', 'properties-value', 'properties-encoding'],
  repair_missing_executable: ['jar-corrupt'],
  install_bundled_java_runtime: ['java-missing', 'bad-java-version'],
  rebuild_support_configs: ['support-config-missing'],
  repair_bedrock_pack_references: ['bedrock-missing-pack-reference'],
  quarantine_identified_plugin: ['plugin-exception', 'plugin-archive-corrupt', 'plugin-dependency', 'duplicate-plugin', 'plugin-api-version', 'loader-mismatch', 'mod-resolution', 'mixin', 'datapack'],
  cleanup_stale_transfers: ['archive-incomplete'],
  quarantine_incompatible_bedrock_pack: ['bedrock-pack-version'],
};

async function cleanupStaleTransferFiles(server, root) {
  if (runtimeStatus(server.id) !== 'offline') return 0;
  const activeServerOperation = [...keyedOperations.keys()].some((key) =>
    key !== `repair:${server.id}`
      && (key.includes(`:${server.id}:`) || key.endsWith(`:${server.id}`)));
  if (activeServerOperation) return 0;
  const resumableUploads = new Set(db.prepare(`
    SELECT relative_path FROM upload_sessions WHERE server_id = ? AND status != 'complete'
  `).all(server.id).map((row) => path.resolve(root, `${row.relative_path}.uploading`)));
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
        if (!['backups', 'archives', 'runtime'].includes(entry.name.toLowerCase())) queue.push(absolute);
      } else if (/\.(?:download|uploading)$/i.test(entry.name)) {
        const stats = await fs.promises.stat(absolute).catch(() => null);
        if (
          stats
          && Date.now() - stats.mtimeMs > 60 * 60 * 1000
          && !(entry.name.endsWith('.uploading') && resumableUploads.has(path.resolve(absolute)))
        ) staleTransfers.push(absolute);
      }
      if (scanned >= 10000) break;
    }
  }
  for (const file of staleTransfers) await fs.promises.rm(file, { force: true });
  return staleTransfers.length;
}

async function executeRequestedRepairTool(request, context) {
  const { server, software, root, diagnostics, logs } = context;
  const actions = [];
  const warnings = [];
  const allowedDiagnostics = REPAIR_TOOL_DIAGNOSTICS[request?.tool];
  const missingExecutableVerified = request?.tool === 'repair_missing_executable'
    && software
    && software.edition === server.type
    && !executableCandidates(server, software).some((candidate) => fs.existsSync(candidate));
  if (!allowedDiagnostics || (!missingExecutableVerified && !diagnostics.some((item) => allowedDiagnostics.includes(item.id)))) {
    return { actions, warnings: ['AI repair tool request did not match an active deterministic diagnostic.'] };
  }
  if (runtimeStatus(server.id) !== 'offline') {
    return { actions, warnings: ['AI repair tool request skipped because the server is not confirmed offline.'] };
  }

  try {
    switch (request.tool) {
      case 'repair_server_properties': {
        const result = await repairPropertiesFile(server);
        if (result.repaired) actions.push(`AI tool repaired server.properties (${result.issues.join(' ') || 'created missing file'}).`);
        break;
      }
      case 'repair_missing_executable': {
        if (!software || software.edition !== server.type) throw new Error('The selected server software does not match this server edition.');
        const result = await repairMissingExecutable(server, software);
        if (result.repaired) actions.push(result.message);
        else warnings.push('Executable repair was not needed because the selected executable already exists.');
        break;
      }
      case 'install_bundled_java_runtime': {
        if (software?.edition !== 'java' || server.type !== 'java') throw new Error('Bundled Java repair is Java-server-only.');
        const major = requiredJavaMajorForMinecraftVersion(server.software_version || 'latest');
        const binary = await installBundledJavaRuntime(root, server.id, major, () => {});
        actions.push(`Installed bundled Java ${major} runtime at ${displayPath(binary)}.`);
        break;
      }
      case 'rebuild_support_configs': {
        const result = await repairMissingSupportConfigs(server, root);
        actions.push(...result.actions);
        warnings.push(...result.warnings);
        break;
      }
      case 'repair_bedrock_pack_references': {
        if (server.type !== 'bedrock') throw new Error('Pack-reference repair is Bedrock-only.');
        const result = await repairBedrockPackReferences(server, root);
        actions.push(...result.actions);
        warnings.push(...result.warnings);
        break;
      }
      case 'quarantine_identified_plugin': {
        const result = await applyAdvancedAgentActions(server, software, root, diagnostics, context.repairContext, logs);
        actions.push(...result.actions);
        warnings.push(...result.warnings);
        break;
      }
      case 'cleanup_stale_transfers': {
        const count = await cleanupStaleTransferFiles(server, root);
        if (count) actions.push(`Removed ${count} confirmed stale partial transfer(s).`);
        break;
      }
      case 'quarantine_incompatible_bedrock_pack': {
        if (server.type !== 'bedrock') throw new Error('Pack quarantine is Bedrock-only.');
        const result = await quarantineIncompatibleBedrockPacks(server, root, logs);
        actions.push(...result.actions);
        warnings.push(...result.warnings);
        break;
      }
      default:
        warnings.push('AI requested an unregistered repair tool; no action was taken.');
    }
  } catch (error) {
    warnings.push(`AI repair tool ${request.tool} failed safely: ${error.message}`);
  }
  return { actions, warnings };
}

async function runServerRepair(server, software, { applyOptimizations = false, allowModelTools = false, logs } = {}) {
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const actions = [];
  const warnings = [];
  const checks = [];
  const diagnostics = diagnoseRuntime(logs || consoleLogs(server.id));
  const knowledge = knowledgeStatus();
  const agentAnalysis = await analyzeServerWithAgent(server, software, diagnostics);
  const repairContext = await advancedRepairContext(server, software, root).catch((error) => ({ error: error.message }));
  agentAnalysis.contextSummary = {
    files: repairContext.files?.length || 0,
    plugins: repairContext.plugins?.length || 0,
    backups: repairContext.backups?.length || 0,
    status: repairContext.status || '',
    error: repairContext.error || '',
  };
  const terminalTelemetry = await collectAgentTerminalTelemetry(server);
  agentAnalysis.terminalTelemetry = terminalTelemetry;
  const missingSelectedExecutable = Boolean(
    software?.edition === server.type
      && !executableCandidates(server, software).some((candidate) => fs.existsSync(candidate)),
  );
  if (allowModelTools && (diagnostics.length || missingSelectedExecutable)) {
    const repairCandidates = diagnostics.map((item) =>
      `issueId: ${item.id}; evidence: ${item.summary}`);
    if (missingSelectedExecutable) {
      repairCandidates.push('issueId: server-not-installed; evidence: Install server software before starting.');
    }
    const modelRequest = await needle2Agent.suggestRepairTool(server.id, [
      'Use request_repair_tool for a confirmed issue if a registered repair matches. Use the exact issueId and evidence labels below. If none matches, make no request.',
      ...repairCandidates,
    ].join('\n')).catch(() => null);
    if (modelRequest) {
      agentAnalysis.requestedRepairTool = { tool: modelRequest.tool, issueId: modelRequest.issueId, evidence: modelRequest.evidence };
      const result = await executeRequestedRepairTool(modelRequest, { server, software, root, diagnostics, logs: logs || consoleLogs(server.id), repairContext });
      actions.push(...result.actions);
      warnings.push(...result.warnings);
    }
  }
  if (terminalTelemetry.enabled) {
    logFixed({
      serverId: server.id,
      category: 'terminal-diagnostics',
      title: 'Terminal telemetry collected',
      detail: terminalTelemetry.summary,
      source: 'repair',
    });
  }
  checks.push({
    name: 'Diagnostic engine',
    ok: true,
    detail: diagnostics.length
      ? `${diagnostics.length} direct cause(s) identified from ${knowledge.diagnosticSignals} signals.`
      : `Analyzed ${knowledge.diagnosticSignals} diagnostic signals; no fault detected.`,
  });
  checks.push({
    name: 'Terminal telemetry',
    ok: !terminalTelemetry.enabled || terminalTelemetry.commands.some((item) => item.code === 0),
    detail: terminalTelemetry.summary,
  });
  diagnostics.forEach((diagnostic) => {
    warnings.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.summary} ${diagnostic.techniques[0]}`);
  });

  if (software?.edition === 'java' && diagnostics.some((item) => item.id === 'bad-java-version' || item.id === 'java-missing')) {
    try {
      const requirement = await ensureSoftwareRequirements(software, server.id, (_progress, message) => {
        appendLog(server.id, `[NexusPanel] Repair dependency check: ${message}`);
      }, server.software_version || 'latest', root);
      actions.push(`Verified Java dependency: ${requirement.message}`);
      checks.push({ name: 'Java runtime dependency', ok: true, detail: requirement.message });
    } catch (error) {
      checks.push({ name: 'Java runtime dependency', ok: false, detail: error.message });
      warnings.push(`Java dependency repair could not finish: ${error.message}`);
    }
  }

  let repair;
  try {
    repair = await repairMissingExecutable(server, software);
    actions.push(repair.message);
    checks.push({ name: 'Executable', ok: true, detail: displayPath(repair.path) });
  } catch (error) {
    repair = { repaired: false, path: server.executable_path || '', message: error.message };
    checks.push({ name: 'Executable', ok: false, detail: error.message });
    warnings.push(`Executable repair could not finish: ${error.message}`);
  }
  if (['java', 'bedrock'].includes(server.type)) {
    const properties = await repairPropertiesFile(server);
    checks.push({
      name: 'Server properties',
      ok: true,
      detail: properties.repaired ? `Repaired ${properties.issues.length || 1} issue(s).` : 'Syntax and values validated.',
    });
    if (properties.repaired) actions.push(`Repaired server.properties (${properties.issues.join(' ') || 'created missing file'}).`);
  }
  const supportRepair = await repairMissingSupportConfigs(server, root);
  supportRepair.actions.forEach((item) => actions.push(item));
  supportRepair.warnings.forEach((item) => warnings.push(item));
  const bedrockReferenceRepair = await repairBedrockPackReferences(server, root);
  bedrockReferenceRepair.actions.forEach((item) => actions.push(item));
  bedrockReferenceRepair.warnings.forEach((item) => warnings.push(item));
  const advancedActions = await applyAdvancedAgentActions(server, software, root, diagnostics, repairContext, consoleLogs(server.id));
  advancedActions.actions.forEach((item) => actions.push(item));
  advancedActions.warnings.forEach((item) => warnings.push(item));
  if (advancedActions.actions.length) {
    logFixed({
      serverId: server.id,
      category: 'advanced-agent',
      title: 'Advanced agent applied safe action(s)',
      detail: advancedActions.actions.join('\n').slice(0, 1200),
      source: 'advanced-agent',
    });
  }
  checks.push({
    name: 'Support config files and agent actions',
    ok: true,
    detail: [...supportRepair.actions, ...bedrockReferenceRepair.actions, ...advancedActions.actions].length
      ? [...supportRepair.actions, ...bedrockReferenceRepair.actions, ...advancedActions.actions].join(', ')
      : 'Required support config files, Bedrock pack references, and safe agent actions are clear.',
  });
  if (server.type === 'bedrock' && diagnostics.some((item) => item.id === 'bedrock-pack-version' || item.id === 'bedrock-world-native-crash')) {
    const packRepair = await quarantineIncompatibleBedrockPacks(server, root, consoleLogs(server.id));
    packRepair.actions.forEach((item) => actions.push(item));
    packRepair.warnings.forEach((item) => warnings.push(item));
    checks.push({
      name: 'Bedrock pack compatibility',
      ok: Boolean(packRepair.actions.length),
      detail: packRepair.actions[0] || packRepair.warnings[0] || 'No incompatible packs found.',
    });
  }

  const staleTransferCount = await cleanupStaleTransferFiles(server, root);
  actions.push(`Removed ${staleTransferCount} stale partial transfer(s).`);
  checks.push({ name: 'Path boundary', ok: true, detail: displayPath(root) });
  const vpsReadiness = await inspectVpsRepairReadiness(server, root);
  vpsReadiness.actions.forEach((item) => actions.push(item));
  vpsReadiness.warnings.forEach((item) => warnings.push(item));
  checks.push({
    name: 'VPS filesystem readiness',
    ok: vpsReadiness.warnings.length === 0,
    detail: vpsReadiness.warnings[0] || vpsReadiness.actions.join(', ') || 'Server root is writable and filesystem reserve was checked.',
  });

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
  actions.push('Rebuilt the ASF resource profile and cleared stale runtime status.');

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

  const optimization = applyOptimizations
    ? await applyAgentOptimizations(server, root, agentAnalysis)
    : { applied: [], skipped: ['Previewed only; optimization changes were not requested.'] };
  if (optimization.applied.length) {
    actions.push(`Applied ${optimization.applied.length} bounded game setting optimization(s): ${optimization.applied.join(', ')}.`);
  }
  optimization.skipped.forEach((item) => warnings.push(item));
  const concreteActions = actions.filter((action) => !/^Removed 0 stale partial transfer/.test(action) && !/^Rebuilt the ASF resource profile/.test(action) && !/^Repaired executable/.test(action) && !/^Executable found/.test(action));
  const summary = `${checks.filter((check) => check.ok).length}/${checks.length} checks passed, ${concreteActions.length} concrete repair action(s), ${warnings.length} warning(s).`;
  const criticalWorldCrash = diagnostics.some((item) => item.id === 'bedrock-world-native-crash');
  logFixed({
    serverId: server.id,
    category: applyOptimizations ? 'repair' : 'repair-preview',
    title: applyOptimizations ? 'Repair & Diagnose completed' : 'Repair preview completed',
    detail: `${summary}\n${actions.slice(0, 8).join('\n')}`,
    source: 'repair-agent',
  });

  return {
    repair,
    checks,
    actions,
    warnings,
    diagnostics,
    knowledge,
    agent: publicAgentAnalysis(agentAnalysis),
    summary,
    concreteActions,
    // A generic repair action (for example rebuilding a config file) does not
    // prove a Bedrock world database crash is fixed. Keep auto-restart blocked
    // until the world has been explicitly recovered and verified.
    shouldRestart: !criticalWorldCrash,
  };
}

async function restoreServerBackup(server, backupName) {
  if (runtimeStatus(server.id) === 'online') throw new Error('Stop the server before restoring a backup.');
  const name = String(backupName || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!name.endsWith('.zip') || name.includes('/')) throw new Error('Choose a backup ZIP to restore.');
  return restoreBackupFileIntoServer(server, server.id, name);
}

function findJavaWorldRoot(root) {
  const candidates = [path.join(root, 'world'), root];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'level.dat')));
  if (!found) throw new Error('No Java world level.dat was found. Start the server once or upload a world first.');
  return found;
}

function findBedrockWorldRoot(root) {
  const worlds = path.join(root, 'worlds');
  if (!fs.existsSync(worlds)) throw new Error('No Bedrock worlds folder was found. Start the server once or upload a world first.');
  const entries = fs.readdirSync(worlds, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(worlds, entry.name));
  const found = entries.find((candidate) => fs.existsSync(path.join(candidate, 'level.dat')) || fs.existsSync(path.join(candidate, 'db')));
  if (!found) throw new Error('No Bedrock world folder with level.dat/db was found.');
  return found;
}

function findConvertedWorldRoot(output) {
  const queue = [output];
  while (queue.length) {
    const current = queue.shift();
    if (fs.existsSync(path.join(current, 'level.dat')) || fs.existsSync(path.join(current, 'db'))) return current;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return output;
}

function sourceWorldForConversion(server) {
  const root = ensureServerDirs(server);
  return server.type === 'bedrock' ? findBedrockWorldRoot(root) : findJavaWorldRoot(root);
}

function createConvertedServerRecord(source, targetType, req) {
  const selectedSoftware = defaultSoftware(targetType);
  const result = db.prepare(`
    INSERT INTO servers (
      name, type, port, max_memory_mb, auto_start, auto_restart, crash_backup,
      scheduled_backups, backup_interval_hours, backup_interval_minutes, backup_retention, wake_on_join, whitelist,
      tunnel_provider, public_alias, startup_delay_sec, software_key, software_version,
      cpu_cores, disk_limit_mb, owner_user_id, install_status, install_progress, install_message
    )
    VALUES (?, ?, ?, ?, 0, 1, 1, 1, 24, 1440, 4, 0, 0, 'none', '', 0, ?, 'latest', ?, 0, ?, 'converted', 5, ?)
  `).run(
    `${source.name} ${targetType === 'java' ? 'Java' : 'Bedrock'} Convert`.slice(0, 80),
    targetType,
    clampNumber(targetType === 'java' ? source.port + 1 : source.port + 10, 1024, 65535, targetType === 'java' ? 25565 : 19132),
    clampMemoryMb(source.max_memory_mb, 1024),
    selectedSoftware.key,
    clampNumber(source.cpu_cores, 1, hostCpuCount(), 1),
    source.owner_user_id || null,
    `World conversion queued from ${source.name}. Install ${selectedSoftware.name} after conversion if needed.`,
  );
  const inserted = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
  setSettingValue(`server_backup_timezone_${inserted.id}`, getUserTimezone(req.user.id));
  prepareServerIdForCreation(inserted.id);
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
  const executablePath = path.join(root, 'software', selectedSoftware.executable);
  const mark = writeProfile({ ...inserted, server_path: root }, root, null);
  db.prepare('UPDATE servers SET server_path = ?, executable_path = ?, nexus_mark_profile = ? WHERE id = ?')
    .run(root, executablePath, JSON.stringify(mark), inserted.id);
  const created = db.prepare('SELECT * FROM servers WHERE id = ?').get(inserted.id);
  writeServerMetadata(created, root);
  return created;
}

async function copyConvertedWorldIntoServer(convertedRoot, targetServer) {
  const root = ensureServerDirs(targetServer);
  const target = targetServer.type === 'java'
    ? path.join(root, 'world')
    : path.join(root, 'worlds', targetServer.name.replace(/[^A-Za-z0-9 _-]+/g, '').slice(0, 40) || 'Converted World');
  await fs.promises.mkdir(target, { recursive: true });
  copyDirectoryContents(convertedRoot, target);
  return target;
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

function javaRuntimeMetaPath(root) {
  return path.join(root, 'runtime', 'java-runtime.json');
}

function adoptiumArchitecture() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'aarch64';
  throw new Error(`Bundled Java auto-install does not support ${process.arch}. Install the required Java runtime manually.`);
}

async function installBundledJavaRuntime(root, serverId, major, onProgress) {
  if (process.platform !== 'linux') throw new Error(`Java ${major}+ is required. Install it manually on this OS, then restart NexusPanel.`);
  const existing = bundledJavaBinary(root, major);
  if (existing) return existing;
  const architecture = adoptiumArchitecture();
  const runtimeDir = path.join(root, 'runtime', `java-${major}`);
  const archivePath = path.join(root, 'runtime', `temurin-java-${major}-${architecture}.tar.gz`);
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${architecture}/jre/hotspot/normal/eclipse?project=jdk`;
  onProgress(7, `Downloading bundled Java ${major} runtime`);
  await downloadToFile(url, archivePath, (progress) => {
    onProgress(Math.max(7, Math.min(48, Math.round(progress * 0.48))), `Downloading bundled Java ${major} runtime`);
  });
  onProgress(52, `Extracting bundled Java ${major}`);
  extractJavaRuntimeArchive(archivePath, runtimeDir);
  const javaBinary = findFile(runtimeDir, 'java');
  if (!javaBinary) throw new Error(`Bundled Java ${major} extraction finished but java binary was not found.`);
  if (process.platform !== 'win32') await fs.promises.chmod(javaBinary, 0o755).catch(() => {});
  await fs.promises.writeFile(javaRuntimeMetaPath(root), JSON.stringify({
    major,
    javaBinary: path.relative(root, javaBinary),
    provider: 'eclipse-temurin',
    installedAt: new Date().toISOString(),
  }, null, 2));
  appendLog(serverId, `[NexusPanel] Bundled Java ${major} runtime ready: ${displayPath(javaBinary)}`);
  return javaBinary;
}

async function verifyJarDownload(filePath, softwareName) {
  const handle = await fs.promises.open(filePath, 'r').catch(() => null);
  if (!handle) throw new Error(`${softwareName} download did not create a jar file.`);
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    if (bytesRead < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error(`${softwareName} download is not a valid jar. Recheck the selected version and retry.`);
    }
  } finally {
    await handle.close();
  }
}

async function installForgeServer(root, serverId, download, executablePath, onProgress) {
  const installerPath = path.join(root, 'runtime', download.fileName || `forge-${download.forgeVersion}-installer.jar`);
  await fs.promises.mkdir(path.dirname(installerPath), { recursive: true });
  const javaCommand = bundledJavaBinary(root, requiredJavaMajorForMinecraftVersion(download.version)) || 'java';
  onProgress(25, `Downloading Forge installer ${download.forgeVersion}`);
  await downloadToFile(download.url, installerPath, (progress) => onProgress(Math.max(25, Math.min(55, Math.round(25 + progress * 0.3))), `Downloading Forge installer ${download.forgeVersion}`));
  await verifyJarDownload(installerPath, 'Forge installer');
  onProgress(60, `Running Forge server installer ${download.forgeVersion}`);
  await runShellCommand(`"${javaCommand}" -jar "${installerPath}" --installServer`, root, (chunk) => {
    onProgress(72, String(chunk).trim().slice(-180) || `Installing Forge ${download.forgeVersion}`);
  });
  const argsPath = path.join(root, 'libraries', 'net', 'minecraftforge', 'forge', download.forgeVersion, process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt');
  const legacyJar = findFile(root, `forge-${download.forgeVersion}.jar`);
  if (!fs.existsSync(argsPath) && !legacyJar) throw new Error('Forge installer finished but no launch args or Forge jar was found.');
  const script = process.platform === 'win32'
    ? `@echo off\r\nset MEM=%ASF_MEMORY_MB%\r\nif "%MEM%"=="" set MEM=1024\r\n${fs.existsSync(argsPath) ? `"${javaCommand}" -Xmx%MEM%M @\"${argsPath}\" nogui` : `"${javaCommand}" -Xmx%MEM%M -jar \"${legacyJar}\" nogui`}\r\n`
    : `#!/bin/sh\nMEM="${'${ASF_MEMORY_MB:-1024}'}"\n${fs.existsSync(argsPath) ? `exec "${javaCommand}" -Xmx"$MEM"M @"${argsPath}" nogui` : `exec "${javaCommand}" -Xmx"$MEM"M -jar "${legacyJar}" nogui`}\n`;
  await fs.promises.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.promises.writeFile(executablePath, script, 'utf8');
  if (process.platform !== 'win32') await fs.promises.chmod(executablePath, 0o755);
  appendLog(serverId, `[NexusPanel] Forge server launcher ready: ${download.forgeVersion}.`);
}

function commandWorks(command, args = ['--version']) {
  const resolved = resolveCommand(command);
  if (!resolved) return false;
  const result = spawnSync(resolved, args, { encoding: 'utf8', windowsHide: true, env: commandEnv() });
  return !result.error && result.status === 0;
}

function commandEnv() {
  const serviceHome = path.join(dataRoot, 'service-home');
  try {
    fs.mkdirSync(serviceHome, { recursive: true, mode: 0o700 });
  } catch {}
  const extraPath = process.platform === 'win32'
    ? []
    : ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin'];
  return {
    ...process.env,
    HOME: process.env.HOME || serviceHome,
    USERPROFILE: process.env.USERPROFILE || serviceHome,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(serviceHome, '.config'),
    PATH: [...extraPath, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
  };
}

function resolveCommand(command) {
  if (path.isAbsolute(command) && fs.existsSync(command)) return command;
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const searchPath = commandEnv().PATH.split(path.delimiter).filter(Boolean);
  for (const directory of searchPath) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        // Only accept a real, executable regular file — never a directory or a
        // non-executable decoy planted earlier in PATH.
        const stats = fs.statSync(candidate);
        if (!stats.isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return command;
}

function commandExists(command) {
  // Never interpolate the command into a shell string. Use argv-only probes so
  // a crafted command name cannot inject shell metacharacters.
  const safeName = String(command || '').trim();
  if (!safeName || !/^[A-Za-z0-9._+-]+$/.test(safeName)) return false;
  const resolved = resolveCommand(safeName);
  if (resolved && resolved !== safeName) return true;
  const probe = process.platform === 'win32'
    ? spawnSync('where.exe', [safeName], { encoding: 'utf8', windowsHide: true, env: commandEnv(), timeout: 1200 })
    : spawnSync('which', [safeName], { encoding: 'utf8', windowsHide: true, env: commandEnv(), timeout: 1200 });
  return !probe.error && probe.status === 0;
}

function tunnelKey(provider, serverId = 0) {
  return `${provider}:${Number(serverId || 0)}`;
}

function tunnelProtocolForServer(server, requested = '') {
  const protocol = String(requested || '').toLowerCase();
  if (['tcp', 'udp', 'http', 'https'].includes(protocol)) return protocol;
  return server?.type === 'bedrock' ? 'udp' : 'tcp';
}

async function readNgrokApi() {
  if (!globalThis.fetch) return null;
  // ngrok's local web interface binds 127.0.0.1:4040 by default. Some setups
  // move it; honour NGROK_WEB_ADDR so status still works after a config change.
  const base = String(process.env.NEXUSPANEL_NGROK_API || 'http://127.0.0.1:4040').replace(/\/+$/, '');
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(base)) return null;
  const response = await fetch(`${base}/api/tunnels`, {
    signal: AbortSignal.timeout(1200),
  }).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}

function parseNgrokRemote(tunnel) {
  const url = String(tunnel?.public_url || '');
  if (!url) return { publicUrl: '', remoteHost: '' };
  try {
    const parsed = new URL(url);
    return { publicUrl: url, remoteHost: parsed.host || url };
  } catch {
    return { publicUrl: url, remoteHost: url.replace(/^[a-z]+:\/\//i, '') };
  }
}

function processRunning(state) {
  return Boolean(state?.child && !state.exited && state.child.exitCode === null && !state.child.killed);
}

async function ngrokStatus(server = null) {
  const tunnels = (await readNgrokApi())?.tunnels || [];
  const port = Number(server?.port || 0);
  // Only report a tunnel whose local address matches THIS server's port.
  // Without the port filter, server A's status would leak server B's public URL.
  const matched = port
    ? tunnels.find((item) => String(item.config?.addr || '').endsWith(`:${port}`) || String(item.config?.addr || '') === String(port))
    : null;
  const parsed = parseNgrokRemote(matched);
  const key = tunnelKey('ngrok', server?.id || 0);
  const processInfo = tunnelProcesses.get(key);
  const installed = commandExists('ngrok');
  return {
    installed,
    binary: installed ? resolveCommand('ngrok') : '',
    running: Boolean(matched || processRunning(processInfo)),
    pid: processInfo?.child?.pid || 0,
    publicUrl: parsed.publicUrl,
    remoteHost: parsed.remoteHost,
    protocol: matched?.proto || processInfo?.protocol || tunnelProtocolForServer(server),
    message: matched ? `ngrok tunnel is live at ${parsed.remoteHost}` : (processInfo?.message || 'ngrok is not running.'),
  };
}

async function startNgrokTunnel(server, requestedProtocol = '') {
  if (isHostEdition()) throw new Error('Normal-edition tunnels are not available in host edition.');
  const ngrokCommand = resolveCommand('ngrok');
  if (!commandExists('ngrok')) throw new Error('ngrok is not installed on the VPS. Install ngrok first, then retry from the panel.');
  const token = settingValue('ngrok_auth_token', '');
  if (!token) throw new Error('Save your ngrok auth token in Settings first.');
  const protocol = tunnelProtocolForServer(server, requestedProtocol);
  const key = tunnelKey('ngrok', server.id);
  const existing = tunnelProcesses.get(key);
  if (processRunning(existing)) return ngrokStatus(server);
  const env = commandEnv();
  const auth = spawnSync(ngrokCommand, ['config', 'add-authtoken', token], { encoding: 'utf8', windowsHide: true, env, timeout: 8000 });
  if (auth.error || auth.status !== 0) {
    const detail = (auth.stderr || auth.stdout || auth.error?.message || '').slice(-800);
    const hint = /ERR_NGROK_107|authentication failed|invalid/i.test(detail)
      ? ' ngrok rejected the saved authtoken. Copy a fresh authtoken from https://dashboard.ngrok.com/get-started/your-authtoken and save it in Settings.'
      : '';
    throw new Error(`ngrok auth setup failed: ${detail}${hint}`);
  }
  const child = spawn(ngrokCommand, [protocol, String(server.port)], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { child, protocol, message: `Starting ngrok ${protocol} tunnel for ${server.name}...`, output: '', exited: false };
  tunnelProcesses.set(key, state);
  const capture = (chunk) => {
    const text = String(chunk);
    state.output = `${state.output}${text}`.slice(-4000);
    state.message = text.trim().slice(-900) || state.message;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.message = `ngrok exited code=${code ?? 'none'} signal=${signal ?? 'none'}.${state.output.trim() ? ` ${state.output.trim().slice(-1200)}` : ''}`;
  });
  await wait(1800);
  const status = await ngrokStatus(server);
  if (!status.running && !status.remoteHost) {
    throw new Error(status.message || `ngrok ${protocol} tunnel exited before it returned a public address.`);
  }
  if (server.id) appendLog(server.id, `[NexusPanel] ngrok ${protocol} tunnel ${status.remoteHost ? `ready: ${status.remoteHost}` : 'started; waiting for remote address'}.`);
  return status;
}

function stopTunnelProcess(provider, serverId = 0) {
  const state = tunnelProcesses.get(tunnelKey(provider, serverId));
  if (!state) return false;
  try {
    if (processRunning(state)) state.child.kill();
  } catch {}
  tunnelProcesses.delete(tunnelKey(provider, serverId));
  return true;
}

/**
 * Reap dead tunnel child processes so tunnelProcesses cannot grow without
 * bound across many start/stop cycles. Called from the periodic scheduler.
 */
function reapTunnelProcesses() {
  for (const [key, state] of tunnelProcesses) {
    if (state.exited || !processRunning(state)) tunnelProcesses.delete(key);
  }
}

function sudoPrefix() {
  return process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0 ? 'sudo -n ' : '';
}

async function installPlayitAgent() {
  if (process.platform !== 'linux') throw new Error('Playit one-click install is only supported on Linux VPS hosts.');
  if (!commandExists('apt-get')) throw new Error('Playit one-click install currently supports Ubuntu/Debian apt hosts.');
  const sudo = sudoPrefix();
  const command = [
    `${sudo}apt-get update`,
    `${sudo}apt-get install -y ca-certificates curl gnupg`,
    `${sudo}mkdir -p /usr/share/keyrings`,
    `curl -SsL https://packages.playit.gg/keys/playit.gpg | ${sudo}gpg --batch --yes --dearmor -o /usr/share/keyrings/playit.gpg`,
    `${sudo}chmod 0644 /usr/share/keyrings/playit.gpg`,
    `printf '%s\\n' 'deb [signed-by=/usr/share/keyrings/playit.gpg] https://packages.playit.gg/data/debian ./' | ${sudo}tee /etc/apt/sources.list.d/playit.list >/dev/null`,
    `${sudo}rm -f /etc/apt/sources.list.d/playit-cloud.list /etc/apt/trusted.gpg.d/playit.gpg`,
    `${sudo}apt-get -o Acquire::GzipIndexes=false -o Acquire::CompressionTypes::Order::=gz -o Acquire::CompressionTypes::gz=false update`,
    `${sudo}apt-get install -y playit`,
  ].join(' && ');
  await runShellCommand(command, path.join(__dirname, '..'));
  const claim = await capturePlayitClaimLink();
  const status = playitStatus();
  return {
    ...status,
    setupUrl: claim.setupUrl || status.setupUrl,
    setupLinks: claim.setupLinks.length ? claim.setupLinks : status.setupLinks,
    message: claim.message || status.message,
  };
}

async function installNgrokAgent() {
  if (process.platform !== 'linux') throw new Error('ngrok one-click install is only supported on Linux VPS hosts.');
  if (!commandExists('apt-get')) throw new Error('ngrok one-click install currently supports Ubuntu/Debian apt hosts.');
  const sudo = sudoPrefix();
  const command = [
    `${sudo}apt-get update`,
    `${sudo}apt-get install -y ca-certificates curl`,
    `curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | ${sudo}tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null`,
    `echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" | ${sudo}tee /etc/apt/sources.list.d/ngrok.list >/dev/null`,
    `${sudo}apt-get update`,
    `${sudo}apt-get install -y ngrok`,
  ].join(' && ');
  await runShellCommand(command, path.join(__dirname, '..'));
  return { installed: commandExists('ngrok'), message: 'ngrok agent installed on the VPS.' };
}

function extractPlayitLinks(text) {
  const links = [...String(text || '').matchAll(/https?:\/\/[^\s"'<>]+/gi)]
    .map((match) => match[0].replace(/[),.;]+$/, ''))
    .filter((url) => /playit\.gg/i.test(url));
  return [...new Set(links)].slice(0, 6);
}

function playitSecretConfigured() {
  for (const candidate of [
    '/etc/playit/playit.toml',
    path.join(commandEnv().HOME || '', '.config', 'playit_gg', 'playit.toml'),
  ]) {
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      if (/secret(?:_key)?\s*=\s*["'][^"']+["']/i.test(content)) return true;
    } catch {}
  }
  return false;
}

async function capturePlayitClaimLink() {
  if (!commandExists('playit') || playitSecretConfigured()) {
    return { setupUrl: '', setupLinks: [], message: '' };
  }
  if (process.platform === 'linux' && commandExists('systemctl')) {
    await runShellCommand(`${sudoPrefix()}systemctl stop playit`, path.join(__dirname, '..')).catch(() => {});
  }
  const playitCommand = resolveCommand('playit');
  const output = await new Promise((resolve) => {
    const child = spawn(playitCommand, [], {
      cwd: path.join(__dirname, '..'),
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let text = '';
    const done = () => {
      try {
        if (!child.killed) child.kill();
      } catch {}
      resolve(text.slice(-12000));
    };
    const timer = setTimeout(done, 9000);
    const capture = (chunk) => {
      text = `${text}${chunk}`.slice(-12000);
      if (extractPlayitLinks(text).some((url) => /claim/i.test(url))) {
        clearTimeout(timer);
        setTimeout(done, 250);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      text = `${text}\n${error.message}`;
      clearTimeout(timer);
      done();
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(text.slice(-12000));
    });
  });
  const setupLinks = extractPlayitLinks(output);
  const setupUrl = setupLinks.find((url) => /claim/i.test(url)) || setupLinks[0] || '';
  return {
    setupUrl,
    setupLinks,
    message: setupUrl
      ? `Open this Playit claim link to finish setup: ${setupUrl}`
      : `Playit installed. Start it from terminal to claim if needed. ${output.trim().slice(-900)}`,
  };
}

function readPlayitOutput() {
  let output = '';
  const state = tunnelProcesses.get(tunnelKey('playit', 0));
  if (state?.output) output = `${output}\n${state.output}`;
  const claimState = tunnelProcesses.get(tunnelKey('playit-claim', 0));
  if (claimState?.output) output = `${output}\n${claimState.output}`;
  if (process.platform === 'linux' && commandExists('journalctl')) {
    const journalctl = resolveCommand('journalctl');
    const logs = spawnSync(journalctl, ['-u', 'playit', '-n', '120', '--no-pager'], {
      encoding: 'utf8',
      windowsHide: true,
      env: commandEnv(),
      timeout: 1500,
      maxBuffer: 1024 * 1024,
    });
    output = `${output}\n${logs.stdout || ''}\n${logs.stderr || ''}`;
  }
  return output.slice(-12000);
}

function playitClaimTerminalPayload() {
  const state = tunnelProcesses.get(tunnelKey('playit-claim', 0));
  const output = state?.output || '';
  const setupLinks = extractPlayitLinks(output);
  return {
    running: processRunning(state),
    pid: state?.child?.pid || 0,
    output,
    setupLinks,
    setupUrl: setupLinks.find((url) => /claim/i.test(url)) || setupLinks[0] || '',
    message: state?.message || (state ? 'Playit claim terminal stopped.' : 'Playit claim terminal is not running.'),
  };
}

async function startPlayitClaimTerminal() {
  if (!commandExists('playit')) throw new Error('Playit is not installed on the VPS. Click Install Playit first.');
  if (process.platform !== 'linux') throw new Error('Playit claim terminal is only supported on Linux VPS hosts.');
  const key = tunnelKey('playit-claim', 0);
  const existing = tunnelProcesses.get(key);
  if (processRunning(existing)) return playitClaimTerminalPayload();
  await runShellCommand(`${sudoPrefix()}systemctl stop playit 2>/dev/null || true; ${sudoPrefix()}pkill -f playitd 2>/dev/null || true`, path.join(__dirname, '..')).catch(() => {});
  const playitCommand = resolveCommand('playit');
  const useScript = commandExists('script');
  const command = useScript ? resolveCommand('script') : playitCommand;
  const args = useScript ? ['-q', '-c', playitCommand, '/dev/null'] : [];
  const child = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: commandEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = {
    child,
    protocol: 'playit-claim',
    message: 'Playit foreground terminal is running. Keep it open until the claim page connects.',
    output: `$ ${useScript ? `script -q -c ${playitCommand} /dev/null` : playitCommand}\n`,
    exited: false,
    startedAt: Date.now(),
  };
  tunnelProcesses.set(key, state);
  const capture = (chunk) => {
    const text = String(chunk).replace(/\r(?!\n)/g, '\n');
    state.output = `${state.output}${text}`.slice(-30000);
    const lastLine = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (lastLine) state.message = lastLine.slice(-900);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (error) => {
    state.exited = true;
    state.message = error.message;
    state.output = `${state.output}\n${error.message}`.slice(-30000);
  });
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.message = `Playit terminal exited code=${code ?? 'none'} signal=${signal ?? 'none'}.`;
    state.output = `${state.output}\n${state.message}`.slice(-30000);
  });
  // Auto-expire the claim terminal after 15 minutes so an abandoned claim
  // session cannot hold a child process and 30 KB of output forever.
  const expiry = setTimeout(() => {
    const current = tunnelProcesses.get(key);
    if (current === state && processRunning(state)) {
      try { state.child.kill(); } catch {}
      state.exited = true;
      state.message = 'Playit claim terminal expired after 15 minutes. Restart it to claim again.';
    }
  }, 15 * 60 * 1000);
  expiry.unref();
  await wait(900);
  return playitClaimTerminalPayload();
}

function playitStatus() {
  const installed = commandExists('playit');
  let service = { active: false, enabled: false, detail: '' };
  if (process.platform === 'linux' && commandExists('systemctl')) {
    const systemctl = resolveCommand('systemctl');
    const active = spawnSync(systemctl, ['is-active', 'playit'], { encoding: 'utf8', windowsHide: true, env: commandEnv(), timeout: 1200 });
    const enabled = spawnSync(systemctl, ['is-enabled', 'playit'], { encoding: 'utf8', windowsHide: true, env: commandEnv(), timeout: 1200 });
    service = {
      active: active.status === 0,
      enabled: enabled.status === 0,
      detail: `${String(active.stdout || active.stderr || '').trim()} ${String(enabled.stdout || enabled.stderr || '').trim()}`.trim(),
    };
  }
  const output = readPlayitOutput();
  const setupLinks = extractPlayitLinks(output);
  const setupUrl = setupLinks.find((url) => /claim|setup|account\/agents|agent/i.test(url)) || setupLinks[0] || 'https://playit.gg/account/agents';
  const setupHint = setupLinks.length ? ` Claim/setup link: ${setupUrl}` : '';
  return {
    installed,
    binary: installed ? resolveCommand('playit') : '',
    running: service.active,
    enabled: service.enabled,
    setupUrl,
    setupLinks,
    message: installed
      ? service.active ? `Playit agent is running on the VPS.${setupHint}` : `Playit is installed. Start it, then claim/setup tunnels in the Playit dashboard if prompted.${setupHint}`
      : 'Playit is not installed on the VPS.',
  };
}

async function startPlayitAgent() {
  const playitCommand = resolveCommand('playit');
  if (!commandExists('playit')) throw new Error('Playit is not installed on the VPS. Click Install Playit first.');
  if (process.platform === 'linux' && commandExists('systemctl')) {
    const sudo = sudoPrefix();
    await runShellCommand(`${sudo}systemctl enable playit && ${sudo}systemctl start playit`, path.join(__dirname, '..'));
    await wait(1200);
    return playitStatus();
  }
  const key = tunnelKey('playit', 0);
  const existing = tunnelProcesses.get(key);
  if (processRunning(existing)) return { ...playitStatus(), running: true, pid: existing.child.pid };
  const child = spawn(playitCommand, [], {
    cwd: path.join(__dirname, '..'),
    env: commandEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { child, protocol: 'playit', message: 'Playit agent started.', output: '', exited: false };
  tunnelProcesses.set(key, state);
  const capture = (chunk) => {
    const text = String(chunk);
    state.output = `${state.output}${text}`.slice(-12000);
    state.message = text.trim().slice(-900) || state.message;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.message = `Playit exited code=${code ?? 'none'} signal=${signal ?? 'none'}.`;
  });
  return { ...playitStatus(), running: true, pid: child.pid, message: state.message };
}

async function stopPlayitAgent() {
  stopTunnelProcess('playit', 0);
  stopTunnelProcess('playit-claim', 0);
  if (process.platform === 'linux' && commandExists('systemctl')) {
    const sudo = sudoPrefix();
    await runShellCommand(`${sudo}systemctl stop playit`, path.join(__dirname, '..')).catch(() => {});
  }
  return playitStatus();
}

function runRequirementCommand(command, args) {
  const executable = resolveCommand(command);
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: commandEnv(),
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

async function ensureSoftwareRequirements(software, serverId, onProgress, version = 'latest', root = null) {
  if (software.edition === 'java') {
    const requiredMajor = requiredJavaMajorForMinecraftVersion(version);
    if (process.platform === 'linux' && root) {
      await installBundledJavaRuntime(root, serverId, requiredMajor, onProgress);
      return { ok: true, message: `Bundled Java ${requiredMajor} runtime ready.` };
    }
    let javaMajor = installedJavaMajor();
    if (process.platform !== 'linux') {
      if (!javaMajor) throw new Error('Java runtime was not found. Install Java 21+ manually, then restart NexusPanel.');
    } else if (!javaMajor) {
      onProgress(6, 'Java missing. Installing Java 21 runtime');
      const installed = installLinuxPackage({
        apt: ['openjdk-21-jre-headless'],
        dnf: ['java-21-openjdk-headless'],
        pacman: ['jdk21-openjdk'],
      });
      javaMajor = installedJavaMajor();
      if (!installed || !javaMajor) {
        throw new Error('Java auto-install did not complete. Install Java 21+ and retry.');
      }
      appendLog(serverId, '[NexusPanel] Requirement installed: Java 21 runtime.');
    }
    if (requiredMajor > javaMajor) {
      if (root) {
        await installBundledJavaRuntime(root, serverId, requiredMajor, onProgress);
        return { ok: true, message: `Bundled Java ${requiredMajor} runtime installed.` };
      }
      throw new Error(`${software.name} ${version} requires Java ${requiredMajor}, but this VPS is running Java ${javaMajor}. Pick an older Minecraft version from the version list or install Java ${requiredMajor}+ on the VPS.`);
    }
    return { ok: true, message: `Java ${javaMajor} runtime ready.` };
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
    plugins: req.user && hasPermission(req.user, capabilities.PLUGINS_MANAGE, permissions.MANAGE_FILES)
      ? pluginRows(req.user.role === 'owner' ? null : serverRows(req.user, req).map((server) => server.id))
      : [],
    softwareCatalog: req.user && hasPermission(req.user, capabilities.SOFTWARE_MANAGE, permissions.MANAGE_SERVERS) ? softwareCatalog() : [],
    templates: req.user && hasPermission(req.user, capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS) && isHostEdition() ? templateRows() : [],
    settings: req.user ? panelSettingsPayload(req.user) : null,
    users: req.user && hasPermission(req.user, capabilities.ADMINS_MANAGE, permissions.MANAGE_ADMINS) ? userRows() : [],
    loginEvents: req.user && hasPermission(req.user, capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS) ? loginEventRows(10) : [],
    health: req.user && hasPermission(req.user, capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS) ? (fs.existsSync(healthPath) ? readHealthFile() : null) : null,
    optimizer: req.user && hasPermission(req.user, capabilities.OPTIMIZER_MANAGE, permissions.MANAGE_SERVERS) ? optimizerStatus() : null,
    adaptiveInsights: [],
    repairBrain: null,
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
      serverSizeBytes: cachedServerSizeBytes(server),
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

app.post('/api/user/timezone', requirePermission(capabilities.TIMEZONE_MANAGE, permissions.VIEW_ONLY), (req, res) => {
  try {
    const { timezone } = req.body;
    if (!timezone) return res.status(400).json({ error: 'Timezone is required' });
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

app.get('/api/optimizer/status', requirePermission(capabilities.OPTIMIZER_MANAGE, permissions.MANAGE_SERVERS), (_req, res) => {
  res.json(optimizerStatus());
});

app.post('/api/adaptive/heal', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), asyncRoute(async (_req, res) => {
  res.json(await runAdaptiveMaintenance());
}));

app.get('/api/optimizer/plan', requirePermission(capabilities.OPTIMIZER_MANAGE, permissions.MANAGE_SERVERS), (_req, res) => {
  res.json(planCommands());
});

app.get('/api/network/metrics', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (_req, res) => {
  res.json({ network: await networkStats() });
}));

app.get('/api/network/download-test', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
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

app.post('/api/network/upload-test', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  res.json({ bytes: Buffer.isBuffer(req.body) ? req.body.length : 0, receivedAt: Date.now() });
});
app.get('/api/nginx/accel-config', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_ADMINS), (_req, res) => {
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

app.post('/api/optimizer/apply', requirePermission(capabilities.OPTIMIZER_MANAGE, permissions.MANAGE_ADMINS), (_req, res) => {
  const result = applyTweaks();
  if (!result.applied) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/setup', asyncRoute(async (req, res) => {
  if (getUserCount() > 0) {
    return res.status(409).json({ error: 'Initial setup has already been completed.' });
  }

  const token = req.get('x-nexuspanel-setup-token') || req.body?.setupToken;
  if (!validSetupToken(token)) {
    return res.status(403).json({ error: 'Invalid or expired setup link.' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim() || 'Owner';
  const password = String(req.body?.password || '');
  const confirmation = String(req.body?.passwordConfirmation || '');

  const emailError = emailPolicyError(email);
  if (emailError) return res.status(400).json({ error: emailError });
  if (name.length < 2 || name.length > 100) {
    return res.status(400).json({ error: 'Name must be between 2 and 100 characters.' });
  }
  const passwordError = passwordPolicyError(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (password !== confirmation) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  try {
    const user = createUser({ email, name, password, role: 'owner', accessLevel: 100 });
    finishInitialSetup();
    setSessionCookie(res, createSession(user.id, { userAgent: req.headers['user-agent'] || '', ip: clientIp(req) }), { secure: req.secure });
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (error) {
    if (/UNIQUE constraint failed: users\.email/i.test(String(error.message))) {
      return res.status(409).json({ error: 'That email address is already registered.' });
    }
    throw error;
  }
}));

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const throttle = loginThrottle(req, email);
  if (throttle.retryMs > 0) {
    const retrySeconds = Math.max(1, Math.ceil(throttle.retryMs / 1000));
    res.setHeader('Retry-After', String(retrySeconds));
    return res.status(429).json({ error: `Too many login attempts. Try again in ${retrySeconds} seconds.` });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const passwordValid = verifyPassword(String(req.body.password || ''), user?.password_hash || dummyPasswordHash);

  if (!user || !passwordValid) {
    recordLoginFailure(throttle.keys);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  clearLoginThrottle(throttle.keys);
  recordLoginEvent(req, user);
  setSessionCookie(res, createSession(user.id, { userAgent: req.headers['user-agent'] || '', ip: clientIp(req) }), { secure: req.secure });
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
  if (isHostEdition() && user && user.role !== 'owner' && settingValue('host_maintenance_mode', '0') === '1') {
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
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters.' });
  const row = db.prepare('SELECT * FROM password_reset_otps WHERE email = ?').get(email);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'OTP expired. Request a new code.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many OTP attempts. Request a new code.' });
  const providedHash = Buffer.from(otpHash(email, otp));
  const expectedHash = Buffer.from(String(row.code_hash || ''));
  const otpValid = providedHash.length === expectedHash.length && crypto.timingSafeEqual(providedHash, expectedHash);
  if (!otpValid) {
    db.prepare('UPDATE password_reset_otps SET attempts = attempts + 1 WHERE email = ?').run(email);
    return res.status(401).json({ error: 'Invalid OTP.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?').run(hashPassword(password), email);
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(email);
  db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
  db.prepare('DELETE FROM auth_throttle WHERE key = ?').run(throttleKey('account', email));
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

app.get('/api/users', requirePermission(capabilities.ADMINS_MANAGE, permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ users: userRows() });
});

app.get('/api/audit/logins', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ events: loginEventRows(10) });
});

app.delete('/api/security/sessions/:id', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (req, res) => {
  const sessionId = String(req.params.id || '').slice(0, 100);
  const session = db.prepare('SELECT id, user_id FROM sessions WHERE id = ?').get(sessionId);
  if (!session || (Number(session.user_id) !== Number(req.user.id) && req.user.role !== 'owner')) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  if (String(req.user.session_id) === String(session.id)) clearSessionCookie(res);
  logFixed({ category: 'security', title: 'Session revoked', detail: `Revoked a session for user #${session.user_id}.`, source: 'owner-action' });
  res.json({ ok: true, current: String(req.user.session_id) === String(session.id) });
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

app.get('/api/health', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  res.json({ health: await runHealthCheck(req.query.force === '1') });
}));

function renderEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderUserDate(user, value) {
  const raw = typeof value === 'number' ? value : String(value || '');
  const normalized = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: getUserTimezone(user.id),
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

app.get('/api/host-agent/status', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), asyncRoute(async (_req, res) => {
  res.json({ hostAgent: { ...hostAgent.localStatus(), live: await hostAgent.request('STATUS') } });
}));

app.get('/api/security/render', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  const [health, liveAgent] = await Promise.all([
    runHealthCheck(req.query.force === '1'),
    hostAgent.request('STATUS'),
  ]);
  const events = loginEventRows(10);
  const now = Date.now();
  const sessionScope = req.user.role === 'owner' ? '' : 'AND sessions.user_id = ?';
  const sessionParams = req.user.role === 'owner' ? [now, now - 14 * 24 * 60 * 60 * 1000] : [now, now - 14 * 24 * 60 * 60 * 1000, req.user.id];
  const activeSessions = db.prepare(`
    SELECT sessions.id, sessions.user_id, sessions.user_agent, sessions.ip,
      sessions.ip_changed_at, sessions.last_seen_at, sessions.expires_at,
      users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.expires_at > ? AND sessions.last_seen_at > ? ${sessionScope}
    ORDER BY sessions.last_seen_at DESC LIMIT 100
  `).all(...sessionParams);
  const deviceMemory = hostMemoryStats();
  const deviceMemoryGb = Math.round((deviceMemory.total / 1024 / 1024 / 1024) * 10) / 10;
  const checks = (health.checks || []).map((check) => `
    <article class="${check.ok ? 'is-ok' : 'is-bad'}">
      <strong>${renderEscape(check.name)}</strong><span>${renderEscape(check.message)}</span>
    </article>`).join('');
  const logins = events.map((event) => `
    <article class="audit-row">
      <div><strong>${renderEscape(event.email)}</strong><span>${renderEscape(event.browser)} - ${renderEscape(event.device)}</span></div>
      <code>${renderEscape(event.ip || 'unknown IP')}</code><time>${renderEscape(renderUserDate(req.user, event.createdAt))}</time>
    </article>`).join('');
  const sessions = activeSessions.map((session) => {
    const current = String(session.id) === String(req.user.session_id);
    const ownerCanManage = req.user.role === 'owner' || Number(session.user_id) === Number(req.user.id);
    return `<article class="audit-row">
      <div><strong>${renderEscape(session.name)}${current ? ' · Current session' : ''}</strong><span>${renderEscape(browserFromUserAgent(session.user_agent))} · ${renderEscape(deviceFromUserAgent(session.user_agent))} · ${renderEscape(session.email)}</span></div>
      <code>${renderEscape(session.ip || 'unknown IP')}${session.ip_changed_at ? ` · address changed ${renderEscape(renderUserDate(req.user, session.ip_changed_at))}` : ''}</code>
      <time>Active ${renderEscape(renderUserDate(req.user, session.last_seen_at))}</time>
      ${ownerCanManage ? `<button class="secondary" type="button" data-action="security-revoke-session" data-session-id="${renderEscape(session.id)}">${current ? 'Sign out this device' : 'Revoke'}</button>` : ''}
    </article>`;
  }).join('');
  const agentState = liveAgent.available && liveAgent.ok ? 'online' : 'unavailable';
  res.type('html').send(`
    <div class="section-head">
      <div><p class="eyebrow">Server-rendered security</p><h2>${renderEscape(health.summary || 'Security status')}</h2></div>
      <div class="row-actions"><button class="secondary" type="button" data-action="database-snapshot">Snapshot DB</button><button type="button" data-action="run-health-check">Run check now</button></div>
    </div>
    <div class="security-runtime-strip">
      <article><span>Native host agent</span><strong class="${agentState === 'online' ? 'is-online' : 'is-offline'}">${agentState}</strong></article>
      <article><span>Agent version</span><strong>${renderEscape(liveAgent.version || '3.0.0')}</strong></article>
      <article><span>Response mode</span><strong>SSR + CSP</strong></article>
      <article><span>Panel version</span><strong>${PANEL_VERSION}</strong></article>
    </div>
    <div class="section-head"><div><p class="eyebrow">Device</p><h2>Host information</h2></div></div>
    <div class="security-runtime-strip">
      <article><span>Platform</span><strong>${renderEscape(`${process.platform} ${os.arch()}`)}</strong></article>
      <article><span>Kernel</span><strong>${renderEscape(os.release())}</strong></article>
      <article><span>CPU</span><strong>${hostCpuCount()} logical cores</strong></article>
      <article><span>Memory</span><strong>${deviceMemoryGb} GB</strong></article>
    </div>
    <p class="muted">Generated at ${renderEscape(renderUserDate(req.user, Date.now()))} (${renderEscape(getUserTimezone(req.user.id))}).</p>
    <div class="health-grid">${checks || '<p class="empty-state">No checks available.</p>'}</div>
    <div class="section-head"><div><p class="eyebrow">Audit</p><h2>Recent logins</h2></div></div>
    <div class="audit-list">${logins || '<p class="empty-state">No login events recorded yet.</p>'}</div>
    <div class="section-head"><div><p class="eyebrow">Sessions</p><h2>Active sessions</h2></div></div>
    <p class="muted">Network address changes are recorded for review and do not sign you out by themselves. Active browser sessions renew while in use and expire after 14 days without activity.</p>
    <div class="audit-list">${sessions || '<p class="empty-state">No other active sessions.</p>'}</div>
  `);
}));

app.get('/api/repair/bundle', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
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

app.get('/api/repair/agent/status', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ agent: repairBrainPayload().agent });
});


function collectAdvancedOverview() {
  const servers = db.prepare('SELECT id, name, status, port, max_memory_mb, cpu_cores FROM servers ORDER BY id').all();
  const health = servers.map((server) => {
    const metrics = processTreeMetrics(server.id) || {};
    const cpu = Number(metrics.cpuPercent ?? 0);
    const memory = Number(metrics.memoryPercent ?? 0);
    const errors = Number(metrics.errorCount ?? 0);
    const score = healthEngine.observe(server.id, { cpu, memory, errors });
    return { server, health: score };
  });
  for (const item of servers) {
    dependencyGraph.node(`server:${item.id}`, { type: 'server', name: item.name, status: item.status });
    dependencyGraph.node(`port:${item.port}`, { type: 'allocation', port: item.port });
    dependencyGraph.edge(`server:${item.id}`, `port:${item.port}`, 'binds');
  }
  return {
    version: PANEL_VERSION,
    generatedAt: Date.now(),
    health,
    incidents: incidentEngine.list(50),
    dependencies: dependencyGraph.snapshot(),
    performance: performanceMonitor.snapshot(),
  };
}

app.get('/api/advanced/overview', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  res.json(collectAdvancedOverview());
});

app.get('/api/advanced/incidents', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  res.json({ incidents: incidentEngine.list(limit) });
});

app.post('/api/advanced/incidents', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (req, res) => {
  const type = String(req.body.type || 'manual').slice(0, 80);
  const severity = ['info','low','medium','high','critical'].includes(req.body.severity) ? req.body.severity : 'info';
  const event = incidentEngine.add(type, req.body.data && typeof req.body.data === 'object' ? req.body.data : {}, severity);
  res.status(201).json({ incident: event });
});

app.post('/api/advanced/change-plan', requirePermission(capabilities.SETTINGS_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
  const risk = ['low','medium','high','critical'].includes(req.body.risk) ? req.body.risk : 'medium';
  const change = req.body.change && typeof req.body.change === 'object' ? req.body.change : {};
  if (Object.keys(change).length > 30) return res.status(400).json({ error: 'Change plan is too large.' });
  res.status(201).json({ plan: changePlanner.plan(change, risk) });
});

app.get('/api/advanced/dependencies', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  collectAdvancedOverview();
  res.json(dependencyGraph.snapshot());
});

app.get('/api/advanced/autonomy/activity', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
  res.setHeader('Cache-Control', 'no-store');
  // Expose only generic activity categories. Internal detail strings can
  // contain user supplied names, paths, addresses, or operation metadata.
  const events = autonomousActivity.list(150).filter((event) => {
    if (!event.serverId) return true;
    const server = db.prepare('SELECT id, owner_user_id FROM servers WHERE id = ?').get(Number(event.serverId));
    return Boolean(server && canUseServer(req.user, server));
  }).map((event) => ({
    ts: event.ts,
    kind: String(event.kind || 'event').slice(0, 40),
    message: '',
  }));
  res.json({ readonly: true, events });
});

app.post('/api/advanced/autonomy/classify', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (req, res) => {
  // Classification only; this endpoint never executes an operation.
  res.json({ readonly: true, ...classifyAutonomy(req.body || {}) });
});

app.get('/api/advanced/autonomy/status', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ enabled: true, mode: 'observability', protectedDataConfirmation: true, readonly: true });
});

app.get('/api/advanced/neural-graph', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(neuralGraph.snapshot());
});

app.get('/api/performance', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ performance: performanceMonitor.snapshot() });
});

// AI routes (advanced-ai, agent, micro) were removed in 1.0.0.
// The repair agent's internal learning still runs; only the external
// AI-facing API surface was retired until the new AI ships.

app.get('/api/world-converter/status', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (_req, res) => {
  res.json({ converter: worldConverter.status() });
});

app.post('/api/world-converter/install', requirePermission(capabilities.SETTINGS_MANAGE, permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner can install the world converter.' });
  res.json({ converter: await worldConverter.install() });
}));

app.get('/api/fixed/logs', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  pruneFixedLogs();
  const logs = db.prepare(`
    SELECT fixed.id, fixed.server_id, fixed.category, fixed.title, fixed.detail,
      fixed.source, fixed.actor_user_id, fixed.actor_name, fixed.created_at, server.name AS server_name
    FROM fixed_logs fixed
    LEFT JOIN servers server ON server.id = fixed.server_id
    ORDER BY fixed.created_at DESC
    LIMIT 200
  `).all().map((row) => ({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name || '',
    category: row.category,
    title: row.title,
    detail: row.detail,
    source: row.source,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name || 'System',
    createdAt: row.created_at,
  }));
  res.json({
    retentionDays: 1,
    logs,
    consoleLogPolicy: {
      memoryLinesPerServer: 600,
      diskRotateBytes: 4 * 1024 * 1024,
      lagRisk: 'low',
    },
  });
});

// The repair-agent episode feedback route was removed in 1.0.0 along with the
// neural repair agent. Deterministic repair history is read-only.

function requireOwnerPassword(req) {
  const owner = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.user.id, 'owner');
  if (!owner || !verifyPassword(req.body.password, owner.password_hash)) {
    throw new Error('Owner password is required.');
  }
  return owner;
}

// The AI full-access command queue was removed in 1.0.0. Owner-approved host
// commands are no longer part of the panel; the deterministic repair engine
// only performs safe, in-root file operations.

app.post('/api/database/snapshot', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_ADMINS), (_req, res) => {
  const snapshot = backupDatabase({ force: true });
  databaseHealthStatus = { ...snapshot.verification, checkedAt: Date.now(), snapshotAt: Date.now() };
  res.json({ ok: true, created: snapshot.created, file: path.basename(snapshot.path), database: databaseHealthStatus });
});

app.post('/api/servers/:id/repair-preview', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const diagnostics = diagnoseRuntime(consoleLogs(server.id));
  const software = softwareForServer(server);
  const agent = await analyzeServerWithAgent(server, software, diagnostics);
  res.json({
    server: server.name,
    signature: crashSignature(server, software, null, null).signature.slice(0, 12),
    diagnostics,
    agent: publicAgentAnalysis(agent),
    knowledge: knowledgeStatus(),
    changesApplied: false,
  });
}));

app.post('/api/servers/:id/world-convert', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const source = getServerOr404(req.params.id, req.user);
  if (runtimeStatus(source.id) === 'online') throw new Error('Stop the source server before converting its world.');
  const targetType = String(req.body.targetType || '').toLowerCase() === 'java' ? 'java' : 'bedrock';
  if (targetType === source.type) throw new Error('Choose the opposite edition for conversion.');
  const sourceWorldPath = sourceWorldForConversion(source);
  const target = createConvertedServerRecord(source, targetType, req);
  try {
    appendLog(source.id, `[NexusPanel] World conversion started for new ${targetType} server ${target.name}.`);
    appendLog(target.id, `[NexusPanel] World conversion source: ${source.name}.`);
    const converted = await worldConverter.convert({
      sourceWorldPath,
      targetType,
      targetVersion: req.body.targetVersion || '',
      serverId: source.id,
    });
    const convertedRoot = findConvertedWorldRoot(converted.output);
    const targetWorldPath = await copyConvertedWorldIntoServer(convertedRoot, target);
    db.prepare(`
      UPDATE servers
      SET install_status = 'missing', install_progress = 100, install_message = ?
      WHERE id = ?
    `).run(`Converted world copied to ${displayPath(targetWorldPath)}. Install ${targetType === 'java' ? 'Java Vanilla' : 'Bedrock Dedicated Server'} from Software before starting.`, target.id);
    appendLog(source.id, `[NexusPanel] World conversion completed into ${target.name}.`);
    appendLog(target.id, `[NexusPanel] Converted world ready at ${displayPath(targetWorldPath)} using ${converted.format}.`);
    res.status(201).json({
      source: serverPayload(source, req),
      target: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(target.id), req),
      converter: worldConverter.status(),
      format: converted.format,
      note: 'Chunker conversion does not reliably preserve live entities or player inventories across editions. Put important player items into chests before converting.',
    });
  } catch (error) {
    db.prepare("UPDATE servers SET install_status = 'failed', install_progress = 0, install_message = ? WHERE id = ?")
      .run(error.message, target.id);
    appendLog(target.id, `[NexusPanel] World conversion failed: ${error.message}`);
    throw error;
  }
}));

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
  prepareServerIdForCreation(inserted.id);
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
  const executablePath = path.join(root, 'software', selectedSoftware.executable);
  const mark = writeProfile({ ...inserted, server_path: root }, root, null);
  db.prepare('UPDATE servers SET server_path = ?, executable_path = ?, nexus_mark_profile = ? WHERE id = ?')
    .run(root, executablePath, JSON.stringify(mark), inserted.id);
  const provisioned = db.prepare('SELECT * FROM servers WHERE id = ?').get(inserted.id);
  writeServerMetadata(provisioned, root);
  res.status(201).json({ user: publicUser(user), server: serverPayload(provisioned, req) });
}));

app.post('/api/users', requirePermission(capabilities.ADMINS_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
  const assignAllServers = String(req.body.assignedServerId || '') === 'all';
  if (assignAllServers && !ownerOnly(req)) {
    return res.status(403).json({ error: 'Only the owner can assign every server.' });
  }
  const assignedServerId = assignAllServers ? 0 : Number(req.body.assignedServerId || 0);
  const assignedServer = assignedServerId
    ? db.prepare('SELECT * FROM servers WHERE id = ?').get(assignedServerId)
    : null;
  if (assignedServerId && !assignedServer) {
    return res.status(404).json({ error: 'Assigned server not found.' });
  }
  let user;
  try {
    user = createUser({
      email: req.body.email,
      name: req.body.name,
      password: req.body.password,
      role: 'admin',
      accessLevel: req.body.accessLevel,
      permissionKeys: grantablePermissionKeys(req.user, req.body.permissionKeys),
      expiresAt: adminExpiresAt(req.body),
    });
  } catch (error) {
    if (/UNIQUE constraint failed: users\.email/i.test(String(error.message))) {
      return res.status(409).json({ error: 'That email address is already registered.' });
    }
    return res.status(400).json({ error: error.message });
  }
  if (assignedServer && user.role !== 'owner') {
    db.prepare('UPDATE servers SET owner_user_id = ? WHERE id = ?').run(user.id, assignedServer.id);
  }
  if (assignAllServers && user.role !== 'owner') {
    db.prepare('UPDATE servers SET owner_user_id = ?').run(user.id);
  }
  const assignment = assignAllServers
    ? 'Granted access to all servers'
    : assignedServer
      ? `Granted access to ${assignedServer.name}`
      : 'No server assignment';
  logFixed({ category: 'admins', title: 'Admin account created', detail: `${user.name} · ${assignment}`, source: 'owner-action' });

  res.status(201).json({ user });
});

app.patch('/api/users/:id', requirePermission(capabilities.ADMINS_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
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
  const permissionKeys = target.role === 'owner'
    ? null
    : grantablePermissionKeys(req.user, req.body.permissionKeys ?? permissionKeysForUser(target));

  db.prepare(`
    UPDATE users
    SET name = ?, access_level = ?, permissions_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, accessLevel, permissionKeys === null ? null : JSON.stringify(permissionKeys), id);

  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

app.delete('/api/users/:id', requirePermission(capabilities.ADMINS_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
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
  const server = getServerOr404(req.params.id, req.user);
  if (!server) return res.status(404).json({ error: 'Server not found.' });

  const minutes = backupIntervalMinutesFrom(server);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  res.json({
    ...serverPayload(server, req),
    backup_interval_hours: hours,
    backup_interval_minutes: mins,
    backup_interval_formatted: hours > 0 && mins > 0 ? `${hours}h ${mins}m` : hours > 0 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${mins} minute${mins > 1 ? 's' : ''}`,
    next_backup_at: server.scheduled_backups ? new Date(nextScheduledBackupAt(server)).toISOString() : null
  });
});

app.get('/api/software/catalog', requireAuth, (_req, res) => {
  res.json({ software: softwareCatalog() });
});

app.get('/api/software/:key/versions', requireAuth, asyncRoute(async (req, res) => {
  res.json({ versions: await softwareVersions(req.params.key) });
}));

app.post('/api/software/check-updates', requirePermission(capabilities.SOFTWARE_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (_req, res) => {
  clearSoftwareVersionCache();
  const versions = Object.fromEntries(await Promise.all(softwareCatalog().map(async (item) => [
    item.key,
    await softwareVersions(item.key).catch(() => []),
  ])));
  res.json({ checkedAt: Date.now(), versions });
}));

app.get('/api/templates', requireAuth, (_req, res) => {
  res.json({ templates: templateRows(), nexuSchemaVersion: 1, example: nexuExample() });
});

app.post('/api/templates/import', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
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

app.get('/api/settings/update-status', requirePermission(capabilities.SETTINGS_MANAGE, permissions.MANAGE_ADMINS), (_req, res) => {
  res.json({ update: updateStatus });
});

app.get('/api/tunnels/normal-plan', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  if (isHostEdition()) return res.status(404).json({ error: 'Normal-edition tunnel setup is not available in host edition.' });
  const server = req.query.serverId ? getServerOr404(req.query.serverId, req.user) : null;
  const protocol = tunnelProtocolForServer(server, req.query.protocol);
  const port = ['http', 'https'].includes(protocol) ? Number(req.query.port || 3000) : Number(server?.port || 25565);
  const ngrok = server ? await ngrokStatus(server) : { installed: commandExists('ngrok'), binary: commandExists('ngrok') ? resolveCommand('ngrok') : '', running: false, publicUrl: '', remoteHost: '', protocol };
  const playit = playitStatus();
  res.json({
    server: server ? { id: server.id, name: server.name, type: server.type, port } : null,
    ngrok: {
      configured: Boolean(settingValue('ngrok_auth_token', '')),
      installed: ngrok.installed,
      binary: ngrok.binary,
      running: ngrok.running,
      protocol,
      publicUrl: ngrok.publicUrl,
      remoteHost: ngrok.remoteHost,
      command: `ngrok ${protocol} ${port}`,
      note: ['http', 'https'].includes(protocol)
        ? `This exposes the panel web port ${port}. Use HTTPS/HTTP only for the website, not Minecraft gameplay.`
        : server?.type === 'bedrock' && protocol === 'tcp'
        ? 'This server is Bedrock, so public gameplay needs UDP. TCP ngrok can start but Bedrock clients will not connect through it.'
        : protocol === 'udp'
        ? 'Bedrock uses UDP. ngrok UDP requires an ngrok plan/account that supports UDP endpoints; Playit is usually easier for Bedrock.'
        : 'Java normally uses TCP. Save the ngrok token, then start the tunnel from this panel.',
    },
    playit: {
      enabled: settingValue('playit_enabled', '0') === '1',
      installed: playit.installed,
      binary: playit.binary,
      running: playit.running,
      serviceEnabled: playit.enabled,
      setupUrl: playit.setupUrl || 'https://playit.gg/account/agents',
      setupLinks: playit.setupLinks || [],
      command: 'playit',
      note: playit.message,
    },
  });
}));

app.post('/api/tunnels/ngrok/start', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const protocol = tunnelProtocolForServer(null, req.body.protocol || req.query.protocol);
  const server = ['http', 'https'].includes(protocol) && !Number(req.body.serverId || req.query.serverId)
    ? { id: 0, name: 'NexusPanel website', type: 'panel', port: Number(req.body.port || req.query.port || port || 3000) }
    : getServerOr404(req.body.serverId || req.query.serverId, req.user);
  res.json({ ngrok: await startNgrokTunnel(server, protocol) });
}));

app.post('/api/tunnels/ngrok/stop', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const protocol = tunnelProtocolForServer(null, req.body.protocol || req.query.protocol);
  const server = ['http', 'https'].includes(protocol) && !Number(req.body.serverId || req.query.serverId)
    ? { id: 0, name: 'NexusPanel website', type: 'panel', port: Number(req.body.port || req.query.port || port || 3000) }
    : getServerOr404(req.body.serverId || req.query.serverId, req.user);
  stopTunnelProcess('ngrok', server.id);
  res.json({ ngrok: await ngrokStatus(server) });
}));

app.get('/api/tunnels/ngrok/status', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = req.query.serverId ? getServerOr404(req.query.serverId, req.user) : null;
  res.json({ ngrok: await ngrokStatus(server) });
}));

app.post('/api/tunnels/ngrok/install', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner can install VPS tunnel software.' });
  res.json({ ngrok: await installNgrokAgent() });
}));

app.post('/api/tunnels/playit/install', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_ADMINS), asyncRoute(async (_req, res) => {
  if (!ownerOnly(_req)) return res.status(403).json({ error: 'Only the owner can install VPS tunnel software.' });
  res.json({ playit: await installPlayitAgent() });
}));

app.post('/api/tunnels/playit/start', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (_req, res) => {
  res.json({ playit: await startPlayitAgent() });
}));

app.post('/api/tunnels/playit/claim-terminal/start', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner can run the Playit claim terminal.' });
  res.json({ terminal: await startPlayitClaimTerminal(), playit: playitStatus() });
}));

app.get('/api/tunnels/playit/claim-terminal/status', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner can view the Playit claim terminal.' });
  res.json({ terminal: playitClaimTerminalPayload(), playit: playitStatus() });
});

app.post('/api/tunnels/playit/stop', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (_req, res) => {
  res.json({ playit: await stopPlayitAgent() });
}));

app.get('/api/tunnels/playit/status', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), (_req, res) => {
  res.json({ playit: playitStatus() });
});

app.get('/api/servers/:id/asf', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const nexu = parseJsonObject(server.nexu_payload);
  res.json({ profile: profileForServer(server, nexu), nexu });
});

app.post('/api/settings/asf/doctor', requirePermission(capabilities.SETTINGS_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
  if (!ownerOnly(req)) return res.status(403).json({ error: 'Only the owner can run the kernel isolation doctor.' });
  const status = kernelStatus({ refresh: true });
  logFixed({
    category: 'security',
    title: `ASF doctor: ${status.tier}`,
    detail: status.preflightPassed
      ? `Native kernel policy ${status.tier} passed with systemd ${status.systemdVersion}, cgroup v2 ${status.cgroupV2 ? 'active' : 'fallback'}, and native runtime active.`
      : `Launch blocked (native runtime required); ${status.failures?.[0]?.detail || status.reason || 'native ASF preflight unavailable'}`,
    source: 'asf-doctor',
  });
  res.json({ asf: status });
});

// ---------------------------------------------------------------------------
// Tebex rank-giving (payment gateway) — auto-config for the Tebex plugin
// ---------------------------------------------------------------------------

/**
 * Build the webhook URL the owner pastes into their Tebex webstore.
 * Uses the configured public base URL when set (so it works behind a reverse
 * proxy or when the store website lives on another domain), otherwise the
 * request's own origin.
 */
function tebexWebhookUrl(req, serverId) {
  const configuredBase = String(settingValue('public_base_url', process.env.NEXUSPANEL_PUBLIC_URL || '')).replace(/\/+$/, '');
  const base = configuredBase || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/tebex/webhook/${Number(serverId)}`;
}

app.get('/api/servers/:id/tebex', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  res.json({ tebex: { ...tebex.tebexStatus(server.id), webhookUrl: tebexWebhookUrl(req, server.id) } });
});

app.post('/api/servers/:id/tebex/auto-config', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const result = await tebex.autoConfigureTebex(server, req.body.webstoreSecret, req.body.webhookSecret, req.body.webstoreToken);
  appendLog(server.id, `[NexusPanel] Tebex auto-config complete: webstore ${result.webstoreName || result.webstoreId}, ${result.packages} package(s), config at ${result.configPath}.`);
  res.json({ tebex: { ...tebex.tebexStatus(server.id), webhookUrl: tebexWebhookUrl(req, server.id) }, autoConfig: result });
}));

app.put('/api/servers/:id/tebex/webhook-secret', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  try {
    tebex.setWebhookSecret(server.id, req.body.webhookSecret);
    res.json({ tebex: { ...tebex.tebexStatus(server.id), webhookUrl: tebexWebhookUrl(req, server.id) } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/servers/:id/tebex/packages/:packageId/rank', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  tebex.setPackageRank(server.id, req.params.packageId, req.body.rank);
  res.json({ tebex: tebex.tebexStatus(server.id) });
});

app.put('/api/servers/:id/tebex/packages/:packageId/command', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  tebex.upsertPackageCommand(server.id, req.params.packageId, {
    command: req.body.command,
    delaySeconds: req.body.delaySeconds,
    onlineRequired: req.body.onlineRequired,
    enabled: req.body.enabled,
  });
  res.json({ tebex: tebex.tebexStatus(server.id) });
});

app.post('/api/servers/:id/tebex/payments', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  try {
    tebex.recordPayment(server.id, req.body || {});
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json({ tebex: tebex.tebexStatus(server.id) });
});

app.post('/api/servers/:id/tebex/payments/:transactionId/executed', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const payment = db.prepare('SELECT id, status FROM tebex_payments WHERE server_id = ? AND transaction_id = ?')
    .get(Number(server.id), String(req.params.transactionId || '').slice(0, 120));
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.status === 'executed') return res.json({ tebex: tebex.tebexStatus(server.id), alreadyExecuted: true });
  tebex.markPaymentExecuted(req.params.transactionId);
  res.json({ tebex: tebex.tebexStatus(server.id) });
});

app.delete('/api/servers/:id/tebex', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  tebex.removeTebex(server);
  appendLog(server.id, '[NexusPanel] Tebex integration removed.');
  res.json({ ok: true });
});

// Public webhook endpoint for Tebex's servers. Signature-verified (HMAC-SHA256
// over the raw body + webstore secret); unauthenticated by design.
app.post('/api/tebex/webhook/:serverId', (req, res) => {
  const serverId = Number(req.params.serverId);
  const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Webhook body must be raw bytes.' });
  try {
    const result = tebex.ingestWebhook(serverId, req.body, req.headers['x-signature'] || req.headers['x-tebex-signature']);
    if (result.ignored && result.reason === 'validation.webhook') {
      if (!result.id) return res.status(400).json({ error: 'Validation webhook is missing its id.' });
      return res.status(200).json({ id: result.id });
    }
    if (result.ok && !result.ignored) {
      appendLog(serverId, `[NexusPanel] Tebex payment received: ${result.event.username || 'unknown player'} — ${result.event.packageName} (${(result.event.priceCents / 100).toFixed(2)} ${result.event.currency}).`);
    }
    res.json(result);
  } catch (error) {
    res.status(Number(error.statusCode) || 400).json({ error: error.message });
  }
});

// Live read-only payment console (SSE). Streams payment events as they arrive.
app.get('/api/servers/:id/tebex/payments/stream', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const writeEvent = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  // Snapshot of recent history first, then live events.
  writeEvent('snapshot', { payments: tebex.tebexStatus(server.id).payments });
  const unsubscribe = tebex.subscribePaymentFeed(server.id, (payload) => writeEvent('payment', payload));
  const heartbeat = setInterval(() => writeEvent('ping', { at: Date.now() }), 15000);
  heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Database connections (Pterodactyl-style)
// ---------------------------------------------------------------------------
app.get('/api/databases/host', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  res.json({ host: hosting.databaseHostConfig() });
});

app.get('/api/databases', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  res.json({ connections: hosting.connectionRows(req.query.serverId ? Number(req.query.serverId) : null) });
});

app.post('/api/databases/provision', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.body.serverId, req.user);
  const connection = await hosting.provisionDatabase(server.id, req.body || {});
  logFixed({ category: 'database', title: 'Server database provisioned', detail: `${connection.name} → ${connection.host}:${connection.port}/${connection.database}`, source: 'owner-action' });
  res.status(201).json({ connection });
}));

app.get('/api/databases/:id/details', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const connection = hosting.connectionDetails(req.params.id);
  if (connection.serverId) getServerOr404(connection.serverId, req.user);
  res.json({ connection });
});

app.post('/api/databases/:id/rotate-password', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const existing = hosting.connectionRows().find((row) => row.id === Number(req.params.id));
  if (!existing) throw new Error('Connection not found.');
  if (existing.serverId) getServerOr404(existing.serverId, req.user);
  const connection = await hosting.rotateProvisionedPassword(req.params.id);
  logFixed({ category: 'database', title: 'Server database password rotated', detail: `${connection.name} password was rotated.`, source: 'owner-action' });
  res.json({ connection });
}));

app.post('/api/databases', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const connection = hosting.createConnection(req.body.serverId || null, req.body || {});
  logFixed({ category: 'database', title: 'Database connection created', detail: `${connection.name} → ${connection.host}:${connection.port}/${connection.database}`, source: 'owner-action' });
  res.status(201).json({ connection });
});

app.put('/api/databases/:id', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const connection = hosting.updateConnection(req.params.id, req.body || {});
  res.json({ connection });
});

app.delete('/api/databases/:id', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const existing = hosting.connectionRows().find((row) => row.id === Number(req.params.id));
  if (!existing) throw new Error('Connection not found.');
  if (existing.serverId) getServerOr404(existing.serverId, req.user);
  await hosting.deleteProvisionedDatabase(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/databases/:id/test', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  res.json({ test: await hosting.testConnection(req.params.id) });
}));

// ---------------------------------------------------------------------------
// Network allocations (Pterodactyl-style ports/IPs)
// ---------------------------------------------------------------------------
app.get('/api/network/allocations', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  res.json({ allocations: hosting.allocationRows(req.query.serverId ? Number(req.query.serverId) : null) });
});

app.post('/api/network/allocations', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const serverId = req.body.serverId ? Number(req.body.serverId) : null;
  if (serverId) getServerOr404(serverId, req.user);
  const allocation = hosting.createAllocation(serverId, req.body || {});
  logFixed({ category: 'network', title: 'Network allocation created', detail: `${allocation.ip}:${allocation.port} (${allocation.protocol})`, source: 'owner-action' });
  res.status(201).json({ allocation });
});

app.post('/api/network/allocations/:id/make-game-port', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const allocation = hosting.allocationRows().find((item) => item.id === Number(req.params.id));
  if (!allocation) return res.status(404).json({ error: 'Allocation not found.' });
  if (!allocation.serverId) return res.status(400).json({ error: 'Assign the allocation to a server first.' });
  const server = getServerOr404(allocation.serverId, req.user);
  const port = hosting.gamePortFromAllocation(server, allocation);
  if (runtimeStatus(server.id) !== 'offline') {
    return res.status(409).json({ error: 'Stop the server before changing its game port.' });
  }
  const collision = db.prepare(`
    SELECT id, name FROM servers
    WHERE port = ? AND id != ?
    LIMIT 1
  `).get(port, server.id);
  if (collision) return res.status(409).json({ error: `Port ${port} is already used by ${collision.name || `server #${collision.id}`}.` });

  await safeTimelinePoint(server, req, 'Before game port change', `Captured server state before changing the game port to ${port}.`);
  const previousPort = Number(server.port);
  if (port !== previousPort) {
    db.prepare('UPDATE servers SET port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(port, server.id);
    const updatedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    try {
      await writeProfile(updatedServer);
      await writeProperties(updatedServer, { 'server-port': String(port) });
      const verified = await readProperties(updatedServer);
      if (Number(verified['server-port']) !== port) throw new Error('server.properties did not retain the selected game port.');
    } catch (error) {
      db.prepare('UPDATE servers SET port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(previousPort, server.id);
      const restoredServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
      const rollbackErrors = [];
      try {
        await writeProfile(restoredServer);
      } catch (rollbackError) {
        rollbackErrors.push(`ASF profile: ${rollbackError.message}`);
      }
      try {
        await writeProperties(restoredServer, { 'server-port': String(previousPort) });
      } catch (rollbackError) {
        rollbackErrors.push(`server.properties: ${rollbackError.message}`);
      }
      if (rollbackErrors.length) {
        throw new Error(`Game port change failed (${error.message}) and rollback was incomplete (${rollbackErrors.join('; ')}).`);
      }
      throw new Error(`Game port change failed and was rolled back: ${error.message}`);
    }
    appendLog(server.id, `[NexusPanel] Game port changed from ${previousPort} to ${port} using allocation ${allocation.ip}:${allocation.port}. Restart the server to apply it.`);
  }
  const updatedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
  res.json({ ok: true, server: serverPayload(updatedServer, req), allocation });
}));

app.delete('/api/network/allocations/:id', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  hosting.deleteAllocation(req.params.id);
  res.json({ ok: true });
});

app.post('/api/network/allocations/:id/probe', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  res.json({ probe: await hosting.probeAllocation(req.params.id) });
}));

app.put('/api/settings', requirePermission(capabilities.SETTINGS_MANAGE, permissions.MANAGE_ADMINS), (req, res) => {
  setSettingValue('asf_enabled', toBool(req.body.asfEnabled, true) ? '1' : '0');
  setSettingValue('repair_agent_terminal_enabled', toBool(req.body.repairAgentTerminalEnabled, true) ? '1' : '0');
  if (req.body.serverSwitcherVisibleCount !== undefined) {
    setSettingValue('server_switcher_visible_count', clampNumber(req.body.serverSwitcherVisibleCount, 1, 20, 3));
  }
  if (req.body.maxBackupSizeGb !== undefined) {
    setSettingValue('backup_max_size_gb', clampNumber(req.body.maxBackupSizeGb, 1, 100, 20));
  }
  if (req.body.timeZone) setUserTimezone(req.user.id, String(req.body.timeZone));
  const publicBaseUrl = String(req.body.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (publicBaseUrl) {
    const parsed = new URL(publicBaseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return res.status(400).json({ error: 'Public panel URL must be HTTP or HTTPS without embedded credentials.' });
    }
  }
  setSettingValue('public_base_url', publicBaseUrl);
  if (!isHostEdition()) {
    const token = String(req.body.ngrokAuthToken || '').trim();
    if (token) setSettingValue('ngrok_auth_token', token);
    setSettingValue('playit_enabled', toBool(req.body.playitEnabled) ? '1' : '0');
  }
  if (isHostEdition()) {
    setSettingValue('host_maintenance_mode', toBool(req.body.hostMaintenanceMode) ? '1' : '0');
    setSettingValue('host_server_quota', clampNumber(req.body.hostServerQuota, 1, 500, 10));
  }
  const updateTag = String(req.body.updateTargetTag || req.body.updateTag || panelSettingsPayload(req.user).updateTag).trim();
  if (/^(?:(?:normal|host)-)?v\d+\.\d+(?:\.\d+)?$/.test(updateTag)) setSettingValue('update_target_tag', updateTag);
  setSettingValue('update_repo', FIXED_UPDATE_REPO);
  res.json({ settings: panelSettingsPayload(req.user) });
});

app.post('/api/settings/update', requirePermission(capabilities.SETTINGS_MANAGE, permissions.MANAGE_ADMINS), asyncRoute(async (req, res) => {
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
  const updateTag = /^(?:(?:normal|host)-)?v\d+\.\d+(?:\.\d+)?$/.test(requestedTag) ? requestedTag : panelSettingsPayload(req.user).updateTag;
  setSettingValue('update_target_tag', updateTag);
  const runtimeBin = path.dirname(process.execPath);
  const runtimePath = [runtimeBin, process.env.PATH].filter(Boolean).join(path.delimiter);
  const child = spawn('bash', [script, repo], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PATH: runtimePath,
      NEXUSPANEL_WEB_UPDATE: '1',
      NEXUSPANEL_UPDATE_TAG: updateTag,
    },
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
  let finalized = false;
  const finishUpdate = async (code, spawnError = null) => {
    if (finalized) return;
    finalized = true;
    const logOutput = spawnError
      ? `${output}\n[NexusPanel] Could not start updater: ${spawnError.message}\n`
      : output;
    try {
      await fs.promises.mkdir(dataRoot, { recursive: true });
      await fs.promises.writeFile(path.join(dataRoot, 'last_update.log'), logOutput.slice(-12000), 'utf8');
    } catch (error) {
      console.error('Could not persist NexusPanel update log:', error);
    }
    updateStatus = {
      running: false,
      progress: code === 0 ? 100 : updateStatus.progress,
      message: code === 0
        ? 'Update complete. Restarting service if configured.'
        : `Update failed with exit ${code ?? 1}. Check data/last_update.log.`,
      startedAt: updateStatus.startedAt,
      finishedAt: Date.now(),
      exitCode: code ?? 1,
    };
    if (code !== 0) console.error(`NexusPanel update failed with code ${code ?? 1}`);
  };
  child.once('error', (error) => { void finishUpdate(1, error); });
  child.once('close', (code) => { void finishUpdate(code); });
  res.json({ ok: true, message: `Update started for ${panelSettingsPayload(req.user).updateTag}. Protected folders stay untouched.`, repo });
}));

function closeWakeWatcher(serverId) {
  const watcher = wakeWatchers.get(serverId);
  if (!watcher) return Promise.resolve();
  wakeWatchers.delete(serverId);
  return new Promise((resolve) => {
    try {
      if (watcher.protocol === 'udp') {
        watcher.handle.close(resolve);
      } else if (watcher.handle.listening) {
        watcher.handle.close(resolve);
      } else {
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

function decodeMinecraftVarInt(buffer, offset = 0) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset + index >= buffer.length) return null;
    const byte = buffer[offset + index];
    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) return { value: value >>> 0, bytes: index + 1 };
  }
  return null;
}

function encodeMinecraftVarInt(value) {
  let remaining = Number(value) >>> 0;
  const bytes = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function frameMinecraftPacket(packet) {
  return Buffer.concat([encodeMinecraftVarInt(packet.length), packet]);
}

function minecraftString(value) {
  const content = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeMinecraftVarInt(content.length), content]);
}

function parseWakeHandshake(packet) {
  const packetId = decodeMinecraftVarInt(packet);
  if (!packetId || packetId.value !== 0) return null;
  let cursor = packetId.bytes;
  const protocol = decodeMinecraftVarInt(packet, cursor);
  if (!protocol) return null;
  cursor += protocol.bytes;
  const addressLength = decodeMinecraftVarInt(packet, cursor);
  if (!addressLength || addressLength.value > 255) return null;
  cursor += addressLength.bytes + addressLength.value;
  if (cursor + 2 > packet.length) return null;
  cursor += 2; // Server port.
  const nextState = decodeMinecraftVarInt(packet, cursor);
  if (!nextState || ![1, 2].includes(nextState.value)) return null;
  return { protocol: protocol.value, nextState: nextState.value };
}

function wakeJavaStatusPacket(protocol) {
  const response = {
    version: { name: 'Starting server...', protocol },
    players: { max: 20, online: 0, sample: [] },
    description: { text: 'Starting server... Please reconnect in a moment.' },
  };
  return frameMinecraftPacket(Buffer.concat([
    encodeMinecraftVarInt(0),
    minecraftString(JSON.stringify(response)),
  ]));
}

function wakeJavaDisconnectPacket() {
  return frameMinecraftPacket(Buffer.concat([
    encodeMinecraftVarInt(0),
    minecraftString(JSON.stringify({ text: 'Starting server... Please reconnect in a moment.' })),
  ]));
}

const raknetMagic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const wakeBedrockGuid = crypto.randomBytes(8);

function wakeBedrockPong(packet, server) {
  if (packet.length < 33 || ![0x01, 0x02].includes(packet[0]) || !packet.subarray(9, 25).equals(raknetMagic)) return null;
  const guid = wakeBedrockGuid.readBigUInt64BE().toString();
  const maxPlayers = Math.max(1, Number(server.max_players) || 20);
  const message = [
    'MCPE', 'Starting server...', '0', 'Starting', '0', String(maxPlayers), guid,
    'Please reconnect in a moment', 'Survival', '1', String(server.port), String(server.port), '',
  ].join(';');
  const encodedMessage = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(encodedMessage.length);
  return Buffer.concat([
    Buffer.from([0x1c]), packet.subarray(1, 9), wakeBedrockGuid, raknetMagic, length, encodedMessage,
  ]);
}

function refreshWakeWatchers() {
  // Auto-start controls panel boot behavior; it must not disable wake-on-join
  // after an operator stops a server manually.
  const servers = db.prepare('SELECT * FROM servers WHERE wake_on_join = 1').all();
  const wanted = new Set();
  for (const server of servers) {
    wanted.add(server.id);
    if (wakeStarting.has(server.id)) continue;
    if (runtimeStatus(server.id) === 'online') {
      closeWakeWatcher(server.id);
      continue;
    }
    if (wakeWatchers.has(server.id)) continue;
    const software = softwareForServer(server);
    if (!software) continue;
    const protocol = server.type === 'java' ? 'tcp' : 'udp';
    let wakeStarted = false;
    const start = async () => {
      if (wakeStarted) return;
      wakeStarted = true;
      wakeStarting.add(server.id);
      try {
        // The game server must bind this same port. Wait for the watcher to
        // finish closing before spawning it, otherwise its bind can fail with
        // EADDRINUSE while Node is still draining the accepted connection.
        await closeWakeWatcher(server.id);
        appendLog(server.id, '[NexusPanel] Wake-on-join packet detected. Starting server...');
        if (['java', 'bedrock'].includes(server.type)) await repairPropertiesFile(server);
        startServer(resolveInstalledExecutable(server, software), software);
      } catch (error) {
        appendLog(server.id, `[NexusPanel] Wake-on-join failed: ${error.message}`);
      } finally {
        wakeStarting.delete(server.id);
        // If launch failed, put the wake listener back immediately so the
        // server port never stays closed until the maintenance timer runs.
        refreshWakeWatchers();
      }
    };
    if (protocol === 'udp') {
      const socket = require('node:dgram').createSocket('udp4');
      socket.once('message', (packet, remote) => {
        const pong = wakeBedrockPong(packet, server);
        if (!pong) {
          void start();
          return;
        }
        socket.send(pong, remote.port, remote.address, () => { void start(); });
      });
      socket.on('error', (error) => {
        appendLog(server.id, `[NexusPanel] Wake UDP listener failed: ${error.message}`);
        closeWakeWatcher(server.id);
      });
      socket.once('listening', () => {
        appendLog(server.id, `[NexusPanel] Wake-on-join is listening on UDP ${server.port}.`);
      });
      socket.bind(server.port, '0.0.0.0');
      wakeWatchers.set(server.id, { handle: socket, protocol });
    } else {
      const listener = require('node:net').createServer((socket) => {
        let pending = Buffer.alloc(0);
        let handshake = null;
        let closing = false;
        const closeAfterReply = (reply) => {
          if (closing) return;
          closing = true;
          if (reply) socket.end(reply, () => socket.destroy());
          else socket.destroy();
        };
        socket.setTimeout(3000, () => closeAfterReply());
        socket.on('close', () => {
          if (handshake) void start();
        });
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
          if (closing) return;
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > 8192) return closeAfterReply();
          while (pending.length) {
            const frameLength = decodeMinecraftVarInt(pending);
            if (!frameLength) return;
            if (frameLength.value > 8192) return closeAfterReply();
            const frameStart = frameLength.bytes;
            const frameEnd = frameStart + frameLength.value;
            if (pending.length < frameEnd) return;
            const packet = pending.subarray(frameStart, frameEnd);
            pending = pending.subarray(frameEnd);
            if (!handshake) {
              handshake = parseWakeHandshake(packet);
              if (!handshake) return closeAfterReply();
              if (handshake.nextState === 2) return closeAfterReply(wakeJavaDisconnectPacket());
              continue;
            }
            const packetId = decodeMinecraftVarInt(packet);
            if (!packetId) continue;
            if (packetId.value === 0) {
              socket.write(wakeJavaStatusPacket(handshake.protocol));
            } else if (packetId.value === 1) {
              closeAfterReply(frameMinecraftPacket(Buffer.concat([
                encodeMinecraftVarInt(1), packet.subarray(packetId.bytes),
              ])));
              return;
            } else {
              closeAfterReply();
              return;
            }
          }
        });
      });
      listener.on('error', (error) => {
        appendLog(server.id, `[NexusPanel] Wake TCP listener failed: ${error.message}`);
        closeWakeWatcher(server.id);
      });
      listener.once('listening', () => {
        appendLog(server.id, `[NexusPanel] Wake-on-join is listening on TCP ${server.port}.`);
      });
      listener.listen(server.port, '0.0.0.0');
      wakeWatchers.set(server.id, { handle: listener, protocol });
    }
  }
  for (const id of [...wakeWatchers.keys()]) {
    if (!wanted.has(id)) closeWakeWatcher(id);
  }
}

app.post('/api/servers', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Server name is required.' });
  const type = req.body.type === 'java' ? 'java' : 'bedrock';
  const selectedSoftware = findSoftware(req.body.softwareKey) || defaultSoftware(type);
  if (!selectedSoftware || selectedSoftware.edition !== type) {
    return res.status(400).json({ error: 'Selected software is not compatible with this server type.' });
  }
  const startupFlags = String(req.body.startupFlags || '');
  try { parseJavaStartupFlags(startupFlags); } catch (error) { return res.status(400).json({ error: error.message }); }

  const ownerUserId = ownerOnly(req) ? resolveServerOwnerUserId(req, req.body.ownerUserId, null) : req.user.id;
  assertHostServerQuota(ownerUserId);
  const result = db.prepare(`
    INSERT INTO servers (
      name, type, port, max_memory_mb, auto_start, auto_restart, crash_backup,
      scheduled_backups, backup_interval_hours, backup_interval_minutes, backup_retention, wake_on_join, whitelist,
      tunnel_provider, public_alias, startup_delay_sec, startup_flags, software_key, software_version, cpu_cores, disk_limit_mb, owner_user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    startupFlags,
    selectedSoftware.key,
    String(req.body.softwareVersion || 'latest').trim().slice(0, 32) || 'latest',
    clampNumber(req.body.cpuCores, 1, hostCpuCount(), 1),
    0,
    ownerUserId,
  );

  const inserted = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
  setSettingValue(`server_backup_timezone_${inserted.id}`, getUserTimezone(req.user.id));
  prepareServerIdForCreation(inserted.id);
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
  const executablePath = path.join(root, 'software', selectedSoftware.executable);
  const mark = writeProfile({ ...inserted, server_path: root }, root, null);
  db.prepare('UPDATE servers SET server_path = ?, executable_path = ?, nexus_mark_profile = ? WHERE id = ?').run(root, executablePath, JSON.stringify(mark), inserted.id);
  const created = db.prepare('SELECT * FROM servers WHERE id = ?').get(inserted.id);
  writeServerMetadata(created, root);
  res.status(201).json({ server: serverPayload(created) });
});

app.post('/api/templates/:key/create', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
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
  prepareServerIdForCreation(inserted.id);
  const root = ensureServerDirs({ ...inserted, server_path: serverPath(inserted.id, inserted.name) });
  setSettingValue(`server_backup_timezone_${inserted.id}`, getUserTimezone(req.user.id));
  const executablePath = selectedSoftware ? path.join(root, 'software', selectedSoftware.executable) : '';
  const mark = writeProfile({ ...inserted, server_path: root, max_memory_mb: memoryMb, cpu_cores: cpuCores, disk_limit_mb: nexu.resources.diskMb }, root, nexu);
  db.prepare('UPDATE servers SET server_path = ?, executable_path = ?, nexus_mark_profile = ? WHERE id = ?').run(root, executablePath, JSON.stringify(mark), inserted.id);
  const created = db.prepare('SELECT * FROM servers WHERE id = ?').get(inserted.id);
  writeServerMetadata(created, root);
  appendLog(inserted.id, `[NexusPanel] Created from Nexu template: ${nexu.name}. ASF profile ready.`);
  res.status(201).json({ server: serverPayload(created) });
});

app.patch('/api/servers/:id', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
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
  const cpuCores = ownerOnly(req)
    ? clampNumber(req.body.cpuCores, 1, hostCpuCount(), target.cpu_cores || 1)
    : target.cpu_cores;
  const ownerUserId = ownerOnly(req)
    ? resolveServerOwnerUserId(req, req.body.ownerUserId, target.owner_user_id)
    : target.owner_user_id;
  const startupFlags = String(req.body.startupFlags ?? target.startup_flags ?? '');
  try { parseJavaStartupFlags(startupFlags); } catch (error) { return res.status(400).json({ error: error.message }); }

  db.prepare(`
    UPDATE servers
    SET name = ?, type = ?, port = ?, max_memory_mb = ?, auto_start = ?,
        auto_restart = ?, crash_backup = ?, scheduled_backups = ?,
        backup_interval_hours = ?, backup_interval_minutes = ?, backup_retention = ?, wake_on_join = ?, whitelist = ?,
        tunnel_provider = ?, public_alias = ?, startup_delay_sec = ?, startup_flags = ?,
        server_path = ?, software_key = ?, software_version = ?, executable_path = ?,
        owner_user_id = ?, cpu_cores = ?
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
    startupFlags,
    root,
    selectedSoftware ? selectedSoftware.key : target.software_key,
    String(req.body.softwareVersion ?? target.software_version ?? 'latest').trim().slice(0, 32) || 'latest',
    executablePath,
    ownerUserId,
    cpuCores,
    id,
  );
  setSettingValue(`server_backup_timezone_${id}`, getUserTimezone(ownerUserId || req.user.id));
  let updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  const mark = writeProfile(updated, root, parseJsonObject(updated.nexu_payload));
  db.prepare('UPDATE servers SET nexus_mark_profile = ? WHERE id = ?').run(JSON.stringify(mark), id);
  updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  writeServerMetadata(updated, root);
  refreshWakeWatchers();
  res.json({ server: serverPayload(updated) });
});

app.delete('/api/servers/:id', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (runtimeStatus(server.id) === 'online') return res.status(400).json({ error: 'Stop the server before deleting it.' });
  const root = assertInside(serversRoot, server.server_path || serverPath(server.id, server.name));
  setSettingValue(serverTombstoneKey(server.id), JSON.stringify({ deletedAt: Date.now(), root }));
  const pendingRestart = crashRestartTimers.get(server.id);
  if (pendingRestart) clearTimeout(pendingRestart);
  crashRestartTimers.delete(server.id);
  crashHistory.delete(server.id);
  closeWakeWatcher(server.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
  serverSizeCache.delete(Number(server.id));
  const removalError = await fs.promises.rm(assertInside(serversRoot, root), { recursive: true, force: true })
    .then(() => null)
    .catch((error) => error);
  const identityCleanup = removalError ? { removed: false, reason: 'server-cleanup-pending' } : removeServerIdentity(server.id);
  db.prepare('DELETE FROM panel_settings WHERE key = ?').run(`server_backup_timezone_${server.id}`);
  await fs.promises.rm(assertInside(backupsRoot, path.join(backupsRoot, String(server.id))), { recursive: true, force: true }).catch(() => {});
  appendLog(server.id, '[NexusPanel] Server deleted.');
  res.json({ ok: true, cleanupPending: Boolean(removalError), identityCleanup });
}));

app.patch('/api/servers/:id/software', requirePermission(capabilities.SOFTWARE_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
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

app.post('/api/servers/:id/software/install', requirePermission(capabilities.SOFTWARE_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const target = getServerOr404(id, req.user);

  const selectedSoftware = findSoftware(req.body.softwareKey || target.software_key) || defaultSoftware(target.type);
  if (!selectedSoftware && target.nexu_payload) {
    // Nexu templates can carry arbitrary installer shell commands. Running them
    // is a host-level code-execution primitive, so it is gated to the owner.
    if (!ownerOnly(req)) {
      return res.status(403).json({ error: 'Only the owner can run Nexu template installer commands.' });
    }
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
const executablePath = path.join(root, selectedSoftware.executable);

// Ensure the server root exists
await fs.promises.mkdir(path.dirname(executablePath), { recursive: true });

const downloadPath = selectedSoftware.key === 'forge'
  ? path.join(root, 'runtime', 'forge-installer.jar')
  : selectedSoftware.key === 'bedrock-vanilla'
  ? path.join(root, 'software', `${selectedSoftware.folder}.zip`)
  : executablePath;  // ✅ Download directly to server root

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
    await ensureSoftwareRequirements(selectedSoftware, id, (progress, message) => {
      db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?').run(progress, message, id);
    }, download.version || version, root);
    if (selectedSoftware.key === 'pocketmine') {
      await installPocketMineRuntime(root, id, (progress, message) => {
        db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?').run(progress, message, id);
      });
    }
    const baseProgress = selectedSoftware.key === 'pocketmine' ? 55 : 18;
    db.prepare('UPDATE servers SET software_version = ?, install_progress = ?, install_message = ? WHERE id = ?')
      .run(download.version, baseProgress, `Downloading ${selectedSoftware.name} ${download.version}`, id);
    if (selectedSoftware.key === 'forge') {
      await installForgeServer(root, id, download, executablePath, (progress, message) => {
        db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?').run(progress, message, id);
      });
    } else {
      await downloadToFile(download.url, downloadPath, (progress) => {
        db.prepare('UPDATE servers SET install_progress = ?, install_message = ? WHERE id = ?')
          .run(selectedSoftware.key === 'pocketmine' ? Math.max(55, Math.min(98, 55 + Math.round(progress * 0.43))) : Math.max(18, progress), `Downloading ${selectedSoftware.name} ${download.version}`, id);
      });
    }
    if (['java-vanilla', 'paper', 'purpur', 'fabric'].includes(selectedSoftware.key)) {
      // ✅ FIXED: Verify the download exists and is valid in the server root
      await verifyJarDownload(executablePath, selectedSoftware.name);
      // No copy needed - it's already in the right place!
    }
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

app.get('/api/servers/:id/plugins', requirePermission(capabilities.PLUGINS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });
  res.json({ plugins: reconcilePluginFiles(id) });
});

app.post('/api/servers/:id/plugins', requirePermission(capabilities.PLUGINS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
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
  await safeTimelinePoint(target, req, 'Before plugin registration', `Captured state before registering ${fileName}.`);
  const name = String(req.body.name || fileName.replace(/\.[^.]+$/, '')).trim().slice(0, 80);
  const result = db.prepare(`
    INSERT INTO plugins (server_id, name, kind, file_name, relative_path, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, kind, fileName, targetPath.relativePath, toBool(req.body.enabled, true));

  res.status(201).json({
    plugin: pluginRows(id).find((plugin) => plugin.id === result.lastInsertRowid),
    targetPath: displayPath(targetPath.absolutePath),
  });
}));

app.get('/api/modrinth/search', requireAuth, asyncRoute(async (req, res) => {
  const server = req.query.serverId ? getServerOr404(req.query.serverId, req.user) : null;
  const software = server ? (findSoftware(server.software_key) || defaultSoftware(server.type)) : null;
  if (software && !['paper', 'purpur', 'fabric', 'forge'].includes(software.key)) {
    return res.json({ hits: [], source: 'modrinth', message: 'Modrinth installs are available for Paper/Purpur plugins and Fabric/Forge mods.' });
  }
  const modded = ['fabric', 'forge'].includes(software?.key);
  const loader = modded
    ? software.key
    : ['paper', 'purpur'].includes(software?.key)
      ? 'paper'
      : String(req.query.loader || '').trim().toLowerCase();
  const projectType = modded ? 'mod' : 'plugin';
  const version = String(req.query.version || server?.software_version || '').trim();
  const selectedLoader = String(req.query.loader || '').trim().toLowerCase();
  const query = String(req.query.query || '').trim();
  const facets = [[`project_type:${projectType}`], ['server_side:required', 'server_side:optional']];
  if (loader) facets.push([`categories:${selectedLoader || loader}`]);
  if (version && !['latest', 'manual'].includes(version)) facets.push([`versions:${version}`]);

  const params = new URLSearchParams({
    query,
    limit: '24',
    // Relevance ranks a directly matching project name ahead of popular but
    // unrelated plugins (e.g. "Geyser" should not be buried by download count).
    index: query ? 'relevance' : 'downloads',
    facets: JSON.stringify(facets),
  });
  const response = await fetch(`https://api.modrinth.com/v2/search?${params}`, {
    headers: { 'User-Agent': 'NexusPanel/2.0 (+https://github.com/Sarvesh12341234/Nexus-panel)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error(`Modrinth search returned HTTP ${response.status}. Try again shortly.`);
    error.statusCode = 502;
    throw error;
  }
  const data = await response.json();
  res.json({
    source: 'modrinth',
    projectType,
    loader,
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

app.get('/api/modrinth/versions', requireAuth, asyncRoute(async (req, res) => {
  const server = getServerOr404(req.query.serverId, req.user);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  if (!['paper', 'purpur', 'fabric', 'forge'].includes(software.key)) {
    return res.status(400).json({ error: 'Modrinth versions are unavailable for this server software.' });
  }
  const projectId = String(req.query.projectId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) return res.status(400).json({ error: 'Invalid Modrinth project id.' });
  const modded = ['fabric', 'forge'].includes(software.key);
  const allowedLoaders = modded ? [software.key] : ['paper', 'spigot', 'bukkit', 'purpur'];
  const loader = String(req.query.loader || (modded ? software.key : 'paper')).trim().toLowerCase();
  if (!allowedLoaders.includes(loader)) return res.status(400).json({ error: 'Selected loader is incompatible with this server.' });
  const gameVersion = String(req.query.gameVersion || server.software_version || '').trim();
  const params = new URLSearchParams({ loaders: JSON.stringify([loader]) });
  if (gameVersion && !['latest', 'manual'].includes(gameVersion)) params.set('game_versions', JSON.stringify([gameVersion]));
  const response = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${params}`, {
    headers: { 'User-Agent': 'NexusPanel/1.0' },
  });
  if (!response.ok) throw new Error(`Modrinth versions failed: ${response.status}`);
  const versions = await response.json();
  res.json({
    versions: versions.map((version) => ({
      id: version.id,
      name: version.name || version.version_number,
      versionNumber: version.version_number,
      gameVersions: version.game_versions || [],
      datePublished: version.date_published || '',
      files: (version.files || []).map((file) => ({ filename: file.filename, primary: Boolean(file.primary) })),
    })),
  });
}));

async function poggitReleases() {
  const response = await fetch('https://poggit.pmmp.io/releases.min.json', {
    headers: { 'User-Agent': 'NexusPanel/2.0 (+https://github.com/Sarvesh12341234/Nexus-panel)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error(`Poggit search returned HTTP ${response.status}. Try again shortly.`);
    error.statusCode = 502;
    throw error;
  }
  return response.json();
}

app.get('/api/poggit/search', requireAuth, asyncRoute(async (req, res) => {
  const server = req.query.serverId ? getServerOr404(req.query.serverId, req.user) : null;
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

app.post('/api/servers/:id/modrinth/install', requirePermission(capabilities.PLUGINS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  if (!['paper', 'purpur', 'fabric', 'forge'].includes(software.key)) {
    return res.status(400).json({ error: 'Modrinth install supports Paper/Purpur plugins and Fabric/Forge mods.' });
  }

  const projectId = String(req.body.projectId || '').trim();
  if (!projectId) return res.status(400).json({ error: 'Modrinth project id is required.' });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) return res.status(400).json({ error: 'Invalid Modrinth project id.' });
  const gameVersion = String(req.body.gameVersion || server.software_version || '').trim();
  const modded = ['fabric', 'forge'].includes(software.key);
  const allowedLoaders = modded ? [software.key] : ['paper', 'spigot', 'bukkit', 'purpur'];
  const loader = String(req.body.loader || (modded ? software.key : 'paper')).trim().toLowerCase();
  if (!allowedLoaders.includes(loader)) return res.status(400).json({ error: 'Selected loader is incompatible with this server.' });
  const versionId = String(req.body.versionId || '').trim();
  if (versionId && !/^[A-Za-z0-9_-]{1,64}$/.test(versionId)) return res.status(400).json({ error: 'Invalid Modrinth version id.' });
  const loaders = [loader];
  const params = new URLSearchParams({ loaders: JSON.stringify(loaders) });
  if (gameVersion && !['latest', 'manual'].includes(gameVersion)) params.set('game_versions', JSON.stringify([gameVersion]));

  const versionResponse = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${params}`, {
    headers: { 'User-Agent': 'NexusPanel/1.0' },
  });
  if (!versionResponse.ok) throw new Error(`Modrinth versions failed: ${versionResponse.status}`);
  const versions = await versionResponse.json();
  const selected = versionId ? versions.find((version) => version.id === versionId) : versions[0];
  if (versionId && !selected) return res.status(400).json({ error: 'That plugin release is not compatible with the selected loader and Minecraft version.' });
  const file = selected?.files?.find((item) => item.primary) || selected?.files?.[0];
  if (!file?.url || !file?.filename) throw new Error('No compatible Modrinth file found.');

  const target = pluginTarget(server, 'jar-plugin', file.filename);
  await downloadToFile(file.url, target.absolutePath, () => {});
  const name = String(req.body.name || selected.name || file.filename.replace(/\.jar$/i, '')).trim().slice(0, 80);
  const result = db.prepare(`
    INSERT INTO plugins (server_id, name, kind, file_name, relative_path, enabled)
    VALUES (?, ?, 'jar-plugin', ?, ?, 1)
  `).run(server.id, name, file.filename, target.relativePath);
  appendLog(server.id, `[NexusPanel] Installed Modrinth ${modded ? 'mod' : 'plugin'} ${name} (${selected.version_number}). Restart server to load it.`);

  res.status(201).json({
    plugin: pluginRows(server.id).find((plugin) => plugin.id === result.lastInsertRowid),
    targetPath: displayPath(target.absolutePath),
  });
}));

app.post('/api/servers/:id/poggit/install', requirePermission(capabilities.PLUGINS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
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

app.get('/api/servers/:id/console', requirePermission(capabilities.CONSOLE_VIEW, permissions.VIEW_CONSOLE), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });
  res.setHeader('Cache-Control', 'no-store');
  const details = runtimeDetails(id);
  res.json({ status: details.status, players: details.players, lines: consoleLogs(id).slice(-300) });
});

function serverMetricsPayload(server) {
  const details = runtimeDetails(server.id);
  const processMetrics = processTreeMetrics({
    pid: details.pid,
    unit: details.unit,
    cacheKey: `server:${server.id}`,
  });
  return {
    status: details.status,
    pid: details.pid,
    unit: details.unit,
    startedAt: details.startedAt,
    metricSource: processMetrics.source,
    processCount: processMetrics.pids.length,
    players: details.players,
    playerCount: details.players.length,
    maxMemoryMb: server.max_memory_mb,
    rssBytes: processMetrics.rssBytes,
    rssMb: processMetrics.rssMb,
    cpuPercent: processMetrics.cpuPercent,
    metricSource: processMetrics.source,
    kernelPressure: processMetrics.pressure,
    memoryEvents: processMetrics.memoryEvents,
    cpuThrottledCount: processMetrics.nrThrottled,
    cpuThrottledUsec: processMetrics.throttledUsec,
  };
}

function hostMetricsPayload() {
  const memory = hostMemoryStats();
  const load = os.loadavg()[0] || 0;
  return {
    cpuPercent: hostCpuPercent(),
    ramUsedBytes: memory.used,
    ramTotalBytes: memory.total,
    ramUsedMb: Math.round(memory.used / 1024 / 1024),
    ramTotalMb: Math.round(memory.total / 1024 / 1024),
    load: Number(load.toFixed(2)),
    cores: hostCpuCount(),
  };
}

app.get('/api/servers/:id/console/stream', requirePermission(capabilities.CONSOLE_VIEW, permissions.VIEW_CONSOLE), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Server not found.' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const writeEvent = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  writeEvent('snapshot', { status: runtimeStatus(id), players: runtimeDetails(id).players, lines: consoleLogs(id).slice(-300) });
  const unsubscribe = subscribeConsole(id, (line) => {
    const details = runtimeDetails(id);
    writeEvent('line', { line, status: details.status, players: details.players });
  });
  const heartbeat = setInterval(() => writeEvent('metrics', {
    at: Date.now(),
    server: serverMetricsPayload(target),
  }), 1000);
  heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get('/api/servers/:id/metrics', requireAuth, (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  res.json(serverMetricsPayload(server));
});

app.get('/api/system/metrics', requireAuth, (_req, res) => {
  res.json(hostMetricsPayload());
});

// The learned-intelligence routes were removed in 1.0.0 along with the AI
// engine. Health/incident data is still available via /api/advanced/overview.

app.use('/api/servers/:id/timeline', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (_req, res) => {
  res.status(410).json({ error: 'Server Time Machine has been removed from this build.' });
});

app.post('/api/presence', requireAuth, (req, res) => {
  const view = String(req.body.view || '').slice(0, 40);
  const serverId = req.body.serverId ? Number(req.body.serverId) : null;
  if (serverId) getServerOr404(serverId, req.user);
  const cursor = {
    x: clampNumber(req.body.x, 0, 100000, 0),
    y: clampNumber(req.body.y, 0, 100000, 0),
    label: String(req.body.label || '').slice(0, 80),
  };
  db.prepare(`
    INSERT INTO panel_presence (user_id, server_id, view, cursor_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, server_id, view) DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at
  `).run(req.user.id, serverId, view, JSON.stringify(cursor), Date.now());
  res.json({ ok: true });
});

app.get('/api/presence', requireAuth, (req, res) => {
  const now = Date.now();
  db.prepare('DELETE FROM panel_presence WHERE updated_at < ?').run(now - 45 * 1000);
  const serverId = req.query.serverId ? Number(req.query.serverId) : null;
  if (serverId) getServerOr404(serverId, req.user);
  const rows = db.prepare(`
    SELECT presence.user_id, presence.server_id, presence.view, presence.cursor_json, presence.updated_at,
           user.name, user.email
    FROM panel_presence presence
    JOIN users user ON user.id = presence.user_id
    WHERE (? IS NULL OR presence.server_id = ?)
    ORDER BY presence.updated_at DESC
    LIMIT 30
  `).all(serverId, serverId);
  res.json({
    users: rows.map((row) => ({
      userId: row.user_id,
      serverId: row.server_id,
      view: row.view,
      cursor: parseJsonObject(row.cursor_json),
      updatedAt: row.updated_at,
      name: row.name,
      email: row.email,
      self: row.user_id === req.user.id,
    })),
  });
});

app.get('/api/security/ddos', requirePermission(capabilities.SECURITY_VIEW, permissions.MANAGE_SECURITY), (_req, res) => {
  const report = collectDdosEvidence();
  res.json({
    ok: true,
    active: Boolean(report.analysis?.active),
    risk: report.analysis?.risk || 'normal',
    parameterCount: DDOS_PARAMETER_COUNT,
  });
});

app.post('/api/servers/:id/start', requirePermission(capabilities.SERVER_START, permissions.POWER_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (!hasJavaEula(server)) return res.status(409).json({ error: 'Agree to the Minecraft EULA first.' });
  const software = softwareForServer(server);
  if (!software) return res.status(400).json({ error: 'This Nexu template needs an installer/runtime before it can start.' });
  await closeWakeWatcher(server.id);
  await safeTimelinePoint(server, req, 'Before server start', 'Captured configuration before launching the process.');
  if (['java', 'bedrock'].includes(server.type)) await repairPropertiesFile(server);
  try {
    const result = startServer(resolveInstalledExecutable(server, software), software);
    logFixed({ serverId: server.id, category: 'server', title: 'Server start requested', detail: result.message || '', source: 'owner-action' });
    return res.json(result);
  } catch (error) {
    if (!/install server software|executable/i.test(error.message)) throw error;
    appendLog(server.id, `[NexusPanel] Smart fix: ${error.message}`);
    const repaired = await repairMissingExecutable(server, software);
    const fixedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    const result = startServer(resolveInstalledExecutable(fixedServer, software), software);
    logFixed({ serverId: server.id, category: 'repair', title: 'Smart start repair applied', detail: repaired.message || error.message, source: 'smart-start' });
    return res.json({ ...result, repaired });
  }
}));

app.get('/api/servers/:id/fix/status', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const job = repairJobs.get(server.id);
  if (!job) return res.json({ status: 'idle', message: 'No repair is running.' });
  res.json({
    id: job.id,
    status: job.status,
    message: job.message,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result || null,
    error: job.error || '',
  });
});

app.post('/api/servers/:id/fix', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (runtimeStatus(server.id) === 'online') return res.status(409).json({ error: 'Stop the server before running Fix Server.' });
  const software = softwareForServer(server);
  if (!software) return res.status(400).json({ error: 'This server has no repairable software runtime.' });
  const existing = repairJobs.get(server.id);
  if (existing && ['queued', 'running'].includes(existing.status)) {
    return res.status(202).json({ ok: true, queued: true, job: { id: existing.id, status: existing.status, message: existing.message } });
  }
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    message: 'Repair queued. The panel remains available.',
    startedAt: Date.now(),
    finishedAt: 0,
    result: null,
    error: '',
  };
  const actorUserId = req.user.id;
  repairJobs.set(server.id, job);
  appendLog(server.id, '[NexusPanel] Repair & Diagnose queued in the background.');
  res.status(202).json({ ok: true, queued: true, job: { id: job.id, status: job.status, message: job.message } });

  setImmediate(() => {
    job.status = 'running';
    job.message = 'Inspecting runtime, files, logs, and isolation policy...';
    withKeyedOperation(`repair:${server.id}`, async () => {
      await safeTimelinePoint(server, { user: { id: actorUserId } }, 'Before Repair & Diagnose', 'Captured configuration before repair workflow.');
      const report = await runServerRepair(server, software, { applyOptimizations: true, allowModelTools: true });
      const learned = learnRepairPlaybook(server, report);
      appendLog(server.id, `[NexusPanel] Repair & Diagnose checks completed: ${report.summary} Start the server and keep it online for 60 seconds before the repair is trusted.`);
      if (learned) appendLog(server.id, `[NexusPanel] Repair playbook ${learned.signature} recorded as an untrusted candidate; it will not be replayed until stable runtime validates it.`);
      if (learned) logFixed({ serverId: server.id, category: 'learning', title: 'Repair playbook candidate recorded', detail: `Signature ${learned.signature}; ${learned.actions} action(s).`, source: 'repair-agent' });
      job.status = 'completed';
      job.message = report.summary;
      job.finishedAt = Date.now();
      job.result = {
        summary: report.summary,
        learned,
        actions: (report.actions || []).slice(0, 12),
        warnings: (report.warnings || []).slice(0, 8),
      };
    }).catch((error) => {
      job.status = 'failed';
      job.message = `Repair failed: ${error.message}`;
      job.error = error.message;
      job.finishedAt = Date.now();
      appendLog(server.id, `[NexusPanel] Repair & Diagnose failed: ${error.message}`);
    }).finally(() => {
      const cleanup = setTimeout(() => {
        if (repairJobs.get(server.id) === job) repairJobs.delete(server.id);
      }, 30 * 60 * 1000);
      cleanup.unref();
    });
  });
}));

app.post('/api/servers/:id/eula', requirePermission(capabilities.SERVER_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  await safeTimelinePoint(server, req, 'Before EULA change', 'Captured configuration before accepting EULA.');
  await agreeJavaEula(server);
  appendLog(server.id, '[NexusPanel] EULA accepted from panel.');
  res.json({ ok: true, eulaAgreed: true });
}));

app.post('/api/servers/:id/stop', requirePermission(capabilities.SERVER_STOP, permissions.POWER_SERVERS), (req, res) => {
  const id = Number(req.params.id);
  const result = stopServer(id);
  refreshWakeWatchers();
  logFixed({ serverId: id, category: 'server', title: 'Server stop requested', detail: result.message || '', source: 'owner-action' });
  res.json(result);
});

app.post('/api/servers/:id/restart', requirePermission(capabilities.SERVER_RESTART, permissions.POWER_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (!hasJavaEula(server)) return res.status(409).json({ error: 'Agree to the Minecraft EULA first.' });
  const software = softwareForServer(server);
  if (!software) return res.status(400).json({ error: 'This Nexu template needs an installer/runtime before it can restart.' });
  await safeTimelinePoint(server, req, 'Before server restart', 'Captured configuration before restart.');
  if (['java', 'bedrock'].includes(server.type)) await repairPropertiesFile(server);
  const result = restartServer(resolveInstalledExecutable(server, software), software);
  logFixed({ serverId: server.id, category: 'server', title: 'Server restart requested', detail: result.message || '', source: 'owner-action' });
  res.json(result);
}));

app.post('/api/servers/:id/kill', requirePermission(capabilities.SERVER_KILL, permissions.POWER_SERVERS), (req, res) => {
  const id = Number(req.params.id);
  const result = killServer(id);
  refreshWakeWatchers();
  logFixed({ serverId: id, category: 'server', title: 'Server kill requested', detail: result.message || '', source: 'owner-action' });
  res.json(result);
});

const commandRateLimits = new Map();

function consumeCommandRateLimit(userId, serverId) {
  const key = `${Number(userId) || 0}:${Number(serverId) || 0}`;
  const now = Date.now();
  const windowMs = 10000;
  const limit = 20;
  const current = commandRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    commandRateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  current.count += 1;
  if (current.count > limit) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfter: 0 };
}

app.post('/api/servers/:id/command', requirePermission(capabilities.CONSOLE_COMMAND, permissions.SEND_COMMANDS), (req, res) => {
  const serverId = Number(req.params.id);
  const rate = consumeCommandRateLimit(req.user?.id, serverId);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ error: `Too many console commands. Try again in ${rate.retryAfter} seconds.` });
  }
  const result = sendCommand(serverId, req.body.command);
  res.json(result);
});

app.get('/api/servers/:id/properties', requirePermission(capabilities.PROPERTIES_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const values = await readProperties(server);
  const schema = propertySchema.filter((item) => item.editions.includes(server.type));
  res.json({ schema, values });
}));

app.put('/api/servers/:id/properties', requirePermission(capabilities.PROPERTIES_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  await safeTimelinePoint(server, req, 'Before server.properties edit', 'Captured properties before panel edit.');
  const allowed = new Set(propertySchema.filter((item) => item.editions.includes(server.type)).map((item) => item.key));
  const values = {};
  for (const [key, value] of Object.entries(req.body.values || {})) {
    if (allowed.has(key)) values[key] = String(value);
  }

  if (Object.prototype.hasOwnProperty.call(values, 'server-port')) {
    const requestedPort = Number(values['server-port']);
    if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
      return res.status(400).json({ error: 'Server port must be an integer between 1024 and 65535.' });
    }
    if (requestedPort !== Number(server.port)) {
      if (runtimeStatus(server.id) === 'online' || runtimeStatus(server.id) === 'starting') {
        return res.status(409).json({ error: 'Stop the server before changing its game port.' });
      }
      const collision = db.prepare(`
        SELECT id, name FROM servers
        WHERE port = ? AND id != ?
        LIMIT 1
      `).get(requestedPort, server.id);
      if (collision) {
        return res.status(409).json({ error: `Port ${requestedPort} is already allocated to ${collision.name || `server #${collision.id}`}.` });
      }
      db.prepare('UPDATE servers SET port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(requestedPort, server.id);
      const updatedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
      try {
        writeProfile(updatedServer);
      } catch (error) {
        db.prepare('UPDATE servers SET port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(server.port, server.id);
        throw new Error(`Port changed in database but ASF profile regeneration failed; change was rolled back. ${error.message}`);
      }
    }
  }

  const currentServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
  await writeProperties(currentServer, values);
  const verified = await readProperties(currentServer);
  if (Object.prototype.hasOwnProperty.call(values, 'server-port') && Number(verified['server-port']) !== Number(currentServer.port)) {
    return res.status(500).json({ error: 'Port verification failed after saving.' });
  }
  appendLog(server.id, '[NexusPanel] server.properties updated and allocation synchronized. Restart may be required.');
  res.json({ values: verified, server: serverPayload(currentServer, req) });
}));

app.get('/api/servers/:id/whitelist', requirePermission(capabilities.WHITELIST_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  res.json({ players: await readWhitelist(server) });
}));

app.post('/api/servers/:id/whitelist', requirePermission(capabilities.WHITELIST_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  await safeTimelinePoint(server, req, 'Before whitelist edit', 'Captured whitelist and properties before adding player.');
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Player name is required.' });
  if (software.edition === 'java' && !/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    return res.status(400).json({ error: 'Java usernames must be 3-16 letters, numbers, or underscores.' });
  }
  let rows = await readWhitelist(server);
  const existing = rows.find((row) => String(row.name || '').toLowerCase() === name.toLowerCase());
  if (software.edition === 'java') {
    const properties = await readProperties(server);
    const onlineMode = String(properties['online-mode'] ?? 'true').toLowerCase() === 'true';
    const uuid = await javaUuidForName(name, onlineMode);
    if (!uuid) {
      if (runtimeStatus(server.id) === 'online') {
        await writeProperties(server, { 'white-list': 'true' });
        sendCommand(server.id, 'whitelist on');
        sendCommand(server.id, `whitelist add ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        rows = await readWhitelist(server);
        if (rows.some((row) => String(row.name || '').toLowerCase() === name.toLowerCase())) {
          appendLog(server.id, `[NexusPanel] Whitelisted ${name} through the running Java server.`);
          return res.status(201).json({ players: rows });
        }
      }
      return res.status(404).json({
        error: `No paid Java profile named "${name}" was found. Check the spelling, or disable Online Mode before adding an offline player.`,
      });
    }
    if (existing) {
      if (existing.uuid !== uuid || existing.name !== name) {
        existing.uuid = uuid;
        existing.name = name;
      }
    } else {
      rows.push({ uuid, name });
    }
  } else {
    if (!existing) rows.push({ name, xuid: String(req.body.xuid || ''), ignoresPlayerLimit: Boolean(req.body.ignoresPlayerLimit) });
  }
  await writeWhitelist(server, rows);
  const key = software.edition === 'java' ? 'white-list' : 'allow-list';
  await writeProperties(server, { [key]: 'true' });
  reloadWhitelistIfRunning(server, software);
  appendLog(server.id, `[NexusPanel] Whitelisted ${name}.`);
  res.status(201).json({ players: rows });
}));

app.delete('/api/servers/:id/whitelist/:name', requirePermission(capabilities.WHITELIST_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  await safeTimelinePoint(server, req, 'Before whitelist removal', `Captured whitelist before removing ${req.params.name}.`);
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  const name = String(req.params.name || '').toLowerCase();
  const rows = (await readWhitelist(server)).filter((row) => String(row.name || '').toLowerCase() !== name);
  await writeWhitelist(server, rows);
  reloadWhitelistIfRunning(server, software);
  appendLog(server.id, `[NexusPanel] Removed whitelist entry ${req.params.name}.`);
  res.json({ players: rows });
}));

app.delete('/api/servers/:id/whitelist', requirePermission(capabilities.WHITELIST_MANAGE, permissions.MANAGE_SERVERS), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  await safeTimelinePoint(server, req, 'Before whitelist clear', 'Captured whitelist before clearing all entries.');
  const software = findSoftware(server.software_key) || defaultSoftware(server.type);
  await writeWhitelist(server, []);
  reloadWhitelistIfRunning(server, software);
  appendLog(server.id, '[NexusPanel] Cleared whitelist.');
  res.json({ players: [] });
}));

app.get('/api/servers/:id/backups', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
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
  const backups = await backupRows(server);
  const nextBackupAt = nextScheduledBackupAt(server);
  const offlineBackupAt = lastOfflineBackupAt(server.id);
  res.json({
    backups,
    backupGroups: groupedBackups(backups),
    canManageShare: canShareOwner,
    shareCode: code || null,
    shareRequests: incoming,
    sharedBackups,
    schedule: {
      enabled: Boolean(server.scheduled_backups),
      intervalMinutes: backupIntervalMinutesFrom(server),
      lastBackupAt: Number(server.last_backup_at || 0),
      nextBackupAt,
      lastOfflineBackupAt: offlineBackupAt,
      nextOfflineBackupAt: server.scheduled_backups ? (offlineBackupAt ? offlineBackupAt + 24 * 60 * 60 * 1000 : Date.now()) : 0,
      schedulerResolutionSeconds: 30,
      fileNameTimeZone: backupTimezone(server),
    },
  });
}));

app.post('/api/servers/:id/backups/public-link', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
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

app.delete('/api/servers/:id/backups/public-link', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
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

app.post('/api/servers/:id/backups/import-url', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const url = await validatePublicBackupUrl(req.body.url);
  // fetchPinned connects to the DNS-validated IP, closing the rebinding window.
  const response = await fetchPinned(url, {
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

app.post('/api/servers/:id/backups/share-code', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can create backup codes.' });
  const code = ensureBackupShareCode(server, req.body || {});
  res.json({ code: code.code, expiresAt: code.expires_at });
});

app.delete('/api/servers/:id/backups/share-code', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can hide backup codes.' });
  db.prepare('DELETE FROM backup_share_codes WHERE server_id = ?').run(server.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/backups/share-request', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const target = getServerOr404(req.params.id, req.user);
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

app.post('/api/servers/:id/backups/share-requests/:requestId/approve', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can approve backup access.' });
  const request = db.prepare('SELECT * FROM backup_share_requests WHERE id = ? AND source_server_id = ?').get(Number(req.params.requestId), server.id);
  if (!request) return res.status(404).json({ error: 'Share request not found.' });
  const expiresAt = Date.now() + durationMs(req.body || {}, 60, 24 * 60);
  db.prepare('UPDATE backup_share_requests SET status = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', expiresAt, request.id);
  res.json({ ok: true, expiresAt });
});

app.delete('/api/servers/:id/backups/share-requests/:requestId', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  if (!canOwnServerShare(req.user, server)) return res.status(403).json({ error: 'Only the source server owner can remove backup access.' });
  const request = db.prepare('SELECT * FROM backup_share_requests WHERE id = ? AND source_server_id = ?').get(Number(req.params.requestId), server.id);
  if (!request) return res.status(404).json({ error: 'Share request not found.' });
  db.prepare('UPDATE backup_share_requests SET status = ?, expires_at = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('revoked', request.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/backups', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const job = startProgressJob(backupProgressJobs, server.id, 'backup', async (report) => {
    const backup = await createServerBackup(server, 'manual', report);
    logFixed({ serverId: server.id, category: 'backup', title: 'Manual backup created', detail: backup.name, source: 'backup' });
    return { backup, backups: await backupRows(server) };
  });
  res.status(202).json({ job: progressJobPayload(job) });
}));

app.get('/api/servers/:id/operations/:jobId', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const job = fileOperationJobs.get(String(req.params.jobId)) || backupProgressJobs.get(String(req.params.jobId));
  if (!job || job.serverId !== Number(server.id)) return res.status(404).json({ error: 'Operation not found.' });
  res.json({ job: progressJobPayload(job) });
});

app.get('/api/servers/:id/backups/operations/:jobId', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const job = backupProgressJobs.get(String(req.params.jobId));
  if (!job || job.serverId !== Number(server.id)) return res.status(404).json({ error: 'Backup operation not found.' });
  res.json({ job: progressJobPayload(job) });
});

app.delete('/api/servers/:id/backups', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const backupPath = String(req.query.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!backupPath.endsWith('.zip') || backupPath.includes('/')) {
    return res.status(400).json({ error: 'Choose a backup file to delete.' });
  }
  const target = assertInside(backupsRoot, path.join(backupsRoot, String(server.id), backupPath));
  await fs.promises.rm(target, { force: true });
  res.json({ ok: true, backups: await backupRows(server) });
}));

app.get('/api/servers/:id/backups/download', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const name = String(req.query.name || '').replaceAll('\\', '/');
  if (!name.endsWith('.zip') || name.includes('/')) return res.status(400).json({ error: 'Choose a backup file.' });
  const target = assertInside(backupsRoot, path.join(backupsRoot, String(server.id), name));
  await streamDownload(req, res, target, name);
}));

app.post('/api/servers/:id/backups/restore', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  await safeTimelinePoint(server, req, 'Before backup restore', `Captured configuration before restoring ${req.body.name || 'backup'}.`);
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
  logFixed({ serverId: server.id, category: 'backup', title: 'Backup restored', detail: `Restored ${req.body.name || 'backup'} from server ${sourceServerId}.`, source: 'backup' });
  res.json({ ok: true, ...result, backups: await backupRows(server) });
}));

app.put('/api/servers/:id/backups/settings', requirePermission(capabilities.BACKUPS_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const intervalMinutes = parseBackupIntervalMinutes(req.body, backupIntervalMinutesFrom(server));
  const intervalHours = Math.max(1, Math.round(intervalMinutes / 60));
  const scheduledBackups = toBool(req.body.scheduledBackups, Boolean(server.scheduled_backups));
  const scheduleChanged = scheduledBackups !== Boolean(server.scheduled_backups)
    || intervalMinutes !== backupIntervalMinutesFrom(server);
  const scheduleUpdatedAt = scheduleChanged ? Date.now() : Number(server.backup_schedule_updated_at || 0);
  const retention = clampNumber(req.body.backupRetention, 1, 50, server.backup_retention || 4);
  db.prepare('UPDATE servers SET scheduled_backups = ?, backup_interval_hours = ?, backup_interval_minutes = ?, backup_schedule_updated_at = ?, backup_retention = ? WHERE id = ?')
    .run(scheduledBackups, intervalHours, intervalMinutes, scheduleUpdatedAt, retention, server.id);
  res.json({ server: serverPayload(db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id)) });
});

app.get('/api/servers/:id/tunnels', requireAuth, (req, res) => {
  getServerOr404(req.params.id, req.user);
  res.status(410).json({ error: 'Tunnels were removed. Use Templates or your VPS reverse proxy setup instead.' });
});

app.put('/api/servers/:id/tunnels', requirePermission(capabilities.NETWORK_MANAGE, permissions.MANAGE_SERVERS), (req, res) => {
  getServerOr404(req.params.id, req.user);
  res.status(410).json({ error: 'Tunnels were removed. Use Templates or your VPS reverse proxy setup instead.' });
});

app.use('/api/servers/:id/files', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  let release;
  try {
    const server = getServerOr404(req.params.id, req.user);
    if (runtimeStatus(server.id) === 'online') {
      release = beginLiveServerFileOperation(server.id);
    } else {
      release = beginServerFileOperation(server.id);
    }
  } catch (error) {
    return next(error);
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
});

app.get('/api/servers/:id/files', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.query.path || '');
  const stats = await fs.promises.stat(target.absolute).catch(() => null);
  if (!stats) return res.status(404).json({ error: 'Path not found.' });

  if (stats.isDirectory()) {
    const entries = (await fs.promises.readdir(target.absolute, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink()
        && isUserVisibleServerEntry(path.posix.join(target.relative.replaceAll('\\', '/'), entry.name)));
    const payloadEntries = await Promise.all(entries.map(async (entry) => {
      // Dirent already gives the directory type. Avoid an extra filesystem
      // stat for every folder; only regular files need size/mtime metadata.
      const entryStats = entry.isDirectory()
        ? null
        : await fs.promises.stat(path.join(target.absolute, entry.name)).catch(() => null);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: path.posix.join(target.relative.replaceAll('\\', '/'), entry.name).replace(/^\/+/, ''),
        size: entryStats?.isFile() ? entryStats.size : 0,
        modifiedAt: entryStats ? entryStats.mtimeMs : 0,
        ...(entry.isDirectory() ? { extension: '', kind: 'folder', mime: '', editable: false, previewable: false } : fileDescriptor(entry.name, entryStats?.size || 0)),
      };
    }));
    return res.json({
      path: target.relative,
      type: 'directory',
      entries: payloadEntries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1),
    });
  }

  const descriptor = fileDescriptor(target.relative, stats.size);
  if (!descriptor.editable) return res.json({
    path: target.relative,
    type: 'file',
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    ...descriptor,
  });
  res.json({
    path: target.relative,
    type: 'file',
    content: await fs.promises.readFile(target.absolute, 'utf8'),
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    ...descriptor,
  });
}));

app.get('/api/servers/:id/files/search', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const query = String(req.query.q || '').trim();
  const mode = req.query.mode === 'content' ? 'content' : 'name';
  if (query.length < 2) return res.json({ query, mode, results: [] });
  if (query.length > 120) return res.status(400).json({ error: 'Search text must be 120 characters or fewer.' });

  const serverRoot = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const scope = safeServerFile(server, req.query.path || '');
  const scopeStats = await fs.promises.stat(scope.absolute).catch(() => null);
  if (!scopeStats?.isDirectory()) return res.status(400).json({ error: 'Search scope must be a folder.' });

  const queue = [{ absolute: scope.absolute, relative: scope.relative, depth: 0 }];
  const results = [];
  const needle = query.toLocaleLowerCase();
  const maxResults = 250;
  const maxVisited = mode === 'content' ? 12000 : 30000;
  const maxContentBytes = 1024 * 1024;
  const maxScannedBytes = 128 * 1024 * 1024;
  const maxDepth = 16;
  let visited = 0;
  let scannedBytes = 0;
  let skippedFiles = 0;
  let truncated = false;

  while (queue.length && results.length < maxResults && visited < maxVisited) {
    const directory = queue.shift();
    if (directory.depth > maxDepth) {
      truncated = true;
      continue;
    }
    const children = await fs.promises.readdir(directory.absolute, { withFileTypes: true }).catch(() => []);
    const candidates = [];
    for (const child of children) {
      if (++visited > maxVisited) {
        truncated = true;
        break;
      }
      if (child.isSymbolicLink()) continue;
      const relative = path.posix.join(directory.relative, child.name).replace(/^\.\//, '');
      if (!isUserVisibleServerEntry(relative)) continue;
      const absolute = path.join(directory.absolute, child.name);
      const stats = await fs.promises.stat(absolute).catch(() => null);
      if (!stats) continue;
      const descriptor = child.isDirectory()
        ? { extension: '', kind: 'folder', mime: '', editable: false, previewable: false }
        : fileDescriptor(child.name, stats.size);
      const base = {
        name: child.name,
        path: relative,
        type: child.isDirectory() ? 'directory' : 'file',
        size: stats.isFile() ? stats.size : 0,
        modifiedAt: stats.mtimeMs,
        ...descriptor,
      };
      if (mode === 'name') {
        if (relative.toLocaleLowerCase().includes(needle)) results.push(base);
      } else if (child.isFile() && descriptor.editable && stats.size <= maxContentBytes) {
        candidates.push({ absolute, base });
      } else if (mode === 'content' && child.isFile() && descriptor.editable && stats.size > maxContentBytes) {
        skippedFiles += 1;
        truncated = true;
      }
      if (child.isDirectory()) queue.push({ absolute, relative, depth: directory.depth + 1 });
      if (results.length >= maxResults) break;
    }

    // Read candidate files concurrently in small batches so content search is
    // responsive without opening thousands of descriptors at once.
    for (let index = 0; index < candidates.length && results.length < maxResults; index += 8) {
      const batch = candidates.slice(index, index + 8);
      let reservedBatchBytes = 0;
      const inspected = await Promise.all(batch.map(async (candidate) => {
        if (candidate.base.size > maxScannedBytes - scannedBytes - reservedBatchBytes) return { skipped: true };
        reservedBatchBytes += candidate.base.size;
        const content = await fs.promises.readFile(candidate.absolute, 'utf8').catch(() => null);
        if (content === null) return null;
        // Reject likely binary or malformed text. Config and source search
        // should not return random byte fragments decoded as UTF-8.
        if (content.includes('\uFFFD') || /\0/.test(content)) return null;
        const matches = [];
        const lines = content.split(/\r?\n/);
        const lineOffsets = [];
        let totalLineOffset = 0;
        for (const line of lines) {
          lineOffsets.push(totalLineOffset);
          totalLineOffset += line.length + 1;
        }
        for (let lineIndex = 0; lineIndex < lines.length && matches.length < 20; lineIndex += 1) {
          const line = lines[lineIndex];
          const lower = line.toLocaleLowerCase();
          let column = lower.indexOf(needle);
          while (column >= 0 && matches.length < 20) {
            matches.push({ line: lineIndex + 1, column: column + 1, offset: lineOffsets[lineIndex] + column, text: line.slice(0, 500) });
            column = lower.indexOf(needle, column + Math.max(1, needle.length));
          }
        }
        return matches.length ? { ...candidate.base, matches, matchCount: matches.length } : null;
      }));
      for (let index = 0; index < inspected.length; index += 1) {
        const match = inspected[index];
        const candidate = batch[index];
        if (match?.skipped) {
          skippedFiles += 1;
          truncated = true;
        } else {
          scannedBytes += candidate.base.size;
          if (match) results.push(match);
        }
      }
    }
  }

  if (queue.length || visited >= maxVisited) truncated = true;
  results.sort((left, right) => left.path.localeCompare(right.path));
  res.json({
    query,
    mode,
    scope: scope.relative,
    results,
    truncated,
    scannedBytes,
    visited,
    skippedFiles,
    root: path.relative(serverRoot, scope.absolute).replaceAll('\\', '/'),
  });
}));

app.get('/api/servers/:id/files/preview', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.query.path || '');
  const stats = await fs.promises.stat(target.absolute).catch(() => null);
  if (!stats?.isFile()) return res.status(404).json({ error: 'File not found.' });
  const descriptor = fileDescriptor(target.relative, stats.size);
  if (!descriptor.previewable) return res.status(415).json({ error: 'This file type is download-only.' });
  const handle = await fs.promises.open(target.absolute, 'r');
  const header = Buffer.alloc(16);
  await handle.read(header, 0, header.length, 0).finally(() => handle.close());
  if (!validPreviewSignature(descriptor.kind, header)) return res.status(415).json({ error: 'File signature does not match its extension.' });
  res.setHeader('Content-Type', descriptor.mime);
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(target.absolute).replace(/["\\]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:");
  res.sendFile(target.absolute, { acceptRanges: true, cacheControl: false });
}));

app.put('/api/servers/:id/files', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a file path inside the server folder.' });
  await safeTimelinePoint(server, req, 'Before file edit', `Captured state before editing ${target.relative}.`);
  await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.promises.writeFile(target.absolute, String(req.body.content ?? ''), 'utf8');
  res.json({ ok: true, path: target.relative });
}));

app.post('/api/servers/:id/files/upload', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a destination file path.' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Upload body must be binary.' });
  await safeTimelinePoint(server, req, 'Before file upload', `Captured state before uploading ${target.relative}.`);
  await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.promises.writeFile(target.absolute, req.body);
  res.status(201).json({ ok: true, path: target.relative, size: req.body.length });
}));

app.get('/api/servers/:id/files/uploads', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  res.json({ uploads: uploadRows(server.id) });
});

app.post('/api/servers/:id/files/upload-progress', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose an upload path.' });
  const key = uploadProgressKey(server.id, target.relative);
  if (req.body.status === 'complete' || req.body.status === 'canceled') {
    liveUploadProgress.delete(key);
    return res.json({ ok: true });
  }
  const session = uploadSession(server.id, target.relative);
  if (!session) return res.status(404).json({ error: 'Upload session was not found.' });
  const size = Number(session.size || req.body.size || 0);
  const uploadedBytes = clampNumber(req.body.uploadedBytes, 0, Math.max(0, size), Number(session.uploaded_bytes || 0));
  const previous = liveUploadProgress.get(key);
  liveUploadProgress.set(key, {
    uploadedBytes: Math.max(Number(previous?.uploadedBytes || 0), uploadedBytes),
    status: 'active',
    message: 'Uploading live',
    updatedAt: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/api/servers/:id/files/upload-status', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
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
    db.prepare('DELETE FROM upload_sessions WHERE server_id = ? AND relative_path = ?').run(server.id, target.relative);
    liveUploadProgress.delete(uploadProgressKey(server.id, target.relative));
    return res.json({ uploadedBytes: complete.size, uploadedChunks: [{ start: 0, end: complete.size }], complete: true, sha256: expectedFileHash || '' });
  }
  const uploadedBytes = partial ? uploadedRangeBytes(chunks) : 0;
  upsertUploadSession(server.id, target.relative, totalSize, uploadedBytes, uploadedBytes ? 'paused' : 'waiting', uploadedBytes ? 'Ready to resume exact chunks' : 'Waiting for upload', chunks);
  res.json({ uploadedBytes, uploadedChunks: chunks, complete: false });
}));

app.post('/api/servers/:id/files/upload-chunk', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
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
  // Disk-exhaustion defense: cap the declared total so a client cannot reserve
  // an unbounded sparse file inside the server root.
  const maxUploadBytes = Math.max(1, Number(process.env.NEXUSPANEL_MAX_UPLOAD_GB || 50)) * 1024 * 1024 * 1024;
  if (totalSize > maxUploadBytes) return res.status(413).json({ error: 'Upload exceeds the configured size limit.' });
  if (expectedChunkHash && sha256Hex(req.body) !== expectedChunkHash) {
    return res.status(409).json({ error: 'Chunk checksum mismatch. Retrying this chunk is safe.' });
  }
  await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
  const partialPath = `${target.absolute}.uploading`;
  const existing = uploadSession(server.id, target.relative);
  if (existing && existing.status === 'canceled') return res.status(409).json({ error: 'Upload was canceled.' });
  const existingChunks = parseChunkRanges(existing?.chunks_json);
  const chunkEnd = offset + req.body.length;
  const overlaps = existingChunks.some((range) => offset < range.end && chunkEnd > range.start);
  if (overlaps) {
    return res.status(409).json({ error: 'Upload chunk overlaps an already committed range. Resume from the reported chunks.' });
  }
  if (!fs.existsSync(partialPath)) await fs.promises.writeFile(partialPath, Buffer.alloc(0));
  const handle = await fs.promises.open(partialPath, 'r+');
  try {
    await handle.write(req.body, 0, req.body.length, offset);
  } finally {
    await handle.close();
  }
  const chunks = mergeChunkRanges(existingChunks, { start: offset, end: chunkEnd });
  const uploadedBytes = uploadedRangeBytes(chunks);
  if (uploadedBytes >= totalSize && req.query.finalize === '1') {
    await safeTimelinePoint(server, req, 'Before chunked upload finalize', `Captured state before finalizing ${target.relative}.`);
    const stats = await fs.promises.stat(partialPath);
    if (stats.size !== totalSize) return res.status(409).json({ error: 'Upload size mismatch. Retry the file.' });
    const finalHash = await fileSha256Hex(partialPath);
    if (expectedFileHash && finalHash !== expectedFileHash) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => {});
      upsertUploadSession(server.id, target.relative, totalSize, 0, 'failed', 'Final checksum mismatch; clean retry required', []);
      return res.status(409).json({ error: 'Final file checksum mismatch. Retry the upload.' });
    }
    await fs.promises.rename(partialPath, target.absolute);
    db.prepare('DELETE FROM upload_sessions WHERE server_id = ? AND relative_path = ?').run(server.id, target.relative);
    liveUploadProgress.delete(uploadProgressKey(server.id, target.relative));
    return res.status(201).json({ ok: true, path: target.relative, uploadedBytes: totalSize, complete: true, sha256: finalHash });
  }
  upsertUploadSession(server.id, target.relative, totalSize, uploadedBytes, 'active', 'Uploading', chunks);
  res.json({ ok: true, path: target.relative, uploadedBytes, complete: false });
  });
}));

app.post('/api/servers/:id/files/upload-complete', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose a destination file path.' });
  await safeTimelinePoint(server, req, 'Before upload complete', `Captured state before completing ${target.relative}.`);
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
  db.prepare('DELETE FROM upload_sessions WHERE server_id = ? AND relative_path = ?').run(server.id, target.relative);
  liveUploadProgress.delete(uploadProgressKey(server.id, target.relative));
  res.status(201).json({ ok: true, path: target.relative, uploadedBytes: totalSize, complete: true, sha256: finalHash });
}));

app.post('/api/servers/:id/files/upload-pause', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose an upload path.' });
  const partial = await fs.promises.stat(`${target.absolute}.uploading`).catch(() => null);
  const session = uploadSession(server.id, target.relative);
  const chunks = mergeChunkRanges(parseChunkRanges(session?.chunks_json));
  liveUploadProgress.delete(uploadProgressKey(server.id, target.relative));
  upsertUploadSession(server.id, target.relative, Number(req.body.size || partial?.size || 0), uploadedRangeBytes(chunks), 'paused', 'Paused', chunks);
  res.json({ uploads: uploadRows(server.id) });
}));

app.delete('/api/servers/:id/files/upload-session', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Choose an upload path.' });
  await fs.promises.rm(`${target.absolute}.uploading`, { force: true }).catch(() => {});
  db.prepare('DELETE FROM upload_sessions WHERE server_id = ? AND relative_path = ?').run(server.id, target.relative);
  liveUploadProgress.delete(uploadProgressKey(server.id, target.relative));
  res.json({ uploads: uploadRows(server.id) });
}));

app.post('/api/servers/:id/files/mkdir', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.body.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Folder name is required.' });
  await safeTimelinePoint(server, req, 'Before folder create', `Captured state before creating ${target.relative}.`);
  await fs.promises.mkdir(target.absolute, { recursive: true });
  res.json({ ok: true, path: target.relative });
}));

app.delete('/api/servers/:id/files', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.query.path || '');
  if (!target.relative) return res.status(400).json({ error: 'Cannot delete the server root.' });
  await safeTimelinePoint(server, req, 'Before file delete', `Captured state before deleting ${target.relative}.`);
  await fs.promises.rm(target.absolute, { recursive: true, force: true });
  res.json({ ok: true });
}));

// Bulk delete keeps multi-selection removal to a single round trip instead of
// one request per item, which removes the multi-second delay and the request
// storm that made large selections feel unreliable.
app.post('/api/servers/:id/files/delete-batch', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [];
  if (!requested.length) return res.status(400).json({ error: 'Select at least one item to delete.' });
  if (requested.length > 500) return res.status(400).json({ error: 'Too many items selected. Delete in smaller batches.' });

  const deleted = [];
  const failed = [];
  await safeTimelinePoint(server, req, 'Before bulk file delete', `Captured state before deleting ${requested.length} item(s).`);
  for (const relative of requested) {
    try {
      const target = safeServerFile(server, relative);
      if (!target.relative) {
        failed.push({ path: String(relative || ''), error: 'Cannot delete the server root.' });
        continue;
      }
      await fs.promises.rm(target.absolute, { recursive: true, force: true });
      deleted.push(target.relative);
    } catch (error) {
      failed.push({ path: String(relative || ''), error: error.message });
    }
  }
  res.json({ ok: failed.length === 0, deleted, failed });
}));

app.post('/api/servers/:id/files/copy', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const destinationDir = safeServerFile(server, req.body.destination || '');
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const copied = [];
  await safeTimelinePoint(server, req, 'Before file copy', `Captured state before copying ${requested.length} item(s).`);
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

app.post('/api/servers/:id/files/move', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const destinationDir = safeServerFile(server, req.body.destination || '');
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const moved = [];
  await safeTimelinePoint(server, req, 'Before file move', `Captured state before moving ${requested.length} item(s).`);
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

app.post('/api/servers/:id/files/extract', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const destinationDir = safeServerFile(server, req.body.destination || '');
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const mode = ['replace', 'skip', 'fail'].includes(req.body.mode) ? req.body.mode : 'fail';
  const extracted = [];
  const requestedEntries = [];
  await safeTimelinePoint(server, req, 'Before archive extract', `Captured state before extracting ${requested.length} archive(s).`);
  for (const relative of requested) {
    const source = safeServerFile(server, relative);
    if (!source.relative || !archiveFormat(source.absolute)) {
      return res.status(400).json({ error: 'Select one or more supported archives: ZIP, TAR, GZ, BZ2, XZ, ZST, 7Z, or RAR.' });
    }
    const stats = await fs.promises.stat(source.absolute).catch(() => null);
    if (!stats || !stats.isFile()) return res.status(404).json({ error: `${source.relative} is not a file.` });
    let entries;
    try {
      entries = archiveEntries(source.absolute);
    } catch (error) {
      if (error.message.startsWith('Archive contains a link or special file')) {
        return res.status(400).json({ error: `${source.relative}: ${error.message}` });
      }
      throw error;
    }
    const blockedEntry = entries.find((entry) => !isUserVisibleServerEntry(path.posix.join(destinationDir.relative.replaceAll('\\', '/'), entry)));
    if (blockedEntry) {
      return res.status(403).json({ error: `Archive contains protected NexusPanel metadata/runtime path: ${blockedEntry}` });
    }
    if (mode === 'fail') {
      const collisions = archiveCollisions(source.absolute, destinationDir.absolute);
      if (collisions.length) {
        return res.status(409).json({
          error: `Extract would replace ${collisions.length} existing file(s). Choose Replace all or Skip existing.`,
          collisions,
        });
      }
    }
    extracted.push(source.relative);
    requestedEntries.push({ source, entries });
  }
  const worker = path.join(__dirname, 'file_operation_worker.js');
  const job = startProgressJob(fileOperationJobs, server.id, 'extract', async (report) => {
    const totalEntries = requestedEntries.reduce((sum, item) => sum + item.entries.length, 0);
    const expected = requestedEntries.flatMap((item) => item.entries.map((entry) => path.resolve(destinationDir.absolute, ...entry.replaceAll('\\', '/').split('/'))));
    const child = spawn(process.execPath, [worker], {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || '',
        WINDIR: process.env.WINDIR || '',
        TEMP: process.env.TEMP || '',
        TMP: process.env.TMP || '',
        NEXUSPANEL_WORKER_ARCHIVES: JSON.stringify(requestedEntries.map((item) => item.source.absolute)),
        NEXUSPANEL_WORKER_DESTINATION: destinationDir.absolute,
        NEXUSPANEL_WORKER_MODE: mode,
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    let error;
    const finish = new Promise((resolve) => child.once('error', (cause) => { error = cause; resolve(); }).once('exit', (code) => { if (code !== 0) error = new Error(stderr.trim() || `Archive extraction exited with code ${code}.`); resolve(); }));
    const timer = setInterval(() => {
      let completed = 0;
      for (const filename of expected) {
        try {
          const stats = fs.statSync(filename);
          if (mode === 'skip' || stats.mtimeMs >= job.createdAt - 1000) completed += 1;
        } catch {}
      }
      report({ percent: totalEntries ? Math.min(99, Math.floor(completed / totalEntries * 100)) : 0, message: `Extracting ${completed}/${totalEntries} files` });
    }, 250);
    await finish;
    clearInterval(timer);
    if (error) throw error;
    report({ percent: 100, message: `Extracted ${extracted.length} archive(s)` });
    return { ok: true, paths: extracted, destination: destinationDir.relative };
  });
  res.status(202).json({ job: progressJobPayload(job) });
}));

app.post('/api/servers/:id/files/archive', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const root = ensureServerDirs({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
  const requestedDestination = String(req.body.destination || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const destination = safeServerFile(server, requestedDestination);
  const destinationStats = await fs.promises.stat(destination.absolute).catch(() => null);
  if (!destinationStats?.isDirectory()) return res.status(400).json({ error: 'Archive destination must be an existing folder.' });
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path || ''];
  const relativePaths = requested
    .map((item) => String(item || '').replaceAll('\\', '/').replace(/^\/+/, ''))
    .filter((item, index, list) => list.indexOf(item) === index);

  for (const relative of relativePaths) {
    const checked = safeServerFile(server, relative);
    if (!checked.relative) return res.status(400).json({ error: 'Cannot archive the server root directly. Select files or folders inside it.' });
    const blockedEntry = await firstProtectedServerTreeEntry(root, checked.relative);
    if (blockedEntry) return res.status(403).json({ error: `Cannot archive protected NexusPanel metadata/runtime path: ${blockedEntry}` });
  }
  const archiveName = `${server.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'server'}-${Date.now()}.zip`;
  const archiveRelative = path.posix.join(destination.relative, archiveName);
  const archivePath = assertInside(root, path.join(root, archiveRelative));
  await createZip(root, relativePaths, archivePath);
  res.json({
    archive: archiveRelative,
    downloadUrl: `/api/servers/${server.id}/files/download?path=${encodeURIComponent(archiveRelative)}`,
  });
}));

app.get('/api/servers/:id/files/download', requirePermission(capabilities.FILES_MANAGE, permissions.MANAGE_FILES), asyncRoute(async (req, res) => {
  const server = getServerOr404(req.params.id, req.user);
  const target = safeServerFile(server, req.query.path || '');
  await streamDownload(req, res, target.absolute, path.basename(target.absolute));
}));

app.patch('/api/plugins/:id', requirePermission(capabilities.PLUGINS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found.' });
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(plugin.server_id);
  if (!canUseServer(req.user, server)) return res.status(403).json({ error: 'No permission for this server.' });

  db.prepare('UPDATE plugins SET enabled = ? WHERE id = ?').run(toBool(req.body.enabled, Boolean(plugin.enabled)), id);
  res.json({ plugin: pluginRows(plugin.server_id).find((row) => row.id === id) });
});

app.delete('/api/plugins/:id', requirePermission(capabilities.PLUGINS_MANAGE, permissions.MANAGE_FILES), (req, res) => {
  const id = Number(req.params.id);
  const plugin = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found.' });
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(plugin.server_id);
  if (!canUseServer(req.user, server)) return res.status(403).json({ error: 'No permission for this server.' });

  db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  const status = Number(err.statusCode) || 400;
  // Never leak internal stack traces, filesystem paths, or SQL errors to clients.
  const safeMessage = status >= 500
    ? 'Something went wrong on the panel. Check the server logs.'
    : (err.message || 'Something went wrong.');
  if (status >= 500) console.error(`[NexusPanel] Unhandled route error: ${err.stack || err.message}`);
  res.status(status).json({ error: safeMessage });
});

async function runAutoBackups() {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM servers WHERE scheduled_backups = 1').all();
  for (const server of rows) {
    const pauseUntil = backupPausedUntil(server.id);
    if (pauseUntil) {
      if (serverStableFor(server.id, 60 * 1000)) clearServerBackupPause(server.id);
      else continue;
    }
    const online = runtimeStatus(server.id) === 'online';
    if (!online) {
      const dayMs = 24 * 60 * 60 * 1000;
      if (now - lastOfflineBackupAt(server.id) < dayMs || autoBackupInFlight.has(server.id)) continue;
      autoBackupInFlight.add(server.id);
      createServerBackup(server, 'offline')
        .catch((error) => appendLog(server.id, `[NexusPanel] Offline backup failed: ${error.message}`))
        .finally(() => autoBackupInFlight.delete(server.id));
      continue;
    }
    const intervalMs = backupIntervalMinutesFrom(server) * 60 * 1000;
    if (now - backupScheduleAnchor(server) < intervalMs || autoBackupInFlight.has(server.id)) continue;
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
        .run(normalized, uploadedBytes, 'Maintenance normalized upload ranges', upload.server_id, upload.relative_path);
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
  db.prepare('DELETE FROM auth_throttle WHERE updated_at < ?').run(now - 24 * 60 * 60 * 1000);
  const expiredOtps = db.prepare('DELETE FROM password_reset_otps WHERE expires_at <= ?').run(now).changes;
  const expiredLinks = db.prepare('UPDATE backup_public_links SET revoked_at = ? WHERE revoked_at = 0 AND expires_at <= ?').run(now, now).changes;
  if (expiredSessions) actions.push(`Removed ${expiredSessions} expired session(s)`);
  if (expiredOtps) actions.push(`Removed ${expiredOtps} expired reset code(s)`);
  if (expiredLinks) actions.push(`Revoked ${expiredLinks} expired public backup link(s)`);
  const validatedRepairs = validateStableTerminalRepairs();
  if (validatedRepairs.length) actions.push(`Validated ${validatedRepairs.length} learned terminal repair(s)`);
  const validatedPlaybooks = validateStableRepairPlaybooks();
  if (validatedPlaybooks.length) actions.push(`Validated ${validatedPlaybooks.length} repair playbook(s) after stable runtime`);
  const validatedAgentEpisodes = validateStableAgentEpisodes();
  if (validatedAgentEpisodes.length) actions.push(`Trained repair agent from ${validatedAgentEpisodes.length} stable recovery episode(s)`);
  if (settingValue('repair_agent_live_enabled', '0') === '1') {
    const live = await runLiveAgentSweep();
    if (live.actions.length) actions.push(...live.actions);
  }
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
  if (actions.length) {
    logFixed({
      category: 'maintenance',
      title: 'Maintenance completed',
      detail: actions.slice(0, 20).join('\n'),
      source: 'panel-maintenance',
    });
  }
  return { ok: true, ...adaptiveMaintenanceStatus };
}

function liveAgentDiagnosisKey(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : [])
    .map((item) => item.id)
    .filter(Boolean)
    .slice(0, 4)
    .join('|');
}

function recentLiveAgentEpisode(serverId, signature, diagnosisKey, cooldownMs = 7 * 24 * 60 * 60 * 1000) {
  const rows = db.prepare(`
    SELECT id, diagnoses_json, created_at
    FROM repair_agent_episodes
    WHERE server_id = ? AND signature = ? AND status IN ('live-observed', 'validated', 'failed') AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 12
  `).all(Number(serverId), String(signature || ''), Date.now() - cooldownMs);
  return rows.find((row) => liveAgentDiagnosisKey(parseJsonObject(row.diagnoses_json) || []) === diagnosisKey) || null;
}

function pruneDuplicateLiveAgentEpisodes() {
  const rows = db.prepare(`
    SELECT id, server_id, signature, diagnoses_json
    FROM repair_agent_episodes
    WHERE status = 'live-observed'
    ORDER BY created_at DESC
  `).all();
  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const key = `${row.server_id}:${row.signature}:${liveAgentDiagnosisKey(parseJsonObject(row.diagnoses_json) || [])}`;
    if (seen.has(key)) duplicates.push(row.id);
    else seen.add(key);
  }
  if (!duplicates.length) return 0;
  const placeholders = duplicates.map(() => '?').join(',');
  db.prepare(`DELETE FROM repair_agent_plans WHERE episode_id IN (${placeholders})`).run(...duplicates);
  db.prepare(`DELETE FROM repair_agent_episodes WHERE id IN (${placeholders})`).run(...duplicates);
  return duplicates.length;
}

async function runLiveAgentSweep() {
  const actions = [];
  const pruned = pruneDuplicateLiveAgentEpisodes();
  if (pruned) actions.push(`Pruned ${pruned} duplicate live agent episode(s)`);
  const servers = db.prepare('SELECT * FROM servers').all();
  for (const server of servers.slice(0, 50)) {
    const software = softwareForServer(server);
    if (!software) continue;
    const logs = consoleLogs(server.id).slice(-80);
    const diagnostics = diagnoseRuntime(logs, { limit: 6 });
    const root = findServerRoot({ ...server, server_path: server.server_path || serverPath(server.id, server.name) });
    const watchFiles = ['server.properties', 'eula.txt', '.nexus-server.json']
      .map((name) => path.join(root, name))
      .filter((filePath) => fs.existsSync(filePath));
    if (diagnostics.length) {
      const signature = crashSignature(server, software, null, null).signature;
      const diagnosisKey = liveAgentDiagnosisKey(diagnostics);
      if (runtimeStatus(server.id) === 'offline' && server.type === 'bedrock' && diagnostics.some((item) => item.id === 'bedrock-pack-version')) {
        const repairKey = `live_agent_pack_repair_${server.id}_${diagnosisKey}`;
        const lastRepair = Number(settingValue(repairKey, '0')) || 0;
        if (Date.now() - lastRepair > 30 * 60 * 1000) {
          setSettingValue(repairKey, String(Date.now()));
          const packRepair = await quarantineIncompatibleBedrockPacks(server, root, logs);
          if (packRepair.actions.length) {
            actions.push(`Live agent quarantined incompatible Bedrock pack for ${server.name}`);
            logFixed({
              serverId: server.id,
              category: 'live-agent',
              title: 'Live agent quarantined incompatible Bedrock pack',
              detail: packRepair.actions.join('\n'),
              source: 'live-agent',
            });
          }
          if (packRepair.warnings.length) {
            appendLog(server.id, `[NexusPanel] Live agent pack repair note: ${packRepair.warnings.join(' ')}`);
          }
        }
      }
      const recent = recentLiveAgentEpisode(server.id, signature, diagnosisKey);
      if (recent) {
        if (diagnostics.some((item) => item.id === 'bedrock-pack-version')) {
          const lastNotice = Number(settingValue(`live_agent_notice_${server.id}_${diagnosisKey}`, '0')) || 0;
          if (Date.now() - lastNotice > 60 * 60 * 1000) {
            setSettingValue(`live_agent_notice_${server.id}_${diagnosisKey}`, String(Date.now()));
            appendLog(server.id, '[NexusPanel] Live agent suppressed duplicate Bedrock pack warning. Run Repair & Diagnose once after stopping the server to quarantine incompatible packs.');
          }
        }
        continue;
      }
      const analysis = await analyzeServerWithAgent(server, software, diagnostics);
      const repairContext = await advancedRepairContext(server, software, root).catch((error) => ({ error: error.message }));
      actions.push(`Live maintenance analyzed ${server.name}: ${diagnostics[0].summary}`);
      logFixed({
        serverId: server.id,
        category: 'live-maintenance',
        title: 'Live maintenance analyzed console',
        detail: diagnostics.map((item) => item.summary).join('; ').slice(0, 1200),
        source: 'live-maintenance',
      });
      if (runtimeStatus(server.id) === 'offline' && diagnostics.some((item) => ['properties-path', 'properties-syntax', 'properties-value', 'properties-encoding'].includes(item.id))) {
        const properties = await repairPropertiesFile(server);
        if (properties.repaired) {
          actions.push(`Live agent repaired properties for ${server.name}`);
          logFixed({
            serverId: server.id,
            category: 'live-agent',
            title: 'Live agent repaired server.properties',
            detail: properties.issues.join('\n') || 'Rebuilt invalid properties file.',
            source: 'live-agent',
          });
        }
      }
      if (runtimeStatus(server.id) === 'offline' && diagnostics.some((item) => item.id === 'support-config-missing')) {
        const support = await repairMissingSupportConfigs(server, root);
        if (support.actions.length) {
          actions.push(`Live agent rebuilt support config for ${server.name}`);
          logFixed({
            serverId: server.id,
            category: 'live-agent',
            title: 'Live agent rebuilt support config',
            detail: support.actions.join('\n'),
            source: 'live-agent',
          });
        }
      }
      if (runtimeStatus(server.id) === 'offline') {
        const advancedActions = await applyAdvancedAgentActions(server, software, root, diagnostics, repairContext, logs);
        if (advancedActions.actions.length) {
          actions.push(`Live maintenance applied ${advancedActions.actions.length} safe action(s) for ${server.name}`);
          logFixed({
            serverId: server.id,
            category: 'live-maintenance',
            title: 'Live maintenance applied safe action(s)',
            detail: advancedActions.actions.join('\n').slice(0, 1200),
            source: 'live-maintenance',
          });
        }
        if (advancedActions.warnings.length) {
          appendLog(server.id, `[NexusPanel] Live maintenance note: ${advancedActions.warnings.join(' ')}`);
        }
      }
      if (diagnostics.some((item) => ['disk-full', 'inode-full', 'read-only-fs', 'disk-io-error'].includes(item.id))) {
        appendLog(server.id, '[NexusPanel] Storage fault detected. Free disk space on the VPS or check the mount with: df -h && df -i && findmnt -T .');
      }
    }
    for (const filePath of watchFiles) {
      const stats = fs.statSync(filePath);
      if (Date.now() - stats.mtimeMs < 3 * 60 * 1000) {
        logFixed({
          serverId: server.id,
          category: 'live-agent',
          title: 'Live agent noticed file change',
          detail: displayPath(filePath),
          source: 'live-agent',
        });
      }
    }
  }
  return { actions };
}

function startSchedulers() {
  setInterval(runAutoBackups, 30 * 1000).unref();
  setInterval(() => runAdaptiveMaintenance().catch(() => {}), 2 * 60 * 1000).unref();
  setInterval(() => runHealthCheck(false).catch(() => {}), 24 * 60 * 60 * 1000).unref();
  // Reap exited tunnel children so the map never grows unbounded.
  setInterval(reapTunnelProcesses, 5 * 60 * 1000).unref();
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
        const current = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
        if (!current || isServerTombstoned(server.id) || runtimeStatus(server.id) === 'online') return;
        if (!hasJavaEula(current)) throw new Error('Minecraft EULA has not been accepted.');
        const software = softwareForServer(current);
        if (!software) throw new Error('No installed runtime is configured.');
        if (['java', 'bedrock'].includes(current.type)) await repairPropertiesFile(current);
        startServer(resolveInstalledExecutable(current, software), software);
        appendLog(current.id, '[NexusPanel] Auto-start completed.');
      } catch (error) {
        appendLog(server.id, `[NexusPanel] Auto-start failed: ${error.message}`);
      }
    }, delayMs);
    timer.unref();
  }
}

setExitHandler(async ({ server, software, code, signal, intentional, uptimeMs = 0, recoveryReason = '', runLogs = [] }) => {
  if (intentional) {
    crashHistory.delete(server.id);
    const pendingRestart = crashRestartTimers.get(server.id);
    if (pendingRestart) clearTimeout(pendingRestart);
    crashRestartTimers.delete(server.id);
    refreshWakeWatchers();
    return;
  }
  const current = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
  if (!current) return;
  const now = Date.now();
  const recent = (crashHistory.get(server.id) || []).filter((time) => now - time < 2 * 60 * 1000);
  recent.push(now);
  crashHistory.set(server.id, recent);
  const launchFailure = uptimeMs < 10 * 1000;
  pauseServerBackups(current.id, launchFailure ? 30 * 60 * 1000 : 10 * 60 * 1000, launchFailure ? 'the last launch never became stable' : 'the game crashed');
  const crash = rememberCrash(current, software, code, signal);
  const crashDiagnostics = diagnoseRuntime(runLogs, { limit: 5 });
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
    pauseServerBackups(current.id, 60 * 60 * 1000, 'a restart storm was detected');
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
  let proactiveReport = null;
  if (!learnedRecovery && !targetedPropertyHeal) {
    proactiveReport = await runServerRepair(current, software, { allowModelTools: true, logs: runLogs })
      .then((report) => {
        appendLog(current.id, `[NexusPanel] Proactive crash repair completed: ${report.summary}`);
        (report.concreteActions || []).forEach((action) => appendLog(current.id, `[NexusPanel] Repair action: ${action}`));
        (report.warnings || []).slice(0, 4).forEach((warning) => appendLog(current.id, `[NexusPanel] Repair warning: ${warning}`));
        return report;
      })
      .catch((error) => appendLog(current.id, `[NexusPanel] Proactive crash repair warning: ${error.message}`));
    if (proactiveReport && proactiveReport.shouldRestart === false) {
      pauseServerBackups(current.id, 60 * 60 * 1000, 'repair did not find a safe automatic world fix');
      appendLog(current.id, '[NexusPanel] Auto-restart stopped because Repair did not apply a concrete fix for this Bedrock world crash. Restore a verified backup or remove the incompatible world/pack files, then start manually.');
      return;
    }
  }
  const restartDelaySeconds = launchFailure ? 10 * recent.length : 5;
  appendLog(current.id, `[NexusPanel] Unexpected exit detected. Restarting in ${restartDelaySeconds} seconds...`);
  const previousTimer = crashRestartTimers.get(current.id);
  if (previousTimer) clearTimeout(previousTimer);
  const timer = setTimeout(async () => {
    crashRestartTimers.delete(current.id);
    try {
      const latest = db.prepare('SELECT * FROM servers WHERE id = ?').get(current.id);
      if (latest && !isServerTombstoned(current.id) && runtimeStatus(current.id) === 'offline') {
        if (['java', 'bedrock'].includes(latest.type)) await repairPropertiesFile(latest);
        startServer(resolveInstalledExecutable(latest, software), software);
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

  const envEmail = String(process.env.NEXUSPANEL_OWNER_EMAIL || '').trim();
  const envPassword = String(process.env.NEXUSPANEL_OWNER_PASSWORD || '');
  if (!envEmail || !envPassword) {
    ensureSetupToken();
    console.log('No owner account exists yet. Complete first-run setup using the setup URL printed by the installer.');
    return;
  }

  createUser({
    email: envEmail,
    name: process.env.NEXUSPANEL_OWNER_NAME || 'Owner',
    password: envPassword,
    role: 'owner',
    accessLevel: 100,
  });
  finishInitialSetup();
  console.log(`Created owner account from NEXUSPANEL_OWNER_EMAIL: ${envEmail}`);
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
