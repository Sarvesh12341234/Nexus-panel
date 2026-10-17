const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout || 15000 });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').slice(-12000),
    stderr: String(result.stderr || '').slice(-12000),
  };
}

function numericMode(file) {
  try { return (fs.statSync(file).mode & 0o7777).toString(8); } catch { return null; }
}

function safePath(root, relative = '.') {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Path escapes server root');
  }
  return resolved;
}

function audit(root, { limit = 4000 } = {}) {
  const result = { root: path.resolve(root), exists: fs.existsSync(root), files: 0, dirs: 0, inaccessible: [], writableRoot: false, rootMode: numericMode(root) };
  if (!result.exists) return result;
  try {
    fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK | fs.constants.W_OK);
    result.writableRoot = true;
  } catch { result.writableRoot = false; }
  const stack = [path.resolve(root)];
  while (stack.length && result.files + result.dirs < limit) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) {
      result.inaccessible.push({ path: current, error: error.code || error.message });
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) { result.dirs += 1; stack.push(full); }
        else result.files += 1;
        const access = entry.isDirectory()
          ? fs.constants.R_OK | fs.constants.X_OK
          : fs.constants.R_OK;
        fs.accessSync(full, access);
      } catch (error) {
        result.inaccessible.push({ path: full, error: error.code || error.message });
      }
    }
  }
  return result;
}

function repair(root, { owner = null, group = null, dryRun = false } = {}) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) throw new Error(`Server root does not exist: ${resolved}`);
  const auditBefore = audit(resolved);
  const actions = [];
  const add = (action, args) => {
    actions.push({ action, args });
    if (!dryRun) {
      const result = run(action, args, { timeout: 30000 });
      if (!result.ok) actions[actions.length - 1].error = result.stderr || result.stdout || `exit ${result.status}`;
    }
  };

  // Never make files world-writable recursively. Directories need traversal; regular files do not need to be executable.
  add('find', [resolved, '-type', 'd', '-exec', 'chmod', 'u+rwx,g+rx,o-rwx', '{}', '+']);
  add('find', [resolved, '-type', 'f', '-exec', 'chmod', 'u+rw,g+r,o-rwx', '{}', '+']);
  // Restore executable bit only for known launcher binaries/scripts.
  for (const rel of ['start.sh', 'run.sh', 'bedrock_server', 'server.jar']) {
    const file = safePath(resolved, rel);
    if (fs.existsSync(file)) add('chmod', ['u+x,g+x,o-rwx', file]);
  }
  if (owner && group) add('chown', ['-R', `${owner}:${group}`, resolved]);
  else if (owner) add('chown', ['-R', owner, resolved]);
  const auditAfter = dryRun ? auditBefore : audit(resolved);
  return { ok: auditAfter.inaccessible.length === 0 && auditAfter.writableRoot, auditBefore, auditAfter, actions };
}

module.exports = { audit, repair, safePath, numericMode };
