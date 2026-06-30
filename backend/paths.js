const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const serversRoot = path.join(workspaceRoot, 'servers');
const softwareRoot = path.join(workspaceRoot, 'software');
const externalDataRoot = process.env.NEXUSPANEL_DATA_ROOT
  || (process.platform === 'win32'
    ? path.join(process.env.ProgramData || workspaceRoot, 'NexusPanel')
    : '/var/lib/nexuspanel');
const backupsRoot = process.env.NEXUSPANEL_BACKUP_ROOT || path.join(externalDataRoot, 'backups');
const legacyBackupsRoot = path.join(workspaceRoot, 'backups');
const legacyBackupFolderRoot = path.join(workspaceRoot, 'backupfolder');

fs.mkdirSync(serversRoot, { recursive: true });
fs.mkdirSync(softwareRoot, { recursive: true });
fs.mkdirSync(backupsRoot, { recursive: true });
for (const legacyRoot of [legacyBackupsRoot, legacyBackupFolderRoot]) {
  if (path.resolve(legacyRoot) !== path.resolve(backupsRoot) && fs.existsSync(legacyRoot)) {
    fs.cpSync(legacyRoot, backupsRoot, { recursive: true, force: false, errorOnExist: false });
  }
}

function slug(value) {
  return String(value || 'server')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'server';
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes NexusPanel storage.');
  }
  return resolvedTarget;
}

function serverPath(id, name) {
  return assertInside(serversRoot, path.join(serversRoot, `${id}-${slug(name)}`));
}

function serverRootScore(root) {
  if (!fs.existsSync(root)) return -1;
  let score = 1;
  for (const [relative, weight] of [
    ['server.properties', 12],
    ['level.dat', 8],
    ['world/level.dat', 14],
    ['worlds', 10],
    ['software', 6],
    ['plugins', 3],
    ['bedrock_server', 14],
    ['server.jar', 14],
  ]) {
    if (fs.existsSync(path.join(root, relative))) score += weight;
  }
  return score;
}

function findServerRoot(server) {
  const candidates = [];
  if (server.server_path) {
    try {
      candidates.push(assertInside(serversRoot, server.server_path));
    } catch {}
  }
  candidates.push(serverPath(server.id, server.name));
  if (fs.existsSync(serversRoot)) {
    for (const entry of fs.readdirSync(serversRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${Number(server.id)}-`)) {
        candidates.push(assertInside(serversRoot, path.join(serversRoot, entry.name)));
      }
    }
  }
  const unique = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  return unique.sort((a, b) => serverRootScore(b) - serverRootScore(a))[0] || serverPath(server.id, server.name);
}

function ensureServerDirs(server) {
  const root = findServerRoot(server);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function pluginTarget(server, kind, fileName) {
  const root = ensureServerDirs(server);
  const cleanName = path.basename(String(fileName || '').replaceAll('\\', '/'));
  if (!cleanName || cleanName !== fileName) throw new Error('Plugin file name must be a plain file name.');

  const targetDir = kind === 'resource-pack'
    ? path.join(root, 'packs', 'resource_packs')
    : kind === 'behavior-pack'
      ? path.join(root, 'packs', 'behavior_packs')
      : path.join(root, 'plugins');

  fs.mkdirSync(assertInside(root, targetDir), { recursive: true });

  return {
    absolutePath: assertInside(root, path.join(targetDir, cleanName)),
    relativePath: path.relative(root, path.join(targetDir, cleanName)).replaceAll('\\', '/'),
  };
}

function displayPath(absolutePath) {
  return path.relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
}

module.exports = {
  assertInside,
  backupsRoot,
  displayPath,
  externalDataRoot,
  ensureServerDirs,
  findServerRoot,
  pluginTarget,
  serverPath,
  serversRoot,
  softwareRoot,
};
