'use strict';

class CapabilityGuard {
  constructor() { this.scopes = new Map(); }
  grant(subject, scopes=[]) {
    this.scopes.set(String(subject), new Set(scopes.map(String)));
  }
  can(subject, scope) {
    const s=this.scopes.get(String(subject));
    return !!s && (s.has('*') || s.has(String(scope)));
  }
  require(subject, scope) {
    if(!this.can(subject,scope)) throw new Error(`capability denied: ${scope}`);
    return true;
  }
}
module.exports={CapabilityGuard};
