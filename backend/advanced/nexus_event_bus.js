'use strict';
const {RingBuffer}=require('./operations');
class NexusEventBus{
  constructor(limit=1000){this.events=new RingBuffer(limit);this.listeners=new Map();}
  emit(type,payload={}){
    const e={type,payload,ts:Date.now()};
    this.events.push(e);
    const ls=this.listeners.get(type)||[];
    for(const fn of ls){try{fn(e)}catch(_){}}
    return e;
  }
  on(type,fn){
    if(!this.listeners.has(type))this.listeners.set(type,[]);
    this.listeners.get(type).push(fn);
    return ()=>this.listeners.set(type,(this.listeners.get(type)||[]).filter(x=>x!==fn));
  }
  recent(n=100){return this.events.values().slice(-n);}
}
module.exports={NexusEventBus};
