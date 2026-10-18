'use strict';

function backupIntervalMinutesFrom(server) {
  const minutes = Number(server.backup_interval_minutes || 0);
  if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes);
  return Math.max(1, Number(server.backup_interval_hours || 24)) * 60;
}

function backupScheduleAnchor(server) {
  return Math.max(Number(server.last_backup_at || 0), Number(server.backup_schedule_updated_at || 0));
}

function nextScheduledBackupAt(server, now = Date.now()) {
  if (!server.scheduled_backups) return 0;
  const anchor = backupScheduleAnchor(server);
  return anchor > 0 ? anchor + backupIntervalMinutesFrom(server) * 60 * 1000 : now;
}

module.exports = { backupIntervalMinutesFrom, backupScheduleAnchor, nextScheduledBackupAt };
