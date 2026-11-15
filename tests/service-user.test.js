'use strict';

const assert = require('node:assert/strict');
const service = require('../backend/service');
const originalGetuid = process.getuid;
const originalSudoUser = process.env.SUDO_USER;
const originalServiceUser = process.env.NEXUSPANEL_SERVICE_USER;
try {
  process.getuid = () => 0;
  process.env.SUDO_USER = 'invoking-user';
  delete process.env.NEXUSPANEL_SERVICE_USER;
  assert.doesNotMatch(service.serviceContent(), /^User=/m,
    'sudo installation must default to root so ASF can create server identities');
  process.env.NEXUSPANEL_SERVICE_USER = 'explicit-user';
  assert.match(service.serviceContent(), /^User=explicit-user$/m,
    'an explicit service user must remain honored');
} finally {
  if (originalGetuid === undefined) delete process.getuid;
  else process.getuid = originalGetuid;
  if (originalSudoUser === undefined) delete process.env.SUDO_USER;
  else process.env.SUDO_USER = originalSudoUser;
  if (originalServiceUser === undefined) delete process.env.NEXUSPANEL_SERVICE_USER;
  else process.env.NEXUSPANEL_SERVICE_USER = originalServiceUser;
}
console.log('Service identity selection tests passed.');
