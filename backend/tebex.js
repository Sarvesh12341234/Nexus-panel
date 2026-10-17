'use strict';

/**
 * Tebex rank-giving integration (payment gateway).
 *
 * Auto-configures the Tebex plugin for a Minecraft server:
 *  1. Validates the webstore secret against the Tebex plugin API.
 *  2. Fetches the webstore's packages and game servers.
 *  3. Generates the plugin config (secret, server id, rank commands).
 *  4. Writes the config into the server folder for the Tebex plugin to read.
 *  5. Stores packages + rank commands in the panel database.
 *
 * The panel never handles payments itself — Tebex does. This module only
 * configures the plugin and records payment webhooks so owners can audit them.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('./db');
const { ensureServerDirs } = require('./paths');

const TEBEX_PLUGIN_API = 'https://plugin.tebex.io';
const TEBEX_PLUGIN_VERSION = 'v1.0.0';

const DATA_ROOT = path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_ROOT, 'tebex.secret');

/** Panel-generated key for encrypting the webstore secret at rest. */
function loadSecretKey() {
  if (process.env.NEXUSPANEL_TEBEX_SECRET) return process.env.NEXUSPANEL_TEBEX_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_ROOT, { recursive: true, mode: 0o750 });
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
  return secret;
}

function encryptSecret(value) {
  const key = crypto.createHash('sha256').update(loadSecretKey()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(value) {
  try {
    const [iv, tag, data] = String(value || '').split('.');
    const key = crypto.createHash('sha256').update(loadSecretKey()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function tebexConfig(serverId) {
  return db.prepare('SELECT * FROM tebex_configs WHERE server_id = ?').get(Number(serverId)) || null;
}

function tebexPackages(serverId) {
  return db.prepare('SELECT * FROM tebex_packages WHERE server_id = ? AND active = 1 ORDER BY name').all(Number(serverId));
}

function tebexCommands(serverId) {
  return db.prepare(`
    SELECT command.*, package.name AS package_name, package.rank AS package_rank
    FROM tebex_commands command
    JOIN tebex_packages package ON package.id = command.package_id
    WHERE command.server_id = ?
    ORDER BY package.name, command.id
  `).all(Number(serverId));
}

function tebexPayments(serverId, limit = 50) {
  return db.prepare('SELECT * FROM tebex_payments WHERE server_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(Number(serverId), Math.max(1, Math.min(200, Number(limit) || 50)));
}

/**
 * Validate a webstore secret with the Tebex plugin API.
 * Endpoint: GET https://plugin.tebex.io/information
 * Auth: X-Tebex-Secret header. 403 = bad secret, 200 = valid.
 */
async function validateWebstoreSecret(secret) {
  const clean = String(secret || '').trim();
  if (!clean || clean.length < 8 || clean.length > 128) {
    throw new Error('Webstore secret must be 8-128 characters.');
  }
  const response = await fetch(`${TEBEX_PLUGIN_API}/information`, {
    headers: {
      'X-Tebex-Secret': clean,
      'X-Tebex-Plugin-Version': TEBEX_PLUGIN_VERSION,
      'User-Agent': 'NexusPanel-Tebex/1.0.0',
    },
    signal: AbortSignal.timeout(10000),
  }).catch(() => {
    throw new Error('Could not reach the Tebex plugin API. Check the VPS internet connection.');
  });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        'Tebex rejected the webstore secret (HTTP 403). '
        + 'Checklist: (1) the secret comes from Tebex → Webstore → Developer → Game servers, '
        + '(2) it belongs to a GAME SERVER integration, not a webstore-wide key, '
        + '(3) it was copied without extra spaces or quotes. '
        + 'Generate a fresh secret and try again.',
      );
    }
    if (response.status === 404) {
      throw new Error('Tebex plugin API endpoint not found. The Tebex API layout may have changed; update NexusPanel.');
    }
    throw new Error(`Tebex API returned HTTP ${response.status}.`);
  }
  const info = await response.json().catch(() => null);
  if (!info?.account?.id) throw new Error('Tebex API returned an unexpected response.');
  return {
    webstoreId: String(info.account.id),
    name: String(info.account.name || ''),
    currency: String(info.account.currency?.iso_4217 || 'USD'),
    serverId: String(info.server?.id || ''),
  };
}

function validateWebhookSecret(secret) {
  const clean = String(secret || '').trim();
  if (clean.length < 8 || clean.length > 256) {
    throw new Error('Tebex webhook signing secret must be 8-256 characters.');
  }
  return clean;
}

/** Fetch the packages defined in the webstore. */
async function fetchWebstorePackages(secret) {
  const response = await fetch(`${TEBEX_PLUGIN_API}/packages`, {
    headers: {
      'X-Tebex-Secret': String(secret || ''),
      'X-Tebex-Plugin-Version': TEBEX_PLUGIN_VERSION,
      'User-Agent': 'NexusPanel-Tebex/1.0.0',
    },
    signal: AbortSignal.timeout(10000),
  }).catch(() => {
    throw new Error('Could not reach the Tebex plugin API.');
  });
  if (!response.ok) throw new Error(`Tebex packages lookup failed: HTTP ${response.status}.`);
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.data)) throw new Error('Tebex returned an unexpected packages response.');
  return payload.data;
}

/**
 * Derive a rank name from a Tebex package.
 * "VIP Rank" -> "vip"; "Ultimate++" -> "ultimate".
 */
function rankFromPackageName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/rank|package|tier|upgrade/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 32) || 'default';
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

