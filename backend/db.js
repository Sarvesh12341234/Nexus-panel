const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'nexuspanel.sqlite'));
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
    expires_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
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
    backup_retention INTEGER NOT NULL DEFAULT 4,
    wake_on_join INTEGER NOT NULL DEFAULT 0,
    whitelist INTEGER NOT NULL DEFAULT 0,
    tunnel_provider TEXT NOT NULL DEFAULT 'none',
    public_alias TEXT NOT NULL DEFAULT '',
    startup_delay_sec INTEGER NOT NULL DEFAULT 0,
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
    last_replayed_at INTEGER NOT NULL DEFAULT 0
  );
`);

// Insert default timezone
db.exec(`
  INSERT OR IGNORE INTO panel_settings (key, value) 
  VALUES ('timezone', 'UTC')
`);

const serverColumns = {
  auto_start: 'INTEGER NOT NULL DEFAULT 0',
  auto_restart: 'INTEGER NOT NULL DEFAULT 1',
  crash_backup: 'INTEGER NOT NULL DEFAULT 1',
  scheduled_backups: 'INTEGER NOT NULL DEFAULT 1',
  backup_interval_hours: 'INTEGER NOT NULL DEFAULT 24',
  backup_interval_minutes: 'INTEGER NOT NULL DEFAULT 0',
  last_backup_at: 'INTEGER NOT NULL DEFAULT 0',
  backup_retention: 'INTEGER NOT NULL DEFAULT 4',
  wake_on_join: 'INTEGER NOT NULL DEFAULT 0',
  whitelist: 'INTEGER NOT NULL DEFAULT 0',
  tunnel_provider: "TEXT NOT NULL DEFAULT 'none'",
  public_alias: "TEXT NOT NULL DEFAULT ''",
  startup_delay_sec: 'INTEGER NOT NULL DEFAULT 0',
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
};

const uploadColumns = {
  chunks_json: "TEXT NOT NULL DEFAULT '[]'",
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

module.exports = {
  db,
  getUserCount,
};
