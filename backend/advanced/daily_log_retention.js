'use strict';

const IMPORTANT = new Set([
  'learned','neural','security','backup','rollback','world-change',
  'database-change','critical','policy','authentication'
]);

class DailyLogRetention {
  constructor(activity,{maxRoutineDays=1}={}){
    this.activity=activity;
    this.maxRoutineDays=Math.max(1,maxRoutineDays);
  }
  purge(now=Date.now()){
    const cutoff=now-this.maxRoutineDays*86400000;
    const all=this.activity.list(10000);
    const keep=all.filter(e=>IMPORTANT.has(String(e.kind).split('.')[0]) || e.ts>=cutoff);
    // Replace only if the backing activity store exposes a controlled replacement.
    if(typeof this.activity.replace==='function') this.activity.replace(keep);
    return {before:all.length,after:keep.length,removed:Math.max(0,all.length-keep.length)};
  }
}
module.exports={DailyLogRetention,IMPORTANT};
