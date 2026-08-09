const { fork, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { registry: aiToolRegistry, compactForPrompt, search: searchAiTools } = require('./ai_tool_registry');
const { AILearningStore } = require('./ai_learning');

const workspaceRoot = path.join(__dirname, '..');
const modelId = process.env.NEXUSPANEL_ADVANCED_AI_MODEL || 'onnx-community/Qwen2.5-Coder-0.5B-Instruct';
const modelParameters = 500000000;
const estimatedDownloadMb = 420;
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
  { token: 'ownership', detail: 'wrong owner/group or service identity', patterns: [/wrong owner|wrong group|owner(ship)?|group.*(?:denied|mismatch)/i, /chown|uid|gid|runuser/i] },
  { token: 'acl', detail: 'ACL or traversal permission problem', patterns: [/acl|setfacl|getfacl|default:|mask:/i, /cannot traverse|search permission/i] },
  { token: 'filesystem', detail: 'filesystem mount, inode, or read-only problem', patterns: [/read-only file system|stale file handle|inode|too many open files|file descriptor/i] },
  { token: 'package-manager', detail: 'OS package manager or repository problem', patterns: [/apt|dnf|yum|pacman|zypper|dpkg|rpm|package.*not found|repository/i] },
  { token: 'native-build', detail: 'native compiler/toolchain failure', patterns: [/gcc|g\+\+|make|ld:|undefined reference|compiler.*failed|ninja/i] },
  { token: 'tls-cert', detail: 'TLS/certificate/trust problem', patterns: [/certificate|x509|self-signed|unable to verify.*certificate|tls|ssl/i] },
  { token: 'archive', detail: 'archive extraction or partial download problem', patterns: [/unexpected end of file|zip.*invalid|tar.*error|gzip.*error|partial.*download|checksum|integrity/i] },
  { token: 'database', detail: 'SQLite/database locking or integrity problem', patterns: [/sqlite|database is locked|malformed database|foreign key|integrity_check/i] },
  { token: 'native-startup', detail: 'native sandbox startup failure', patterns: [/process exited code=200/i, /identity-root-access-failed/i, /native kernel sandbox active/i, /cannot enforce landlock/i, /cannot install seccomp filter/i, /cannot enter isolated uid/i] },
  { token: 'startup-observability', detail: 'launcher/supervisor diagnostics missing', patterns: [/starting java with paper/i, /process exited code=/i, /unknown signature/i, /no paper startup/i] },
];

let pipelinePromise = null;
let reasoningWorker = null;
let reasoningRequestId = 0;
const reasoningRequests = new Map();
const learning = new AILearningStore(workspaceRoot);

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
    reasoningVersion: 6,
    toolRegistry: aiToolRegistry(),
    learning: learning.summary(),
    reasoningStrategy: 'streaming-evidence+deterministic-forensics+weighted-cause-graph+optional-quantized-model+typed-tools+repair-planner+rollback-gates',
    modelPurpose: 'Lightweight local model is optional; the live engine first uses deterministic evidence correlation and only loads the model when confidence is insufficient.',
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

