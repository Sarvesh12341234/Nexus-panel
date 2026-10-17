'use strict';
function registerAutonomyApi(app,{activity,policy,graph}){
  app.get('/api/advanced/autonomy/activity',(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.json({readonly:true,events:activity.list(150)});
  });
  app.post('/api/advanced/autonomy/classify',(req,res)=>{
    // Classification only; this endpoint does not execute an operation.
    res.json({readonly:true,...policy.classify(req.body||{})});
  });
  app.get('/api/advanced/autonomy/status',(req,res)=>{
    res.json({enabled:true,mode:'autonomous',protectedDataConfirmation:true,readonly:true});
  });
}
module.exports={registerAutonomyApi};
