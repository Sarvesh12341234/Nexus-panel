'use strict';
const crypto=require('crypto');

class ChangeLedger {
  constructor(limit=500){this.limit=limit;this.items=[];}
  add(entry){
    const e={id:crypto.randomUUID(),ts:Date.now(),...entry};
    this.items.push(e);
    if(this.items.length>this.limit)this.items.splice(0,this.items.length-this.limit);
    return e;
  }
  recent(n=100){return this.items.slice(-n);}
}
module.exports={ChangeLedger};
