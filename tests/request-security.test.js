'use strict';

const assert = require('node:assert/strict');
const { requestSecurityError } = require('../backend/request_security');

function request(method, headers = {}, overrides = {}) {
  return {
    method,
    path: '/api/example',
    protocol: 'https',
    headers,
    get: (name) => name.toLowerCase() === 'host' ? 'panel.example.test' : '',
    ...overrides,
  };
}

assert.equal(requestSecurityError(request('GET')), '');
assert.equal(requestSecurityError(request('POST', { cookie: 'np_session=session' })), 'Request verification failed.');
assert.equal(requestSecurityError(request('POST', {
  cookie: 'np_session=session',
  'x-nexuspanel-request': '1',
  'sec-fetch-site': 'same-site',
  origin: 'https://evil.example.test',
})), 'Cross-site request blocked.');
assert.equal(requestSecurityError(request('POST', {
  cookie: 'np_session=session',
  'x-nexuspanel-request': '1',
  'sec-fetch-site': 'same-origin',
  origin: 'https://panel.example.test',
})), '');
assert.equal(requestSecurityError(request('POST', {
  'x-nexuspanel-request': '1',
  origin: 'https://evil.example.test',
})), 'Cross-site request blocked.');
assert.equal(requestSecurityError(request('POST', { authorization: 'Bearer api-token' })), '');
assert.equal(requestSecurityError(request('POST', {}, { path: '/tebex/webhook/42' })), '');
console.log('CSRF and origin security tests passed.');
