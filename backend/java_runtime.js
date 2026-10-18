'use strict';

const fs = require('node:fs');
const path = require('node:path');

function javaRuntimeMetadata(serverRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(serverRoot, 'runtime', 'java-runtime.json'), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function usableJavaPath(runtimeRoot, candidate) {
  if (!candidate) return '';
  const resolved = path.resolve(candidate);
  if (!isInside(runtimeRoot, resolved)) return '';
  try {
    const realPath = fs.realpathSync(resolved);
    const stat = fs.statSync(realPath);
    return isInside(runtimeRoot, realPath) && stat.isFile() ? realPath : '';
  } catch {
    return '';
  }
}

function findJavaBinary(runtimeRoot) {
  let entries;
  try {
    entries = fs.readdirSync(runtimeRoot, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('jdk-')) continue;
    const candidate = usableJavaPath(runtimeRoot, path.join(runtimeRoot, entry.name, 'bin', 'java'));
    if (candidate) return candidate;
  }
  return '';
}

function bundledJavaBinary(serverRoot, requiredMajor = 0) {
  const metadata = javaRuntimeMetadata(serverRoot);
  const major = Number(metadata?.major || 0);
  if (!metadata || !Number.isSafeInteger(major) || major < 1 || (requiredMajor && major < requiredMajor)) return '';

  const runtimeRoot = path.resolve(serverRoot, 'runtime', `java-${major}`);
  const savedPath = String(metadata.javaBinary || '');
  const candidates = [];
  if (savedPath) {
    if (path.isAbsolute(savedPath)) {
      candidates.push(savedPath);
      const marker = `${path.sep}runtime${path.sep}java-${major}${path.sep}`;
      const markerIndex = savedPath.lastIndexOf(marker);
      if (markerIndex >= 0) candidates.push(path.join(runtimeRoot, savedPath.slice(markerIndex + marker.length)));
    } else {
      candidates.push(path.resolve(serverRoot, savedPath));
      candidates.push(path.resolve(runtimeRoot, savedPath));
    }
  }
  for (const candidate of candidates) {
    const usable = usableJavaPath(runtimeRoot, candidate);
    if (usable) return usable;
  }
  return findJavaBinary(runtimeRoot);
}

module.exports = { bundledJavaBinary, javaRuntimeMetadata };
