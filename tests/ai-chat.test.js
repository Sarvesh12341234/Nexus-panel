'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { hashPassword, verifyPassword } = require('../backend/auth');
const { createAiChat, TTL } = require('../backend/ai_chat');
const { runFullTerminal } = require('../backend/ai_full_terminal');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ai-test-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE panel_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  let now = Date.now(); const originalNow = Date.now; Date.now = () => now;
  let providerCalls = [], operations = [], round = 0, requestedTool = 'server_info';
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); providerCalls.push({ url, body, headers: options.headers });
    const anthropic = url.includes('anthropic');
    let data;
    if (round++ % 2 === 0) data = anthropic
      ? { content: [{ type: 'tool_use', id: 'call1', name: requestedTool, input: {} }] }
      : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: requestedTool, arguments: '{}' } }] } }] };
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
    assert.equal((await request('/full-access', 'PUT', { enabled: true, password: 'wrong-password' })).status, 401);
    assert.equal((await request('/settings')).body.fullAccess, false);
    assert.equal((await request('/full-access', 'PUT', { enabled: true, password: 'correct-password' }, { 'x-role': 'admin' })).status, 403);
    assert.equal((await request('/full-access', 'PUT', { enabled: true, password: 'correct-password' })).body.fullAccess, true);
    assert.equal((await request('/history?serverId=42')).status, 401);
    await request('/unlock', 'POST', { password: 'correct-password' });
    requestedTool = 'full_terminal'; round = 0; providerCalls = [];
    await request('/chat', 'POST', { serverId: 42, message: 'Run a command' });
    assert.equal(operations.at(-1).name, 'full_terminal');
    assert.ok(providerCalls[0].body.tools.some((tool) => tool.function.name === 'full_terminal'));
    assert.equal((await request('/full-access', 'PUT', { enabled: false })).body.fullAccess, false);
    await request('/unlock', 'POST', { password: 'correct-password' });
    const count = operations.length; round = 0; providerCalls = [];
    await request('/chat', 'POST', { serverId: 42, message: 'Run a command' });
    assert.equal(operations.length, count);
    assert.ok(!providerCalls[0].body.tools.some((tool) => tool.function.name === 'full_terminal'));
    assert.match(providerCalls[1].body.messages.at(-1).content, /disabled tool/);
    requestedTool = 'server_info';
    const terminal = await runFullTerminal('node -e "process.stdout.write(\'full-access-test\')"', dir);
    assert.equal(terminal.exitCode, 0); assert.equal(terminal.stdout, 'full-access-test');
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
      const jpeg = Buffer.from('ffd8ffe000000000', 'hex').toString('base64');
      providerCalls = []; round = 0;
      assert.equal((await request('/chat', 'POST', { serverId: 42, message: '', attachedImage: jpeg })).status, 200);
      const imageMessage = providerCalls[0].body.messages.find((item) => Array.isArray(item.content) && item.content.some((part) => part.type === (provider === 'anthropic' ? 'image' : 'image_url')));
      const image = imageMessage.content.find((part) => part.type === (provider === 'anthropic' ? 'image' : 'image_url'));
      if (provider === 'anthropic') assert.equal(image.source.media_type, 'image/jpeg');
      else assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
      const history = (await request('/history?serverId=42')).body.messages;
      assert.match(history.at(-2).images[0], /^data:image\/jpeg;base64,/);
      assert.equal((await request('/chat', 'POST', { serverId: 42, message: '', attachedImage: 'invalid!' })).status, 400);
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
