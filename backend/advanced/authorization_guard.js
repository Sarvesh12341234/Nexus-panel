'use strict';
function authorize({subject,scope,capabilityGuard}){
  if(!capabilityGuard || !subject || !scope) return {ok:false,reason:'missing authorization context'};
  try{capabilityGuard.require(subject,scope);return {ok:true};}
  catch(_){return {ok:false,reason:'capability denied'};}
}
module.exports={authorize};
