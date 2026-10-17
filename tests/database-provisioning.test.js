'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuspanel-db-provisioning-'));
process.env.NEXUSPANEL_DATA_DIR = dataDir;
process.env.NEXUSPANEL_DB_SECRET = 'database-provisioning-test-secret';
process.env.NEXUSPANEL_DB_HOST = '127.0.0.1';
process.env.NEXUSPANEL_DB_PORT = '3306';
process.env.NEXUSPANEL_DB_USER = 'panel_admin';
process.env.NEXUSPANEL_DB_PASSWORD = 'local-admin-password';
process.env.NEXUSPANEL_DB_ALLOWED_HOST = '%';
process.env.NEXUSPANEL_DB_PUBLIC_HOST = 'db.example.test';

const { db } = require('../backend/db');
const hosting = require('../backend/hosting');

async function run() {
  let serverId;
  try {
    serverId = Number(db.prepare("INSERT INTO servers (name, type) VALUES (?, 'bedrock')").run('Provisioning test').lastInsertRowid);
    const hostStatus = hosting.databaseHostConfig();
    assert.equal(hostStatus.configured, true);
    assert.equal(hostStatus.allowedHost, '%');
    assert.equal(Object.hasOwn(hostStatus, 'password'), false);
    assert.equal(Object.hasOwn(hostStatus, 'username'), false);
    const queries = [];
    let ended = 0;
    const connect = async (config) => {
      assert.equal(config.host, '127.0.0.1');
      assert.equal(config.port, 3306);
      assert.equal(config.user, 'panel_admin');
      assert.equal(config.password, 'local-admin-password');
      return {
        async query(sql) {
          queries.push(sql);
          if (sql.startsWith('GRANT') && process.env.FAIL_TEST_GRANT === '1') throw new Error('grant denied');
          return [[], []];
        },
        async end() { ended += 1; },
      };
    };

    const connection = await hosting.provisionDatabase(serverId, { name: 'LuckPerms' }, { connect });
    assert.equal(connection.name, 'LuckPerms');
    assert.equal(connection.serverId, serverId);
    assert.equal(connection.host, 'db.example.test');
    assert.equal(connection.port, 3306);
    assert.equal(connection.provisioned, true);
    assert.equal(connection.userHost, '%');
    assert.match(connection.database, new RegExp(`^s${serverId}_luckperms_[a-f0-9]{8}$`));
    assert.match(connection.username, /^np[a-f0-9]{24}$/);
    assert.match(connection.password, /^[A-Za-z0-9_-]{32}$/);
    assert.match(connection.jdbcUrl, /^jdbc:mysql:\/\/db\.example\.test:3306\//);
    assert.ok(queries.some((sql) => sql.startsWith('CREATE DATABASE')));
    assert.ok(queries.some((sql) => sql.startsWith("CREATE USER 'np") && sql.includes("@'%'")));
    assert.ok(queries.some((sql) => sql.startsWith('GRANT ALL PRIVILEGES ON')));
    assert.equal(ended, 1);
    assert.equal(Object.hasOwn(hosting.connectionRows(serverId)[0], 'password'), false);

    const previousPassword = connection.password;
    const rotated = await hosting.rotateProvisionedPassword(connection.id, { connect });
    assert.notEqual(rotated.password, previousPassword);
    assert.ok(queries.some((sql) => sql.startsWith('ALTER USER')));
    assert.equal(hosting.connectionDetails(connection.id).password, rotated.password);

    await hosting.deleteProvisionedDatabase(connection.id, { connect });
    assert.ok(queries.some((sql) => sql.startsWith('DROP USER IF EXISTS')));
    assert.ok(queries.some((sql) => sql.startsWith('DROP DATABASE IF EXISTS')));
    assert.throws(() => hosting.connectionDetails(connection.id), /Connection not found/);

    const countBeforeFailure = db.prepare('SELECT COUNT(*) AS count FROM database_connections').get().count;
    process.env.FAIL_TEST_GRANT = '1';
    await assert.rejects(hosting.provisionDatabase(serverId, { name: 'Cleanup test' }, { connect }), /grant denied/);
    delete process.env.FAIL_TEST_GRANT;
    const countAfterFailure = db.prepare('SELECT COUNT(*) AS count FROM database_connections').get().count;
    assert.equal(countAfterFailure, countBeforeFailure, 'failed provisioning must not leave a panel connection record');
    assert.ok(queries.some((sql) => sql.startsWith('DROP DATABASE IF EXISTS')), 'failed provisioning must clean up the created database');

    process.env.NEXUSPANEL_DB_PASSWORD = '';
    assert.equal(hosting.databaseHostConfig().configured, false);
    await assert.rejects(hosting.provisionDatabase(serverId, { name: 'Missing config' }, { connect }), /not configured/);
    console.log('Database provisioning, password rotation, and cleanup tests passed.');
  } finally {
    if (serverId) db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
