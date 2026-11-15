'use strict';
const { exec } = require('node:child_process');

function runFullTerminal(command, cwd, options = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 10000 || command.includes('\0')) throw new Error('Enter a shell command of up to 10,000 characters.');
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: Math.max(1, Math.min(30000, (options.expiresAt || Date.now() + 30000) - Date.now())), signal: options.signal, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ command, stdout: stdout.slice(0, 12000), stderr: stderr.slice(0, 4000), exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0, error: error ? String(error.message).slice(0, 500) : null, killed: Boolean(error?.killed) });
    });
  });
}
module.exports = { runFullTerminal };
