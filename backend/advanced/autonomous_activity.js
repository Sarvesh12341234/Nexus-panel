'use strict';
const crypto=require('crypto');
const {RingBuffer}=require('./operations');
class AutonomousActivity{
  constructor(limit=500){this.events=new RingBuffer(limit);}
  add(kind,message,meta={}){
    const e={id:crypto.randomUUID(),ts:Date.now(),kind,message,meta};
    this.events.push(e); return e;
  }
  list(limit=100){return this.events.values().slice(-limit);}
  replace(items){this.events=new RingBuffer(this.events.capacity||500);for(const e of items)this.events.push(e);}
}
module.exports={AutonomousActivity};
