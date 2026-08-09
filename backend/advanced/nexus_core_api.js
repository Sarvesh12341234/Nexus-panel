'use strict';
function registerNexusCoreApi(app,{bus,decision,health,activity}){
  app.get('/api/nexus/core',(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.json({
      version:'5.1.0',
      readonly:true,
      architecture:'event-driven',
      recentEvents:bus.recent(80),
      health:health.snapshot(),
      activity:activity.list(80)
    });
  });
  app.post('/api/nexus/decision',(req,res)=>{
    res.json({readonly:true,decision:decision.decide(req.body||{})});
  });
}
module.exports={registerNexusCoreApi};
