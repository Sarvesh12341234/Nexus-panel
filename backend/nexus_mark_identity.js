const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { externalDataRoot, serversRoot } = require('./paths');

const identityRoot = path.join(externalDataRoot, 'nexus-mark', 'identities');
const cache = new Map();

function run(command, args, timeout = 30000) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout });
}

function commandAvailable(command) {
  const searchPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return searchPath.some((directory) => {
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function identityName(serverId) {
  const id = Number(serverId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid NexusMark server identity id.');
  return `nexusmark-s${id}`;
}

function accountUid(name) {
  const result = run('id', ['-u', name], 3000);
  return result.status === 0 ? Number(String(result.stdout || '').trim()) : 0;
}

function accountGid(name) {
  const result = run('id', ['-g', name], 3000);
  return result.status === 0 ? Number(String(result.stdout || '').trim()) : 0;
}

function accountMatches(name, serverRoot) {
  const result = run('getent', ['passwd', name], 3000);
  if (result.status !== 0) return false;
  const fields = String(result.stdout || '').trim().split(':');
  const shell = fields[6] || '';
  return fields[5] === serverRoot && /(?:^|\/)nologin$/.test(shell);
}

function createAccount(name, serverRoot) {
  if (accountUid(name)) {
    return accountMatches(name, serverRoot)
      ? { ok: true, created: false }
      : { ok: false, reason: 'account-name-conflict' };
  }
  const shell = fs.existsSync('/usr/sbin/nologin') ? '/usr/sbin/nologin' : '/sbin/nologin';
  let result = run('useradd', [
    '--system', '--user-group', '--no-create-home', '--home-dir', serverRoot,
    '--shell', shell, '--comment', 'NexusMark isolated game server', name,
  ]);
  if (result.status !== 0 && commandAvailable('adduser')) {
    result = run('adduser', ['-S', '-D', '-H', '-h', serverRoot, '-s', shell, name]);
  }
  if (result.status !== 0 || !accountUid(name)) {
    return { ok: false, reason: 'account-create-failed', error: String(result.stderr || result.stdout || '').trim().slice(0, 800) };
  }
  run('passwd', ['-l', name], 3000);
  return { ok: true, created: true };
}

function removeAclEntry(name, targets) {
  const existing = targets.filter((entry, index, values) => entry && values.indexOf(entry) === index && fs.existsSync(entry));
  if (existing.length && commandAvailable('setfacl')) run('setfacl', ['-x', `u:${name}`, '--', ...existing], 10000);
}

function directoryTree(root) {
  const directories = [root];
  const executables = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        directories.push(child);
        queue.push(child);
      } else {
        try {
          if ((fs.statSync(child).mode & 0o111) !== 0) executables.push(child);
        } catch {}
      }
    }
  }
  return { directories, executables };
}

function applyAcl(name, serverRoot, nativeBinary = '') {
  const access = run('setfacl', [
    '-R', '-P', '-m', `u:${name}:rw-,g::---,o::---,m::rwx`, '--', serverRoot,
  ], 120000);
  if (access.status !== 0) {
    return { ok: false, reason: 'acl-apply-failed', error: String(access.stderr || access.stdout || '').trim().slice(0, 800) };
  }
  const tree = directoryTree(serverRoot);
  const directories = tree.directories;
  for (let index = 0; index < directories.length; index += 100) {
    const batch = directories.slice(index, index + 100);
    const directoryAcl = run('setfacl', [
      '-m', `u:${name}:rwx,g::---,o::---,m::rwx,d:u:${name}:rwx,d:g::---,d:o::---,d:m::rwx`,
      '--', ...batch,
    ], 120000);
    if (directoryAcl.status !== 0) {
      return { ok: false, reason: 'default-acl-failed', error: String(directoryAcl.stderr || directoryAcl.stdout || '').trim().slice(0, 800) };
    }
  }
  for (let index = 0; index < tree.executables.length; index += 100) {
    const batch = tree.executables.slice(index, index + 100);
    const executableAcl = run('setfacl', ['-m', `u:${name}:rwx`, '--', ...batch], 120000);
    if (executableAcl.status !== 0) {
      return { ok: false, reason: 'executable-acl-failed', error: String(executableAcl.stderr || executableAcl.stdout || '').trim().slice(0, 800) };
    }
  }
  run('setfacl', ['-m', `u:${name}:--x`, '--', serversRoot], 10000);
  if (nativeBinary && fs.existsSync(nativeBinary)) {
    const paths = [
      externalDataRoot,
      path.join(externalDataRoot, 'nexus-mark'),
      path.dirname(nativeBinary),
      nativeBinary,
    ].filter((entry, index, values) => values.indexOf(entry) === index && fs.existsSync(entry));
    const binaryAcl = run('setfacl', ['-m', `u:${name}:r-x`, '--', ...paths], 10000);
    if (binaryAcl.status !== 0) {
      return { ok: false, reason: 'runtime-acl-failed', error: String(binaryAcl.stderr || binaryAcl.stdout || '').trim().slice(0, 800) };
    }
  }
  return { ok: true, directories: directories.length };
}

function verifyIdentity(name, serverRoot, nativeBinary = '') {
  if (!commandAvailable('runuser')) return { ok: true, verification: 'acl-applied' };
  const checks = ['test', '-r', serverRoot, '-a', '-w', serverRoot, '-a', '-x', serverRoot];
  const rootCheck = run('runuser', ['-u', name, '--', ...checks], 5000);
  if (rootCheck.status !== 0) return { ok: false, reason: 'identity-root-access-failed' };
  if (nativeBinary) {
    const binaryCheck = run('runuser', ['-u', name, '--', 'test', '-r', nativeBinary, '-a', '-x', nativeBinary], 5000);
    if (binaryCheck.status !== 0) return { ok: false, reason: 'identity-runtime-access-failed' };
  }
  return { ok: true, verification: 'runuser' };
}

function ensureServerIdentity(profile, nativeBinary = '') {
  if (process.platform !== 'linux') return { available: false, reason: 'linux-only' };
  if (process.env.NEXUSPANEL_PER_SERVER_USERS === '0') return { available: false, reason: 'disabled' };
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return { available: false, reason: 'panel-not-root' };
  if (!commandAvailable('setfacl')) return { available: false, reason: 'setfacl-missing' };
  const serverRoot = path.resolve(profile.serverRoot || '');
  const relative = path.relative(path.resolve(serversRoot), serverRoot);
  if (!serverRoot || relative.startsWith('..') || path.isAbsolute(relative)) return { available: false, reason: 'server-root-outside-storage' };

  const name = identityName(profile.serverId);
  const cacheKey = `${profile.serverId}:${serverRoot}:${nativeBinary}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && accountUid(name)) return cached.value;

  const account = createAccount(name, serverRoot);
  if (!account.ok) return { available: false, ...account, name };
  fs.mkdirSync(identityRoot, { recursive: true, mode: 0o750 });
  const markerPath = path.join(identityRoot, `${Number(profile.serverId)}.json`);
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {}
  const markerCurrent = marker?.name === name && marker?.serverRoot === serverRoot && marker?.nativeBinary === nativeBinary;

  let acl = { ok: true, directories: Number(marker?.directories || 0) };
  let verification = markerCurrent ? verifyIdentity(name, serverRoot, nativeBinary) : { ok: false };
  if (!verification.ok) {
    acl = applyAcl(name, serverRoot, nativeBinary);
    if (!acl.ok) return { available: false, ...acl, name, uid: accountUid(name) };
    verification = verifyIdentity(name, serverRoot, nativeBinary);
  }
  if (!verification.ok) return { available: false, ...verification, name, uid: accountUid(name) };

  const value = {
    available: true,
    name,
    group: name,
    uid: accountUid(name),
    gid: accountGid(name),
    created: account.created,
    aclDirectories: acl.directories,
    verification: verification.verification,
  };
  fs.writeFileSync(markerPath, JSON.stringify({ ...value, serverRoot, nativeBinary, updatedAt: Date.now() }, null, 2), { mode: 0o640 });
  cache.set(cacheKey, { value, expiresAt: Date.now() + 10 * 60 * 1000 });
  return value;
}

function identitySupportStatus() {
  if (process.platform !== 'linux') return { available: false, reason: 'linux-only' };
  if (process.env.NEXUSPANEL_PER_SERVER_USERS === '0') return { available: false, reason: 'disabled' };
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return { available: false, reason: 'panel-not-root' };
  if (!commandAvailable('setfacl')) return { available: false, reason: 'setfacl-missing' };
  if (!commandAvailable('useradd') && !commandAvailable('adduser')) return { available: false, reason: 'account-tool-missing' };
  return { available: true, method: 'locked-system-user+posix-acl' };
}

function removeServerIdentity(serverId) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return { removed: false, reason: 'root-linux-required' };
  }
  const id = Number(serverId);
  const name = identityName(id);
  const markerPath = path.join(identityRoot, `${id}.json`);
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { return { removed: false, reason: 'identity-marker-missing' }; }
  if (marker?.name !== name || Number(marker?.uid) !== accountUid(name)) {
    return { removed: false, reason: 'identity-marker-mismatch' };
  }
  removeAclEntry(name, [serversRoot, marker.nativeBinary, marker.nativeBinary && path.dirname(marker.nativeBinary)]);
  const removed = run('userdel', [name], 10000);
  if (removed.status !== 0 && accountUid(name)) {
    return { removed: false, reason: 'account-delete-failed', error: String(removed.stderr || removed.stdout || '').trim().slice(0, 800) };
  }
  try { fs.rmSync(markerPath, { force: true }); } catch {}
  for (const key of cache.keys()) if (key.startsWith(`${id}:`)) cache.delete(key);
  return { removed: true, name };
}

module.exports = { ensureServerIdentity, identityName, identitySupportStatus, removeServerIdentity };
