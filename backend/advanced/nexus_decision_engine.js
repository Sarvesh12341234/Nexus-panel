'use strict';
const {classify}=require('./autonomy_policy');
class NexusDecisionEngine{
  decide(input={}){
    const risk=classify(input);
    const complexity=input.complexity||'normal';
    const model=complexity==='tiny' || input.localOnly ? 'microllm' : 'configured-ai';
    return {
      action:input.action||'observe',
      risk:risk.mode,
      reason:risk.reason,
      model,
      autonomous:risk.mode==='autonomous',
      requiresConfirmation:risk.mode==='rare-confirmation'
    };
  }
}
module.exports={NexusDecisionEngine};
