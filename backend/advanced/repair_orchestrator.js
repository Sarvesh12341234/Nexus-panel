'use strict';
const crypto=require('crypto');

const PHASES=['observe','diagnose','plan','authorize','snapshot','repair','verify','commit','rollback'];
const SAFE_AUTO=new Set(['observe','diagnose','plan','verify']);

class RepairOrchestrator {
  constructor(graph, microLM){
    this.graph=graph;
    this.microLM=microLM;
    this.jobs=new Map();
  }
  create(target, reason){
    const id=crypto.randomUUID();
    const job={id,target,reason,phase:'observe',status:'running',createdAt:Date.now(),history:[]};
    this.jobs.set(id,job);
    this._pulse(job,'repair.create');
    return job;
  }
  transition(id,phase,detail={}){
    const job=this.jobs.get(id); if(!job) throw new Error('repair job not found');
    if(!PHASES.includes(phase)) throw new Error('invalid repair phase');
    const prev=job.phase;
    job.phase=phase; job.history.push({ts:Date.now(),from:prev,to:phase,detail});
    this._pulse(job,`repair.${phase}`,detail);
    return job;
  }
  finish(id,status='verified'){
    const job=this.jobs.get(id); if(!job) throw new Error('repair job not found');
    job.status=status; job.finishedAt=Date.now();
    this._pulse(job,'repair.complete',{status});
    return job;
  }
  _pulse(job,type,payload={}){
    if(this.graph && typeof this.graph.pulse==='function'){
      this.graph.pulse(`repair:${job.id}`,`target:${job.target}`,type,{...payload,phase:job.phase});
    }
  }
  get(id){return this.jobs.get(id)||null;}
  list(){return [...this.jobs.values()].slice(-100);}
}
module.exports={RepairOrchestrator,PHASES,SAFE_AUTO};
