const fs = require('node:fs');
const path = require('node:path');
const { assertSupportedNode } = require('./node_version');

assertSupportedNode();

/**
 * SQLite driver selection.
 *
 * node:sqlite is experimental before Node 24 and its API can shift between
 * minors, so we use better-sqlite3 only if it exposes the DatabaseSync API
 * consumed below; otherwise we fall back to node:sqlite. Both expose the
 * compatible prepare().run/get/all and exec methods used by the panel.
 *
 * The current better-sqlite3 package exports a different constructor API, so
 * it falls back to node:sqlite until a compatible adapter is available.
 */
let DatabaseSync;
let sqliteDriver = 'node:sqlite';
try {
  const betterSqlite3 = require('better-sqlite3');
  if (typeof betterSqlite3.DatabaseSync !== 'function') throw new Error('better-sqlite3 does not expose the DatabaseSync interface.');
  ({ DatabaseSync } = betterSqlite3);
  sqliteDriver = 'better-sqlite3';
} catch {
  ({ DatabaseSync } = require('node:sqlite'));
}

const dataDir = process.env.NEXUSPANEL_DATA_DIR
  ? path.resolve(process.env.NEXUSPANEL_DATA_DIR)
  : process.env.NEXUSPANEL_DATA_ROOT
    ? path.resolve(process.env.NEXUSPANEL_DATA_ROOT)
    : path.join(__dirname, '..', 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o750 });
} catch (error) {
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    console.error(
      `[NexusPanel] Cannot create data directory ${dataDir}: permission denied.\n`
      + `  Fix: set NEXUSPANEL_DATA_DIR to a writable path, or chown the existing one.`,
    );
  } else {
    throw error;
  }
}

const databasePath = path.join(dataDir, 'nexuspanel.sqlite');
const databaseBackupDir = path.join(dataDir, 'db-backups');
fs.mkdirSync(databaseBackupDir, { recursive: true });

