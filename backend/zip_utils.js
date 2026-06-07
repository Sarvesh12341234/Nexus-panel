const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function extractArchive(archivePath, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  extractArchiveInto(archivePath, destination);
}

function isZipFile(archivePath) {
  const stats = fs.statSync(archivePath, { throwIfNoEntry: false });
  if (!stats || !stats.isFile() || stats.size < 22) return false;
  const fd = fs.openSync(archivePath, 'r');
  try {
    const local = Buffer.alloc(4);
    fs.readSync(fd, local, 0, 4, 0);
    if (local.readUInt32LE(0) !== 0x04034b50) return false;
    const tailSize = Math.min(stats.size, 65557);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, stats.size - tailSize);
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function extractArchiveInto(archivePath, destination, options = {}) {
  fs.mkdirSync(destination, { recursive: true });
  if (archivePath.toLowerCase().endsWith('.zip')) {
    if (!isZipFile(archivePath)) {
      throw new Error('This file is not a complete valid ZIP. It may be an unfinished upload/download; re-upload it or use a fresh backup/archive.');
    }
    const mode = ['replace', 'skip', 'fail'].includes(options.mode) ? options.mode : 'replace';
    const unzipArgs = mode === 'skip' ? ['-n', '-q', archivePath, '-d', destination] : mode === 'fail' ? ['-q', archivePath, '-d', destination] : ['-o', '-q', archivePath, '-d', destination];
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} ${mode === 'skip' ? '' : '-Force'}`], { encoding: 'utf8', windowsHide: true })
      : spawnSync('unzip', unzipArgs, { encoding: 'utf8', windowsHide: true });
    if (result.error && result.error.code === 'ENOENT') {
      throw new Error(process.platform === 'win32' ? 'PowerShell Expand-Archive is required to extract zip files.' : 'unzip is required to extract zip files. Run: apt install -y unzip');
    }
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Failed to extract zip.');
    return;
  }
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destination], { encoding: 'utf8', windowsHide: true });
  if (result.error && result.error.code === 'ENOENT') throw new Error('tar is required to extract this archive.');
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Failed to extract archive.');
}

function zipEntries(archivePath) {
  if (!isZipFile(archivePath)) return [];
  if (process.platform === 'win32') return [];
  const result = spawnSync('unzip', ['-Z1', archivePath], { encoding: 'utf8', windowsHide: true });
  if (result.error && result.error.code === 'ENOENT') return [];
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function zipCollisions(archivePath, destination) {
  return zipEntries(archivePath)
    .filter((entry) => !entry.endsWith('/'))
    .filter((entry) => fs.existsSync(path.join(destination, entry)))
    .slice(0, 50);
}

function findFile(root, wanted) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === wanted.toLowerCase()) return absolute;
    if (entry.isDirectory()) {
      const found = findFile(absolute, wanted);
      if (found) return found;
    }
  }
  return null;
}

function copyDirectoryContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectoryContents(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

module.exports = { copyDirectoryContents, extractArchive, extractArchiveInto, findFile, isZipFile, zipCollisions, zipEntries };
