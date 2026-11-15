'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/main.js'), 'utf8');
const start = source.indexOf('async function api(path, options = {}) {');
const end = source.indexOf('\nfunction invalidateApiCache', start);
assert.ok(start >= 0 && end > start, 'frontend API helper must exist');
const context = {
  AbortController, Map, window: { setTimeout, clearTimeout },
  apiCache: new Map(), apiInFlight: new Map(), apiCacheKey: (route) => route,
  fetch: (_path, options) => new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
  }),
};
vm.runInNewContext(source.slice(start, end) + '\nthis.api = api;', context);

(async () => {
  const caller = new AbortController();
  await assert.rejects(context.api('/search', { signal: caller.signal, timeoutMs: 20 }),
    (error) => error.code === 'timeout', 'a caller signal must not disable the timeout');
  const canceled = new AbortController();
  const pending = context.api('/search', { signal: canceled.signal, timeoutMs: 1000 });
  canceled.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError' && !error.code,
    'caller cancellation must stay distinguishable from a timeout');
  const first = new AbortController();
  const second = new AbortController();
  const firstRequest = context.api('/same-search', { signal: first.signal, timeoutMs: 1000 });
  const secondRequest = context.api('/same-search', { signal: second.signal, timeoutMs: 25 });
  first.abort();
  await assert.rejects(firstRequest, (error) => error.name === 'AbortError');
  await assert.rejects(secondRequest, (error) => error.code === 'timeout',
    'canceling an old search must not abort an identical new search');
  console.log('Frontend API timeout and cancellation tests passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
