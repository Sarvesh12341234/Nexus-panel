'use strict';
const fs=require('fs'), path=require('path');
function checkWritable(dir){
  try{
    fs.accessSync(dir,fs.constants.W_OK);
    return {ok:true,path};
  }catch(e){return {ok:false,path:dir,code:e.code||'EACCESS'};}
}
function checkPathSafety(p){
  const resolved=path.resolve(p);
  if(resolved==='/' || resolved.length<4) return {ok:false,reason:'unsafe target'};
  return {ok:true,path:resolved};
}
function platformInfo(){
  return {platform:process.platform,arch:process.arch,node:process.version};
}
module.exports={checkWritable,checkPathSafety,platformInfo};
