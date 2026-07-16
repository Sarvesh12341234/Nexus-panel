const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.join(__dirname, '..');
const modelId = process.env.NEXUSPANEL_ADVANCED_AI_MODEL || 'onnx-community/CodeBERTa-small-v1-ONNX';
const modelParameters = 84000000;
const estimatedDownloadMb = 1240;
const modelTask = 'fill-mask';
const focusLabels = [
  { token: 'java', detail: 'Java/runtime compatibility' },
  { token: 'memory', detail: 'memory pressure or allocation limits' },
  { token: 'permission', detail: 'filesystem permission or ownership issue' },
  { token: 'network', detail: 'port, tunnel, DNS, or connection issue' },
  { token: 'world', detail: 'world data or corrupted save issue' },
  { token: 'plugin', detail: 'plugin, mod, behavior pack, or datapack issue' },
  { token: 'configuration', detail: 'server.properties or launch configuration issue' },
  { token: 'storage', detail: 'disk space, file write, or backup issue' },
  { token: 'systemd', detail: 'service lifecycle or cgroup issue' },
  { token: 'sandbox', detail: 'Nexus-Mark isolation or resource control issue' },
];

let pipelinePromise = null;

function packageInstalled() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

function markerPath() {
  return path.join(workspaceRoot, 'data', 'advanced-ai.json');
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeMarker(payload) {
  await fs.promises.mkdir(path.dirname(markerPath()), { recursive: true });
  await fs.promises.writeFile(markerPath(), JSON.stringify({ ...payload, updatedAt: Date.now() }, null, 2), 'utf8');
}

function status() {
  const marker = readMarker();
  return {
    modelId,
    modelParameters,
    estimatedDownloadMb,
    modelTask,
    modelPurpose: 'Code-trained local ONNX repair-focus scorer. The deterministic repair agent still performs all actions.',
    packageInstalled: packageInstalled(),
    enabled: marker.enabled === true,
    installedAt: marker.installedAt || 0,
    lastError: marker.lastError || '',
    ready: packageInstalled() && marker.enabled === true,
  };
}

function installPackage() {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '@huggingface/transformers@latest'], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const capture = (chunk) => {
      output = `${output}${chunk}`.slice(-8000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function loadPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline(modelTask, modelId, { dtype: 'q8' }));
  }
  return pipelinePromise;
}

async function install() {
  const result = packageInstalled() ? { code: 0, output: 'Package already installed.' } : await installPackage();
  if (result.code !== 0) {
    await writeMarker({ ...readMarker(), enabled: false, lastError: result.output.slice(-1000) });
    throw new Error(`Advanced AI install failed: ${result.output.slice(-1000)}`);
  }
  try {
    await loadPipeline();
    await writeMarker({ enabled: true, installedAt: Date.now(), lastError: '' });
  } catch (error) {
    await writeMarker({ enabled: false, installedAt: Date.now(), lastError: error.message });
    throw new Error(`Advanced AI model download failed: ${error.message}`);
  }
  return status();
}

async function setEnabled(enabled) {
  const marker = readMarker();
  await writeMarker({ ...marker, enabled: Boolean(enabled) });
  return status();
}

async function reason({ server, diagnostics = [], logs = [], context = null }) {
  if (!status().ready) return null;
  const contextText = context
    ? JSON.stringify({
      runtime: context.runtime,
      status: context.status,
      software: context.software,
      properties: context.properties,
      plugins: (context.plugins || []).slice(0, 40),
      backups: (context.backups || []).slice(0, 20),
      timeline: (context.timeline || []).slice(0, 12),
      health: context.health,
      settings: context.settings,
      files: (context.files || []).slice(0, 120),
      error: context.error || '',
    }).slice(-8000)
    : '';
  const prompt = [
    'minecraft server repair focus: <mask>',
    `Server: ${server?.name || 'unknown'} ${server?.type || ''} ${server?.software_key || ''}`,
    `Diagnostics: ${diagnostics.map((item) => `${item.id}:${item.summary}`).join('; ') || 'none'}`,
    `Panel context: ${(contextText || 'none').slice(-3500)}`,
    `Recent logs: ${logs.slice(-24).join('\n').slice(-3000)}`,
  ].join('\n');
  const classifier = await loadPipeline();
  let output;
  try {
    output = await classifier(prompt, {
      targets: focusLabels.map((item) => item.token),
      top_k: 6,
    });
  } catch {
    output = await classifier(prompt, { top_k: 6 });
  }
  const rows = (Array.isArray(output) ? output : [output])
    .flat()
    .map((item) => ({
      token: String(item?.token_str || item?.sequence || item?.token || '').replace(/\s+/g, ' ').trim().toLowerCase(),
      score: Number(item?.score || 0),
    }))
    .filter((item) => item.token)
    .slice(0, 6);
  const ranked = rows.map((item) => {
    const label = focusLabels.find((candidate) => item.token.includes(candidate.token));
    const name = label ? label.detail : item.token.replace(/<[^>]+>/g, '').slice(0, 42);
    return `${name} ${Math.round(item.score * 100)}%`;
  });
  return ranked.length
    ? `CodeBERTa repair focus: ${ranked.join(', ')}. Use this as a secondary signal; built-in sandbox checks choose the action.`
    : 'CodeBERTa repair focus produced no confident label. Use built-in deterministic repair checks.';
}

if (require.main === module) {
  install()
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = {
  install,
  reason,
  setEnabled,
  status,
};
