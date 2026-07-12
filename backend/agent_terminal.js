const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { assertInside, ensureServerDirs } = require('./paths');

const MAX_OUTPUT = 24000;
const DEFAULT_TIMEOUT_MS = 12000;
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9=-]*$/;
const SAFE_TOKEN = /^[A-Za-z0-9_./:=,+-]+$/;
const SAFE_FILTER = /^[A-Za-z0-9_.*+?()[\]{}|^$\\/:=-]+$/;
const SYSTEMD_TOKEN = /^[A-Za-z0-9_.@*-]+(?:\.service)?$/;

const ALLOWED_COMMANDS = new Map([
  ['df', { args: FLAG, token: SAFE_TOKEN }],
  ['du', { args: FLAG, token: SAFE_TOKEN }],
  ['free', { args: FLAG }],
  ['uptime', { args: /^$/ }],
  ['uname', { args: FLAG }],
  ['whoami', { args: /^$/ }],
  ['id', { args: FLAG, token: /^[A-Za-z0-9_.-]+$/ }],
  ['which', { args: /^[A-Za-z0-9_.+-]+$/ }],
  ['cat', { args: FLAG, token: SAFE_TOKEN }],
  ['java', { args: /^-(?:version|XshowSettings:properties)$/ }],
  ['node', { args: /^-(?:v|e)$/ }],
  ['npm', { args: /^(?:-v|--version)$/ }],
  ['mount', { args: FLAG, token: SAFE_TOKEN }],
  ['findmnt', { args: FLAG, token: SAFE_TOKEN }],
  ['lsblk', { args: FLAG, token: /^[A-Za-z0-9_,+.-]+$/ }],
  ['blkid', { args: FLAG, token: SAFE_TOKEN }],
  ['dmesg', { args: FLAG, token: /^(?:err|warn|crit|alert|emerg|info|debug)$/ }],
  ['systemctl', { args: /^(?:status|show|list-units|list-unit-files|reset-failed|is-active|is-enabled|cat|daemon-reload|stop)$/, token: new RegExp(`${FLAG.source}|${SYSTEMD_TOKEN.source}`) }],
  ['journalctl', { args: /^(?:cat|short-iso|nexuspanel|nexusmark[A-Za-z0-9_.@*-]*\.service)$/, token: FLAG }],
  ['ss', { args: FLAG, token: /^(?:sport|dport|=|:\d+)$/ }],
  ['ip', { args: FLAG, token: /^[A-Za-z0-9_.:/-]+$/ }],
  ['ping', { args: FLAG, token: /^[A-Za-z0-9_.:-]+$/ }],
  ['traceroute', { args: FLAG, token: /^[A-Za-z0-9_.:-]+$/ }],
  ['dig', { args: FLAG, token: /^[A-Za-z0-9_.:-]+$/ }],
  ['nslookup', { args: FLAG, token: /^[A-Za-z0-9_.:-]+$/ }],
  ['conntrack', { args: FLAG, token: /^[A-Za-z0-9_.:=/-]+$/ }],
  ['nft', { args: /^(?:list|--handle|ruleset|table|chain|inet|ip|ip6|filter|input|output|forward)$/ }],
  ['iptables', { args: /^(?:-S|-L|-n|-v|--line-numbers)$/ }],
  ['sysctl', { args: /^(?:-a|-n)$/, token: /^[A-Za-z0-9_.-]+$/ }],
  ['lsof', { args: FLAG, token: /^[A-Za-z0-9_.:/@=-]+$/ }],
  ['ps', { args: FLAG, token: /^[A-Za-z0-9_,=.-]+$/ }],
  ['pgrep', { args: FLAG, token: /^[A-Za-z0-9_.:-]+$/ }],
  ['ls', { args: FLAG, token: SAFE_TOKEN }],
  ['stat', { args: /^--?[A-Za-z0-9%][A-Za-z0-9%=-]*$/, token: SAFE_TOKEN }],
  ['file', { args: FLAG, token: SAFE_TOKEN }],
  ['tail', { args: FLAG, token: /^\d+$|^[A-Za-z0-9_./:-]+$/ }],
  ['head', { args: FLAG, token: /^\d+$|^[A-Za-z0-9_./:-]+$/ }],
  ['grep', { args: FLAG, token: SAFE_FILTER }],
  ['wc', { args: FLAG, token: SAFE_TOKEN }],
  ['chmod', { args: FLAG, token: /^[0-7]{3,4}$|^[ugoa]*[+-][rwxXst]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['mkdir', { args: FLAG, token: SAFE_TOKEN }],
  ['touch', { args: FLAG, token: SAFE_TOKEN }],
]);

function redact(value) {
  return String(value || '')
    .replace(/\b(password|token|secret|api[-_]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=<redacted>')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .slice(-MAX_OUTPUT);
}

function commandKey(command, args) {
  return crypto.createHash('sha256').update([command, ...args].join('\0')).digest('hex');
}

function agentAccessHash(secret, command, args, purpose) {
  return crypto.createHmac('sha256', String(secret)).update(`${purpose}\0${command}\0${args.join('\0')}`).digest('hex');
}

function normalizeCommand(command, args = [], server = null) {
  const executable = path.basename(String(command || '').trim()).toLowerCase();
  const rule = ALLOWED_COMMANDS.get(executable);
  if (!rule) throw new Error(`Terminal diagnostic command is not allowed: ${executable || 'empty'}`);
  const cleanArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  if (cleanArgs.length > 32) throw new Error('Terminal diagnostic argument list is too long.');
  for (const arg of cleanArgs) {
    const allowed = rule.args.test(arg) || (rule.token && rule.token.test(arg));
    if (!arg || arg.length > 220 || /[\r\n;&|`$<>]/.test(arg) || !allowed) {
      throw new Error(`Terminal diagnostic argument is not allowed for ${executable}.`);
    }
  }
  if (server) {
    const root = ensureServerDirs(server);
    for (const arg of cleanArgs) {
      if (!/[\\/]/.test(arg)) continue;
      const resolved = path.isAbsolute(arg) ? arg : path.resolve(root, arg);
      assertInside(root, resolved);
    }
  }
  return { command: executable, args: cleanArgs };
}

function runAgentTerminal(db, secret, request) {
  const started = Date.now();
  const server = request.server || null;
  const { command, args } = normalizeCommand(request.command, request.args || [], server);
  const purpose = String(request.purpose || 'repair-agent').slice(0, 120);
  const accessHash = agentAccessHash(secret, command, args, purpose);
  const cwd = server ? ensureServerDirs(server) : path.resolve(__dirname, '..');
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (code, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanOutput = redact(`${output}${error ? `\n${error}` : ''}`);
      db.prepare(`
        INSERT INTO repair_agent_terminal_audit (
          server_id, command_key, command_preview, purpose, exit_code,
          duration_ms, output_preview, access_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        server?.id || null,
        commandKey(command, args),
        redact(`${command} ${args.join(' ')}`).slice(0, 300),
        purpose,
        Number.isFinite(Number(code)) ? Number(code) : 1,
        Date.now() - started,
        cleanOutput.slice(-4000),
        accessHash,
        Date.now(),
      );
      resolve({
        command,
        args,
        code: Number.isFinite(Number(code)) ? Number(code) : 1,
        output: cleanOutput,
        durationMs: Date.now() - started,
        accessHashPreview: `${accessHash.slice(0, 10)}...${accessHash.slice(-8)}`,
      });
    };
    const capture = (chunk) => { output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT); };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(124, 'Terminal diagnostic command timed out.');
    }, Number(request.timeoutMs || DEFAULT_TIMEOUT_MS));
    timer.unref();
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code));
  });
}