function suggestedTools(ranked, server) {
  const modDirectory = ['fabric', 'forge'].includes(String(server?.software_key || '').toLowerCase()) ? 'mods' : 'plugins';
  const candidates = {
    java: { tool: 'diagnostic_command', command: 'java', args: ['-version'], reason: 'Verify the Java runtime actually used by the panel.' },
    memory: { tool: 'diagnostic_command', command: 'free', args: ['-m'], reason: 'Check host memory pressure before changing the server allocation.' },
    permission: { tool: 'diagnostic_command', command: 'getfacl', args: ['-p', '.'], reason: 'Inspect the isolated server root permissions and ACL.' },
    ownership: { tool: 'diagnostic_command', command: 'namei', args: ['-l', '.'], reason: 'Inspect owner/group/traversal permissions for every path component.' },
    acl: { tool: 'diagnostic_command', command: 'getfacl', args: ['-p', '.'], reason: 'Inspect POSIX ACL entries and default ACLs.' },
    filesystem: { tool: 'diagnostic_command', command: 'findmnt', args: ['-T', '.'], reason: 'Determine mount options such as read-only, nosuid, or nodev.' },
    'package-manager': { tool: 'diagnostic_command', command: 'sh', args: ['-c', 'command -v apt-get || command -v dnf || command -v yum || command -v pacman || command -v zypper'], reason: 'Identify the available OS package manager before recovery.' },
    'native-build': { tool: 'diagnostic_command', command: 'make', args: ['--version'], reason: 'Verify the native build toolchain before rebuilding Nexus-Mark.' },
    'tls-cert': { tool: 'diagnostic_command', command: 'openssl', args: ['version'], reason: 'Verify the TLS toolchain before diagnosing certificate failures.' },
    archive: { tool: 'diagnostic_command', command: 'file', args: ['.'], reason: 'Inspect filesystem/archive type before extraction repair.' },
    database: { tool: 'server_info', reason: 'Correlate database state with the server runtime before modifying files.' },
    network: { tool: 'diagnostic_command', command: 'ss', args: ['-lntup'], reason: 'Check listening sockets and port conflicts.' },
    world: { tool: 'list_files', path: server?.type === 'bedrock' ? 'worlds' : 'world', reason: 'Inspect world storage before any repair or restore.' },
    plugin: { tool: 'list_files', path: modDirectory, reason: `Inspect installed ${modDirectory} for loader or version conflicts.` },
    configuration: { tool: 'read_file', path: 'server.properties', reason: 'Review the effective server configuration.' },
    storage: { tool: 'diagnostic_command', command: 'df', args: ['-h', '.'], reason: 'Verify free storage in the server filesystem.' },
    systemd: { tool: 'server_info', reason: 'Inspect the live process, cgroup allocation, and Nexus-Mark profile.' },
    sandbox: { tool: 'diagnostic_command', command: 'namei', args: ['-l', '.'], reason: 'Verify every server-root path component is accessible.' },
    'native-startup': { tool: 'server_info', reason: 'Inspect Nexus-Mark native mode, identity status, cgroup policy, and supervisor diagnostics before repairing game files.' },
    'startup-observability': { tool: 'server_info', reason: 'Inspect the launch timeline and supervisor result before changing Minecraft configuration.' },
  };
  const seen = new Set();
  return ranked
    .map((item) => candidates[item.token])
    .filter((item) => {
      const key = JSON.stringify(item || {});
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
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


function advancedAssessment({ diagnostics = [], logs = [], context = null, server = null }) {
  const text = [
    diagnostics.map((item) => `${item?.id || ''} ${item?.summary || ''} ${item?.detail || ''}`).join('\n'),
    logs.slice(-300).join('\n'),
    context ? JSON.stringify(context) : '',
  ].join('\n');
  const ranked = evidenceRank(text, diagnostics).sort((a, b) => b.evidenceScore - a.evidenceScore);
  const primary = ranked.find((item) => item.evidenceScore > 0) || ranked[0];
  const blockers = [];
  if (/permission denied|eacces|eperm|operation not permitted/i.test(text)) blockers.push('filesystem-access');
  if (/identity-root-access-failed/i.test(text)) blockers.push('native-identity');
  if (/process exited code=200/i.test(text) && !/starting minecraft server|done \(/i.test(text)) blockers.push('pre-paper-startup');
  if (/no space left|enospc|disk full/i.test(text)) blockers.push('storage');
  if (/read-only file system/i.test(text)) blockers.push('read-only-mount');
  if (/address already in use|eaddrinuse/i.test(text)) blockers.push('port-conflict');
  return {
    version: 4,
    model: modelId,
    serverId: server?.id || null,
    primary: primary ? { token: primary.token, detail: primary.detail, confidence: Number(primary.evidenceScore.toFixed(3)) } : null,
    ranked: ranked.slice(0, 8).map((item) => ({ token: item.token, detail: item.detail, evidenceScore: Number(item.evidenceScore.toFixed(3)) })),
    blockers,
    confidence: Number(Math.min(0.99, (primary?.evidenceScore || 0) + (blockers.length ? 0.15 : 0)).toFixed(3)),
    strategy: 'collect-evidence -> classify -> verify-preconditions -> propose-repair -> rollback-gate -> owner-approved-mutation',
    autoRepairEligible: blockers.length > 0 && !blockers.includes('storage') && !blockers.includes('read-only-mount'),
  };
}

function forensicStartupAssessment({ diagnostics = [], logs = [], context = null }) {
  const text = [
    diagnostics.map((item) => `${item?.id || ''} ${item?.summary || ''} ${item?.detail || ''}`).join('\n'),
    logs.slice(-120).join('\n'),
    context ? JSON.stringify({
      runtime: context.runtime,
      status: context.status,
      error: context.error,
      timeline: (context.timeline || []).slice(-20),
    }) : '',
  ].join('\n');
  const hasExit200 = /process exited code=200/i.test(text);
  const identityFailed = /identity-root-access-failed|identity-runtime-access-failed|acl-(?:apply|default|executable)-failed/i.test(text);
  const nativeActive = /nexus-mark.*(?:maximum|compatible).*policy active|native kernel sandbox active|native-landlock-seccomp/i.test(text);
  const paperStarted = /starting minecraft server|loading properties|preparing spawn area|done \(\d+(?:\.\d+)?s\)!/i.test(text);
  const supervisorFailure = /systemd-run|result=|execmainstatus|status=|journal/i.test(text);
  const signals = [
    hasExit200 ? 'exit code 200' : '',
    identityFailed ? 'per-server identity failure' : '',
    nativeActive ? 'native Nexus-Mark active' : '',
    paperStarted ? 'Paper boot evidence present' : 'no normal Paper boot evidence',
  ].filter(Boolean);
  if ((hasExit200 && nativeActive && !paperStarted) || (identityFailed && nativeActive && !paperStarted)) {
    const confidence = hasExit200 && identityFailed ? 0.96 : hasExit200 ? 0.91 : 0.86;
    return {
      id: 'nexusmark-startup-failure',
      confidence,
      rootCause: 'The failure is most consistent with the native Nexus-Mark startup path, not Minecraft world/config repair.',
      evidence: signals,
      next: supervisorFailure
        ? 'Read the systemd supervisor result and native stderr, then retry once with compatibility isolation.'
        : 'Capture native stderr and retry once with compatibility isolation.',
      doNotRepair: ['whitelist.json', 'banned-players.json', 'banned-ips.json', 'ops.json', 'world data'],
    };
  }
  if (hasExit200 && !paperStarted) {
    return {
      id: 'startup-observability',
      confidence: 0.68,
      rootCause: 'The process exits before normal Paper startup logs; the exit status alone does not prove a Minecraft configuration fault.',
      evidence: signals,
      next: 'Capture launcher/native stderr and supervisor status before attempting game-file repairs.',
      doNotRepair: ['world data', 'support JSON'],
    };
  }
  return null;
}

async function reasonPlanLocal({ server, diagnostics = [], logs = [], context = null }) {
  const forensic = forensicStartupAssessment({ diagnostics, logs, context });
  const modelReady = status().ready;
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
    `Deterministic forensics: ${forensic ? JSON.stringify(forensic) : 'none'}`,
    `Diagnostics: ${diagnostics.map((item) => `${item.id}:${item.summary}`).join('; ') || 'none'}`,
    `Panel context: ${(contextText || 'none').slice(-3500)}`,
    'Typed panel tool registry (read-only may be inspected automatically; mutations require authorization):',
    compactForPrompt(10000),
    `Learned repair summary: ${JSON.stringify(learning.summary())}`,
    `Recent logs: ${logs.slice(-24).join('\n').slice(-3000)}`,
  ].join('\n');
  const evidenceText = [
    diagnostics.map((item) => `${item?.id || ''} ${item?.summary || ''} ${item?.detail || ''}`).join('\n'),
    contextText,
    logs.slice(-80).join('\n'),
  ].join('\n').slice(-16000);
  let modelText = '';
  if (modelReady) {
    try {
      const generator = await loadPipeline();
      const output = await generator([
        { role: 'system', content: 'You are a concise infrastructure repair planner. Return a short diagnosis, evidence, and safest next tool.' },
        { role: 'user', content: prompt.slice(-7000) },
      ], { max_new_tokens: 180, temperature: 0.2, do_sample: false, repetition_penalty: 1.08 });
      const generated = Array.isArray(output) ? output[0]?.generated_text : output?.generated_text;
      modelText = Array.isArray(generated)
        ? String(generated[generated.length - 1]?.content || '')
        : String(generated || '').slice(prompt.length);
    } catch (error) {
      modelText = `optional-model-error:${error.message}`;
    }
  }
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
  const suggestions = suggestedTools(ranked, server);
  const learnedSuggestions = learning.rank(ranked[0]?.token || 'unknown', suggestions);
  if (!ranked.length) {
    const summary = modelText.trim()
      ? `Advanced AI found no corroborated failure signature. Model assessment: ${modelText.replace(/\s+/g, ' ').trim().slice(0, 600)} Deterministic checks retain control.`
      : 'Advanced AI found no corroborated failure signature. Deterministic repair checks retain control.';
    return { summary, suggestions: [], modelAssessment: modelText.replace(/\s+/g, ' ').trim().slice(0, 600) };
  }
  const summary = ranked.map((item) => `${item.detail} ${Math.round(item.score * 100)}% (${item.evidenceCount} evidence match${item.evidenceCount === 1 ? '' : 'es'})`);
  const next = learnedSuggestions.map((item) => {
    if (item.command) return `${item.command} ${(item.args || []).join(' ')}`.trim();
    return `${item.tool}${item.path ? ` ${item.path}` : ''}`;
  });
  return {
    summary: `${forensic ? `Forensic gate: ${forensic.rootCause} Confidence ${Math.round(forensic.confidence * 100)}%. ` : ''}Advanced AI ensemble: ${summary.join(', ')}.${next.length ? ` Audited next checks: ${next.join('; ')}.` : ''} Model output is never executed directly.`,
    suggestions: learnedSuggestions,
    modelAssessment: modelText.replace(/\s+/g, ' ').trim().slice(0, 600) || 'Deterministic live evidence engine; optional local model not loaded.',
    forensic,
  };
}

function rejectReasoningRequests(error) {
  for (const pending of reasoningRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  reasoningRequests.clear();
}

function ensureReasoningWorker() {
  if (reasoningWorker?.connected) return reasoningWorker;
  const child = fork(__filename, ['--reason-worker'], {
    cwd: workspaceRoot,
    env: { ...process.env, NEXUSPANEL_ADVANCED_AI_WORKER: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  child.on('message', (message) => {
    if (message?.type !== 'reason-result') return;
    const pending = reasoningRequests.get(message.id);
    if (!pending) return;
    reasoningRequests.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result || null);
  });
  child.on('error', (error) => rejectReasoningRequests(error));
  child.on('exit', (code) => {
    if (reasoningWorker === child) reasoningWorker = null;
    rejectReasoningRequests(new Error(`Advanced AI worker exited with code ${code ?? 'unknown'}.`));
  });
  reasoningWorker = child;
  return child;
}

async function reasonPlan(input) {
  // Fast path: deterministic live diagnostics work even when the optional model is not installed.
  // This keeps the panel lightweight and avoids downloading hundreds of MB just to diagnose a simple fault.
  if (!status().ready) return reasonPlanLocal(input);
  if (process.env.NEXUSPANEL_ADVANCED_AI_WORKER === '1') return reasonPlanLocal(input);
  const worker = ensureReasoningWorker();
  const id = ++reasoningRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reasoningRequests.delete(id);
      reject(new Error('Advanced AI worker timed out.'));
    }, 180000);
    timer.unref();
    reasoningRequests.set(id, { resolve, reject, timer });
    worker.send({ type: 'reason-plan', id, input }, (error) => {
      if (!error) return;
      const pending = reasoningRequests.get(id);
      if (!pending) return;
      reasoningRequests.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function reason(input) {
  const plan = await reasonPlan(input);
  return plan?.summary || null;
}

if (require.main === module) {
  if (process.argv.includes('--reason-worker')) {
    let queue = Promise.resolve();
    process.on('message', (message) => {
      if (message?.type !== 'reason-plan') return;
      queue = queue.then(async () => {
        try {
          const result = await reasonPlanLocal(message.input || {});
          process.send?.({ type: 'reason-result', id: message.id, result });
        } catch (error) {
          process.send?.({ type: 'reason-result', id: message.id, error: error.message });
        }
      });
    });
    process.on('disconnect', () => process.exit(0));
  } else {
    install()
      .then((payload) => {
        console.log(JSON.stringify(payload, null, 2));
      })
      .catch((error) => {
        console.error(error.message);
        process.exit(1);
      });
  }
}

function toolRegistry() { return aiToolRegistry(); }
function learn(input) { return learning.learn(input); }
function learningSummary() { return learning.summary(); }
function searchTools(query, limit) { return searchAiTools(query, limit); }

module.exports = {
  advancedAssessment,
  install,
  reason,
  reasonPlan,
  setEnabled,
  status,
  toolRegistry,
  learn,
  learningSummary,
  searchTools,
};
