'use strict';
const crypto=require('crypto');
function requestContext(req,res,next){
  const supplied=String(req.get('x-request-id')||'').trim();
  const id=/^[A-Za-z0-9._:-]{1,80}$/.test(supplied) ? supplied : crypto.randomUUID();
  req.nexusRequestId=id;
  res.setHeader('X-Nexus-Request-Id',id);
  next();
}
module.exports={requestContext};
