'use strict';

const fs=require('node:fs');
const path=require('node:path');

class MicroDecisionModel {
  constructor(root) {
    this.file=path.join(root,'data','micro-lm.json');
    this.features=['eacces','oom','eaddrinuse','crash','cpu','memory','disk','network','nexusmark','paper','plugin','healthy'];
    this.actions=['inspect-permissions','inspect-memory','inspect-port','inspect-network','inspect-nexusmark','inspect-paper','inspect-plugin','observe'];
    this.state=this.load();
  }
  load(){try{const v=JSON.parse(fs.readFileSync(this.file,'utf8'));if(v?.weights)return v;}catch{} return {version:1,weights:{},samples:0,updatedAt:0};}
  save(){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o750});const t=this.file+'.tmp';fs.writeFileSync(t,JSON.stringify(this.state,null,2),{mode:0o600});try{fs.chmodSync(t,0o600)}catch{};fs.renameSync(t,this.file);}
  vector(e){const text=JSON.stringify(e||{}).toLowerCase();return Object.fromEntries(this.features.map(f=>[f,text.includes(f)?1:0]));}
  decide(e={}){const x=this.vector(e);const scores=this.actions.map(action=>{const w=this.state.weights[action]||{};let s=0.05;for(const [f,v] of Object.entries(x))s+=v*Number(w[f]||0);return {action,score:s};}).sort((a,b)=>b.score-a.score);const top=scores[0];return {action:top.action,confidence:Number(Math.max(.05,Math.min(.99,0.5+top.score/4)).toFixed(2)),scores:scores.slice(0,5),samples:this.state.samples};}
  learn(e={},action,reward){const x=this.vector(e);const a=this.actions.includes(action)?action:this.decide(e).action;const r=Math.max(-1,Math.min(1,Number(reward)||0));const w=this.state.weights[a]||(this.state.weights[a]={});for(const [f,v] of Object.entries(x))w[f]=Math.max(-3,Math.min(3,Number(w[f]||0)+.12*r*v));this.state.samples++;this.state.updatedAt=Date.now();if(this.state.samples%20===0){for(const ww of Object.values(this.state.weights))for(const f of Object.keys(ww))ww[f]*=.995;}this.save();return this.decide(e);}
}
module.exports={MicroDecisionModel};
