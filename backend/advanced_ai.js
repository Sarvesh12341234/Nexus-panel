const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.join(__dirname, '..');
const modelId = process.env.NEXUSPANEL_ADVANCED_AI_MODEL || 'onnx-community/Qwen2.5-Coder-0.5B-Instruct';
const modelParameters = 494000000;
const estimatedDownloadMb = 760;
const modelTask = 'text-generation';
const focusLabels = [
  { token: 'java', detail: 'Java/runtime compatibility', patterns: [/unsupported class/i, /java(?:\s+|_)?version/i, /jvm|jdk|jre/i, /could not (?:find|create).*java/i] },
  { token: 'memory', detail: 'memory pressure or allocation limits', patterns: [/outofmemory/i, /heap space/i, /oom|killed process/i, /memory (?:limit|pressure|allocation)/i] },
  { token: 'permission', detail: 'filesystem permission or ownership issue', patterns: [/permission denied/i, /eacces/i, /operation not permitted/i, /read-only file system/i, /ownership/i] },
  { token: 'network', detail: 'port, tunnel, DNS, or connection issue', patterns: [/address already in use/i, /eaddrinuse/i, /connection (?:refused|timed out)/i, /dns|enotfound|firewall|route unreachable/i] },
  { token: 'world', detail: 'world data or corrupted save issue', patterns: [/level\.dat/i, /failed to (?:load|save).*world/i, /corrupt.*(?:world|chunk)/i, /chunk.*(?:error|invalid)/i] },
  { token: 'plugin', detail: 'plugin, mod, behavior pack, or datapack issue', patterns: [/plugin|mod(?:s|ded)?|datapack/i, /mixin|loader conflict/i, /incompatible.*(?:pack|version)/i, /could not load.*\.jar/i] },
  { token: 'configuration', detail: 'server.properties or launch configuration issue', patterns: [/server\.properties/i, /invalid (?:config|configuration|property)/i, /parse.*(?:yaml|json|toml|properties)/i, /eula/i] },
  { token: 'storage', detail: 'disk space, file write, or backup issue', patterns: [/no space left/i, /disk (?:full|quota|i\/o)/i, /enospc/i, /failed to (?:write|backup)/i, /sqlite.*(?:locked|wal)/i] },
  { token: 'systemd', detail: 'service lifecycle or cgroup issue', patterns: [/systemd|systemctl/i, /start-limit/i, /cgroup/i, /unit .* (?:failed|not found)/i] },
  { token: 'sandbox', detail: 'Nexus-Mark isolation or resource control issue', patterns: [/nexus-mark/i, /sandbox/i, /allocation guard/i, /resource control/i, /outside server root/i] },
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
    reasoningVersion: 3,
    reasoningStrategy: 'quantized-coder-model-evidence-and-typed-tools',
    modelPurpose: 'Quantized local coding model proposes diagnoses and typed tools; policy checks and owner approval control mutations.',
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
      .then(({ pipeline }) => pipeline(modelTask, modelId, { dtype: 'q4' }))
      .catch((error) => {
        pipelinePromise = null;
        throw error;
      });
  }
  return pipelinePromise;
}

function evidenceRank(text, diagnostics) {
  return focusLabels.map((label) => {
    const matches = label.patterns.filter((pattern) => pattern.test(text)).length;
    const direct = diagnostics.filter((item) => {
      const value = `${item?.id || ''} ${item?.summary || ''} ${item?.detail || ''}`;
      return label.patterns.some((pattern) => pattern.test(value));
    }).length;
    return {
      ...label,
      evidenceCount: matches + (direct * 2),
      evidenceScore: Math.min(1, (matches * 0.18) + (direct * 0.35)),
    };
  });
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
    'You are the NexusPanel repair planner. Diagnose the strongest root cause using only the supplied evidence.',
    'Available typed tools: server_info, list_files, read_file, write_file, send_console, diagnostic_command, queue_host_command.',
    'Never invent evidence. Mutating tools require a time-limited owner unlock and host commands require separate approval.',
    `Server: ${server?.name || 'unknown'} ${server?.type || ''} ${server?.software_key || ''}`,
    `Diagnostics: ${diagnostics.map((item) => `${item.id}:${item.summary}`).join('; ') || 'none'}`,
    `Panel context: ${(contextText || 'none').slice(-3500)}`,
    `Recent logs: ${logs.slice(-24).join('\n').slice(-3000)}`,
  ].join('\n');
  const evidenceText = [
    diagnostics.map((item) => `${item?.id || ''} ${item?.summary || ''} ${item?.detail || ''}`).join('\n'),
    contextText,
    logs.slice(-80).join('\n'),
  ].join('\n').slice(-16000);
  const generator = await loadPipeline();
  const output = await generator([
    { role: 'system', content: 'You are a concise infrastructure repair planner. Return a short diagnosis, evidence, and safest next tool.' },
    { role: 'user', content: prompt.slice(-7000) },
  ], { max_new_tokens: 180, temperature: 0.2, do_sample: false, repetition_penalty: 1.08 });
  const generated = Array.isArray(output) ? output[0]?.generated_text : output?.generated_text;
  const modelText = Array.isArray(generated)
    ? String(generated[generated.length - 1]?.content || '')
    : String(generated || '').slice(prompt.length);
  const modelScores = new Map();
  for (const label of focusLabels) {
    if (label.patterns.some((pattern) => pattern.test(modelText)) || modelText.toLowerCase().includes(label.token)) modelScores.set(label.token, 0.72);
  }
  const ranked = evidenceRank(evidenceText, diagnostics)
    .map((label) => ({
      ...label,
      modelScore: modelScores.get(label.token) || 0,
      score: Math.min(0.99, ((modelScores.get(label.token) || 0) * 0.4) + (label.evidenceScore * 0.6)),
    }))
    .filter((item) => item.score >= 0.04 || item.evidenceCount > 0)
    .sort((left, right) => right.score - left.score || right.evidenceCount - left.evidenceCount)
    .slice(0, 4);
  if (!ranked.length) {
    return modelText.trim()
      ? `Advanced AI found no corroborated failure signature. Model assessment: ${modelText.replace(/\s+/g, ' ').trim().slice(0, 600)} Deterministic checks retain control.`
      : 'Advanced AI found no corroborated failure signature. Deterministic repair checks retain control.';
  }
  const summary = ranked.map((item) => `${item.detail} ${Math.round(item.score * 100)}% (${item.evidenceCount} evidence match${item.evidenceCount === 1 ? '' : 'es'})`);
  return `Advanced AI ensemble: ${summary.join(', ')}. Planner: ${modelText.replace(/\s+/g, ' ').trim().slice(0, 600)} Policy checks choose every action.`;
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
