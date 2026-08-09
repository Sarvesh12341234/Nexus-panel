
'use strict';

/**
 * NexusPanel Advanced Operations Core 3.2.2
 * Lightweight, dependency-free orchestration primitives.
 *
 * Features:
 * - bounded incident timeline
 * - health scoring
 * - dependency/correlation graph
 * - safe change plans with rollback metadata
 * - model routing hints
 * - adaptive cooldowns
 */
const crypto = require('crypto');

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function id(prefix='nx') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

class RingBuffer {
  constructor(limit=500) { this.limit=limit; this.items=[]; }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length-this.limit);
  }
  values() { return this.items.slice(); }
  clear() { this.items.length=0; }
}

class HealthEngine {
  constructor() {
    this.history = new Map();
    this.window = 30;
  }
  observe(serverId, sample) {
    const arr=this.history.get(String(serverId)) || [];
    arr.push({...sample, ts: now()});
    if(arr.length>this.window) arr.splice(0,arr.length-this.window);
    this.history.set(String(serverId),arr);
    return this.score(serverId);
  }
  score(serverId) {
    const a=this.history.get(String(serverId)) || [];
    if(!a.length) return {score:100, risk:'unknown', confidence:0};
    let penalty=0;
    const last=a[a.length-1];
    const cpu=Number(last.cpu)||0, mem=Number(last.memory)||0, errors=Number(last.errors)||0;
    if(cpu>90) penalty+=25; else if(cpu>75) penalty+=10;
    if(mem>90) penalty+=25; else if(mem>80) penalty+=10;
    penalty += clamp(errors*3,0,30);
    if(a.length>=5) {
      const first=a[Math.max(0,a.length-5)];
      if((Number(last.cpu)||0)-(Number(first.cpu)||0)>20) penalty+=10;
      if((Number(last.memory)||0)-(Number(first.memory)||0)>20) penalty+=10;
    }
    const score=clamp(100-penalty,0,100);
    return {score, risk:score<40?'critical':score<65?'high':score<85?'medium':'low',
      confidence:clamp(0.35+a.length/40,0,0.95)};
  }
}

class IncidentEngine {
  constructor(limit=300) { this.events=new RingBuffer(limit); }
  add(type, data={}, severity='info') {
    const event={id:id('evt'),ts:now(),type,severity,data};
    this.events.push(event); return event;
  }
  list(limit=100) { return this.events.values().slice(-limit); }
}

class DependencyGraph {
  constructor() { this.nodes=new Map(); this.edges=new Map(); }
  node(id, meta={}) {
    const k=String(id); this.nodes.set(k,{id:k,...meta}); return this.nodes.get(k);
  }
  edge(a,b,relation='depends_on',weight=1) {
    this.node(a); this.node(b);
    const k=`${a}->${b}:${relation}`;
    this.edges.set(k,{from:String(a),to:String(b),relation,weight});
  }
  snapshot() { return {nodes:[...this.nodes.values()],edges:[...this.edges.values()]}; }
}

class ChangePlanner {
  plan(change, risk='medium') {
    return {
      id:id('plan'),
      createdAt:now(),
      risk,
      change,
      stages:['validate','snapshot','apply','verify'],
      rollback:{required:risk!=='low',strategy:'restore_snapshot_on_failed_verification'},
      status:'proposed'
    };
  }
}

function routeModel(task={}) {
  if(task.localOnly || task.complexity==='tiny') return 'microllm';
  if(task.code || task.debug || task.tools) return 'openrouter-selected';
  return 'openrouter-selected';
}

module.exports={RingBuffer,HealthEngine,IncidentEngine,DependencyGraph,ChangePlanner,routeModel};
