'use strict';
const PROTECTED = new Set([
  'world','world_nether','world_the_end','backups','database','nexus.db'
]);
function classify(op={}){
  const text=String(op.target||'')+' '+String(op.action||'');
  const destructive=!!op.irreversible || /(delete|wipe|format|overwrite|purge|drop database)/i.test(text);
  const protectedData=[...PROTECTED].some(x=>text.includes(x));
  if(destructive || protectedData) return {mode:'rare-confirmation',reason:'protected or irreversible data'};
  return {mode:'autonomous',reason:'reversible/operational change'};
}
module.exports={classify};
