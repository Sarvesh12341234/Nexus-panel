const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const hostAgent = require('../backend/host_agent');
const { runtimeDetails, trackPlayerLine } = require('../backend/runtime');
const service = require('../backend/service');

assert.equal(fs.existsSync(hostAgent.localStatus().sourcePath), true, 'native host agent source is missing');
assert.match(service.serviceContent(), /nexuspanel-host-agent\.service/);
assert.match(service.serviceContent(), /nexuspanel-nexusmark\.service/);
assert.match(service.hostAgentServiceContent(), /RestrictAddressFamilies=AF_UNIX/);
assert.match(service.nexusMarkServiceContent(), /Type=oneshot/);

const playerTestServerId = 987654;
trackPlayerLine(String(playerTestServerId), '[Server thread/INFO]: \u001b[32mJavaPlayer\u001b[0m joined the game');
assert.deepEqual(runtimeDetails(playerTestServerId).players, ['JavaPlayer']);
trackPlayerLine(playerTestServerId, '[Server thread/INFO]: JavaPlayer lost connection: Disconnected');
assert.deepEqual(runtimeDetails(String(playerTestServerId)).players, []);

console.log('NexusPanel v3 architecture test passed.');


const permissionRepair = fs.readFileSync(path.join(__dirname, '..', 'backend', 'permission_repair.js'), 'utf8');
assert.ok(permissionRepair.includes("u+rwx,g+rx,o-rwx"), 'permission repair should use restrictive directory modes');
assert.ok(permissionRepair.includes("u+rw,g+r,o-rwx"), 'permission repair should use restrictive file modes');
assert.ok(!permissionRepair.includes('chmod 777'), 'permission repair must never chmod 777');
console.log('Permission repair safety checks passed');
