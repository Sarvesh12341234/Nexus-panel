'use strict';
const crypto=require('crypto');
const {RingBuffer}=require('./operations');

class NeuralGraph {
  constructor(limit=1000){
    this.nodes=new Map();
    this.edges=new Map();
    this.events=new RingBuffer(limit);
  }
  node(id,type,label,meta={}){
    const k=String(id);
    if(!this.nodes.has(k)) this.nodes.set(k,{id:k,type,label,meta});
    else this.nodes.get(k).meta={...this.nodes.get(k).meta,...meta};
    return this.nodes.get(k);
  }
  connect(from,to,type='flow'){
    const a=String(from), b=String(to);
    const key=`${a}=>${b}:${type}`;
    if(!this.edges.has(key)) this.edges.set(key,{id:key,from:a,to:b,type,activity:0,lastActivity:0});
    return this.edges.get(key);
  }
  pulse(from,to,type='flow',payload={}){
    const e=this.connect(from,to,type);
    e.activity=Math.min(1,e.activity+0.35);
    e.lastActivity=Date.now();
    const event={id:crypto.randomUUID(),ts:Date.now(),from:String(from),to:String(to),type,payload};
    this.events.push(event);
    return event;
  }
  decay(){
    const t=Date.now();
    for(const e of this.edges.values()){
      const dt=t-e.lastActivity;
      e.activity=dt>0?Math.max(0,e.activity*Math.pow(0.92,dt/1000)):e.activity;
    }
  }
  snapshot(){
    this.decay();
    return {
      readonly:true,
      ts:Date.now(),
      nodes:[...this.nodes.values()],
      edges:[...this.edges.values()],
      events:this.events.values().slice(-100)
    };
  }
}
module.exports={NeuralGraph};
