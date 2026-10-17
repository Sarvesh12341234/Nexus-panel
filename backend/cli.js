#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  hasSystemd,
  install,
  logsService,
  changePort,
  componentAction,
  restartService,
  serviceName,
  startService,
  status,
  stopService,
} = require('./service');
const { getUserCount } = require('./db');
const { createUser } = require('./auth');
const { doctor: platformDoctor } = require('./platform');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function help() {
  console.log(`NexusPanel CLI

Usage:
  nexuspanel version
  nexuspanel doctor
  nexuspanel platform
  nexuspanel permissions audit
  nexuspanel permissions repair
  nexuspanel start
  nexuspanel stop
  nexuspanel restart
  nexuspanel status
  nexuspanel logs
  nexuspanel change panelport 8080
  nexuspanel update
  nexuspanel install
  nexuspanel service install
  nexuspanel setup-owner
  nexuspanel setup-url
  nexuspanel asf status
  nexuspanel asf rebuild
  nexuspanel asf restart
  nexuspanel agent status
  nexuspanel agent restart
  nexuspanel agent logs
  nexuspanel users
  nexuspanel foreground

Service: ${serviceName}`);
}

function setupUrl() {
  const dataDir = path.join(__dirname, '..', 'data');
  const tokenPath = path.join(dataDir, 'setup_token');
  if (getUserCount() > 0) throw new Error('Initial setup is already complete.');
  let token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '';
  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  }
  const port = Number(process.env.PORT || 3000);
  console.log(`Setup URL: http://YOUR_VPS_IP:${port}/setup.html?token=${token}`);
}


async function ensureOwnerForCli() {
  if (getUserCount() > 0) return;
  const envEmail = String(process.env.NEXUSPANEL_OWNER_EMAIL || '').trim();
  const envPassword = String(process.env.NEXUSPANEL_OWNER_PASSWORD || '');
  const envName = String(process.env.NEXUSPANEL_OWNER_NAME || 'Owner').trim() || 'Owner';
  if (envEmail && envPassword) {
    createUser({ email: envEmail, name: envName, password: envPassword, role: 'owner', accessLevel: 100 });
    console.log(`Owner account created from NEXUSPANEL_OWNER_EMAIL: ${envEmail}`);
    return;
  }
  let input = stdin;
  let output = stdout;
  let ttyHandle = null;
  if (!stdin.isTTY && process.platform !== 'win32' && fs.existsSync('/dev/tty')) {
    ttyHandle = fs.createReadStream('/dev/tty');
    input = ttyHandle;
  }
  if (!input.isTTY) {
    throw new Error('No owner account exists. Run nexuspanel start in an interactive terminal or set NEXUSPANEL_OWNER_EMAIL and NEXUSPANEL_OWNER_PASSWORD.');
  }
  console.log('\nNexusPanel first run: create the owner account before the service starts.');
  const rl = readline.createInterface({ input, output });
  try {
    const name = (await rl.question('Owner account name [Owner]: ')).trim() || 'Owner';
    const email = (await rl.question('Owner email: ')).trim();
    const password = await rl.question('Owner password (12+ chars): ');
    createUser({ email, name, password, role: 'owner', accessLevel: 100 });
    console.log('Owner account created. Starting NexusPanel...');
  } finally {
    rl.close();
    if (ttyHandle) ttyHandle.destroy();
  }
}

// Helper function to format dates with timezone
function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return dateString;
  }
}

