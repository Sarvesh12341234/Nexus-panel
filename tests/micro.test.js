'use strict';
const assert=require('node:assert');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {MicroDecisionModel}=require('../backend/micro_lm');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-micro-'));const m=new MicroDecisionModel(root);
const before=m.decide({error:'EACCES permission denied'});assert(before.action);
const after=m.learn({error:'EACCES permission denied'},'inspect-permissions',1);
assert(after.action);assert(m.state.samples===1);assert(fs.existsSync(path.join(root,'data','micro-lm.json')));
console.log('MicroLM test passed');