function verifiedBackupPaths() {
  return fs.readdirSync(databaseBackupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^nexuspanel-\d+\.sqlite$/.test(entry.name))
    .map((entry) => path.join(databaseBackupDir, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function openDatabaseWithRecovery() {
  let opened;
  try {
    opened = new DatabaseSync(databasePath);
    const result = opened.prepare('PRAGMA quick_check').get();
    if (result.quick_check !== 'ok') {
      opened.close();
      opened = null;
      throw new Error(`SQLite quick_check: ${result.quick_check}`);
    }
    return opened;
  } catch (error) {
    try { opened?.close(); } catch {}
    const damagedPath = `${databasePath}.damaged-${Date.now()}`;
    if (fs.existsSync(databasePath)) fs.renameSync(databasePath, damagedPath);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databasePath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${damagedPath}${suffix}`);
    }
    for (const backup of verifiedBackupPaths()) {
      let recovered;
      try {
        fs.copyFileSync(backup, databasePath);
        recovered = new DatabaseSync(databasePath);
        const result = recovered.prepare('PRAGMA quick_check').get();
        if (result.quick_check !== 'ok') throw new Error(result.quick_check);
        console.error(`[NexusPanel] Recovered SQLite database from ${path.basename(backup)}. Damaged copy: ${path.basename(damagedPath)}`);
        return recovered;
      } catch {
        try { recovered?.close(); } catch {}
        fs.rmSync(databasePath, { force: true });
      }
    }
    throw error;
  }
}

const db = openDatabaseWithRecovery();
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
    access_level INTEGER NOT NULL DEFAULT 0 CHECK (access_level BETWEEN 0 AND 100),
    permissions_json TEXT,
    expires_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    user_agent_hash TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    ip_changed_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'bedrock',
    host TEXT NOT NULL DEFAULT '127.0.0.1',
    port INTEGER NOT NULL DEFAULT 19132,
    status TEXT NOT NULL DEFAULT 'offline',
    max_memory_mb INTEGER NOT NULL DEFAULT 1024,
    auto_start INTEGER NOT NULL DEFAULT 0,
    auto_restart INTEGER NOT NULL DEFAULT 1,
    crash_backup INTEGER NOT NULL DEFAULT 1,
    scheduled_backups INTEGER NOT NULL DEFAULT 1,
    backup_interval_hours INTEGER NOT NULL DEFAULT 24,
    backup_interval_minutes INTEGER NOT NULL DEFAULT 0,
    last_backup_at INTEGER NOT NULL DEFAULT 0,
    backup_schedule_updated_at INTEGER NOT NULL DEFAULT 0,
    backup_retention INTEGER NOT NULL DEFAULT 4,
    wake_on_join INTEGER NOT NULL DEFAULT 0,
    whitelist INTEGER NOT NULL DEFAULT 0,
    tunnel_provider TEXT NOT NULL DEFAULT 'none',
    public_alias TEXT NOT NULL DEFAULT '',
    startup_delay_sec INTEGER NOT NULL DEFAULT 0,
    startup_flags TEXT NOT NULL DEFAULT '',
    server_path TEXT NOT NULL DEFAULT '',
    software_key TEXT NOT NULL DEFAULT '',
    software_version TEXT NOT NULL DEFAULT 'latest',
    executable_path TEXT NOT NULL DEFAULT '',
    install_status TEXT NOT NULL DEFAULT 'missing',
    install_progress INTEGER NOT NULL DEFAULT 0,
    install_message TEXT NOT NULL DEFAULT 'Software not installed',
    cpu_cores INTEGER NOT NULL DEFAULT 1,
    disk_limit_mb INTEGER NOT NULL DEFAULT 0,
    template_key TEXT NOT NULL DEFAULT '',
    nexu_payload TEXT NOT NULL DEFAULT '',
    nexus_mark_profile TEXT NOT NULL DEFAULT '',
    owner_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS plugins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tunnel_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    token TEXT NOT NULL DEFAULT '',
    remote_host TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, provider),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS upload_sessions (
    server_id INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    uploaded_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    message TEXT NOT NULL DEFAULT '',
    chunks_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, relative_path),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    email TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS panel_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS nexu_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS password_reset_otps (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS backup_share_codes (
    server_id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS backup_share_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_server_id INTEGER NOT NULL,
    target_server_id INTEGER NOT NULL,
    requester_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
    expires_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_server_id, target_server_id),
    FOREIGN KEY (source_server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (target_server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS auth_throttle (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    window_started_at INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS backup_public_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repair_crash_state (
    server_id INTEGER PRIMARY KEY,
    signature TEXT NOT NULL,
    software_key TEXT NOT NULL DEFAULT '',
    sample TEXT NOT NULL DEFAULT '',
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repair_playbooks (
    signature TEXT PRIMARY KEY,
    software_key TEXT NOT NULL DEFAULT '',
    sample TEXT NOT NULL DEFAULT '',
    actions_json TEXT NOT NULL DEFAULT '[]',
    learned_from_server_id INTEGER,
    success_count INTEGER NOT NULL DEFAULT 0,
    replay_count INTEGER NOT NULL DEFAULT 0,
    last_learned_at INTEGER NOT NULL DEFAULT 0,
    last_replayed_at INTEGER NOT NULL DEFAULT 0,
    pending_validation INTEGER NOT NULL DEFAULT 0,
    validated_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS repair_command_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    signature TEXT NOT NULL,
    software_key TEXT NOT NULL DEFAULT '',
    command_hash TEXT NOT NULL,
    command_text TEXT NOT NULL DEFAULT '',
    command_preview TEXT NOT NULL DEFAULT '',
    safe_to_replay INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    stable_success_count INTEGER NOT NULL DEFAULT 0,
    replay_count INTEGER NOT NULL DEFAULT 0,
    observed_at INTEGER NOT NULL,
    validated_at INTEGER NOT NULL DEFAULT 0,
    last_replayed_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(server_id, signature, command_hash),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repair_agent_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    signature TEXT NOT NULL DEFAULT '',
    context_json TEXT NOT NULL DEFAULT '{}',
    features_json TEXT NOT NULL DEFAULT '[]',
    diagnoses_json TEXT NOT NULL DEFAULT '[]',
    plan_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'planned',
    confidence REAL NOT NULL DEFAULT 0,
    reward REAL NOT NULL DEFAULT 0,
    feedback_source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    validated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repair_agent_weights (
    label TEXT NOT NULL,
    feature_index INTEGER NOT NULL,
    weight REAL NOT NULL DEFAULT 0,
    updates INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (label, feature_index)
  );

  CREATE TABLE IF NOT EXISTS repair_web_cache (
    query_hash TEXT PRIMARY KEY,
    query_text TEXT NOT NULL,
    results_json TEXT NOT NULL DEFAULT '[]',
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repair_agent_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    plan_key TEXT NOT NULL,
    plan_json TEXT NOT NULL DEFAULT '{}',
    sandbox_json TEXT NOT NULL DEFAULT '{}',
    rollback_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'candidate',
    score REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT 0,
    validated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (episode_id) REFERENCES repair_agent_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repair_agent_terminal_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    command_key TEXT NOT NULL,
    command_preview TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    output_preview TEXT NOT NULL DEFAULT '',
    access_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fixed_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    category TEXT NOT NULL DEFAULT 'panel',
    title TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repair_agent_command_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    command_text TEXT NOT NULL DEFAULT '',
    command_preview TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    risk TEXT NOT NULL DEFAULT 'high',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT NOT NULL DEFAULT 'repair-agent',
    requested_at INTEGER NOT NULL,
    approved_by_user_id INTEGER,
    approved_at INTEGER NOT NULL DEFAULT 0,
    executed_at INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    output_preview TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS server_timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'snapshot',
    title TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    manifest_json TEXT NOT NULL DEFAULT '{}',
    actor_user_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS panel_presence (
    user_id INTEGER NOT NULL,
    server_id INTEGER,
    view TEXT NOT NULL DEFAULT '',
    cursor_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, server_id, view),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );
`);

// Insert default timezone
db.exec(`
  INSERT OR IGNORE INTO panel_settings (key, value) 
  VALUES ('timezone', 'UTC')
`);

// ---------------------------------------------------------------------------
// Tebex rank-giving integration (payment gateway)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS tebex_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL UNIQUE,
    webstore_secret TEXT NOT NULL DEFAULT '',
    webstore_token TEXT NOT NULL DEFAULT '',
    webhook_secret TEXT NOT NULL DEFAULT '',
    webstore_id TEXT NOT NULL DEFAULT '',
    tebex_plugin_version TEXT NOT NULL DEFAULT 'v1.0.0',
    auto_config INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 0,
    last_check_at INTEGER NOT NULL DEFAULT 0,
    last_check_ok INTEGER NOT NULL DEFAULT 0,
    last_check_message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )
`);

const existingTebexConfigColumns = new Set(db.prepare('PRAGMA table_info(tebex_configs)').all().map((column) => column.name));
if (!existingTebexConfigColumns.has('webhook_secret')) {
  db.exec("ALTER TABLE tebex_configs ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''");
}
if (!existingTebexConfigColumns.has('webstore_token')) {
  db.exec("ALTER TABLE tebex_configs ADD COLUMN webstore_token TEXT NOT NULL DEFAULT ''");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tebex_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    tebex_package_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    rank TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (server_id, tebex_package_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tebex_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    package_id INTEGER NOT NULL,
    command TEXT NOT NULL,
    delay_seconds INTEGER NOT NULL DEFAULT 0,
    online_required INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (package_id) REFERENCES tebex_packages(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tebex_payments (
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
    created_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )
`);

// ---------------------------------------------------------------------------
// External database connections (Pterodactyl-style)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS database_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 3306,
    username TEXT NOT NULL,
    password_encrypted TEXT NOT NULL,
    database TEXT NOT NULL,
    driver TEXT NOT NULL DEFAULT 'mysql' CHECK (driver IN ('mysql', 'postgres')),
    provisioned INTEGER NOT NULL DEFAULT 0,
    user_host TEXT NOT NULL DEFAULT '%',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
  )
`);
const existingDatabaseConnectionColumns = new Set(db.prepare('PRAGMA table_info(database_connections)').all().map((column) => column.name));
if (!existingDatabaseConnectionColumns.has('provisioned')) {
  db.exec('ALTER TABLE database_connections ADD COLUMN provisioned INTEGER NOT NULL DEFAULT 0');
}
if (!existingDatabaseConnectionColumns.has('user_host')) {
  db.exec("ALTER TABLE database_connections ADD COLUMN user_host TEXT NOT NULL DEFAULT '%'");
}

// ---------------------------------------------------------------------------
// Network allocations (Pterodactyl-style port/IP assignment)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS network_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    label TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp', 'both')),
    assigned_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (ip, port),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
  )
`);