function runFullAccessCommand(db, secret, request) {
  const started = Date.now();
  const commandText = String(request.command || '').trim();
  if (!commandText) throw new Error('Full access command is empty.');
  if (commandText.length > 4000) throw new Error('Full access command is too long.');
  const purpose = String(request.purpose || 'owner-approved-full-access').slice(0, 120);
  const accessHash = agentAccessHash(secret, 'full-access-shell', [commandText], purpose);
  const cwd = request.cwd || path.resolve(__dirname, '..');
  const shell = process.platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', commandText] }
    : { command: process.env.SHELL || '/bin/bash', args: ['-lc', commandText] };
  return new Promise((resolve) => {
    const child = spawn(shell.command, shell.args, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (code, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanOutput = redact(`${output}${error ? `\n${error}` : ''}`);
      db.prepare(`
        INSERT INTO repair_agent_terminal_audit (
          server_id, command_key, command_preview, purpose, exit_code,
          duration_ms, output_preview, access_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.serverId || null,
        commandKey('full-access-shell', [commandText]),
        redact(commandText).slice(0, 300),
        purpose,
        Number.isFinite(Number(code)) ? Number(code) : 1,
        Date.now() - started,
        cleanOutput.slice(-4000),
        accessHash,
        Date.now(),
      );
      resolve({
        code: Number.isFinite(Number(code)) ? Number(code) : 1,
        output: cleanOutput,
        durationMs: Date.now() - started,
        accessHashPreview: `${accessHash.slice(0, 10)}...${accessHash.slice(-8)}`,
      });
    };
    const capture = (chunk) => { output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT); };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(124, 'Full access command timed out.');
    }, Number(request.timeoutMs || 30000));
    timer.unref();
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code));
  });
}

module.exports = {
  agentAccessHash,
  normalizeCommand,
  runFullAccessCommand,
  runAgentTerminal,
};
