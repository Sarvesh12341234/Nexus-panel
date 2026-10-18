'use strict';

const MAX_FLAG_TEXT_LENGTH = 4096;
const MAX_FLAG_COUNT = 64;
const PANEL_MANAGED_FLAGS = [
  /^-Xmx/i,
  /^-XX:MaxHeapSize(?:=|$)/i,
  /^-jar$/i,
  /^-cp$/i,
  /^-classpath$/i,
  /^--class-path(?:=|$)/i,
  /^-D(?:java\.io\.tmpdir|user\.home|jna\.tmpdir|io\.netty\.native\.workdir|org\.lwjgl\.system\.SharedLibraryExtractPath)=/i,
];

function parseJavaStartupFlags(input = '') {
  const source = String(input ?? '');
  if (source.length > MAX_FLAG_TEXT_LENGTH) throw new Error(`Startup flags must be ${MAX_FLAG_TEXT_LENGTH} characters or fewer.`);
  if (/[\0\r]/.test(source)) throw new Error('Startup flags cannot contain null bytes or carriage returns.');
  const flags = source.split('\n').map((flag) => flag.trim()).filter(Boolean);
  if (flags.length > MAX_FLAG_COUNT) throw new Error(`Use no more than ${MAX_FLAG_COUNT} startup flags.`);
  for (const flag of flags) {
    if (!flag.startsWith('-')) throw new Error(`Each startup flag must begin with a dash: ${flag.slice(0, 80)}`);
    if (PANEL_MANAGED_FLAGS.some((pattern) => pattern.test(flag))) {
      throw new Error(`NexusPanel manages ${flag.split(/[=\s]/, 1)[0]}; remove it from custom startup flags.`);
    }
  }
  return flags;
}

module.exports = { parseJavaStartupFlags };
