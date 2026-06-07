const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function extractArchive(archivePath, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  extractArchiveInto(archivePath, destination);
}

function extractArchiveInto(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (archivePath.toLowerCase().endsWith('.zip')) {
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`], { encoding: 'utf8', windowsHide: true })
      : spawnSync('unzip', ['-q', archivePath, '-d', destination], { encoding: 'utf8', windowsHide: true });
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

module.exports = { copyDirectoryContents, extractArchive, extractArchiveInto, findFile };
