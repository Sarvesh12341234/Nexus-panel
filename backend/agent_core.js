'use strict';
const {EventEmitter}=require('node:events');
class NexusAgentCore extends EventEmitter{
 constructor({microLm,learning}={}){super();this.microLm=microLm;this.learning=learning;this.events=[];this.maxEvents=200;this.on('event',e=>{this.events.unshift({...e,at:Date.now()});this.events.length=Math.min(this.events.length,this.maxEvents);});}
 ingest(type,payload={}){const decision=this.microLm?.decide(payload)||null;this.emit('event',{type,payload,decision});return decision;}
 snapshot(){return {eventCount:this.events.length,recent:this.events.slice(0,30)};}
}
module.exports={NexusAgentCore};
