'use strict';

const MINIMUM_NODE = Object.freeze([22, 5, 0]);
const MAXIMUM_NODE_EXCLUSIVE = 25;

function nodeVersionSupported(version = process.versions.node) {
  const parts = String(version).split('.').map((part) => Number(part));
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) return false;
  const [major, minor, patch = 0] = parts;
  if (major < MINIMUM_NODE[0] || major >= MAXIMUM_NODE_EXCLUSIVE) return false;
  if (major > MINIMUM_NODE[0]) return true;
  if (minor > MINIMUM_NODE[1]) return true;
  return minor === MINIMUM_NODE[1] && patch >= MINIMUM_NODE[2];
}

function assertSupportedNode(version = process.versions.node) {
  if (!nodeVersionSupported(version)) {
    throw new Error(
      `NexusPanel requires Node.js >=22.5.0 and <25.0.0; detected ${version}. `
      + 'Install Node.js 24 (recommended) and rerun the command.',
    );
  }
}

module.exports = { assertSupportedNode, nodeVersionSupported };
