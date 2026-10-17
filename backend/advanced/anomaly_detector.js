'use strict';

class AnomalyDetector {
  constructor(limit=60){this.limit=limit;this.samples=new Map();}
  observe(id,value){
    const k=String(id), n=Number(value)||0, a=this.samples.get(k)||[];
    a.push(n); if(a.length>this.limit)a.shift(); this.samples.set(k,a);
    if(a.length<8)return {anomaly:false,confidence:0};
    const mean=a.reduce((x,y)=>x+y,0)/a.length;
    const variance=a.reduce((x,y)=>x+(y-mean)**2,0)/a.length;
    const sd=Math.sqrt(variance)||1;
    const z=Math.abs((n-mean)/sd);
    return {anomaly:z>=3,zScore:z,mean,confidence:Math.min(.95,a.length/this.limit+.2)};
  }
}
module.exports={AnomalyDetector};
