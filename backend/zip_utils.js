const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Zip Slip / path-traversal guard.
 * Rejects any archive entry that is absolute, contains a drive letter, or
 * resolves outside the extraction destination (e.g. "../../etc/cron.d/x").
 */
function assertSafeArchiveEntry(entry, destination) {
  const raw = String(entry || '').replaceAll('\\', '/');
  if (!raw) return;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`Archive entry uses an absolute path and was blocked: ${entry}`);
  }
  const resolvedDestination = path.resolve(destination);
  const resolvedEntry = path.resolve(resolvedDestination, raw);
  const relative = path.relative(resolvedDestination, resolvedEntry);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Archive entry escapes the extraction folder and was blocked: ${entry}`);
  }
}

function assertSafeArchive(archivePath, destination) {
  for (const entry of zipEntries(archivePath)) assertSafeArchiveEntry(entry, destination);
}

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

function archiveFormat(archivePath) {
  const name = path.basename(String(archivePath || '')).toLowerCase();
  if (name.endsWith('.zip')) return 'zip';
  if (/\.(?:tar|tgz|tbz2?|txz|tzst)$/.test(name) || /\.tar\.(?:gz|bz2?|xz|zst|zstd)$/.test(name)) return 'tar';
  if (name.endsWith('.7z')) return '7z';
  if (name.endsWith('.rar')) return 'rar';
  if (name.endsWith('.gz')) return 'gzip';
  if (name.endsWith('.bz2') || name.endsWith('.bz')) return 'bzip2';
  if (name.endsWith('.xz')) return 'xz';
  if (name.endsWith('.zst') || name.endsWith('.zstd')) return 'zstd';
  return '';
}

function runArchiveTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error?.code === 'ENOENT') return null;
  return result;
}

function assertNoArchiveLinks(archivePath, command, args) {
  const result = runArchiveTool(command, args);
  if (!result || result.status !== 0) return;
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.some((line) => /^[lhbcp][rwxStTs-]{9}\s/.test(line))) {
    throw new Error('Archive contains a link or special file; only regular files and folders can be extracted.');
  }
}

function archiveEntries(archivePath) {
  const format = archiveFormat(archivePath);
  if (format === 'zip') {
    if (!isZipFile(archivePath)) {
      throw new Error('This file is not a complete valid ZIP archive.');
    }
    const entries = zipEntries(archivePath);
    assertNoArchiveLinks(archivePath, 'unzip', ['-Z', '-l', archivePath]);
    return entries;
  }
  if (['gzip', 'bzip2', 'xz', 'zstd'].includes(format)) {
    const extension = path.extname(archivePath);
    const outputName = path.basename(archivePath).slice(0, -extension.length);
    if (!outputName || outputName === '.' || outputName === '..') {
      throw new Error('Could not determine the extracted filename.');
    }
    return [outputName];
  }
  if (!format) throw new Error('This archive format is not supported for extraction.');

  if (format === 'tar') {
    const result = runArchiveTool('tar', ['-tf', archivePath]);
    if (!result) throw new Error('tar is required to list this archive.');
    if (result.status === 0) {
      assertNoArchiveLinks(archivePath, 'tar', ['-tvf', archivePath]);
      return result.stdout.split(/\r?\n/).filter(Boolean);
    }
    throw new Error(result.stderr || result.stdout || 'Could not read the tar archive contents.');
  }

  const result = runArchiveTool('bsdtar', ['-tf', archivePath]);
  if (result?.status === 0) {
    assertNoArchiveLinks(archivePath, 'bsdtar', ['-tvf', archivePath]);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }
  throw new Error(`bsdtar (libarchive-tools) is required to list ${format.toUpperCase()} archives.`);
}

function archiveCollisions(archivePath, destination) {
  return archiveEntries(archivePath)
    .filter((entry) => !entry.endsWith('/'))
    .filter((entry) => fs.existsSync(path.join(destination, entry)))
    .slice(0, 50);
}

function decompressSingleFile(archivePath, destination, format, options) {
  const extension = path.extname(archivePath);
  const outputName = path.basename(archivePath).slice(0, -extension.length);
  const outputPath = path.join(destination, outputName);
  const temporaryPath = path.join(destination, `.nexuspanel-extract-${process.pid}-${Date.now()}`);
  const commands = {
    gzip: ['gzip', ['-dc', '--', archivePath]],
    bzip2: ['bzip2', ['-dc', '--', archivePath]],
    xz: ['xz', ['-dc', '--', archivePath]],
    zstd: ['zstd', ['-dc', '--', archivePath]],
  };
  const [command, args] = commands[format];
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o666);
    const result = runArchiveTool(command, args, { encoding: null, stdio: ['ignore', fd, 'pipe'] });
    if (!result) throw new Error(`${command} is required to decompress .${extension.slice(1)} files.`);
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || result.stdout?.toString() || `Failed to decompress ${path.basename(archivePath)}.`);
    }
    if (options.mode === 'skip' && fs.existsSync(outputPath)) return;
    if (options.mode === 'fail' && fs.existsSync(outputPath)) throw new Error(`${outputName} already exists.`);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function extractArchiveInto(archivePath, destination, options = {}) {
  fs.mkdirSync(destination, { recursive: true });
  const format = archiveFormat(archivePath);
  if (format === 'zip') {
    archiveEntries(archivePath);
    // Zip Slip defense: every entry must stay inside the destination.
    assertSafeArchive(archivePath, destination);
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
  const mode = ['replace', 'skip', 'fail'].includes(options.mode) ? options.mode : 'replace';
  const entries = archiveEntries(archivePath);
  for (const entry of entries) assertSafeArchiveEntry(entry, destination);
  if (['gzip', 'bzip2', 'xz', 'zstd'].includes(format)) {
    decompressSingleFile(archivePath, destination, format, { mode });
    return;
  }

  const tarArgs = ['-xf', archivePath, '-C', destination];
  const tarCommand = format === 'tar' ? 'tar' : 'bsdtar';
  if (mode === 'skip') tarArgs.unshift('-k');
  const result = runArchiveTool(tarCommand, tarArgs);
  if (!result) throw new Error(`${tarCommand} is required to extract this archive.`);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Failed to extract archive.');
}

function zipEntries(archivePath) {
  if (!isZipFile(archivePath)) return [];
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
      `$zip=[System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(archivePath)});`,
      'try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }',
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) return [];
    return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
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

module.exports = { archiveCollisions, archiveEntries, archiveFormat, assertSafeArchive, assertSafeArchiveEntry, copyDirectoryContents, extractArchive, extractArchiveInto, findFile, isZipFile, zipCollisions, zipEntries };
