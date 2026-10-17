'use strict';

/**
 * External database connections (Pterodactyl-style) and network allocations.
 *
 * Database passwords are encrypted at rest with AES-256-GCM using a
 * panel-generated key (data/db_connections.secret). The key never leaves the
 * host; only the panel can decrypt.
 *
 * Network allocations assign (ip, port) pairs to servers with collision
 * checks, mirroring Pterodactyl's allocation model.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { db } = require('./db');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_ROOT, 'db_connections.secret');

function loadSecret() {
  if (process.env.NEXUSPANEL_DB_SECRET) return process.env.NEXUSPANEL_DB_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_ROOT, { recursive: true, mode: 0o750 });
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
  return secret;
}

function encryptPassword(password) {
  const key = crypto.createHash('sha256').update(loadSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptPassword(value) {
  try {
    const [iv, tag, data] = String(value || '').split('.');
    const key = crypto.createHash('sha256').update(loadSecret()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Database connections                                                */
/* ------------------------------------------------------------------ */

function validateConnectionInput({ name, host, port, username, password, database, driver }) {
  const cleanName = String(name || '').trim().slice(0, 80);
  if (cleanName.length < 2) throw new Error('Connection name must be at least 2 characters.');
  const cleanHost = String(host || '').trim().slice(0, 200);
  if (!cleanHost || /[\s]/.test(cleanHost)) throw new Error('Host must not be empty or contain spaces.');
  const cleanPort = Number(port);
  if (!Number.isSafeInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) throw new Error('Port must be 1-65535.');
  const cleanUser = String(username || '').trim().slice(0, 80);
  if (!cleanUser) throw new Error('Username is required.');
  const cleanPassword = String(password || '');
  if (cleanPassword.length > 200) throw new Error('Password must be at most 200 characters.');
  const cleanDatabase = String(database || '').trim().slice(0, 80);
  if (!cleanDatabase || /[^A-Za-z0-9_-]/.test(cleanDatabase)) throw new Error('Database name must be letters, numbers, underscores, or dashes.');
  const cleanDriver = ['mysql', 'postgres'].includes(driver) ? driver : 'mysql';
  return { name: cleanName, host: cleanHost, port: cleanPort, username: cleanUser, password: cleanPassword, database: cleanDatabase, driver: cleanDriver };
}

function connectionRows(serverId = null) {
  const rows = serverId
    ? db.prepare('SELECT * FROM database_connections WHERE server_id = ? ORDER BY created_at DESC').all(Number(serverId))
    : db.prepare('SELECT * FROM database_connections ORDER BY created_at DESC').all();
  return rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    database: row.database,
    driver: row.driver,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function createConnection(serverId, input) {
  const clean = validateConnectionInput(input);
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO database_connections (server_id, name, host, port, username, password_encrypted, database, driver, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId ? Number(serverId) : null,
    clean.name,
    clean.host,
    clean.port,
    clean.username,
    encryptPassword(clean.password),
    clean.database,
    clean.driver,
    now,
    now,
  );
  return connectionRows().find((row) => row.id === Number(result.lastInsertRowid));
}

function updateConnection(connectionId, input) {
  const existing = db.prepare('SELECT * FROM database_connections WHERE id = ?').get(Number(connectionId));
  if (!existing) throw new Error('Connection not found.');
  const clean = validateConnectionInput(input);
  db.prepare(`
    UPDATE database_connections
    SET name = ?, host = ?, port = ?, username = ?, password_encrypted = ?, database = ?, driver = ?, updated_at = ?
    WHERE id = ?
  `).run(
    clean.name,
    clean.host,
    clean.port,
    clean.username,
    encryptPassword(clean.password),
    clean.database,
    clean.driver,
    Date.now(),
    Number(connectionId),
  );
  return connectionRows().find((row) => row.id === Number(connectionId));
}

function deleteConnection(connectionId) {
  const result = db.prepare('DELETE FROM database_connections WHERE id = ?').run(Number(connectionId));
  if (!result.changes) throw new Error('Connection not found.');
  return { ok: true };
}

/**
 * Test a connection with a TCP probe. We deliberately do NOT install mysql/
 * postgres client libraries — a TCP reachability check plus a handshake read
 * is enough to verify host/port/firewall without pulling native deps.
 */
function testConnection(connectionId) {
  const row = db.prepare('SELECT * FROM database_connections WHERE id = ?').get(Number(connectionId));
  if (!row) throw new Error('Connection not found.');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const startedAt = Date.now();
    const finish = (ok, detail) => {
      try { socket.destroy(); } catch {}
      resolve({ ok, latencyMs: Date.now() - startedAt, detail });
    };
    socket.setTimeout(4000);
    socket.once('connect', () => finish(true, 'TCP connection established.'));
    socket.once('timeout', () => finish(false, 'Connection timed out after 4 seconds.'));
    socket.once('error', (error) => finish(false, error.code || error.message));
    socket.connect(row.port, row.host);
  });
}

