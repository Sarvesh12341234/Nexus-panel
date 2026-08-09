'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert');
const index=fs.readFileSync(path.join(__dirname,'..','backend','index.js'),'utf8');
assert(index.includes("WHERE port = ? AND id != ?"));
assert(!/WHERE\s+port\s*=\s*['"`]\s*\$\{/.test(index));
assert(fs.existsSync(path.join(__dirname,'..','backend','openrouter.js')));
assert(index.includes("app.post('/api/advanced-ai/providers/openrouter/key'"));
console.log('Security/provider/port regression test passed');
