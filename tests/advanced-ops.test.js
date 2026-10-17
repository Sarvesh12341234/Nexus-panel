const assert = require('node:assert/strict');
const { HealthEngine, IncidentEngine, DependencyGraph, ChangePlanner, routeModel } = require('../backend/advanced/operations');

const h = new HealthEngine();
const healthy = h.observe('1', {cpu: 20, memory: 30, errors: 0});
assert.equal(healthy.score, 100);
const stressed = h.observe('1', {cpu: 95, memory: 95, errors: 5});
assert.ok(stressed.score < 40);

const incidents = new IncidentEngine(2);
incidents.add('a'); incidents.add('b'); incidents.add('c', {}, 'high');
assert.equal(incidents.list().length, 2);

const graph = new DependencyGraph();
graph.edge('server:1','port:25565','binds');
assert.equal(graph.snapshot().edges.length, 1);

const plan = new ChangePlanner().plan({key:'port',value:25566}, 'high');
assert.deepEqual(plan.stages, ['validate','snapshot','apply','verify']);
assert.equal(plan.rollback.required, true);

assert.equal(routeModel({complexity:'tiny'}), 'microllm');
assert.equal(routeModel({code:true}), 'deferred');

console.log('Advanced operations tests passed');
