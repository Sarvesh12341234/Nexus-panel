const { db } = require('./db');

function getUserTimezone(userId) {
  // Check user-specific timezone first
  const userResult = db.prepare('SELECT value FROM panel_settings WHERE key = ?')
    .get(`timezone_${userId}`);
  
  if (userResult) return userResult.value;
  
  // Fallback to global default
  const globalResult = db.prepare('SELECT value FROM panel_settings WHERE key = ?')
    .get('timezone');
  
  return globalResult?.value || 'UTC';
}

function setUserTimezone(userId, timezone) {
  // Validate timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new Error('Invalid timezone');
  }
  
  db.prepare(`
    INSERT OR REPLACE INTO panel_settings (key, value, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(`timezone_${userId}`, timezone);
}

function getAllTimezones() {
  return Intl.supportedValuesOf('timeZone');
}

module.exports = { getUserTimezone, setUserTimezone, getAllTimezones };