/**
 * Auto-configure Tebex for a server:
 *  - validate the secret
 *  - sync packages into the panel DB
 *  - write the plugin config file into the server folder
 */
async function autoConfigureTebex(server, secret, webhookSecret) {
  const clean = String(secret || '').trim();
  const cleanWebhookSecret = validateWebhookSecret(webhookSecret);
  const info = await validateWebstoreSecret(clean);
  const packages = await fetchWebstorePackages(clean);
  const now = Date.now();

  db.prepare(`
    INSERT INTO tebex_configs (server_id, webstore_secret, webhook_secret, webstore_id, tebex_plugin_version, auto_config, enabled, last_check_at, last_check_ok, last_check_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1, 'Webstore verified.', ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      webstore_secret = excluded.webstore_secret,
      webhook_secret = excluded.webhook_secret,
      webstore_id = excluded.webstore_id,
      auto_config = 1,
      enabled = 1,
      last_check_at = excluded.last_check_at,
      last_check_ok = 1,
      last_check_message = 'Webstore verified.',
      updated_at = excluded.updated_at
  `).run(Number(server.id), encryptSecret(clean), encryptSecret(cleanWebhookSecret), info.webstoreId, TEBEX_PLUGIN_VERSION, now, now, now);

  // Sync packages. Rank defaults to a cleaned package name; owners can edit it.
  const existing = new Map(db.prepare('SELECT id, tebex_package_id FROM tebex_packages WHERE server_id = ?')
    .all(Number(server.id)).map((row) => [Number(row.tebex_package_id), row.id]));
  db.prepare('UPDATE tebex_packages SET active = 0 WHERE server_id = ?').run(Number(server.id));
  for (const pkg of packages) {
    const packageId = Number(pkg.id);
    if (!Number.isSafeInteger(packageId)) continue;
    const name = String(pkg.name || `Package ${packageId}`).slice(0, 120);
    const priceAmount = Number(pkg.base_price?.amount ?? pkg.base_price ?? pkg.price?.amount ?? pkg.price ?? 0);
    const priceCents = Number.isFinite(priceAmount) ? Math.max(0, Math.round(priceAmount * 100)) : 0;
    const currency = String(
      pkg.currency?.iso_4217
      || pkg.base_price?.currency
      || pkg.price?.currency
      || (typeof pkg.currency === 'string' ? pkg.currency : '')
      || info.currency
      || 'USD',
    ).slice(0, 8).toUpperCase();
    if (existing.has(packageId)) {
      db.prepare('UPDATE tebex_packages SET name = ?, price_cents = ?, currency = ?, active = 1 WHERE id = ?')
        .run(name, priceCents, currency, existing.get(packageId));
    } else {
      const inserted = db.prepare(`
        INSERT INTO tebex_packages (server_id, tebex_package_id, name, rank, price_cents, currency, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(Number(server.id), packageId, name, rankFromPackageName(name), priceCents, currency, now);
      // Default rank command for the new package.
      db.prepare(`
        INSERT INTO tebex_commands (server_id, package_id, command, delay_seconds, online_required, enabled, created_at)
        VALUES (?, ?, ?, 0, 0, 1, ?)
      `).run(Number(server.id), inserted.lastInsertRowid, `lp user {username} parent set {rank}`, now);
    }
  }

  // Write the plugin config into the server folder so the Tebex plugin
  // (Bukkit/Spigot/Paper) picks it up on the next start.
  const root = ensureServerDirs(server);
  const configDir = path.join(root, 'plugins', 'Tebex');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o750 });
  const configPath = path.join(configDir, 'config.yml');
  const configYaml = [
    '# Auto-generated by NexusPanel — Tebex rank giving',
    `secret: ${yamlString(clean)}`,
    `server-id: ${yamlString(info.serverId)}`,
    `webstore-id: ${yamlString(info.webstoreId)}`,
    'auto-reports: true',
    'offline-command-execution: true',
    'check-for-updates: true',
    'commands:',
    ...tebexCommands(server.id).map((command) => (
      `  - package: ${yamlString(command.package_name)}\n    rank: ${yamlString(command.package_rank)}\n    command: ${yamlString(command.command)}\n    delay: ${command.delay_seconds}\n    online: ${command.online_required ? 'true' : 'false'}`
    )),
    '',
  ].join('\n');
  fs.writeFileSync(configPath, configYaml, { mode: 0o600 });

  return {
    webstoreId: info.webstoreId,
    webstoreName: info.name,
    currency: info.currency,
    packages: packages.length,
    configPath: path.relative(root, configPath).replaceAll('\\', '/'),
  };
}

function setWebhookSecret(serverId, secret) {
  const clean = validateWebhookSecret(secret);
  const result = db.prepare('UPDATE tebex_configs SET webhook_secret = ?, updated_at = ? WHERE server_id = ?')
    .run(encryptSecret(clean), Date.now(), Number(serverId));
  if (!result.changes) throw new Error('Configure the Tebex webstore before adding a webhook signing secret.');
  return { ok: true };
}

/** Update the rank for a synced package. */
function setPackageRank(serverId, packageRowId, rank) {
  const clean = String(rank || '').trim().replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 32);
  if (!clean) throw new Error('Rank must be 1-32 letters, numbers, underscores, or dashes.');
  const result = db.prepare('UPDATE tebex_packages SET rank = ? WHERE id = ? AND server_id = ?')
    .run(clean, Number(packageRowId), Number(serverId));
  if (!result.changes) throw new Error('Package not found.');
  return { ok: true, rank: clean };
}

/** Add or update the command executed when a package is purchased. */
function upsertPackageCommand(serverId, packageRowId, { command, delaySeconds = 0, onlineRequired = false, enabled = true }) {
  const clean = String(command || '').trim();
  if (!clean || clean.length > 300) throw new Error('Command must be 1-300 characters.');
  // Only allow safe placeholders; block shell metacharacters and newlines.
  if (/[\r\n;&|`$<>]/.test(clean)) throw new Error('Command contains blocked characters.');
  const pkg = db.prepare('SELECT id FROM tebex_packages WHERE id = ? AND server_id = ?')
    .get(Number(packageRowId), Number(serverId));
  if (!pkg) throw new Error('Package not found.');
  const existing = db.prepare('SELECT id FROM tebex_commands WHERE package_id = ?').get(pkg.id);
  if (existing) {
    db.prepare('UPDATE tebex_commands SET command = ?, delay_seconds = ?, online_required = ?, enabled = ? WHERE id = ?')
      .run(clean, Math.max(0, Math.min(3600, Number(delaySeconds) || 0)), onlineRequired ? 1 : 0, enabled ? 1 : 0, existing.id);
    return { ok: true, updated: true };
  }
  db.prepare(`
    INSERT INTO tebex_commands (server_id, package_id, command, delay_seconds, online_required, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Number(serverId), pkg.id, clean, Math.max(0, Math.min(3600, Number(delaySeconds) || 0)), onlineRequired ? 1 : 0, enabled ? 1 : 0, Date.now());
  return { ok: true, created: true };
}

/** Record a payment webhook (called by the Tebex plugin's relay or manually). */
function recordPayment(serverId, { transactionId, username = '', uuid = '', packageId = null, priceCents = 0, currency = 'USD', commands = [] }) {
  const cleanTxn = String(transactionId || '').trim().slice(0, 120);
  if (!cleanTxn) throw new Error('Transaction id is required.');
  db.prepare(`
    INSERT INTO tebex_payments (server_id, transaction_id, status, username, uuid, package_id, price_cents, currency, commands_json, created_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      username = excluded.username,
      package_id = excluded.package_id,
      price_cents = excluded.price_cents,
      currency = excluded.currency
  `).run(
    Number(serverId),
    cleanTxn,
    String(username || '').slice(0, 32),
    String(uuid || '').slice(0, 64),
    packageId ? Number(packageId) : null,
    Math.max(0, Math.round(Number(priceCents) || 0)),
    String(currency || 'USD').slice(0, 8).toUpperCase(),
    JSON.stringify(Array.isArray(commands) ? commands.slice(0, 20) : []),
    Date.now(),
  );
  return { ok: true, transactionId: cleanTxn };
}

/** Mark a payment as executed (the plugin ran its commands). */
function markPaymentExecuted(transactionId) {
  const result = db.prepare("UPDATE tebex_payments SET status = 'executed', executed_at = ? WHERE transaction_id = ?")
    .run(Date.now(), String(transactionId || '').slice(0, 120));
  if (!result.changes) throw new Error('Payment not found.');
  return { ok: true };
}

/** Full status payload for the Tebex section. */
function tebexStatus(serverId) {
  const config = tebexConfig(serverId);
  return {
    configured: Boolean(config?.webstore_secret),
    webhookConfigured: Boolean(config?.webhook_secret),
    enabled: Boolean(config?.enabled),
    autoConfig: Boolean(config?.auto_config),
    webstoreId: config?.webstore_id || '',
    pluginVersion: config?.tebex_plugin_version || TEBEX_PLUGIN_VERSION,
    lastCheckAt: Number(config?.last_check_at || 0),
    lastCheckOk: Boolean(config?.last_check_ok),
    lastCheckMessage: config?.last_check_message || '',
    packages: tebexPackages(serverId),
    commands: tebexCommands(serverId),
    payments: tebexPayments(serverId),
  };
}

/* ------------------------------------------------------------------ */
/* Live payment feed (webhook + SSE)                                   */
/* ------------------------------------------------------------------ */

/**
 * In-memory live feed per server. Payments pushed here are streamed to any
 * connected Tebex consoles. Not persisted — the DB is the source of truth.
 */
const paymentFeed = new Map(); // serverId -> Set<(payload) => void>

function subscribePaymentFeed(serverId, send) {
  const id = Number(serverId);
  const listeners = paymentFeed.get(id) || new Set();
  listeners.add(send);
  paymentFeed.set(id, listeners);
  return () => {
    const current = paymentFeed.get(id);
    if (!current) return;
    current.delete(send);
    if (!current.size) paymentFeed.delete(id);
  };
}

function publishPayment(serverId, payload) {
  const listeners = paymentFeed.get(Number(serverId));
  if (!listeners) return;
  for (const send of listeners) {
    try { send(payload); } catch {}
  }
}

/**
 * Verify a Tebex webhook signature.
 * Tebex hashes the raw body, then HMAC-signs that hex digest with the
 * webhook endpoint secret.
 * We recompute locally with a timing-safe compare — never trust the header.
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  const provided = String(signature || '').trim().toLowerCase();
  if (!provided || !/^[a-f0-9]{64}$/.test(provided)) return false;
  const bodyHash = crypto.createHash('sha256')
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || '')))
    .digest('hex');
  const expected = crypto.createHmac('sha256', String(secret || '')).update(bodyHash).digest('hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function normalizePaymentWebhook(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Webhook body is not a JSON object.');
  }
  const type = String(payload.type || '').toLowerCase();
  if (type === 'validation.webhook') return { ignored: true, reason: 'validation.webhook' };
  const legacyPayment = String(payload.status || '').toLowerCase() === 'payment';
  if (type !== 'payment.completed' && !legacyPayment) {
    return { ignored: true, reason: `type=${type || 'none'}` };
  }

  const subject = payload.subject && typeof payload.subject === 'object' ? payload.subject : payload;
  const products = Array.isArray(subject.products)
    ? subject.products
    : Array.isArray(subject.packages)
      ? subject.packages
      : [];
  const firstProduct = products[0] || {};
  const customer = subject.customer || {};
  const customerUsername = customer.username || firstProduct.username || subject.player || payload.player || {};
  const rawUsername = typeof customerUsername === 'string'
    ? customerUsername
    : customerUsername.username || subject.username || payload.username || '';
  const username = String(rawUsername).trim();
  const price = subject.price_paid || subject.price || firstProduct.paid_price || firstProduct.base_price || {};
  const amountCents = subject.amount_cents ?? subject.price_cents ?? firstProduct.base_price_cents;
  const amount = Number(amountCents ?? (Number(price.amount ?? price) * 100));
  const transactionId = String(subject.transaction_id || payload.transaction_id || (legacyPayment ? payload.id : '') || '')
    .trim()
    .slice(0, 120);
  if (!transactionId) throw new Error('Webhook is missing a transaction id.');

  return {
    transactionId,
    username: username.slice(0, 32),
    uuid: String(subject.uuid || payload.uuid || customerUsername.id || customer.uuid || subject.player?.uuid || payload.player?.uuid || '').slice(0, 64),
    packageId: Number(firstProduct.id) || null,
    packageName: String(firstProduct.name || 'Unknown package').slice(0, 120),
    priceCents: Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0,
    currency: String(
      subject.currency
      || price.currency
      || firstProduct.currency?.iso_4217
      || firstProduct.currency
      || 'USD',
    ).slice(0, 8).toUpperCase(),
  };
}

/**
 * Ingest a Tebex payment webhook for a server.
 * Payment events use Tebex's { type, subject } envelope and are verified over
 * the raw JSON body before any fields are trusted.
 */
function ingestWebhook(serverId, rawBody, signature) {
  const config = tebexConfig(serverId);
  if (!config?.webstore_secret) throw new Error('Tebex is not configured for this server.');
  if (!config.webhook_secret) throw new Error('Tebex webhook signing secret is not configured.');
  const secret = decryptSecret(config.webhook_secret);
  if (!secret) throw new Error('Tebex webhook signing secret could not be decrypted. Re-enter it in Tebex settings.');
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    const error = new Error('Webhook signature verification failed.');
    error.statusCode = 403;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(String(rawBody || '{}'));
  } catch {
    throw new Error('Webhook body is not valid JSON.');
  }
  const payment = normalizePaymentWebhook(payload);
  if (payment.ignored) return { ok: true, ...payment };

  // Resolve the panel package row so the feed can show the rank being granted.
  const packageRow = payment.packageId
    ? db.prepare('SELECT id, name, rank FROM tebex_packages WHERE server_id = ? AND tebex_package_id = ?')
      .get(Number(serverId), payment.packageId)
    : null;
  const commands = packageRow
    ? db.prepare('SELECT command, delay_seconds, online_required FROM tebex_commands WHERE package_id = ? AND enabled = 1')
      .all(packageRow.id)
      .map((row) => ({
        command: row.command
          .replaceAll('{username}', payment.username || '{username}')
          .replaceAll('{rank}', packageRow.rank),
        delaySeconds: row.delay_seconds,
        onlineRequired: Boolean(row.online_required),
      }))
    : [];

  recordPayment(serverId, {
    transactionId: payment.transactionId,
    username: payment.username,
    uuid: payment.uuid,
    packageId: packageRow?.id || null,
    priceCents: payment.priceCents,
    currency: payment.currency,
    commands,
  });

  const event = {
    type: 'payment',
    transactionId: payment.transactionId,
    username: payment.username,
    uuid: payment.uuid,
    packageName: packageRow?.name || payment.packageName,
    rank: packageRow?.rank || '',
    priceCents: payment.priceCents,
    currency: payment.currency,
    commands,
    at: Date.now(),
  };
  publishPayment(serverId, event);
  return { ok: true, event };
}

/** Remove the Tebex configuration and plugin config file for a server. */
function removeTebex(server) {
  const root = ensureServerDirs(server);
  const configPath = path.join(root, 'plugins', 'Tebex', 'config.yml');
  try { fs.rmSync(configPath, { force: true }); } catch {}
  try { fs.rmdirSync(path.join(root, 'plugins', 'Tebex'), { force: true }); } catch {}
  db.prepare('DELETE FROM tebex_configs WHERE server_id = ?').run(Number(server.id));
  db.prepare('DELETE FROM tebex_payments WHERE server_id = ?').run(Number(server.id));
  db.prepare('DELETE FROM tebex_commands WHERE server_id = ?').run(Number(server.id));
  db.prepare('DELETE FROM tebex_packages WHERE server_id = ?').run(Number(server.id));
  return { ok: true };
}

module.exports = {
  autoConfigureTebex,
  ingestWebhook,
  markPaymentExecuted,
  normalizePaymentWebhook,
  recordPayment,
  removeTebex,
  setWebhookSecret,
  setPackageRank,
  subscribePaymentFeed,
  tebexStatus,
  upsertPackageCommand,
  validateWebstoreSecret,
  verifyWebhookSignature,
};
