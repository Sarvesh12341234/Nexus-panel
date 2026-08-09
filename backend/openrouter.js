'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const KEY_FILE = path.join(DATA, 'openrouter.secret');
const STATE_FILE = path.join(DATA, 'openrouter.json');
const API_BASE = 'https://openrouter.ai/api/v1';

function ensureSecret() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o750 });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
  return fs.readFileSync(KEY_FILE, 'utf8').trim();
}

function crypt(value) {
  const secret = crypto.createHash('sha256').update(ensureSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decrypt(value) {
  try {
    const [iv, tag, data] = String(value).split('.');
    const secret = crypto.createHash('sha256').update(ensureSecret()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function saveState(state) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o750 });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, STATE_FILE);
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

function setApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (key && !/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(key)) {
    throw new Error('Invalid OpenRouter API key format.');
  }
  const state = loadState();
  if (key) state.apiKey = crypt(key);
  else delete state.apiKey;
  state.updatedAt = Date.now();
  saveState(state);
  return status();
}

function getApiKey() {
  const state = loadState();
  return state.apiKey ? decrypt(state.apiKey) : '';
}

function status() {
  const state = loadState();
  return {
    configured: Boolean(state.apiKey),
    keyPreview: state.apiKey ? 'sk-or-v1-••••••••••••' : '',
    model: state.model || '',
    freeOnly: state.freeOnly !== false,
    updatedAt: Number(state.updatedAt || 0),
    cachedModelsAt: Number(state.cachedModelsAt || 0),
  };
}

function setConfig({ model, freeOnly }) {
  const state = loadState();
  if (model !== undefined) state.model = String(model || '').slice(0, 180);
  if (freeOnly !== undefined) state.freeOnly = Boolean(freeOnly);
  saveState(state);
  return status();
}

function sanitizeModel(item) {
  return {
    id: String(item.id || ''),
    name: String(item.name || item.id || ''),
    description: String(item.description || '').slice(0, 500),
    contextLength: Number(item.context_length || 0),
    pricing: {
      prompt: String(item.pricing?.prompt ?? ''),
      completion: String(item.pricing?.completion ?? ''),
    },
    free: String(item.pricing?.prompt ?? '') === '0' && String(item.pricing?.completion ?? '') === '0',
    supportedParameters: Array.isArray(item.supported_parameters) ? item.supported_parameters.slice(0, 40) : [],
    architecture: item.architecture ? {
      modality: String(item.architecture.modality || ''),
      tokenizer: String(item.architecture.tokenizer || ''),
    } : {},
  };
}

async function request(endpoint, options = {}) {
  const key = getApiKey();
  if (!key) throw new Error('OpenRouter API key is not configured.');
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.NEXUSPANEL_PUBLIC_URL || 'http://localhost:3000',
      'X-Title': 'NexusPanel',
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    const message = String(data?.error?.message || data?.error || text || `OpenRouter HTTP ${response.status}`).slice(0, 500);
    throw new Error(message);
  }
  return data;
}

async function listModels({ force = false, freeOnly = true } = {}) {
  const state = loadState();
  if (!force && Array.isArray(state.models) && Date.now() - Number(state.cachedModelsAt || 0) < 10 * 60 * 1000) {
    return state.models;
  }
  const data = await request('/models');
  const models = (Array.isArray(data.data) ? data.data : [])
    .map(sanitizeModel)
    .filter((model) => !freeOnly || model.free)
    .sort((a, b) => {
      const af = a.free ? 1 : 0; const bf = b.free ? 1 : 0;
      return bf - af || b.contextLength - a.contextLength || a.name.localeCompare(b.name);
    })
    .slice(0, 500);
  state.models = models;
  state.cachedModelsAt = Date.now();
  saveState(state);
  return models;
}

async function test() {
  const data = await request('/models');
  return { ok: Array.isArray(data.data), count: Array.isArray(data.data) ? data.data.length : 0 };
}

async function chat({ model, messages, tools, temperature = 0.15, maxTokens = 1200, web = false } = {}) {
  const state = loadState();
  const selected = String(model || state.model || '').trim();
  if (!selected) throw new Error('No OpenRouter model selected.');
  const payload = {
    model: web && !selected.endsWith(':online') ? `${selected}:online` : selected,
    messages: Array.isArray(messages) ? messages.slice(-40) : [],
    temperature: Math.max(0, Math.min(1, Number(temperature) || 0)),
    max_tokens: Math.max(64, Math.min(4096, Number(maxTokens) || 1200)),
  };
  if (Array.isArray(tools) && tools.length) payload.tools = tools.slice(0, 64);
  const data = await request('/chat/completions', { method: 'POST', body: JSON.stringify(payload) });
  return {
    id: String(data.id || ''),
    model: String(data.model || payload.model),
    choices: Array.isArray(data.choices) ? data.choices.slice(0, 4) : [],
    usage: data.usage || null,
  };
}

module.exports = { status, setApiKey, getApiKey, setConfig, listModels, test, chat };
