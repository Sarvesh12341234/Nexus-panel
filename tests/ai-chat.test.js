'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { hashPassword, verifyPassword } = require('../backend/auth');
const { createAiChat, TTL } = require('../backend/ai_chat');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ai-test-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE panel_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  let now = Date.now(); const originalNow = Date.now; Date.now = () => now;
  let providerCalls = [], operations = [], round = 0;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); providerCalls.push({ url, body, headers: options.headers });
    const anthropic = url.includes('anthropic');
    let data;
    if (round++ % 2 === 0) data = anthropic
      ? { content: [{ type: 'tool_use', id: 'call1', name: 'server_info', input: {} }] }
      : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'server_info', arguments: '{}' } }] } }] };
    else data = anthropic ? { content: [{ type: 'text', text: 'Server checked.' }] } : { choices: [{ message: { role: 'assistant', content: 'Server checked.' } }] };
    return { ok: true, text: async () => JSON.stringify(data) };
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, role: req.headers['x-role'] || 'owner', session_id: req.headers['x-session'] || 'one' }; next(); });
  const ai = createAiChat({ db, dataDir: dir, hashPassword, verifyPassword, fetchImpl, requireAuth: (_req, _res, next) => next(), getServer: (id) => ({ id: Number(id) }), executeTool: async (name, args, server) => { operations.push({ name, args, server }); return { status: 'online' }; } });
  app.use('/ai', ai.router); app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  async function request(route, method = 'GET', body, headers = {}) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/ai${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, body: await result.json() };
  }
  try {
    assert.equal((await request('/settings', 'GET', null, { 'x-role': 'admin' })).status, 403);
    assert.equal((await request('/settings', 'PUT', { provider: 'openai', model: 'gpt-test', apiKey: 'secret-key', enabled: true })).status, 200);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM panel_settings').all()).includes('secret-key'));
    assert.ok(!JSON.stringify((await request('/settings')).body).includes('secret-key'));
    assert.equal((await request('/unlock', 'POST', { password: 'short' })).status, 400);
    assert.equal((await request('/unlock', 'POST', { password: 'correct-password' })).status, 200);
    assert.equal((await request('/unlock', 'POST', { password: 'wrong-password' }, { 'x-session': 'two' })).status, 401);
    assert.equal((await request('/chat', 'POST', { serverId: 42, message: 'Check it' })).body.reply, 'Server checked.');
    assert.equal(operations[0].server.id, 42);
    assert.equal(providerCalls[0].headers.Authorization, 'Bearer secret-key');
    assert.equal((await request('/history?serverId=42')).body.messages.length, 2);
    assert.equal((await request('/history?serverId=43')).body.messages.length, 0);
    now += TTL + 1;
    assert.equal((await request('/history?serverId=42')).status, 401);
    assert.equal((await request('/unlock', 'POST', { password: 'correct-password' })).status, 200);
    assert.equal((await request('/history?serverId=42')).body.messages.length, 0);
    for (const provider of ['nvidia', 'anthropic']) {
      providerCalls = []; round = 0;
      assert.equal((await request('/settings', 'PUT', { provider, model: 'model-test', apiKey: 'other-key', enabled: true })).status, 200);
      assert.equal((await request('/history?serverId=42')).status, 401);
      await request('/unlock', 'POST', { password: 'correct-password' });
      assert.equal((await request('/chat', 'POST', { serverId: 42, message: 'Check' })).body.reply, 'Server checked.');
      assert.ok(providerCalls[0].url.includes(provider === 'nvidia' ? 'nvidia' : 'anthropic'));
      if (provider === 'anthropic') assert.equal(providerCalls[1].body.messages.at(-1).content[0].type, 'tool_result');
      else assert.equal(providerCalls[1].body.messages.at(-1).role, 'tool');
    }
    assert.equal((await request('/settings', 'PUT', { provider: 'anthropic', model: 'model-test', enabled: false })).status, 200);
    assert.equal((await request('/history?serverId=42')).status, 401);
    console.log('AI chat tests passed.');
  } finally {
    Date.now = originalNow; await new Promise((resolve) => server.close(resolve)); db.close();
    const root = path.resolve(os.tmpdir()) + path.sep;
    if (path.resolve(dir).startsWith(root)) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
