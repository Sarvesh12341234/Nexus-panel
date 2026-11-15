'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'ai', 'needle2', 'known-issues.json');
const REPAIR_TOOLS = require('../ai/needle2/repair-tools.json');
const { repairCandidatePrompt } = require('./needle2_repair_candidates');
const DEFAULT_MODEL_PATH = path.join(__dirname, '..', 'data', 'needle2', 'nexuspanel-needle2.cact');
const LOCAL_REPAIR_MODEL_PATH = path.join(__dirname, '..', 'data', 'needle2', 'nexuspanel-needle2-repair.cact');
const BUNDLED_REPAIR_MODEL_PATH = path.join(__dirname, '..', 'models', 'nexuspanel-needle2-repair.cact');
const WORKER_PATH = path.join(__dirname, 'needle2_worker.py');
const MAX_WORKERS = Math.max(1, Math.min(32, Number(process.env.NEXUSPANEL_NEEDLE2_MAX_WORKERS) || 8));
const IDLE_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 45000;
const REQUEST_TIMEOUT_MS = 15000;
const registry = readRegistry();
const workers = new Map();
let nextRequestId = 1;
let lastWorkerError = '';

function readRegistry() {
  try {
    const value = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function modelPath(mode = 'classify') {
  return path.resolve(mode === 'repair'
    ? (process.env.NEXUSPANEL_NEEDLE2_REPAIR_MODEL || (fs.existsSync(LOCAL_REPAIR_MODEL_PATH) ? LOCAL_REPAIR_MODEL_PATH : BUNDLED_REPAIR_MODEL_PATH))
    : (process.env.NEXUSPANEL_NEEDLE2_MODEL || DEFAULT_MODEL_PATH));
}

function validModelFile(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const header = Buffer.alloc(4);
    if (fs.readSync(handle, header, 0, header.length, 0) !== header.length) return false;
    return [0x05e12a83, 0x05e12a84].includes(header.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function enabled(mode = 'classify') {
  return Object.keys(registry).length > 0 && validModelFile(modelPath(mode)) && fs.existsSync(WORKER_PATH);
}

function pythonCommand() {
  if (process.env.NEXUSPANEL_NEEDLE2_PYTHON) return String(process.env.NEXUSPANEL_NEEDLE2_PYTHON);
  const localPython = process.platform === 'win32'
    ? path.join(__dirname, '..', 'data', 'needle2', 'runtime-win', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', 'data', 'needle2', 'runtime-linux', 'bin', 'python');
  return fs.existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3');
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
  if (workers.get(worker.key) !== worker) return;
  workers.delete(worker.key);
  if (worker.startTimer) clearTimeout(worker.startTimer);
  if (worker.startTimer) worker.startTimer = null;
  if (worker.pendingTimer) clearTimeout(worker.pendingTimer);
  if (worker.pendingTimer) worker.pendingTimer = null;
  // Clear busy so anything waiting on this worker stops immediately.
  worker.busy = false;
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

function createWorker(serverId, mode = 'classify') {
  reapIdle();
  if (workers.size >= MAX_WORKERS) {
    const oldest = [...workers.entries()]
      .filter(([, item]) => item.ready && !item.busy)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (oldest) removeWorker(oldest[0], oldest[1]);
  }
  if (workers.size >= MAX_WORKERS) return null;

  const child = spawn(pythonCommand(), [WORKER_PATH, modelPath(mode)], {
    cwd: path.dirname(WORKER_PATH),
    env: safeEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const worker = {
    key: `${mode}:${serverId}`,
    child,
    ready: false,
    busy: false,
    lastUsedAt: Date.now(),
    pending: new Map(),
    requestQueue: Promise.resolve(),
    buffer: '',
    startTimer: null,
    pendingTimer: null,
  };
  workers.set(worker.key, worker);
  worker.startTimer = setTimeout(() => {
    lastWorkerError = 'Needle worker did not start before the timeout.';
    removeWorker(serverId, worker);
  }, START_TIMEOUT_MS);
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
        lastWorkerError = '';
        clearTimeout(worker.startTimer);
        worker.startTimer = null;
        continue;
      }
      if (message.ready === false) {
        const errorType = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(String(message.error || '')) ? message.error : 'UnknownError';
        lastWorkerError = `Needle worker could not initialize (${errorType}).`;
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
  child.on('error', () => {
    lastWorkerError = 'Needle Python process could not be started.';
    removeWorker(serverId, worker, false);
  });
  child.on('exit', () => {
    if (!worker.ready && !lastWorkerError) lastWorkerError = 'Needle worker exited before it was ready.';
    removeWorker(serverId, worker, false);
  });
  return worker;
}

async function getReadyWorker(serverId, mode = 'classify') {
  let worker = workers.get(`${mode}:${serverId}`);
  if (worker && worker.ready) return worker;
  if (!worker) worker = createWorker(serverId, mode);
  if (!worker) return null;
  if (worker.readyPromise) return worker.readyPromise;
  worker.readyPromise = new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      if (worker.ready) return resolve(worker);
      if (workers.get(worker.key) !== worker || Date.now() - startedAt > START_TIMEOUT_MS) return resolve(null);
      const timer = setTimeout(poll, 100);
      timer.unref?.();
    };
    poll();
  });
  return worker.readyPromise;
}

async function requestWorkerResult(serverId, input, candidate = null) {
  const mode = candidate ? 'repair' : 'classify';
  if (!enabled(mode)) return null;
  const id = Number(serverId);
  const text = redact(input);
  if (!Number.isSafeInteger(id) || id <= 0 || text.length < 12) return null;
  if (candidate && text !== repairCandidatePrompt(candidate)) return null;
  const worker = await getReadyWorker(id, mode);
  if (!worker) return null;

  // Queue requests atomically. Polling `busy` allows multiple callers to see
  // the same idle worker and write concurrently, corrupting request/result
  // association in the single-session Python process.
  let queueExpired = false;
  let queueTimeout;
  const queueDeadline = new Promise((resolve) => {
    queueTimeout = setTimeout(() => {
      queueExpired = true;
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    queueTimeout.unref?.();
  });
  const runRequest = async () => {
    if (queueExpired || workers.get(worker.key) !== worker || !worker.child.stdin.writable) return null;
    const requestId = nextRequestId++;
    worker.busy = true;
    worker.lastUsedAt = Date.now();
    return new Promise((resolve) => {
      worker.pending.set(requestId, resolve);
      worker.pendingTimer = setTimeout(() => {
        worker.pending.delete(requestId);
        worker.busy = false;
        removeWorker(id, worker);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      worker.pendingTimer.unref?.();
      worker.child.stdin.write(`${JSON.stringify({ requestId, text, mode, ...(candidate ? { candidate } : {}) })}\n`, (error) => {
        if (error) {
          worker.pending.delete(requestId);
          clearTimeout(worker.pendingTimer);
          worker.pendingTimer = null;
          worker.busy = false;
          resolve(null);
        }
      });
    });
  };
  const request = worker.requestQueue.then(runRequest, runRequest);
  worker.requestQueue = request.catch(() => null);
  const result = await Promise.race([request, queueDeadline]);
  clearTimeout(queueTimeout);

  if (!result || typeof result !== 'object') return null;
  const evidence = typeof result.evidence === 'string' ? result.evidence.trim() : '';
  if (!evidence || evidence.length > 700 || !text.toLowerCase().includes(evidence.toLowerCase())) return null;
  return { result, text, evidence };
}

function matchDocumentedIssue(input) {
  const text = redact(input);
  const lower = text.toLowerCase();
  const matches = [];
  for (const [id, issue] of Object.entries(registry)) {
    const error = String(issue.error || '').trim();
    if (error.length < 16) continue;
    const offset = lower.lastIndexOf(error.toLowerCase());
    if (offset >= 0) matches.push({ id, evidence: text.slice(offset, offset + error.length) });
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

async function classify(serverId, input) {
  if (!Number.isSafeInteger(Number(serverId)) || Number(serverId) <= 0) return null;
  const exact = matchDocumentedIssue(input);
  if (exact) {
    const issue = registry[exact.id];
    return {
      issueId: exact.id, evidence: exact.evidence,
      cause: String(issue.cause || '').slice(0, 1200),
      fix: String(issue.fix || '').slice(0, 1200),
      error: String(issue.error || '').slice(0, 500),
      source: 'documented-exact-match', verified: false, executable: false,
    };
  }
  if (!enabled()) return null;
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

async function suggestRepairTool(serverId, candidate) {
  if (!candidate || typeof candidate.issueId !== 'string' || typeof candidate.tool !== 'string'
      || typeof candidate.evidence !== 'string' || !candidate.evidence.trim()
      || REPAIR_TOOLS.issueMap[candidate.issueId] !== candidate.tool) return null;
  const response = await requestWorkerResult(serverId, repairCandidatePrompt(candidate), candidate);
  if (!response) return null;
  const { result, evidence } = response;
  if (result.kind !== 'repair-tool' || typeof result.tool !== 'string' || typeof result.issueId !== 'string') return null;
  const issue = registry[result.issueId];
  const allowed = REPAIR_TOOLS.issueMap[result.issueId];
  if (!issue || !allowed || allowed !== result.tool || issue.repairTool !== result.tool
      || result.issueId !== candidate.issueId || result.tool !== candidate.tool
      || evidence.length < 12 || !candidate.evidence.includes(evidence)) return null;
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
    repairModelEnabled: enabled('repair'),
    repairModel: enabled('repair') ? path.basename(modelPath('repair')) : '',
    repairModelError: fs.existsSync(modelPath('repair')) && !validModelFile(modelPath('repair'))
      ? 'Repair model is invalid or is an unresolved Git LFS pointer.' : null,
    documentedIssues: Object.keys(registry).length,
    isolatedServerWorkers: workers.size,
    maxWorkers: MAX_WORKERS,
    runtimeError: lastWorkerError || null,
    mode: enabled('repair') ? 'advisory-and-confirmed-repair-routing' : 'read-only-advisory',
  };
}

function shutdownWorkers() {
  for (const [key, worker] of workers) removeWorker(key, worker);
}

process.once('exit', shutdownWorkers);

module.exports = { classify, suggestRepairTool, enabled, status, matchDocumentedIssue, shutdownWorkers };
