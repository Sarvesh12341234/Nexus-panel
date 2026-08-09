'use strict';

function registerNexus41Api(app,{ledger,detector}){
  app.get('/api/nexus/ledger',(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.json({readonly:true,entries:ledger.recent(100)});
  });
  app.post('/api/nexus/anomaly',(req,res)=>{
    const b=req.body||{};
    res.json({readonly:true,result:detector.observe(b.id,b.value)});
  });
}
module.exports={registerNexus41Api};
