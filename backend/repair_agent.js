const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { diagnoseRuntime, knowledgeRules } = require('./repair_knowledge');
const { hostCpuCount, hostCpuPercent, hostMemoryStats } = require('./system_info');

const FEATURE_DIMENSIONS = 3840;
const MAX_MODEL_PARAMETERS = 300000;
const MAX_AGENT_MEMORY_BYTES = 1024 * 1024 * 1024;
const MAX_LEARNED_WEIGHTS = 32768;
const MAX_EPISODES = 2000;
const rules = knowledgeRules();
const PARAMETER_COUNT = rules.length * FEATURE_DIMENSIONS + rules.length;

if (PARAMETER_COUNT > MAX_MODEL_PARAMETERS) {
  throw new Error(`Repair agent model exceeds ${MAX_MODEL_PARAMETERS} parameters.`);
}

const ACTION_LIBRARY = Object.freeze({
  'repair-properties': {
    risk: 'low',
    applies: ['properties-syntax', 'properties-path', 'properties-encoding', 'properties-value', 'wrong-working-directory'],
    description: 'Validate and atomically rebuild server.properties inside the active server root.',
  },
  'repair-executable': {
    risk: 'medium',
    applies: ['jar-corrupt', 'bedrock-binary', 'java-missing', 'pocketmine-php'],
    description: 'Verify or reinstall the configured game runtime from the selected software source.',
  },
  'cleanup-partials': {
    risk: 'low',
    applies: ['archive-incomplete', 'disk-full'],
    description: 'Remove stale partial transfers older than one hour inside this server root.',
  },
  'rebuild-resource-profile': {
    risk: 'low',
    applies: ['cgroup-memory-cap', 'cpu-throttle', 'systemd-unit', 'pty-scope'],
    description: 'Regenerate Nexus-Mark CPU, memory, working-directory, and transient-unit metadata.',
  },
  'verify-world-storage': {
    risk: 'read-only',
    applies: ['world-leveldat', 'world-region', 'leveldb', 'save-failed', 'live-backup-race', 'world-lock'],
    description: 'Inspect world metadata, live-writer state, and verified backup availability without replacing data.',
  },
  'verify-database': {
    risk: 'read-only',
    applies: ['sqlite', 'sqlite-wal'],
    description: 'Run SQLite integrity and foreign-key checks before any recovery decision.',
  },
  'optimize-game-distance': {
    risk: 'medium',
    applies: ['cant-keep-up', 'watchdog', 'cpu-throttle', 'gc-thrash', 'disk-latency'],
    description: 'Propose bounded view and simulation distance changes based on host pressure.',
  },
  'vps-resource-plan': {
    risk: 'read-only',
    applies: ['native-memory', 'oom-kill', 'process-limit', 'file-descriptors', 'disk-full', 'inode-full', 'disk-io-error'],
    description: 'Build a VPS resource plan from memory, CPU, pressure, disk, and process telemetry.',
  },
  'network-plan': {
    risk: 'read-only',
    applies: ['port-in-use', 'bind-address', 'dns', 'udp-firewall', 'route-unreachable', 'tls', 'rcon-auth'],
    description: 'Build protocol-aware TCP/UDP, DNS, bind, and firewall checks without changing the host.',
  },
});

function hashFeature(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function featureIndex(value) {
  return hashFeature(value) % FEATURE_DIMENSIONS;
}

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.:/+-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(-12000);
}

function sparseFeatures(text, context) {
  const values = new Map();
  const add = (key, amount = 1) => {
    const index = featureIndex(key);
    values.set(index, Math.min(4, (values.get(index) || 0) + amount));
  };
  const words = tokens(text);
  for (let index = 0; index < words.length; index += 1) {
    add(`token:${words[index]}`);
    if (index) add(`bigram:${words[index - 1]}:${words[index]}`, 0.6);
  }
  for (const [key, raw] of Object.entries(context || {})) {
    if (raw == null || typeof raw === 'object') continue;
    const value = typeof raw === 'number' ? Math.round(raw) : String(raw).toLowerCase();
    add(`context:${key}:${value}`, 1.5);
  }
  const length = Math.sqrt([...values.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
  return [...values].map(([index, value]) => [index, value / length]);
}

function readText(filePath, maxBytes = 32768) {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, maxBytes);
  } catch {
    return '';
  }
}

