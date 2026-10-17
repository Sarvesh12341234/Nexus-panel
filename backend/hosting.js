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
const mysql = require('mysql2/promise');

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

function databaseHostConfig() {
  const host = String(process.env.NEXUSPANEL_DB_HOST || '').trim();
  const port = Number(process.env.NEXUSPANEL_DB_PORT || 3306);
  const username = String(process.env.NEXUSPANEL_DB_USER || '').trim();
  const password = String(process.env.NEXUSPANEL_DB_PASSWORD || '');
  const allowedHost = String(process.env.NEXUSPANEL_DB_ALLOWED_HOST || '%').trim();
  const publicHost = String(process.env.NEXUSPANEL_DB_PUBLIC_HOST || host).trim();
  const configured = Boolean(host && username && password && Number.isSafeInteger(port) && port >= 1 && port <= 65535);
  return {
    configured,
    host,
    port,
    publicHost,
    allowedHost,
  };
}

function requireDatabaseHostConfig() {
  const config = databaseHostConfig();
  if (!config.configured) {
    throw new Error('Database provisioning is not configured. Set NEXUSPANEL_DB_HOST, NEXUSPANEL_DB_USER, and NEXUSPANEL_DB_PASSWORD for the panel service.');
  }
  if (!/^[A-Za-z0-9%._:-]{1,255}$/.test(config.allowedHost)) {
    throw new Error('NEXUSPANEL_DB_ALLOWED_HOST must be a valid host pattern such as %, an IP address, or a hostname.');
  }
  return {
    ...config,
    username: String(process.env.NEXUSPANEL_DB_USER).trim(),
    password: String(process.env.NEXUSPANEL_DB_PASSWORD),
  };
}

function sqlIdentifier(value) {
  const identifier = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(identifier)) throw new Error('Generated database identifier is invalid.');
  return `\`${identifier}\``;
}

function sqlString(value) {
  const string = String(value);
  if (string.includes('\0')) throw new Error('Database SQL value contains an invalid character.');
  return `'${string.replaceAll("'", "''")}'`;
}

function mysqlAccount(user, host) {
  return `${sqlString(user)}@${sqlString(host)}`;
}

function jdbcUrl(row, password) {
  const host = net.isIP(row.host) === 6 ? `[${row.host}]` : row.host;
  const scheme = row.driver === 'postgres' ? 'postgresql' : 'mysql';
  return `jdbc:${scheme}://${host}:${row.port}/${encodeURIComponent(row.database)}?user=${encodeURIComponent(row.username)}&password=${encodeURIComponent(password)}`;
}

