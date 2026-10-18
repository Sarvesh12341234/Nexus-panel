'use strict';

const assert = require('node:assert/strict');
const {
  backupIntervalMinutesFrom,
  backupScheduleAnchor,
  nextScheduledBackupAt,
} = require('../backend/backup_schedule');

const now = 2_000_000_000_000;
const server = {
  scheduled_backups: 1,
  backup_interval_hours: 24,
  backup_interval_minutes: 60,
  last_backup_at: now - 30 * 60 * 1000,
  backup_schedule_updated_at: now,
};

assert.equal(backupIntervalMinutesFrom(server), 60);
assert.equal(backupScheduleAnchor(server), now);
assert.equal(nextScheduledBackupAt(server, now), now + 60 * 60 * 1000);
assert.equal(nextScheduledBackupAt({ ...server, backup_schedule_updated_at: 0 }, now), now + 30 * 60 * 1000);
assert.equal(nextScheduledBackupAt({ ...server, scheduled_backups: 0 }, now), 0);
assert.equal(nextScheduledBackupAt({
  scheduled_backups: 1,
  backup_interval_hours: 24,
  backup_interval_minutes: 0,
  last_backup_at: 0,
  backup_schedule_updated_at: 0,
}, now), now);

console.log('Backup schedule tests passed.');