function pressureStatus(name) {
  const text = readText(`/proc/pressure/${name}`, 2048);
  const match = text.match(/some\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/);
  return match
    ? { avg10: Number(match[1]), avg60: Number(match[2]), avg300: Number(match[3]) }
    : null;
}

function diskStatus(root) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(root);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      totalBytes,
      freeBytes,
      usedPercent: totalBytes ? Math.round((1 - freeBytes / totalBytes) * 100) : 0,
    };
  } catch {
    return null;
  }
}

function serverFileStatus(server, root) {
  const propertiesPath = path.join(root, 'server.properties');
  const properties = readText(propertiesPath, 128 * 1024);
  const property = (name) => properties.match(new RegExp(`^${name}=([^\\r\\n]+)`, 'mi'))?.[1]?.trim() || '';
  const javaWorld = path.join(root, 'world', 'level.dat');
  const bedrockWorlds = path.join(root, 'worlds');
  return {
    rootExists: fs.existsSync(root),
    executableExists: Boolean(server.executable_path && fs.existsSync(server.executable_path)),
    propertiesExists: fs.existsSync(propertiesPath),
    worldExists: fs.existsSync(javaWorld) || fs.existsSync(bedrockWorlds),
    viewDistance: Number(property('view-distance') || 0),
    simulationDistance: Number(property('simulation-distance') || property('tick-distance') || 0),
    maxPlayers: Number(property('max-players') || 0),
  };
}

function hostContext(server, root, runtime) {
  const memory = hostMemoryStats();
  const processMemory = process.memoryUsage();
  const disk = diskStatus(root);
  const cpuCount = hostCpuCount();
  const load = os.loadavg();
  const files = serverFileStatus(server, root);
  const panelRoot = path.resolve(__dirname, '..');
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  return {
    platform: process.platform,
    serverType: server.type,
    softwareKey: server.software_key || '',
    runtime,
    assignedCpuCores: Number(server.cpu_cores || 1),
    assignedMemoryMb: Number(server.max_memory_mb || 1024),
    hostCpuCores: cpuCount,
    hostCpuPercent: hostCpuPercent(),
    loadPerCore: Number(((load[0] || 0) / Math.max(1, cpuCount)).toFixed(2)),
    hostMemoryPercent: Math.round((memory.used / Math.max(1, memory.total)) * 100),
    hostFreeMemoryMb: Math.round(memory.free / 1024 / 1024),
    panelRssMb: Math.round(processMemory.rss / 1024 / 1024),
    panelHeapMb: Math.round(processMemory.heapUsed / 1024 / 1024),
    panelHeapPercent: Math.round((processMemory.heapUsed / Math.max(1, heapLimit)) * 100),
    panelUptimeMinutes: Math.round(process.uptime() / 60),
    panelIndexExists: fs.existsSync(path.join(panelRoot, 'frontend', 'index.html')),
    panelScriptExists: fs.existsSync(path.join(panelRoot, 'frontend', 'js', 'main.js')),
    panelStyleExists: fs.existsSync(path.join(panelRoot, 'frontend', 'css', 'main.css')),
    diskUsedPercent: disk?.usedPercent ?? -1,
    diskFreeMb: disk ? Math.round(disk.freeBytes / 1024 / 1024) : -1,
    rootExists: files.rootExists,
    executableExists: files.executableExists,
    propertiesExists: files.propertiesExists,
    worldExists: files.worldExists,
    viewDistance: files.viewDistance,
    simulationDistance: files.simulationDistance,
    maxPlayers: files.maxPlayers,
    cpuPressure10: pressureStatus('cpu')?.avg10 ?? -1,
    memoryPressure10: pressureStatus('memory')?.avg10 ?? -1,
    ioPressure10: pressureStatus('io')?.avg10 ?? -1,
  };
}

