const { db } = require('./db');

function getBackupInterval(serverId) {
  const result = db.prepare(`
    SELECT backup_interval_hours, backup_interval_minutes 
    FROM servers 
    WHERE id = ?
  `).get(serverId);
  
  if (!result) {
    return { hours: 24, minutes: 0, totalMinutes: 1440 };
  }
  
  const hours = result.backup_interval_hours || 24;
  const minutes = result.backup_interval_minutes || 0;
  
  return {
    hours: hours,
    minutes: minutes,
    totalMinutes: (hours * 60) + minutes
  };
}

function setBackupInterval(serverId, hours, minutes) {
  // Validate
  const validHours = Math.max(0, Math.min(168, parseInt(hours) || 0));
  const validMinutes = Math.max(0, Math.min(59, parseInt(minutes) || 0));
  
  // If both are 0, set to 1 hour minimum
  let finalHours = validHours;
  let finalMinutes = validMinutes;
  
  if (validHours === 0 && validMinutes === 0) {
    finalHours = 1;
    finalMinutes = 0;
  }
  
  db.prepare(`
    UPDATE servers 
    SET backup_interval_hours = ?, 
        backup_interval_minutes = ?,
        scheduled_backups = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(finalHours, finalMinutes, serverId);
  
  return { hours: finalHours, minutes: finalMinutes };
}

function formatBackupInterval(hours, minutes) {
  const h = parseInt(hours) || 0;
  const m = parseInt(minutes) || 0;
  
  if (h === 0 && m === 0) return 'Disabled';
  if (h === 0) return `${m} minute${m > 1 ? 's' : ''}`;
  if (m === 0) return `${h} hour${h > 1 ? 's' : ''}`;
  return `${h}h ${m}m`;
}

function getNextBackupTime(serverId) {
  const interval = getBackupInterval(serverId);
  const totalMinutes = interval.totalMinutes;
  
  if (totalMinutes === 0) return null;
  
  const lastBackup = db.prepare('SELECT last_backup_at FROM servers WHERE id = ?')
    .get(serverId);
  
  const lastBackupTime = lastBackup?.last_backup_at || 0;
  const now = Date.now();
  
  if (lastBackupTime === 0) {
    return new Date(now + (totalMinutes * 60 * 1000));
  }
  
  const nextBackup = lastBackupTime + (totalMinutes * 60 * 1000);
  return new Date(Math.max(now, nextBackup));
}

module.exports = { 
  getBackupInterval, 
  setBackupInterval, 
  formatBackupInterval,
  getNextBackupTime
};