const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { displayPath } = require('./paths');

const workspaceRoot = path.join(__dirname, '..');
const toolsRoot = path.join(workspaceRoot, 'data', 'tools');
const chunkerJarPath = path.join(toolsRoot, 'chunker-cli.jar');
const releasesApi = 'https://api.github.com/repos/HiveGamesOSS/Chunker/releases/latest';

function status() {
  return {
    installed: fs.existsSync(chunkerJarPath),
    jarPath: fs.existsSync(chunkerJarPath) ? displayPath(chunkerJarPath) : '',
    provider: 'Chunker CLI',
    source: 'HiveGamesOSS/Chunker',
    capabilities: [
      'Converts Java and Bedrock world blocks, biomes, tile entities, dimensions, containers, items in containers, and maps.',
      'Does not reliably convert live entities or player inventories across editions.',
    ],
  };
}

async function downloadToFile(url, target) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url, { headers: { 'User-Agent': 'NexusPanel/2.0' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed with ${response.status}`);
  const temporary = `${target}.${process.pid}.${Date.now()}.download`;
  const file = fs.createWriteStream(temporary);
  for await (const chunk of response.body) {
    if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve));
  }
  await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
  await fs.promises.rename(temporary, target);
}

async function install() {
  if (!globalThis.fetch) throw new Error('This Node.js runtime cannot fetch Chunker releases.');
  const response = await fetch(releasesApi, { headers: { 'User-Agent': 'NexusPanel/2.0' } });
  if (!response.ok) throw new Error(`Chunker release lookup failed with ${response.status}`);
  const release = await response.json();
  const asset = (release.assets || []).find((item) => /chunker.*cli.*\.jar$/i.test(item.name) || /cli.*chunker.*\.jar$/i.test(item.name));
  if (!asset?.browser_download_url) {
    throw new Error('No Chunker CLI jar was found in the latest GitHub release. Download the CLI jar manually into data/tools/chunker-cli.jar.');
  }
  await downloadToFile(asset.browser_download_url, chunkerJarPath);
  return { ...status(), version: release.tag_name || '', asset: asset.name };
}

function runChunker({ input, output, format }) {
  return new Promise((resolve) => {
    const child = spawn('java', ['-jar', chunkerJarPath, '-i', input, '-f', format, '-o', output], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let text = '';
    const capture = (chunk) => {
      text = `${text}${chunk}`.slice(-16000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code, output: text }));
  });
}

function conversionFormat(targetType, version = '') {
  const clean = String(version || '').match(/\d+(?:\.\d+){1,3}/)?.[0] || (targetType === 'java' ? '1.21.5' : '1.21.100');
  return `${targetType === 'java' ? 'JAVA' : 'BEDROCK'}_${clean.replace(/\./g, '_')}`;
}

function conversionWorkspace(serverId) {
  return path.join(workspaceRoot, 'data', 'world-conversions', `${Date.now()}-${Number(serverId)}-${crypto.randomBytes(4).toString('hex')}`);
}

async function convert({ sourceWorldPath, targetType, targetVersion = '', serverId }) {
  if (!fs.existsSync(chunkerJarPath)) throw new Error('Chunker CLI is not installed. Install the converter first.');
  const output = path.join(conversionWorkspace(serverId), 'output');
  await fs.promises.mkdir(output, { recursive: true });
  const format = conversionFormat(targetType, targetVersion);
  const result = await runChunker({ input: sourceWorldPath, output, format });
  if (result.code !== 0) throw new Error(`Chunker conversion failed for ${format}: ${result.output.slice(-3000)}`);
  return { output, format, log: result.output.slice(-3000) };
}

module.exports = {
  convert,
  install,
  status,
};
