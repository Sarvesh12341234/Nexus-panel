const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');

const SESSION_COOKIE = 'np_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const secretPath = path.join(__dirname, '..', 'data', 'cookie_secret');

function loadCookieSecret() {
  if (process.env.NEXUSPANEL_COOKIE_SECRET) return process.env.NEXUSPANEL_COOKIE_SECRET;
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

const COOKIE_SECRET = loadCookieSecret();

const permissions = {
  VIEW_ONLY: 0,
  POWER_SERVERS: 5,
  VIEW_CONSOLE: 20,
  SEND_COMMANDS: 40,
  MANAGE_SERVERS: 60,
  MANAGE_FILES: 80,
  MANAGE_ADMINS: 100,
};

const capabilities = Object.freeze({
  SERVER_START: 'server.start',
  SERVER_STOP: 'server.stop',
  SERVER_RESTART: 'server.restart',
  SERVER_KILL: 'server.kill',
  CONSOLE_VIEW: 'console.view',
  CONSOLE_COMMAND: 'console.command',
  SERVER_MANAGE: 'server.manage',
  SOFTWARE_MANAGE: 'software.manage',
  PROPERTIES_MANAGE: 'properties.manage',
  WHITELIST_MANAGE: 'whitelist.manage',
  PLUGINS_MANAGE: 'plugins.manage',
  FILES_MANAGE: 'files.manage',
  BACKUPS_MANAGE: 'backups.manage',
  OPTIMIZER_MANAGE: 'optimizer.manage',
  NETWORK_MANAGE: 'network.manage',
  ADMINS_MANAGE: 'admins.manage',
  SECURITY_VIEW: 'security.view',
  SETTINGS_MANAGE: 'settings.manage',
  TIMEZONE_MANAGE: 'timezone.manage',
});
const capabilityValues = new Set(Object.values(capabilities));

function normalizePermissionKeys(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map((key) => String(key)).filter((key) => capabilityValues.has(key)))];
}

function permissionKeysForUser(user) {
  if (!user || user.permissions_json == null) return null;
  try {
    return normalizePermissionKeys(JSON.parse(user.permissions_json)) || [];
  } catch {
    return [];
  }
}

function hasPermission(user, permission, fallbackLevel = 0) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  const keys = permissionKeysForUser(user);
  if (keys !== null) return keys.includes(permission);
  return Number(user.access_level || 0) >= Number(fallbackLevel || 0);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, original] = String(storedHash || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !original) return false;

  const derived = crypto.scryptSync(password, salt, 64);
  const originalBuffer = Buffer.from(original, 'hex');
  return originalBuffer.length === derived.length && crypto.timingSafeEqual(originalBuffer, derived);
}

function sign(value) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url');
}

function encodeSession(id) {
  return `${id}.${sign(id)}`;
}

function decodeSession(cookieValue) {
  const [id, signature] = String(cookieValue || '').split('.');
  if (!id || !signature) return null;
  return signature === sign(id) ? id : null;
}

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf('=');
      if (index === -1) return cookies;
      cookies[item.slice(0, index)] = decodeURIComponent(item.slice(index + 1));
      return cookies;
    }, {});
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    accessLevel: user.access_level,
    permissionKeys: permissionKeysForUser(user),
    expiresAt: user.expires_at || 0,
  };
}

function createUser({ email, name, password, role = 'admin', accessLevel = 0, permissionKeys = null, expiresAt = 0 }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail.includes('@')) throw new Error('A valid email is required.');
  if (!name || String(name).trim().length < 2) throw new Error('Name must be at least 2 characters.');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters.');

  const cleanRole = role === 'owner' ? 'owner' : 'admin';
  const cleanAccessLevel = cleanRole === 'owner' ? 100 : Math.max(0, Math.min(100, Number(accessLevel) || 0));
  const cleanPermissionKeys = cleanRole === 'owner' ? null : normalizePermissionKeys(permissionKeys);
  const cleanExpiresAt = cleanRole === 'owner' ? 0 : Math.max(0, Number(expiresAt) || 0);

  const result = db.prepare(`
    INSERT INTO users (email, name, password_hash, role, access_level, permissions_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizedEmail,
    String(name).trim(),
    hashPassword(password),
    cleanRole,
    cleanAccessLevel,
    cleanPermissionKeys === null ? null : JSON.stringify(cleanPermissionKeys),
    cleanExpiresAt,
  );

  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid));
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
  return encodeSession(id);
}

function clearSession(cookieValue) {
  const id = decodeSession(cookieValue);
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function setSessionCookie(res, value) {
  const useSecureCookie = process.env.NEXUSPANEL_SECURE_COOKIE === '1';
  const maxAge = SESSION_TTL_MS;
  const expiresDate = new Date(Date.now() + maxAge);
  
  let cookieStr = `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (useSecureCookie) cookieStr += '; Secure';
  cookieStr += `; Expires=${expiresDate.toUTCString()}; Max-Age=${Math.floor(maxAge / 1000)}`;
  
  res.setHeader('Set-Cookie', cookieStr);
}

function clearSessionCookie(res) {
  const cookieStr = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
  res.setHeader('Set-Cookie', cookieStr);
}

function authMiddleware(req, _res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = decodeSession(cookies[SESSION_COOKIE]);
  if (!sessionId) return next();

  const row = db.prepare(`
    SELECT users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).get(sessionId, Date.now());

  if (row && row.expires_at && row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(row.id, 'owner');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  } else if (row) {
    req.user = row;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  next();
}

function requireAccess(level) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Login required.' });
    if (req.user.access_level < level) return res.status(403).json({ error: 'Not enough access.' });
    next();
  };
}

function requirePermission(permission, fallbackLevel = 0) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Login required.' });
    if (!hasPermission(req.user, permission, fallbackLevel)) {
      return res.status(403).json({ error: 'This account does not have that permission.' });
    }
    next();
  };
}

module.exports = {
  SESSION_COOKIE,
  capabilities,
  permissions,
  authMiddleware,
  clearSession,
  clearSessionCookie,
  createSession,
  createUser,
  hashPassword,
  hasPermission,
  normalizePermissionKeys,
  permissionKeysForUser,
  publicUser,
  requireAccess,
  requireAuth,
  requirePermission,
  setSessionCookie,
  verifyPassword,
};
