'use strict';
const fs=require('fs'), path=require('path');

function walk(dir,out=[]){
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    if(['node_modules','.git'].includes(e.name)) continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()) walk(p,out);
    else if(e.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}
function audit(root){
  const findings=[];
  for(const file of walk(root)){
    const lines=fs.readFileSync(file,'utf8').split(/\r?\n/);
    lines.forEach((line,n)=>{
      if(/\beval\s*\(|new\s+Function\s*\(/.test(line))
        findings.push({file,line:n+1,type:'dynamic-code'});
      if(/\bchild_process\.(exec|execSync)\s*\(/.test(line))
        findings.push({file,line:n+1,type:'shell-exec-review'});
      if(/\$\{[^}]+\}/.test(line) && /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line))
        findings.push({file,line:n+1,type:'sql-interpolation-review'});
      if(/console\.(log|error)\s*\(.*(key|token|password|secret)/i.test(line))
        findings.push({file,line:n+1,type:'secret-log-review'});
    });
  }
  return findings;
}
if(require.main===module){
  console.log(JSON.stringify(audit(process.argv[2]||process.cwd()),null,2));
}
module.exports={audit};
