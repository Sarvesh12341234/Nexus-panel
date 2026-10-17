'use strict';
function withTimeout(promise, ms, label='operation'){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);
  });
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}
async function retry(fn,{attempts=3,baseMs=250,maxMs=2000}={}){
  let last;
  for(let i=0;i<attempts;i++){
    try{return await fn(i);}
    catch(e){last=e;if(i+1<attempts) await new Promise(r=>setTimeout(r,Math.min(maxMs,baseMs*2**i)));}
  }
  throw last;
}
module.exports={withTimeout,retry};