async function main() {
  const command = process.argv[2] || 'status';

  // Handle user list command
  if (command === 'users' || command === 'list-users') {
    const { db } = require('./db');
    console.log('\n=== NexusPanel User Database ===\n');

    const users = db.prepare('SELECT id, email, name, role, access_level, created_at FROM users ORDER BY created_at DESC').all();

    if (users.length === 0) {
      console.log('❌ No users found in database.');
      console.log('   Run: npm start (to create owner account)');
      process.exit(0);
    }

    console.log(`Found ${users.length} user(s):\n`);

    users.forEach((user, index) => {
      console.log(`${index + 1}. ${user.name} (${user.email})`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Access Level: ${user.access_level}`);
      console.log(`   Created: ${formatDate(user.created_at)}`);
      console.log('');
    });

    console.log('=== Sessions ===\n');

    const sessions = db.prepare('SELECT id, user_id, expires_at FROM sessions LIMIT 10').all();

    if (sessions.length === 0) {
      console.log('No active sessions.');
    } else {
      console.log(`${sessions.length} session(s):`);
      sessions.forEach((session, index) => {
        const isExpired = session.expires_at < Date.now();
        const status = isExpired ? '❌ EXPIRED' : '✅ ACTIVE';
        const expiresAt = new Date(session.expires_at).toLocaleString();
        console.log(`${index + 1}. User ${session.user_id} - ${status} (expires: ${expiresAt})`);
      });
    }

    console.log('');
    process.exit(0);
  }

  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log('NexusPanel 1.0.0');
    return;
  }
  if (command === 'setup-url') return setupUrl();
  if (command === 'permissions' && ['audit', 'repair'].includes(process.argv[3])) {
    const { audit, repair } = require('./permission_repair');
    const root = path.join(__dirname, '..');
    const servers = path.join(root, 'servers');
    const mutable = ['data', 'servers', 'software', 'backups', 'backupfolder'].map((name) => path.join(root, name)).filter((target) => fs.existsSync(target));
    const targets = [...mutable, ...(fs.existsSync(servers) ? fs.readdirSync(servers, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(servers, e.name)) : [])];
    const output = targets.map((target) => process.argv[3] === 'repair' ? repair(target, { owner: process.platform === 'win32' ? null : require('os').userInfo().username }) : audit(target));
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === 'setup-owner' || command === 'owner:setup') {
    await ensureOwnerForCli();
    console.log('Owner account is ready.');
    return;
  }
  if (command === 'install') {
    await ensureOwnerForCli();
    return install({ start: true });
  }
  if (command === 'service' && process.argv[3] === 'install') {
    await ensureOwnerForCli();
    return install({ start: !process.argv.includes('--no-start') });
  }
  if (command === 'start') {
    await ensureOwnerForCli();
    return startService();
  }
  if (command === 'stop') return stopService();
  if (command === 'restart') return restartService();
  if (command === 'status') return status();
  if (command === 'logs') return logsService();
  if (command === 'change' && process.argv[3] === 'panelport') return changePort(process.argv[4]);
  if (command === 'asf' && (process.argv[3] || 'status') === 'status') {
    const { kernelStatus } = require('./asf');
    console.log(JSON.stringify(kernelStatus({ refresh: true }), null, 2));
    return;
  }
  if (command === 'asf' && process.argv[3] === 'rebuild') {
    const { nativeStatus } = require('./asf_native');
    console.log(JSON.stringify(nativeStatus({ build: true, force: true }), null, 2));
    return;
  }
  if (command === 'asf' && ['start', 'stop', 'restart'].includes(process.argv[3])) return componentAction('asf', process.argv[3]);
  if (command === 'asf' && process.argv[3] === 'logs') return run('journalctl', ['-u', 'nexuspanel-asf', '-n', '100', '--no-pager']);
  if (command === 'agent' && (process.argv[3] || 'status') === 'status') {
    const { localStatus, request } = require('./host_agent');
    console.log(JSON.stringify({ ...localStatus(), live: await request('STATUS') }, null, 2));
    return;
  }
  if (command === 'agent' && ['start', 'stop', 'restart'].includes(process.argv[3])) return componentAction('agent', process.argv[3]);
  if (command === 'agent' && process.argv[3] === 'logs') return run('journalctl', ['-u', 'nexuspanel-host-agent', '-n', '100', '--no-pager']);
  if (command === 'update') return run('bash', [path.join(__dirname, '..', 'update', 'update.sh'), process.argv[3] || ''], { cwd: path.join(__dirname, '..') });
  if (command === 'foreground') {
    await ensureOwnerForCli();
    return require('./index');
  }
  if (command === 'platform') {
    console.log(JSON.stringify(platformDoctor(), null, 2));
    return;
  }
  if (command === 'doctor') {
    const { kernelStatus } = require('./asf');
    const { localStatus, request } = require('./host_agent');
    console.log(JSON.stringify({
      version: '1.0.0',
      platform: platformDoctor(),
      node: process.version,
      systemd: hasSystemd(),
      service: status({ quiet: true }),
      asf: kernelStatus({ refresh: true }),
      hostAgent: { ...localStatus(), live: await request('STATUS') },
    }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  Promise.resolve(main()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}


// NexusPanel 3.2.2 advanced diagnostics commands.
if (process.argv[2] === 'advanced-health') {
  const {HealthEngine}=require('./advanced/operations');
  const h=new HealthEngine();
  const server=process.argv[3] || 'local';
  console.log(JSON.stringify(h.score(server), null, 2));
  process.exit(0);
}
