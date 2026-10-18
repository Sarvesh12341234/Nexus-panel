'use strict';

const { spawnSync } = require('node:child_process');

const extractionScript = String.raw`
import os
import posixpath
import shutil
import stat
import sys
import tarfile
import tempfile

archive_path, destination = sys.argv[1:3]
destination = os.path.abspath(destination)
parent = os.path.dirname(destination)
os.makedirs(parent, exist_ok=True)
stage = tempfile.mkdtemp(prefix='.nexuspanel-java-', dir=parent)
previous = destination + '.previous-' + str(os.getpid())
promoted = False

def safe_name(name):
    if not name or name.startswith('/') or '\\' in name:
        raise ValueError('Archive contains an absolute or invalid path.')
    normalized = posixpath.normpath(name)
    if normalized in ('', '.'):
        return ''
    if normalized == '..' or normalized.startswith('../'):
        raise ValueError('Archive contains a path outside its extraction folder.')
    return normalized

def ensure_directory(relative):
    current = stage
    for part in relative.split('/') if relative else []:
        current = os.path.join(current, part)
        try:
            os.mkdir(current, 0o755)
        except FileExistsError:
            mode = os.lstat(current).st_mode
            if not stat.S_ISDIR(mode):
                raise ValueError('Archive path conflicts with a non-directory entry.')

try:
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        if len(members) > 100000:
            raise ValueError('Java runtime archive has too many entries.')
        total_size = sum(member.size for member in members if member.isfile())
        if total_size > 2 * 1024 * 1024 * 1024:
            raise ValueError('Java runtime archive exceeds the 2 GiB extraction limit.')

        seen = set()
        directories = {}
        links = []
        files = []
        for member in members:
            name = safe_name(member.name)
            if not name:
                if member.isdir():
                    continue
                raise ValueError('Java runtime archive contains an invalid root entry.')
            if name in seen:
                raise ValueError('Java runtime archive contains duplicate paths.')
            seen.add(name)
            if member.isdir():
                directories[name] = member.mode
            elif member.isfile():
                files.append((member, name))
            elif member.issym():
                target = member.linkname
                resolved_target = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if not target or target.startswith('/') or '\\' in target or resolved_target == '..' or resolved_target.startswith('../'):
                    raise ValueError('Java runtime archive contains a link outside its extraction folder.')
                links.append((name, target))
            else:
                raise ValueError('Java runtime archive contains an unsupported special or hard-link entry.')

        for name in directories:
            ensure_directory(name)

        for member, name in files:
            ensure_directory(posixpath.dirname(name))
            target_path = os.path.join(stage, *name.split('/'))
            source = archive.extractfile(member)
            if source is None:
                raise ValueError('Could not read a Java runtime archive file.')
            mode = 0o755 if member.mode & 0o111 else 0o644
            fd = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
            try:
                with os.fdopen(fd, 'wb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
            finally:
                source.close()

        for name, target in links:
            ensure_directory(posixpath.dirname(name))
            os.symlink(target, os.path.join(stage, *name.split('/')))

        stage_real = os.path.realpath(stage)
        for name, _ in links:
            link_path = os.path.join(stage, *name.split('/'))
            resolved = os.path.realpath(link_path)
            if os.path.commonpath((stage_real, resolved)) != stage_real:
                raise ValueError('Java runtime archive contains a link that escapes its extraction folder.')

        for name, mode in sorted(directories.items(), key=lambda item: item[0].count('/'), reverse=True):
            os.chmod(os.path.join(stage, *name.split('/')), 0o755)

    if os.path.lexists(destination):
        if not stat.S_ISDIR(os.lstat(destination).st_mode) or os.path.lexists(previous):
            raise ValueError('Existing Java runtime destination is not a safe directory.')
        os.rename(destination, previous)
    try:
        os.rename(stage, destination)
        promoted = True
    except Exception:
        if os.path.lexists(previous):
            os.rename(previous, destination)
        raise
    if os.path.lexists(previous):
        shutil.rmtree(previous)
except Exception:
    if not promoted and os.path.lexists(stage):
        shutil.rmtree(stage)
    raise
`;

function extractJavaRuntimeArchive(archivePath, destination) {
  const result = spawnSync('python3', ['-c', extractionScript, archivePath, destination], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('Python 3 is required to safely install the bundled Java runtime.');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Bundled Java runtime extraction failed${detail ? `: ${detail}` : ` (exit ${result.status ?? 'unknown'})`}`);
  }
}

module.exports = { extractJavaRuntimeArchive };
