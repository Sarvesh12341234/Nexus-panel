'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tebex-history-'));
const databasePath = path.join(dataDir, 'nexuspanel.sqlite');
const legacy = new DatabaseSync(databasePath);
legacy.exec(`CREATE TABLE tebex_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  username TEXT NOT NULL DEFAULT '',
  uuid TEXT NOT NULL DEFAULT '',
  package_id INTEGER,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  commands_json TEXT NOT NULL DEFAULT '[]',
  executed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
)`);
legacy.close();
process.env.NEXUSPANEL_DATA_DIR = dataDir;
process.env.NEXUSPANEL_DATA_ROOT = dataDir;

const { db } = require('../backend/db');
const { recordPayment } = require('../backend/tebex');
try {
  const migratedColumns = new Set(db.prepare('PRAGMA table_info(tebex_payments)').all().map((column) => column.name));
  assert.ok(migratedColumns.has('package_name'));
  assert.ok(migratedColumns.has('rank'));

  db.exec('PRAGMA foreign_keys = OFF');
  recordPayment(987654, {
    transactionId: 'history-test-transaction',
    username: 'spcrafting',
    packageName: 'Crafting Rank',
    rank: 'crafting',
    priceCents: 1300,
    currency: 'USD',
  });
  const payment = db.prepare('SELECT package_name, rank, price_cents, currency FROM tebex_payments WHERE transaction_id = ?')
    .get('history-test-transaction');
  assert.deepEqual({ ...payment }, {
    package_name: 'Crafting Rank',
    rank: 'crafting',
    price_cents: 1300,
    currency: 'USD',
  });
  console.log('Tebex payment history migration and persistence tests passed.');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
