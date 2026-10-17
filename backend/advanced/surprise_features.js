'use strict';

/*
  1. Predictive Restart Guard: identifies repeated failures before another restart.
  2. Config Drift Detector: hashes selected config snapshots to detect unexpected changes.
  3. Repair Confidence: combines health + repeat-failure signals into a bounded score.
  4. Dependency Heatmap: counts recent events per component for graph emphasis.
  5. Golden Snapshot Planner: recommends the smallest useful snapshot before risky changes.
*/
const crypto=require('crypto');
function predictiveRestartGuard(history=[]){
  const recent=history.slice(-5), failures=recent.filter(x=>x && x.ok===false).length;
  return {restartRecommended:failures<3, failures, storm:failures>=3};
}
function configFingerprint(value){
  return crypto.createHash('sha256').update(JSON.stringify(value||{})).digest('hex');
}
function repairConfidence({health=100,failures=0,verification=1}={}){
  return Math.max(0,Math.min(1,(health/100)*0.6 + Math.max(0,1-failures/5)*0.25 + verification*0.15));
}
function dependencyHeat(events=[]){
  const m={};
  for(const e of events){
    for(const k of [e.from,e.to,e.component].filter(Boolean)) m[k]=(m[k]||0)+1;
  }
  return m;
}
function goldenSnapshotPlan(op={}){
  const protectedChange=!!op.protectedData || /world|database|backup/i.test(String(op.target||''));
  return {recommended:protectedChange || op.risk==='high',reason:protectedChange?'protected data':'high-risk change'};
}
module.exports={predictiveRestartGuard,configFingerprint,repairConfidence,dependencyHeat,goldenSnapshotPlan};
