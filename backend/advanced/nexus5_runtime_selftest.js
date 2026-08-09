'use strict';
const assert=require('assert');
const {CapabilityGuard}=require('./capability_guard');
const {AnomalyDetector}=require('./anomaly_detector');
const {NexusDecisionEngine}=require('./nexus_decision_engine');

function run(){
  const g=new CapabilityGuard(); g.grant('ai',['server:read']);
  assert(g.can('ai','server:read')); assert(!g.can('ai','server:write'));
  const d=new AnomalyDetector();
  for(let i=0;i<12;i++) d.observe('cpu',10);
  const a=d.observe('cpu',100);
  assert(a.anomaly===true);
  const e=new NexusDecisionEngine();
  const safe=e.decide({action:'repair permissions',target:'/srv/panel/config'});
  assert(safe.autonomous===true);
  const protectedOp=e.decide({action:'delete',target:'world'});
  assert(protectedOp.requiresConfirmation===true);
  return {ok:true,checks:4};
}
if(require.main===module) console.log(JSON.stringify(run()));
module.exports={run};