const serverColumns = {
  auto_start: 'INTEGER NOT NULL DEFAULT 0',
  auto_restart: 'INTEGER NOT NULL DEFAULT 1',
  crash_backup: 'INTEGER NOT NULL DEFAULT 1',
  scheduled_backups: 'INTEGER NOT NULL DEFAULT 1',
  backup_interval_hours: 'INTEGER NOT NULL DEFAULT 24',
  backup_interval_minutes: 'INTEGER NOT NULL DEFAULT 0',
  last_backup_at: 'INTEGER NOT NULL DEFAULT 0',
  backup_schedule_updated_at: 'INTEGER NOT NULL DEFAULT 0',
  backup_retention: 'INTEGER NOT NULL DEFAULT 4',
  wake_on_join: 'INTEGER NOT NULL DEFAULT 0',
  whitelist: 'INTEGER NOT NULL DEFAULT 0',
  tunnel_provider: "TEXT NOT NULL DEFAULT 'none'",
  public_alias: "TEXT NOT NULL DEFAULT ''",
  startup_delay_sec: 'INTEGER NOT NULL DEFAULT 0',
  startup_flags: "TEXT NOT NULL DEFAULT ''",
  server_path: "TEXT NOT NULL DEFAULT ''",
  software_key: "TEXT NOT NULL DEFAULT ''",
  software_version: "TEXT NOT NULL DEFAULT 'latest'",
  executable_path: "TEXT NOT NULL DEFAULT ''",
  install_status: "TEXT NOT NULL DEFAULT 'missing'",
  install_progress: 'INTEGER NOT NULL DEFAULT 0',
  install_message: "TEXT NOT NULL DEFAULT 'Software not installed'",
  cpu_cores: 'INTEGER NOT NULL DEFAULT 1',
  disk_limit_mb: 'INTEGER NOT NULL DEFAULT 0',
  template_key: "TEXT NOT NULL DEFAULT ''",
  nexu_payload: "TEXT NOT NULL DEFAULT ''",
  nexus_mark_profile: "TEXT NOT NULL DEFAULT ''",
  owner_user_id: 'INTEGER',
};

