'use strict';
const crypto=require('crypto');

class Nexus5Autopilot {
  constructor({bus,ledger,policy,activity,maxAttempts=3}={}){
    this.bus=bus; this.ledger=ledger; this.policy=policy; this.activity=activity;
    this.maxAttempts=Math.max(1,Math.min(5,maxAttempts));
    this.jobs=new Map();
  }
  start(target,reason){
    const id=crypto.randomUUID();
    const job={id,target,reason,status:'running',attempts:0,startedAt:Date.now(),steps:[]};
    this.jobs.set(id,job);
    this._event('autopilot.started',job);
    return job;
  }
  step(id,action,result){
    const j=this.jobs.get(id); if(!j) throw new Error('job not found');
    j.attempts++;
    j.steps.push({ts:Date.now(),action,result});
    this._event('autopilot.step',{id,action,result,attempt:j.attempts});
    if(j.attempts>=this.maxAttempts && !result?.ok) j.status='needs-review';
    return j;
  }
  finish(id,ok,summary){
    const j=this.jobs.get(id); if(!j) throw new Error('job not found');
    j.status=ok?'verified':'failed'; j.summary=summary; j.finishedAt=Date.now();
    this.ledger?.add({kind:'autonomous-change',jobId:id,target:j.target,ok,summary});
    this._event('autopilot.finished',j);
    return j;
  }
  _event(type,payload){
    this.bus?.emit(type,payload);
    this.activity?.add(type,payload.summary||type,{jobId:payload.id||payload.jobId});
  }
  list(){return [...this.jobs.values()].slice(-100);}
}
module.exports={Nexus5Autopilot};
