'use strict';
class NexusHealthMonitor{
  constructor(bus,health){this.bus=bus;this.health=health;this.last=new Map();}
  observe(id,sample){
    const result=this.health.observe(id,sample);
    this.last.set(String(id),{sample,result,ts:Date.now()});
    this.bus.emit('health.updated',{serverId:String(id),result});
    if(result.risk==='critical')this.bus.emit('health.critical',{serverId:String(id),result});
    return result;
  }
  snapshot(){return Object.fromEntries(this.last);}
}
module.exports={NexusHealthMonitor};
