const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { externalDataRoot } = require('./paths');

const sourcePath = path.resolve(__dirname, '..', 'native', 'nexusmark', 'src', 'nexusmark.c');
const binaryDir = path.join(externalDataRoot, 'nexus-mark', 'bin');
const binaryPath = path.join(binaryDir, 'nexusmark-native');
let cached = null;

function probeBinary(file) {
  if (!file || !fs.existsSync(file)) return null;
  const probe = spawnSync(file, ['--probe'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  if (probe.status !== 0) return {
    available: false,
    reason: 'kernel-unsupported',
    error: String(probe.stderr || probe.stdout || '').trim().slice(0, 1000),
  };
  const detail = String(probe.stdout || '').trim();
  const abi = Number(detail.match(/landlock-abi=(\d+)/)?.[1] || 0);
  const testRoot = path.join(binaryDir, `self-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(testRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    return { available: false, reason: 'self-test-setup-failed', error: error.message };
  }
  const startedAt = Date.now();
  let selfTest;
  const trueCommand = fs.existsSync('/bin/true') ? '/bin/true' : '/usr/bin/true';
  try {
    selfTest = spawnSync(file, ['--root', testRoot, '--port', '65535', '--', trueCommand], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
  } finally {
    if (path.dirname(testRoot) === binaryDir) fs.rmSync(testRoot, { recursive: true, force: true });
  }
  if (selfTest.status !== 0) return {
    available: false,
    reason: 'self-test-failed',
    error: String(selfTest.stderr || selfTest.stdout || '').trim().slice(0, 1000),
  };
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return {
    available: true,
    binary: file,
    detail,
    landlockAbi: abi,
    selfTestMs: Date.now() - startedAt,
    sha256,
  };
}

function compiler() {
  for (const candidate of [process.env.CC, 'cc', 'gcc', 'clang'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    if (probe.status === 0) return candidate;
  }
  return '';
}

function nativeStatus({ build = true } = {}) {
  if (process.platform !== 'linux') return { available: false, reason: 'linux-only' };
  if (process.env.NEXUSPANEL_NATIVE_SANDBOX === '0') return { available: false, reason: 'disabled' };
  if (!fs.existsSync(sourcePath)) return { available: false, reason: 'source-missing' };

  const sourceMtime = fs.statSync(sourcePath).mtimeMs;
  if (cached && cached.sourceMtime === sourceMtime) return cached;
  const existing = probeBinary(binaryPath);
  if (existing?.available && fs.statSync(binaryPath).mtimeMs >= sourceMtime) {
    cached = { ...existing, sourceMtime };
    return cached;
  }
  if (!build) return { available: false, reason: 'not-built', sourceMtime };

  const cc = compiler();
  if (!cc) return { available: false, reason: 'compiler-missing', sourceMtime };
  fs.mkdirSync(binaryDir, { recursive: true, mode: 0o750 });
  const temporary = `${binaryPath}.${process.pid}.tmp`;
  const baseFlags = [
    '-std=c11', '-O2', '-pipe', '-fPIE',
    '-fstack-protector-strong', '-Wformat', '-Wformat-security', '-Werror=format-security',
    '-Wl,-z,relro,-z,now,-z,noexecstack',
  ];
  const variants = [
    {
      name: 'maximum-static-pie',
      flags: [
        '-static-pie', '-DNEXUS_STATIC_BUILD=1', '-DNEXUS_HARDENED_BUILD=1',
        '-D_FORTIFY_SOURCE=3', '-fstack-clash-protection', '-fcf-protection=full',
        '-ftrivial-auto-var-init=zero', '-fvisibility=hidden', '-fno-plt', '-flto',
        '-Wl,-z,separate-code',
      ],
    },
    { name: 'static-pie', flags: ['-static-pie', '-DNEXUS_STATIC_BUILD=1', '-D_FORTIFY_SOURCE=2'] },
    { name: 'dynamic-pie', flags: ['-pie', '-D_FORTIFY_SOURCE=2'] },
  ];
  let result = null;
  let buildVariant = '';
  for (const variant of variants) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    result = spawnSync(cc, [
      ...baseFlags, ...variant.flags, sourcePath, '-o', temporary,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (result.status === 0) {
      buildVariant = variant.name;
      break;
    }
  }
  if (result.status !== 0) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (existing?.available) {
      cached = {
        ...existing,
        sourceMtime,
        staleBinary: true,
        buildWarning: String(result.stderr || result.stdout || '').trim().slice(0, 1000),
      };
      return cached;
    }
    return {
      available: false,
      reason: 'build-failed',
      error: String(result.stderr || result.stdout || '').trim().slice(0, 1000),
      sourceMtime,
    };
  }
  fs.chmodSync(temporary, 0o750);
  const candidate = probeBinary(temporary);
  if (!candidate?.available) {
    fs.rmSync(temporary, { force: true });
    if (existing?.available) {
      cached = {
        ...existing,
        sourceMtime,
        staleBinary: true,
        buildWarning: candidate?.error || candidate?.reason || 'candidate self-test failed',
      };
      return cached;
    }
    cached = { ...(candidate || { available: false, reason: 'kernel-unsupported' }), sourceMtime };
    return cached;
  }
  fs.renameSync(temporary, binaryPath);
  cached = { ...candidate, binary: binaryPath, compiler: cc, buildVariant, sourceMtime };
  return cached;
}

module.exports = { nativeStatus, sourcePath };

if (require.main === module) {
  const status = nativeStatus({ build: true });
  console.log(JSON.stringify(status, null, 2));
  if (process.platform === 'linux' && !status.available) process.exitCode = 1;
}