const userColumns = {
  expires_at: 'INTEGER NOT NULL DEFAULT 0',
  permissions_json: 'TEXT',
};

const uploadColumns = {
  chunks_json: "TEXT NOT NULL DEFAULT '[]'",
};

const sessionColumns = {
  last_seen_at: 'INTEGER NOT NULL DEFAULT 0',
  user_agent_hash: "TEXT NOT NULL DEFAULT ''",
  user_agent: "TEXT NOT NULL DEFAULT ''",
  ip: "TEXT NOT NULL DEFAULT ''",
  ip_changed_at: 'INTEGER NOT NULL DEFAULT 0',
};

const fixedLogColumns = {
  actor_user_id: 'INTEGER',
  actor_name: "TEXT NOT NULL DEFAULT 'System'",
};

const repairPlaybookColumns = {
  pending_validation: 'INTEGER NOT NULL DEFAULT 0',
  validated_at: 'INTEGER NOT NULL DEFAULT 0',
};

const repairAgentEpisodeColumns = {
  features_json: "TEXT NOT NULL DEFAULT '[]'",
  reward: 'REAL NOT NULL DEFAULT 0',
  feedback_source: "TEXT NOT NULL DEFAULT ''",
};

const existingServerColumns = new Set(db.prepare('PRAGMA table_info(servers)').all().map((column) => column.name));
for (const [name, definition] of Object.entries(serverColumns)) {
  if (!existingServerColumns.has(name)) {
    db.exec(`ALTER TABLE servers ADD COLUMN ${name} ${definition}`);
  }
}

const existingUserColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
for (const [name, definition] of Object.entries(userColumns)) {
  if (!existingUserColumns.has(name)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}

const existingUploadColumns = new Set(db.prepare('PRAGMA table_info(upload_sessions)').all().map((column) => column.name));
for (const [name, definition] of Object.entries(uploadColumns)) {
  if (!existingUploadColumns.has(name)) {
    db.exec(`ALTER TABLE upload_sessions ADD COLUMN ${name} ${definition}`);
  }
}

function getUserCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

const existingSessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
for (const [name, definition] of Object.entries(sessionColumns)) {
  if (!existingSessionColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
}

const existingFixedLogColumns = new Set(db.prepare('PRAGMA table_info(fixed_logs)').all().map((column) => column.name));
for (const [name, definition] of Object.entries(fixedLogColumns)) {
  if (!existingFixedLogColumns.has(name)) db.exec(`ALTER TABLE fixed_logs ADD COLUMN ${name} ${definition}`);
}

const existingRepairPlaybookColumns = new Set(db.prepare('PRAGMA table_info(repair_playbooks)').all().map((column) => column.name));
for (const [name, definition] of Object.entries(repairPlaybookColumns)) {
  if (!existingRepairPlaybookColumns.has(name)) {
    db.exec(`ALTER TABLE repair_playbooks ADD COLUMN ${name} ${definition}`);
  }
}

const existingRepairAgentEpisodeColumns = new Set(db.prepare('PRAGMA table_info(repair_agent_episodes)').all().map((column) => column.name));
for (const [name, definition] of Object.entries(repairAgentEpisodeColumns)) {
  if (!existingRepairAgentEpisodeColumns.has(name)) {
    db.exec(`ALTER TABLE repair_agent_episodes ADD COLUMN ${name} ${definition}`);
  }
}

function verifyDatabase() {
  const quick = db.prepare('PRAGMA quick_check').get();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  return {
    ok: quick.quick_check === 'ok' && foreignKeys.length === 0,
    quickCheck: quick.quick_check,
    foreignKeyErrors: foreignKeys.length,
  };
}

function backupDatabase({ force = false } = {}) {
  const latest = verifiedBackupPaths()[0];
  if (!force && latest && Date.now() - fs.statSync(latest).mtimeMs < 6 * 60 * 60 * 1000) {
    return { created: false, path: latest, verification: verifyDatabase() };
  }
  const verification = verifyDatabase();
  if (!verification.ok) throw new Error(`Database integrity check failed: ${verification.quickCheck}`);
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  const stamp = Date.now();
  const temporary = path.join(databaseBackupDir, `nexuspanel-${stamp}.sqlite.tmp`);
  const destination = path.join(databaseBackupDir, `nexuspanel-${stamp}.sqlite`);
  fs.rmSync(temporary, { force: true });
  db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
  const check = new DatabaseSync(temporary, { readOnly: true });
  const backupCheck = check.prepare('PRAGMA quick_check').get();
  check.close();
  if (backupCheck.quick_check !== 'ok') {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Created database snapshot failed verification: ${backupCheck.quick_check}`);
  }
  fs.renameSync(temporary, destination);
  for (const old of verifiedBackupPaths().slice(8)) fs.rmSync(old, { force: true });
  return { created: true, path: destination, verification };
}

try {
  backupDatabase();
} catch (error) {
  console.error(`[NexusPanel] Database snapshot warning: ${error.message}`);
}

module.exports = {
  backupDatabase,
  db,
  getUserCount,
  verifyDatabase,
};
