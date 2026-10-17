'use strict';
const fs=require('fs'), path=require('path');
function scan(root){
  const findings=[];
  function walk(d){
    for(const n of fs.readdirSync(d,{withFileTypes:true})){
      const p=path.join(d,n.name);
      if(n.isDirectory() && !['node_modules','.git'].includes(n.name)) walk(p);
      else if(n.isFile() && /\.(html|js)$/.test(n.name)){
        const s=fs.readFileSync(p,'utf8');
        if(/on(click|load|submit)\s*=/.test(s)) findings.push({file:p,type:'inline-handler'});
        if(/innerHTML\s*=/.test(s)) findings.push({file:p,type:'innerHTML-review'});
      }
    }
  }
  walk(root); return findings;
}
module.exports={scan};