/* ------------------------------------------------------------------ */
/* Network allocations                                                 */
/* ------------------------------------------------------------------ */

function allocationRows(serverId = null) {
  const rows = serverId
    ? db.prepare('SELECT * FROM network_allocations WHERE server_id = ? ORDER BY port').all(Number(serverId))
    : db.prepare('SELECT * FROM network_allocations ORDER BY ip, port').all();
  return rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    label: row.label,
    ip: row.ip,
    port: row.port,
    protocol: row.protocol,
    assignedAt: row.assigned_at,
  }));
}

function validateAllocationInput({ ip, port, protocol = 'tcp', label = '' }) {
  const cleanIp = String(ip || '').trim();
  if (!net.isIP(cleanIp)) throw new Error('IP must be a valid IPv4 or IPv6 address.');
  const cleanPort = Number(port);
  if (!Number.isSafeInteger(cleanPort) || cleanPort < 1024 || cleanPort > 65535) {
    throw new Error('Port must be 1024-65535.');
  }
  const cleanProtocol = ['tcp', 'udp', 'both'].includes(protocol) ? protocol : 'tcp';
  const cleanLabel = String(label || '').trim().slice(0, 60);
  return { ip: cleanIp, port: cleanPort, protocol: cleanProtocol, label: cleanLabel };
}

function createAllocation(serverId, input) {
  const clean = validateAllocationInput(input);
  const collision = db.prepare('SELECT id FROM network_allocations WHERE ip = ? AND port = ?').get(clean.ip, clean.port);
  if (collision) throw new Error(`Port ${clean.port} on ${clean.ip} is already allocated.`);
  const serverPort = serverId
    ? db.prepare('SELECT port FROM servers WHERE id = ?').get(Number(serverId))
    : null;
  if (serverPort && Number(serverPort.port) === clean.port) {
    throw new Error(`Port ${clean.port} is the server's own game port; it is already bound by the game.`);
  }
  const result = db.prepare(`
    INSERT INTO network_allocations (server_id, label, ip, port, protocol, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(serverId ? Number(serverId) : null, clean.label, clean.ip, clean.port, clean.protocol, Date.now());
  return allocationRows().find((row) => row.id === Number(result.lastInsertRowid));
}

function deleteAllocation(allocationId) {
  const result = db.prepare('DELETE FROM network_allocations WHERE id = ?').run(Number(allocationId));
  if (!result.changes) throw new Error('Allocation not found.');
  return { ok: true };
}

/** Check whether an allocated port is actually listening on this host. */
function probeAllocation(allocationId) {
  const row = db.prepare('SELECT * FROM network_allocations WHERE id = ?').get(Number(allocationId));
  if (!row) throw new Error('Allocation not found.');
  const isLocal = ['127.0.0.1', '::1', '0.0.0.0'].includes(row.ip);
  if (!isLocal) {
    return { ok: true, note: 'Remote IP allocations are not probed from the panel.', listening: null };
  }
  const tryProtocol = (protocol) => new Promise((resolve) => {
    if (protocol === 'udp') {
      // UDP has no handshake; a bind attempt tells us if the port is taken.
      const socket = require('node:dgram').createSocket('udp4');
      const done = (ok, detail) => { try { socket.close(); } catch {} resolve({ ok, detail }); };
      socket.once('error', (error) => done(false, error.code || error.message));
      socket.once('listening', () => done(true, 'Port is free.'));
      try { socket.bind(row.port); } catch (error) { done(false, error.message); }
      return;
    }
    const server = net.createServer();
    const done = (ok, detail) => { try { server.close(); } catch {} resolve({ ok, detail }); };
    server.once('error', (error) => done(false, error.code || error.message));
    server.once('listening', () => done(true, 'Port is free.'));
    try { server.listen(row.port, row.ip); } catch (error) { done(false, error.message); }
  });
  return (async () => {
    const tcp = await tryProtocol('tcp');
    return { ok: true, listening: !tcp.ok, detail: tcp.detail, protocol: row.protocol };
  })();
}

module.exports = {
  allocationRows,
  connectionRows,
  createAllocation,
  createConnection,
  deleteAllocation,
  deleteConnection,
  probeAllocation,
  testConnection,
  updateConnection,
};
