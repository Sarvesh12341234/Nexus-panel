'use strict';
function looksLikeUnsafeSql(query){
  if(typeof query!=='string') return false;
  return /(?:select|insert|update|delete|drop)\b[\s\S]*(?:\+|\$\{|\bconcat\s*\()/i.test(query);
}
function requireParameterizedQuery(query,params){
  if(!query || typeof query!=='string') throw new Error('query required');
  if(looksLikeUnsafeSql(query) && !Array.isArray(params)) throw new Error('parameterized query required');
  return true;
}
module.exports={looksLikeUnsafeSql,requireParameterizedQuery};
