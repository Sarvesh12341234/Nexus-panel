const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const serversRoot = path.join(workspaceRoot, 'servers');
const softwareRoot = path.join(workspaceRoot, 'software');
const backupsRoot = path.join(workspaceRoot, 'backupfolder');
const legacyBackupsRoot = path.join(workspaceRoot, 'backups');

fs.mkdirSync(serversRoot, { recursive: true });
fs.mkdirSync(softwareRoot, { recursive: true });
fs.mkdirSync(backupsRoot, { recursive: true });
if (fs.existsSync(legacyBackupsRoot)) {
  fs.cpSync(legacyBackupsRoot, backupsRoot, { recursive: true, force: false, errorOnExist: false });
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

function ensureServerDirs(server) {
  const root = server.server_path || serverPath(server.id, server.name);
  fs.mkdirSync(assertInside(serversRoot, root), { recursive: true });
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
  ensureServerDirs,
  pluginTarget,
  serverPath,
  serversRoot,
  softwareRoot,
};