function telemetryEvidence(context) {
  const evidence = [];
  if (context.hostMemoryPercent >= 90) evidence.push('memory cgroup out of memory host memory critically high');
  else if (context.hostMemoryPercent >= 80) evidence.push('native memory allocation pressure high');
  if (context.loadPerCore >= 1.2 || context.hostCpuPercent >= 92) evidence.push('server overloaded cpu throttled tps below');
  if (context.diskFreeMb >= 0 && context.diskFreeMb < 1024) evidence.push('no space left on device disk free below 1gb');
  if (context.diskUsedPercent >= 95) evidence.push('disk quota nearly exhausted');
  if (context.ioPressure10 >= 10) evidence.push('disk latency high world save slow');
  if (!context.rootExists) evidence.push('server root missing working directory not found');
  if (!context.executableExists) evidence.push('unable to access jarfile bedrock_server not found');
  if (!context.propertiesExists && ['java', 'bedrock'].includes(context.serverType)) evidence.push('server.properties not found');
  if (!context.worldExists) evidence.push('world data missing');
  if (!context.panelIndexExists || !context.panelScriptExists || !context.panelStyleExists) {
    evidence.push('panel ui asset missing frontend script stylesheet not found');
  }
  if (context.panelHeapPercent >= 80 || context.panelRssMb >= 900) {
    evidence.push('panel node heap memory pressure event loop delayed');
  }
  return evidence;
}

function optimizationPlan(context) {
  const recommendations = [];
  const pressure = context.hostCpuPercent >= 85
    || context.loadPerCore >= 0.9
    || context.hostMemoryPercent >= 85
    || context.ioPressure10 >= 8;
  if (pressure && context.viewDistance > 8) {
    recommendations.push({
      key: 'view-distance',
      current: context.viewDistance,
      suggested: Math.max(6, context.viewDistance - 2),
      reason: 'Host pressure is high; reduce chunk work conservatively.',
      automatic: false,
    });
  }
  if (pressure && context.simulationDistance > 6) {
    recommendations.push({
      key: context.serverType === 'bedrock' ? 'tick-distance' : 'simulation-distance',
      current: context.simulationDistance,
      suggested: Math.max(4, context.simulationDistance - 2),
      reason: 'Reduce active ticking while preserving a playable radius.',
      automatic: false,
    });
  }
  if (context.assignedMemoryMb > context.hostFreeMemoryMb + 1024 && context.runtime === 'offline') {
    recommendations.push({
      key: 'memory-allocation',
      current: context.assignedMemoryMb,
      suggested: Math.max(1024, context.hostFreeMemoryMb - 512),
      reason: 'Configured RAM leaves too little host reserve.',
      automatic: false,
    });
  }
  if (context.diskFreeMb >= 0 && context.diskFreeMb < 4096) {
    recommendations.push({
      key: 'backup-retention',
      current: 'configured',
      suggested: 'review',
      reason: 'Low disk reserve can corrupt saves and incomplete backups.',
      automatic: false,
    });
  }
  return recommendations;
}

class RepairAgent {
  constructor(db) {
    this.db = db;
    this.weights = new Float32Array(rules.length * FEATURE_DIMENSIONS);
    this.bias = new Float32Array(rules.length);
    this.labelIndex = new Map(rules.map((rule, index) => [rule.id, index]));
    this.bootstrap();
    this.loadLearning();
  }

  bootstrap() {
    rules.forEach((rule, ruleIndex) => {
      this.bias[ruleIndex] = rule.severity === 'critical' ? 0.25 : rule.severity === 'warning' ? 0.1 : 0;
      const seed = [
        rule.id,
        rule.category,
        rule.summary,
        ...rule.patterns,
        ...rule.techniques,
      ].join(' ');
      for (const token of tokens(seed)) {
        const index = featureIndex(`token:${token}`);
        this.weights[ruleIndex * FEATURE_DIMENSIONS + index] += 0.18;
      }
    });
  }

