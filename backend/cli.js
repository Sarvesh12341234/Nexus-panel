#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const path = require('node:path');
const {
  hasSystemd,
  install,
  logsService,
  changePort,
  restartService,
  serviceName,
  startService,
  status,
  stopService,
} = require('./service');
const { getUserCount } = require('./db');
const { createUser } = require('./auth');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function help() {
  console.log(`NexusPanel CLI

Usage:
  nexuspanel start
  nexuspanel stop
  nexuspanel restart
  nexuspanel status
  nexuspanel logs
  nexuspanel change panelport 8080
  nexuspanel update
  nexuspanel install
  nexuspanel foreground

Service: ${serviceName}`);
}

async function ensureOwnerForCli() {
  if (getUserCount() > 0) return;
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
    const password = await rl.question('Owner password (8+ chars): ');
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
  if (command === 'install') {
    await ensureOwnerForCli();
    return install({ start: true });
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
  if (command === 'update') return run('bash', [path.join(__dirname, '..', 'update', 'update.sh'), process.argv[3] || ''], { cwd: path.join(__dirname, '..') });
  if (command === 'foreground') {
    await ensureOwnerForCli();
    return require('./index');
  }
  if (command === 'doctor') {
    console.log(JSON.stringify({ systemd: hasSystemd(), service: status({ quiet: true }) }, null, 2));
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