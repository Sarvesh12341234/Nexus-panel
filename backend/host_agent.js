const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'native', 'host-agent', 'src', 'nexus_host_agent.c');
const installRoot = process.env.NEXUSPANEL_NATIVE_ROOT || '/var/lib/nexuspanel';
const binaryPath = path.join(installRoot, 'nexus-host-agent');
const socketPath = process.env.NEXUSPANEL_HOST_AGENT_SOCKET || '/run/nexuspanel/host-agent.sock';

function build() {
  if (process.platform !== 'linux') return { available: false, reason: 'Linux is required.' };
  fs.mkdirSync(installRoot, { recursive: true, mode: 0o750 });
  const temporary = `${binaryPath}.${process.pid}.tmp`;
  const variants = [
    { name: 'maximum', flags: ['-std=c17', '-O3', '-pipe', '-flto', '-fPIE', '-pie', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=3', '-Wformat', '-Wformat-security', '-Werror=format-security', '-Wl,-z,relro,-z,now,-z,noexecstack'] },
    { name: 'compatible', flags: ['-std=c17', '-O2', '-pipe', '-fPIE', '-pie', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now,-z,noexecstack'] },
  ];
  let built = null;
  let lastError = '';
  for (const variant of variants) {
    const result = spawnSync(process.env.CC || 'cc', [...variant.flags, sourcePath, '-o', temporary], { encoding: 'utf8' });
    if (result.status === 0) {
      const probe = spawnSync(temporary, ['--version'], { encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout.trim() === '3.0.0') {
        built = variant.name;
        break;
      }
      lastError = probe.stderr || 'Host agent self-test failed.';
    } else {
      lastError = result.stderr || result.stdout || '';
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  if (!built) throw new Error(`Host agent build failed: ${lastError.slice(-2000)}`);
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, binaryPath);
  return { available: true, binaryPath, version: '3.0.0', hardening: built };
}

function request(command = 'STATUS', timeoutMs = 350) {
  if (process.platform !== 'linux') return Promise.resolve({ available: false, reason: 'Linux host agent only.' });
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(payload);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.end(`${command}\n`));
    socket.on('data', (chunk) => { output += chunk.toString('utf8').slice(0, 2048); });
    socket.on('end', () => {
      try { finish({ available: true, ...JSON.parse(output.trim()) }); }
      catch { finish({ available: false, reason: 'Invalid host-agent response.' }); }
    });
    socket.on('timeout', () => finish({ available: false, reason: 'Host agent timed out.' }));
    socket.on('error', (error) => finish({ available: false, reason: error.code || error.message }));
  });
}

function localStatus() {
  return {
    supported: process.platform === 'linux',
    sourcePath,
    binaryPath,
    socketPath,
    built: process.platform === 'linux' && fs.existsSync(binaryPath),
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(build(), null, 2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { binaryPath, build, localStatus, request, socketPath };