  loadLearning() {
    const rows = this.db.prepare(`
      SELECT label, feature_index, weight
      FROM repair_agent_weights
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(MAX_LEARNED_WEIGHTS);
    for (const row of rows) {
      const label = this.labelIndex.get(row.label);
      const feature = Number(row.feature_index);
      if (label == null || feature < 0 || feature >= FEATURE_DIMENSIONS) continue;
      this.weights[label * FEATURE_DIMENSIONS + feature] += Number(row.weight || 0);
    }
  }

  score(features) {
    return rules.map((rule, ruleIndex) => {
      let score = this.bias[ruleIndex];
      const offset = ruleIndex * FEATURE_DIMENSIONS;
      for (const [index, value] of features) score += this.weights[offset + index] * value;
      return { rule, score };
    }).sort((a, b) => b.score - a.score);
  }

  analyze({ server, software, logs, root, runtime, deterministic = [] }) {
    const context = hostContext(server, root, runtime);
    const evidence = telemetryEvidence(context);
    const input = `${(logs || []).slice(-500).join('\n')}\n${evidence.join('\n')}`;
    const features = sparseFeatures(input, context);
    const inferred = diagnoseRuntime(input, { limit: 20 });
    const deterministicById = new Map(
      [...deterministic, ...inferred].map((item) => [item.id, item]),
    );
    const ranked = this.score(features)
      .map(({ rule, score }) => {
        const direct = deterministicById.get(rule.id);
        const adjusted = score + (direct ? 2.5 + Number(direct.matchedSignals || 0) * 0.35 : 0);
        const confidence = Math.max(0.05, Math.min(0.99, 1 / (1 + Math.exp(-(adjusted - 0.4)))));
        return {
          id: rule.id,
          category: rule.category,
          severity: rule.severity,
          summary: rule.summary,
          techniques: rule.techniques,
          confidence: Number(confidence.toFixed(3)),
          source: direct ? 'knowledge+neural' : 'neural',
        };
      })
      .filter((item, index) => deterministicById.has(item.id) || index === 0 || (index < 8 && item.confidence >= 0.53))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 12);
    const diagnosisIds = new Set(ranked.map((item) => item.id));
    const actions = Object.entries(ACTION_LIBRARY)
      .filter(([, action]) => action.applies.some((id) => diagnosisIds.has(id)))
      .map(([id, action]) => ({ id, ...action }));
    for (const baseAction of ['cleanup-partials', 'rebuild-resource-profile', 'verify-world-storage']) {
      if (!actions.some((action) => action.id === baseAction)) {
        actions.push({ id: baseAction, ...ACTION_LIBRARY[baseAction] });
      }
    }
    const graph = this.graph(ranked, actions, evidence, context);
    const plans = this.competingPlans(ranked, actions, context);
    return {
      model: this.status(),
      context,
      evidence,
      diagnoses: ranked,
      actions,
      plans,
      optimizations: optimizationPlan(context),
      graph,
      featureCount: features.length,
      featureVector: features,
      software: software?.key || server.software_key || '',
    };
  }

  graph(diagnoses, actions, evidence, context) {
    const nodes = [
      { id: 'server', type: 'subject', label: 'Minecraft server' },
      { id: 'vps', type: 'subject', label: `${context.platform} host` },
      ...evidence.map((label, index) => ({ id: `evidence:${index}`, type: 'evidence', label })),
      ...diagnoses.map((item) => ({ id: `diagnosis:${item.id}`, type: 'diagnosis', label: item.summary, confidence: item.confidence })),
      ...actions.map((item) => ({ id: `action:${item.id}`, type: 'action', label: item.description, risk: item.risk })),
    ];
    const edges = [
      ...evidence.map((_label, index) => ({ from: `evidence:${index}`, to: 'vps', relation: 'observed-on' })),
      ...diagnoses.map((item) => ({ from: 'server', to: `diagnosis:${item.id}`, relation: 'may-have', weight: item.confidence })),
      ...actions.flatMap((action) => action.applies
        .filter((id) => diagnoses.some((item) => item.id === id))
        .map((id) => ({ from: `diagnosis:${id}`, to: `action:${action.id}`, relation: 'addressed-by' }))),
    ];
    return { nodes, edges };
  }

  competingPlans(diagnoses, actions, context) {
    const primary = diagnoses[0];
    const actionIds = new Set(actions.map((action) => action.id));
    const plans = [];
    const addPlan = (plan) => {
      const key = `${plan.mode}:${plan.steps.join('|')}`;
      if (plans.some((existing) => existing.key === key)) return;
      plans.push({ key, ...plan });
    };

    addPlan({
      mode: 'safe-diagnose',
      title: 'Read-only diagnosis and evidence capture',
      risk: 'read-only',
      score: Number((0.55 + Number(primary?.confidence || 0) * 0.25).toFixed(3)),
      steps: ['telemetry-snapshot', 'database-integrity-check', 'file-layout-check', 'console-signature-capture'],
      rollback: ['no-write-operation'],
      productionGate: 'always-safe',
    });

    if (actionIds.has('repair-properties')) {
      addPlan({
        mode: 'properties-rebuild',
        title: 'Rebuild server.properties with atomic backup',
        risk: 'low',
        score: Number((0.7 + Number(primary?.confidence || 0) * 0.2).toFixed(3)),
        steps: ['backup-server-properties', 'parse-valid-key-values', 'rewrite-utf8-no-bom', 'verify-active-root'],
        rollback: ['restore-server-properties-backup'],
        productionGate: context.runtime === 'offline' ? 'offline-ready' : 'requires-offline',
      });
    }

    if (actionIds.has('repair-executable')) {
      addPlan({
        mode: 'runtime-reinstall',
        title: 'Verify or reinstall selected runtime',
        risk: 'medium',
        score: Number((0.62 + Number(primary?.confidence || 0) * 0.18).toFixed(3)),
        steps: ['snapshot-runtime-metadata', 'verify-download-source', 'download-to-repair-temp', 'atomic-executable-replace'],
        rollback: ['restore-previous-executable-if-present'],
        productionGate: context.diskFreeMb > 1024 ? 'disk-ready' : 'blocked-low-disk',
      });
    }

    if (actionIds.has('optimize-game-distance')) {
      addPlan({
        mode: 'bounded-optimization',
        title: 'Lower heavy game distances conservatively',
        risk: 'medium',
        score: Number((0.58 + Number(primary?.confidence || 0) * 0.14).toFixed(3)),
        steps: ['snapshot-properties', 'apply-only-smaller-distance-values', 'record-performance-before-after'],
        rollback: ['restore-properties-snapshot'],
        productionGate: context.runtime === 'offline' ? 'offline-ready' : 'requires-offline',
      });
    }

    addPlan({
      mode: 'rollback-first',
      title: 'Create rollback point before controlled repair',
      risk: 'low',
      score: Number((0.6 + (context.worldExists ? 0.12 : 0)).toFixed(3)),
      steps: ['create-config-rollback-point', 'verify-backup-directory', 'apply-low-risk-repairs-only'],
      rollback: ['latest-rollback-point'],
      productionGate: context.diskFreeMb > 512 ? 'rollback-ready' : 'blocked-low-disk',
    });

    return plans.sort((a, b) => b.score - a.score).slice(0, 6);
  }

  sandboxPlan(plan, context) {
    const checks = [
      { name: 'bounded-memory', ok: this.status().bounded, detail: `${this.status().estimatedStateMemoryMb} MB estimated agent state` },
      { name: 'disk-reserve', ok: Number(context.diskFreeMb || -1) !== 0 && Number(context.diskFreeMb || -1) > 256, detail: `${context.diskFreeMb} MB free` },
      { name: 'root-present', ok: Boolean(context.rootExists), detail: context.rootExists ? 'server root exists' : 'server root missing' },
      { name: 'production-gate', ok: !String(plan.productionGate || '').startsWith('blocked'), detail: plan.productionGate || 'not specified' },
    ];
    const destructive = ['runtime-reinstall', 'bounded-optimization'].includes(plan.mode);
    if (destructive) {
      checks.push({
        name: 'offline-write-gate',
        ok: context.runtime === 'offline',
        detail: context.runtime === 'offline' ? 'server offline' : 'server is online',
      });
    }
    return {
      ok: checks.every((check) => check.ok),
      checks,
      verifiedAt: Date.now(),
      note: 'Sandbox check verifies preconditions only; web research and model output are never executed directly.',
    };
  }

  recordEpisode({ serverId, signature = '', analysis, status = 'planned' }) {
    const result = this.db.prepare(`
      INSERT INTO repair_agent_episodes (
        server_id, signature, context_json, features_json, diagnoses_json, plan_json, status, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(serverId),
      String(signature),
      JSON.stringify(analysis.context),
      JSON.stringify((analysis.featureVector || []).slice(0, 1024)),
      JSON.stringify(analysis.diagnoses),
      JSON.stringify({ actions: analysis.actions, optimizations: analysis.optimizations, graph: analysis.graph }),
      status,
      Number(analysis.diagnoses[0]?.confidence || 0),
      Date.now(),
    );
    this.db.prepare(`
      DELETE FROM repair_agent_episodes
      WHERE id NOT IN (SELECT id FROM repair_agent_episodes ORDER BY id DESC LIMIT ?)
    `).run(MAX_EPISODES);
    const episodeId = Number(result.lastInsertRowid);
    this.recordPlans(episodeId, serverId, analysis);
    return episodeId;
  }

  recordPlans(episodeId, serverId, analysis) {
    const insert = this.db.prepare(`
      INSERT INTO repair_agent_plans (
        episode_id, server_id, plan_key, plan_json, sandbox_json,
        rollback_json, status, score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const plan of (analysis.plans || []).slice(0, 6)) {
      const sandbox = this.sandboxPlan(plan, analysis.context || {});
      insert.run(
        Number(episodeId),
        Number(serverId),
        plan.key,
        JSON.stringify(plan),
        JSON.stringify(sandbox),
        JSON.stringify({ strategy: plan.rollback || [], created: false }),
        sandbox.ok ? 'sandbox-verified' : 'sandbox-blocked',
        Number(plan.score || 0),
        Date.now(),
      );
    }
  }

  reinforce(episodeId, successfulDiagnosisIds, { reward = 1, source = 'stable-runtime' } = {}) {
    const episode = this.db.prepare('SELECT * FROM repair_agent_episodes WHERE id = ?').get(Number(episodeId));
    if (!episode) return { updated: 0 };
    if (String(source).startsWith('owner-') && String(episode.feedback_source || '').startsWith('owner-')) {
      return { updated: 0, labels: [], reward: 0, source: 'owner-feedback-already-recorded' };
    }
    const diagnoses = JSON.parse(episode.diagnoses_json || '[]');
    const parsedFeatures = JSON.parse(episode.features_json || '[]');
    const features = Array.isArray(parsedFeatures) ? parsedFeatures : [];
    const labels = [...new Set((successfulDiagnosisIds || []).filter((id) => this.labelIndex.has(id)))];
    const cleanReward = Math.max(-1, Math.min(1, Number(reward) || 0));
    let updated = 0;
    const upsert = this.db.prepare(`
      INSERT INTO repair_agent_weights (label, feature_index, weight, updates, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(label, feature_index) DO UPDATE SET
        weight = MAX(-2.0, MIN(2.0, repair_agent_weights.weight + excluded.weight)),
        updates = repair_agent_weights.updates + 1,
        updated_at = excluded.updated_at
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const label of labels) {
        const labelIndex = this.labelIndex.get(label);
        for (const [feature, value] of features.slice(0, 512)) {
          const delta = Math.max(-0.05, Math.min(0.05, 0.035 * value * cleanReward));
          upsert.run(label, feature, delta, Date.now());
          this.weights[labelIndex * FEATURE_DIMENSIONS + feature] += delta;
          updated += 1;
        }
      }
      this.db.prepare(`
        UPDATE repair_agent_episodes
        SET status = ?, reward = reward + ?, feedback_source = ?, validated_at = ?
        WHERE id = ?
      `).run(cleanReward >= 0 ? 'validated' : 'failed', cleanReward, String(source).slice(0, 80), Date.now(), Number(episodeId));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.db.prepare(`
      DELETE FROM repair_agent_weights
      WHERE rowid NOT IN (SELECT rowid FROM repair_agent_weights ORDER BY updated_at DESC LIMIT ?)
    `).run(MAX_LEARNED_WEIGHTS);
    return { updated, labels, reward: cleanReward, source };
  }

  feedback(episodeId, reward, source = 'owner-feedback') {
    const episode = this.db.prepare('SELECT diagnoses_json FROM repair_agent_episodes WHERE id = ?').get(Number(episodeId));
    if (!episode) return { updated: 0, labels: [], reward: 0, source };
    const diagnoses = JSON.parse(episode.diagnoses_json || '[]');
    let labels = Array.isArray(diagnoses)
      ? diagnoses
        .filter((item) => item?.source === 'knowledge+neural' || Number(item?.confidence || 0) >= 0.7)
        .slice(0, 4)
        .map((item) => item.id)
      : [];
    if (!labels.length && Array.isArray(diagnoses) && diagnoses[0]?.id) labels = [diagnoses[0].id];
    return this.reinforce(episodeId, labels, { reward, source });
  }

  penalizeLatest(serverId, source = 'repeat-crash') {
    const episode = this.db.prepare(`
      SELECT id
      FROM repair_agent_episodes
      WHERE server_id = ? AND status = 'planned' AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(Number(serverId), Date.now() - 30 * 60 * 1000);
    return episode ? this.feedback(episode.id, -1, source) : { updated: 0, labels: [], reward: 0, source };
  }

  status() {
    const learned = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(updates), 0) AS updates FROM repair_agent_weights').get();
    const episodes = this.db.prepare(`
      SELECT COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status = 'validated' THEN 1 ELSE 0 END), 0) AS validated,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(reward), 0) AS reward
      FROM repair_agent_episodes
    `).get();
    const modelBytes = this.weights.byteLength + this.bias.byteLength;
    const plans = this.db.prepare(`
      SELECT COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status = 'sandbox-verified' THEN 1 ELSE 0 END), 0) AS verified,
        COALESCE(SUM(CASE WHEN status = 'sandbox-blocked' THEN 1 ELSE 0 END), 0) AS blocked
      FROM repair_agent_plans
    `).get();
    const estimatedStateBytes = modelBytes
      + MAX_LEARNED_WEIGHTS * 32
      + MAX_EPISODES * 2048
      + 16 * 1024 * 1024;
    return {
      architecture: 'hashed-linear-neural-ranker+knowledge-graph',
      version: 1,
      parameterCount: PARAMETER_COUNT,
      featureDimensions: FEATURE_DIMENSIONS,
      labels: rules.length,
      modelBytes,
      modelMemoryMb: Number((modelBytes / 1024 / 1024).toFixed(2)),
      memoryBudgetMb: MAX_AGENT_MEMORY_BYTES / 1024 / 1024,
      estimatedStateMemoryMb: Number((estimatedStateBytes / 1024 / 1024).toFixed(2)),
      maxLearnedWeights: MAX_LEARNED_WEIGHTS,
      maxEpisodes: MAX_EPISODES,
      learnedWeights: Number(learned.count || 0),
      learningUpdates: Number(learned.updates || 0),
      episodes: Number(episodes.count || 0),
      validatedEpisodes: Number(episodes.validated || 0),
      failedEpisodes: Number(episodes.failed || 0),
      cumulativeReward: Number(episodes.reward || 0),
      processRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      plans: Number(plans.count || 0),
      sandboxVerifiedPlans: Number(plans.verified || 0),
      sandboxBlockedPlans: Number(plans.blocked || 0),
      bounded: estimatedStateBytes < MAX_AGENT_MEMORY_BYTES,
    };
  }
}

module.exports = {
  ACTION_LIBRARY,
  FEATURE_DIMENSIONS,
  MAX_AGENT_MEMORY_BYTES,
  PARAMETER_COUNT,
  RepairAgent,
};
