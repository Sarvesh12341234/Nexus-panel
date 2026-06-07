#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const path = require('node:path');
const {
  hasSystemd,
  install,
  logsService,
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
  nexuspanel update
  nexuspanel install
  nexuspanel foreground

Service: ${serviceName}`);
}

async function ensureOwnerForCli() {
  if (getUserCount() > 0) return;
  if (!stdin.isTTY) {
    throw new Error('No owner account exists. Run nexuspanel start in an interactive terminal or set NEXUSPANEL_OWNER_EMAIL and NEXUSPANEL_OWNER_PASSWORD.');
  }
  console.log('\nNexusPanel first run: create the owner account before the service starts.');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const name = (await rl.question('Owner account name [Owner]: ')).trim() || 'Owner';
    const email = (await rl.question('Owner email: ')).trim();
    const password = await rl.question('Owner password (8+ chars): ');
    createUser({ email, name, password, role: 'owner', accessLevel: 100 });
    console.log('Owner account created. Starting NexusPanel...');
  } finally {
    rl.close();
  }
}

async function main() {
  const command = process.argv[2] || 'status';
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
