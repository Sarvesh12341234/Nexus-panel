const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { assertInside, ensureServerDirs } = require('./paths');

const MAX_OUTPUT = 24000;
const DEFAULT_TIMEOUT_MS = 12000;

const ALLOWED_COMMANDS = new Map([
  ['df', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['du', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['free', { args: /^-[A-Za-z0-9]+$/ }],
  ['uptime', { args: /^$/ }],
  ['uname', { args: /^-[A-Za-z0-9]+$/ }],
  ['java', { args: /^-(?:version|XshowSettings:properties)$/ }],
  ['node', { args: /^-(?:v|e)$/ }],
  ['npm', { args: /^(?:-v|--version)$/ }],
  ['systemctl', { args: /^(?:status|show|list-units|list-unit-files|reset-failed|is-active|is-enabled|cat|daemon-reload|stop)$/ }],
  ['journalctl', { args: /^(?:-u|--unit|--since|--no-pager|-n|--lines|-o|cat|short-iso|--boot)$/ }],
  ['ss', { args: /^-[A-Za-z0-9]+$|^sport$|^dport$|^=$|^:\d+$/ }],
  ['ps', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_,=.-]+$/ }],
  ['pgrep', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_.:-]+$/ }],
  ['ls', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['stat', { args: /^-[A-Za-z0-9%]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['file', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['tail', { args: /^-[A-Za-z0-9]+$|^\d+$|^[A-Za-z0-9_./:-]+$/ }],
  ['head', { args: /^-[A-Za-z0-9]+$|^\d+$|^[A-Za-z0-9_./:-]+$/ }],
  ['grep', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_.*+?()[\]{}|^$\\/:=-]+$/ }],
  ['chmod', { args: /^-[A-Za-z0-9]+$|^[0-7]{3,4}$|^[ugoa]*[+-][rwxXst]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['mkdir', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_./:-]+$/ }],
  ['touch', { args: /^-[A-Za-z0-9]+$|^[A-Za-z0-9_./:-]+$/ }],
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
  if (!rule) throw new Error(`AI terminal command is not allowed: ${executable || 'empty'}`);
  const cleanArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  if (cleanArgs.length > 32) throw new Error('AI terminal argument list is too long.');
  for (const arg of cleanArgs) {
    if (!arg || arg.length > 220 || /[\r\n;&|`$<>]/.test(arg) || !rule.args.test(arg)) {
      throw new Error(`AI terminal argument is not allowed for ${executable}.`);
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
      finish(124, 'AI terminal command timed out.');
    }, Number(request.timeoutMs || DEFAULT_TIMEOUT_MS));
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
  runAgentTerminal,
};
