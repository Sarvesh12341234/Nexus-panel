const assert = require('node:assert/strict');
const fs = require('node:fs');
const hostAgent = require('../backend/host_agent');
const service = require('../backend/service');

assert.equal(fs.existsSync(hostAgent.localStatus().sourcePath), true, 'native host agent source is missing');
assert.match(service.serviceContent(), /nexuspanel-host-agent\.service/);
assert.match(service.serviceContent(), /nexuspanel-nexusmark\.service/);
assert.match(service.hostAgentServiceContent(), /RestrictAddressFamilies=AF_UNIX/);
assert.match(service.nexusMarkServiceContent(), /Type=oneshot/);

console.log('NexusPanel v3 architecture test passed.');