function connectionDetails(connectionId) {
  const row = db.prepare('SELECT * FROM database_connections WHERE id = ?').get(Number(connectionId));
  if (!row) throw new Error('Connection not found.');
  const password = decryptPassword(row.password_encrypted);
  if (row.provisioned && !password) throw new Error('Could not decrypt the saved database password. Check the panel database secret file.');
  return {
    id: Number(row.id),
    serverId: row.server_id,
    name: row.name,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    password,
    database: row.database,
    driver: row.driver,
    userHost: row.user_host || '%',
    provisioned: Boolean(row.provisioned),
    jdbcUrl: jdbcUrl(row, password),
  };
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
    provisioned: Boolean(row.provisioned),
    userHost: row.user_host || '%',
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

async function provisionDatabase(serverId, input = {}, options = {}) {
  const cleanServerId = Number(serverId);
  if (!Number.isSafeInteger(cleanServerId) || cleanServerId < 1) throw new Error('Choose a server before provisioning a database.');
  const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(cleanServerId);
  if (!server) throw new Error('Server not found.');
  const name = String(input.name || '').trim().slice(0, 80);
  if (name.length < 2) throw new Error('Database name must be at least 2 characters.');
  const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (slug.length < 2) throw new Error('Database name needs at least two letters or numbers.');
  const hostConfig = requireDatabaseHostConfig();
  const database = `s${cleanServerId}_${slug}_${crypto.randomBytes(4).toString('hex')}`;
  const username = `np${crypto.randomBytes(12).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const account = mysqlAccount(username, hostConfig.allowedHost);
  const connect = options.connect || mysql.createConnection;
  const admin = await connect({
    host: hostConfig.host,
    port: hostConfig.port,
    user: hostConfig.username,
    password: hostConfig.password,
    connectTimeout: 5000,
  });
  let savedConnectionId;
  try {
    await admin.query(`CREATE DATABASE ${sqlIdentifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`CREATE USER ${account} IDENTIFIED BY ${sqlString(password)}`);
    await admin.query(`GRANT ALL PRIVILEGES ON ${sqlIdentifier(database)}.* TO ${account}`);
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO database_connections
        (server_id, name, host, port, username, password_encrypted, database, driver, provisioned, user_host, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'mysql', 1, ?, ?, ?)
    `).run(
      cleanServerId,
      name,
      hostConfig.publicHost,
      hostConfig.port,
      username,
      encryptPassword(password),
      database,
      hostConfig.allowedHost,
      now,
      now,
    );
    savedConnectionId = Number(result.lastInsertRowid);
  } catch (error) {
    try { await admin.query(`DROP USER IF EXISTS ${account}`); } catch (cleanupError) {
      console.error(`[NexusPanel] Could not clean up provisioned database user ${username}: ${cleanupError.message}`);
    }
    try { await admin.query(`DROP DATABASE IF EXISTS ${sqlIdentifier(database)}`); } catch (cleanupError) {
      console.error(`[NexusPanel] Could not clean up provisioned database ${database}: ${cleanupError.message}`);
    }
    throw error;
  } finally {
    await admin.end();
  }
  return connectionDetails(savedConnectionId);
}

async function rotateProvisionedPassword(connectionId, options = {}) {
  const row = db.prepare('SELECT * FROM database_connections WHERE id = ?').get(Number(connectionId));
  if (!row) throw new Error('Connection not found.');
  if (!row.provisioned) throw new Error('Password rotation is available only for databases provisioned by NexusPanel.');
  const hostConfig = requireDatabaseHostConfig();
  const userHost = row.user_host || hostConfig.allowedHost;
  const account = mysqlAccount(row.username, userHost);
  const password = crypto.randomBytes(24).toString('base64url');
  const connect = options.connect || mysql.createConnection;
  const admin = await connect({
    host: hostConfig.host,
    port: hostConfig.port,
    user: hostConfig.username,
    password: hostConfig.password,
    connectTimeout: 5000,
  });
  try {
    await admin.query(`ALTER USER ${account} IDENTIFIED BY ${sqlString(password)}`);
    db.prepare('UPDATE database_connections SET password_encrypted = ?, updated_at = ? WHERE id = ?')
      .run(encryptPassword(password), Date.now(), Number(connectionId));
  } finally {
    await admin.end();
  }
  return connectionDetails(connectionId);
}

async function deleteProvisionedDatabase(connectionId, options = {}) {
  const row = db.prepare('SELECT * FROM database_connections WHERE id = ?').get(Number(connectionId));
  if (!row) throw new Error('Connection not found.');
  if (row.provisioned) {
    const hostConfig = requireDatabaseHostConfig();
    const account = mysqlAccount(row.username, row.user_host || hostConfig.allowedHost);
    const connect = options.connect || mysql.createConnection;
    const admin = await connect({
      host: hostConfig.host,
      port: hostConfig.port,
      user: hostConfig.username,
      password: hostConfig.password,
      connectTimeout: 5000,
    });
    try {
      await admin.query(`DROP USER IF EXISTS ${account}`);
      await admin.query(`DROP DATABASE IF EXISTS ${sqlIdentifier(row.database)}`);
    } finally {
      await admin.end();
    }
  }
  deleteConnection(connectionId);
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

/** Authenticate to MySQL and run a query; use a TCP probe for PostgreSQL. */
function testConnection(connectionId) {
  const row = db.prepare('SELECT * FROM database_connections WHERE id = ?').get(Number(connectionId));
  if (!row) throw new Error('Connection not found.');
  if (row.driver === 'mysql') {
    return (async () => {
      const startedAt = Date.now();
      let connection;
      try {
        connection = await mysql.createConnection({
          host: row.host,
          port: row.port,
          user: row.username,
          password: decryptPassword(row.password_encrypted),
          database: row.database,
          connectTimeout: 4000,
        });
        await connection.query('SELECT 1');
        return { ok: true, latencyMs: Date.now() - startedAt, detail: 'MySQL authentication and query succeeded.' };
      } catch (error) {
        return { ok: false, latencyMs: Date.now() - startedAt, detail: error.code || error.message };
      } finally {
        await connection?.end().catch(() => {});
      }
    })();
  }
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
  connectionDetails,
  connectionRows,
  createAllocation,
  createConnection,
  databaseHostConfig,
  deleteProvisionedDatabase,
  deleteAllocation,
  deleteConnection,
  probeAllocation,
  provisionDatabase,
  rotateProvisionedPassword,
  testConnection,
  updateConnection,
};
