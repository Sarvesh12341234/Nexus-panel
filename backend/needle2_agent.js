'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'ai', 'needle2', 'known-issues.json');
const REPAIR_TOOLS = require('../ai/needle2/repair-tools.json');
const DEFAULT_MODEL_PATH = path.join(__dirname, '..', 'data', 'needle2', 'nexuspanel-needle2.cact');
const WORKER_PATH = path.join(__dirname, 'needle2_worker.py');
const MAX_WORKERS = Math.max(1, Math.min(32, Number(process.env.NEXUSPANEL_NEEDLE2_MAX_WORKERS) || 8));
const IDLE_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 45000;
const REQUEST_TIMEOUT_MS = 15000;
const registry = readRegistry();
const workers = new Map();
let nextRequestId = 1;

function readRegistry() {
  try {
    const value = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function modelPath() {
  return path.resolve(process.env.NEXUSPANEL_NEEDLE2_MODEL || DEFAULT_MODEL_PATH);
}

function enabled() {
  return Object.keys(registry).length > 0 && fs.existsSync(modelPath()) && fs.existsSync(WORKER_PATH);
}

function pythonCommand() {
  return String(process.env.NEXUSPANEL_NEEDLE2_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
}

function safeEnvironment() {
  const keys = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME'];
  const env = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  env.PYTHONUNBUFFERED = '1';
  env.NEEDLE_TELEMETRY = '0';
  return env;
}

function redact(text) {
  return String(text || '')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/ig, '$1[redacted]')
    .replace(/\b(sk-or-v1-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[redacted-token]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]')
    .slice(-1400);
}

function removeWorker(serverId, worker, kill = true) {
  if (workers.get(serverId) !== worker) return;
  workers.delete(serverId);
  if (worker.startTimer) clearTimeout(worker.startTimer);
  if (worker.pendingTimer) clearTimeout(worker.pendingTimer);
  for (const resolve of worker.pending.values()) resolve(null);
  worker.pending.clear();
  if (kill && worker.child && !worker.child.killed) worker.child.kill();
}

function reapIdle() {
  const now = Date.now();
  for (const [serverId, worker] of workers) {
    if (!worker.busy && worker.ready && now - worker.lastUsedAt > IDLE_MS) removeWorker(serverId, worker);
  }
}

function createWorker(serverId) {
  reapIdle();
  if (workers.size >= MAX_WORKERS) {
    const oldest = [...workers.entries()]
      .filter(([, item]) => item.ready && !item.busy)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (oldest) removeWorker(oldest[0], oldest[1]);
  }
  if (workers.size >= MAX_WORKERS) return null;

  const child = spawn(pythonCommand(), [WORKER_PATH, modelPath()], {
    cwd: path.dirname(WORKER_PATH),
    env: safeEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const worker = {
    child,
    ready: false,
    busy: false,
    lastUsedAt: Date.now(),
    pending: new Map(),
    buffer: '',
    startTimer: null,
    pendingTimer: null,
  };
  workers.set(serverId, worker);
  worker.startTimer = setTimeout(() => removeWorker(serverId, worker), START_TIMEOUT_MS);
  worker.startTimer.unref?.();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    worker.buffer += chunk;
    if (worker.buffer.length > 128 * 1024) return removeWorker(serverId, worker);
    let boundary;
    while ((boundary = worker.buffer.indexOf('\n')) >= 0) {
      const line = worker.buffer.slice(0, boundary).trim();
      worker.buffer = worker.buffer.slice(boundary + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.ready === true) {
        worker.ready = true;
        clearTimeout(worker.startTimer);
        worker.startTimer = null;
        continue;
      }
      const resolve = worker.pending.get(Number(message.requestId));
      if (!resolve) continue;
      worker.pending.delete(Number(message.requestId));
      clearTimeout(worker.pendingTimer);
      worker.pendingTimer = null;
      worker.busy = false;
      worker.lastUsedAt = Date.now();
      resolve(message.error ? null : message.result || null);
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', () => removeWorker(serverId, worker, false));
  child.on('exit', () => removeWorker(serverId, worker, false));
  return worker;
}

async function getReadyWorker(serverId) {
  let worker = workers.get(serverId);
  if (worker && worker.ready) return worker;
  if (worker) return null;
  worker = createWorker(serverId);
  if (!worker) return null;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      if (worker.ready) return resolve(worker);
      if (workers.get(serverId) !== worker || Date.now() - startedAt > START_TIMEOUT_MS) return resolve(null);
      const timer = setTimeout(poll, 100);
      timer.unref?.();
    };
    poll();
  });
}

async function requestWorkerResult(serverId, input) {
  if (!enabled()) return null;
  const id = Number(serverId);
  const text = redact(input);
  if (!Number.isSafeInteger(id) || id <= 0 || text.length < 12) return null;
  const worker = await getReadyWorker(id);
  if (!worker || worker.busy || !worker.child.stdin.writable) return null;

  const requestId = nextRequestId++;
  worker.busy = true;
  worker.lastUsedAt = Date.now();
  const result = await new Promise((resolve) => {
    worker.pending.set(requestId, resolve);
    worker.pendingTimer = setTimeout(() => {
      worker.pending.delete(requestId);
      worker.busy = false;
      removeWorker(id, worker);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    worker.pendingTimer.unref?.();
    worker.child.stdin.write(`${JSON.stringify({ requestId, text })}\n`, (error) => {
      if (error) {
        worker.pending.delete(requestId);
        clearTimeout(worker.pendingTimer);
        worker.busy = false;
        resolve(null);
      }
    });
  });

  if (!result || typeof result !== 'object') return null;
  const evidence = typeof result.evidence === 'string' ? result.evidence.trim() : '';
  if (!evidence || evidence.length > 700 || !text.toLowerCase().includes(evidence.toLowerCase())) return null;
  return { result, text, evidence };
}

async function classify(serverId, input) {
  const response = await requestWorkerResult(serverId, input);
  if (!response) return null;
  const { result, evidence } = response;
  if (result.kind !== 'issue' || typeof result.id !== 'string' || !registry[result.id]) return null;
  const issue = registry[result.id];
  return {
    issueId: result.id,
    evidence,
    cause: String(issue.cause || '').slice(0, 1200),
    fix: String(issue.fix || '').slice(0, 1200),
    error: String(issue.error || '').slice(0, 500),
    source: 'needle2-local-advisory',
    verified: false,
    executable: false,
  };
}

async function suggestRepairTool(serverId, input) {
  const response = await requestWorkerResult(serverId, input);
  if (!response) return null;
  const { result, evidence } = response;
  if (result.kind !== 'repair-tool' || typeof result.tool !== 'string' || typeof result.issueId !== 'string') return null;
  const issue = registry[result.issueId];
  const allowed = REPAIR_TOOLS.issueMap[result.issueId];
  if (!issue || !allowed || allowed !== result.tool || issue.repairTool !== result.tool) return null;
  return {
    tool: result.tool,
    issueId: result.issueId,
    evidence,
    cause: String(issue.cause || '').slice(0, 1200),
    fix: String(issue.fix || '').slice(0, 1200),
    source: 'needle2-local-tool-request',
    verified: false,
  };
}

function status() {
  return {
    enabled: enabled(),
    model: enabled() ? path.basename(modelPath()) : '',
    documentedIssues: Object.keys(registry).length,
    isolatedServerWorkers: workers.size,
    maxWorkers: MAX_WORKERS,
    mode: 'read-only-advisory',
  };
}

process.once('exit', () => {
  for (const worker of workers.values()) {
    if (worker.child && !worker.child.killed) worker.child.kill();
  }
});

module.exports = { classify, suggestRepairTool, enabled, status };
