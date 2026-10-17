'use strict';

const MC_TOOLPACK = Object.freeze([
  {id:'mc.server.status',scope:'server:read',description:'Inspect server lifecycle and health'},
  {id:'mc.server.start',scope:'server:operate',description:'Start an authorized server'},
  {id:'mc.server.stop',scope:'server:operate',description:'Stop an authorized server'},
  {id:'mc.server.restart',scope:'server:operate',description:'Restart an authorized server'},
  {id:'mc.console.read',scope:'server:read',description:'Read bounded recent console output'},
  {id:'mc.console.command',scope:'server:console',description:'Send an authorized console command'},
  {id:'mc.properties.read',scope:'server:read',description:'Read server properties'},
  {id:'mc.properties.validate',scope:'server:operate',description:'Validate a property change'},
  {id:'mc.properties.apply',scope:'server:operate',description:'Apply a validated property change'},
  {id:'mc.plugins.list',scope:'server:read',description:'List installed plugins'},
  {id:'mc.plugins.inspect',scope:'server:read',description:'Inspect plugin metadata'},
  {id:'mc.backup.create',scope:'server:backup',description:'Create a server snapshot'},
  {id:'mc.backup.restore',scope:'server:backup',description:'Restore an authorized snapshot'},
  {id:'mc.world.health',scope:'server:read',description:'Check world/storage health'},
  {id:'mc.java.health',scope:'server:read',description:'Inspect Java/runtime health'},
  {id:'mc.performance.sample',scope:'server:read',description:'Sample CPU/RAM/TPS metrics'}
]);

function listTools(){ return MC_TOOLPACK.map(x=>({...x})); }
function getTool(id){ return MC_TOOLPACK.find(x=>x.id===id) || null; }

module.exports={MC_TOOLPACK,listTools,getTool};
