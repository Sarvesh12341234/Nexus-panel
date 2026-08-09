'use strict';
function registerNeuralGraph(app, graph){
  app.get('/api/advanced/neural-graph', (req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.json(graph.snapshot());
  });
}
module.exports={registerNeuralGraph};
