'use strict';

const assert = require('node:assert/strict');
const { matchDocumentedIssue } = require('../backend/needle2_agent');
const known = matchDocumentedIssue('[Error] Unknown command: frobnicate');
assert.equal(known?.id, 'cli-unknown-command');
assert.equal(known.evidence, 'Unknown command: frobnicate');
assert.equal(matchDocumentedIssue('Server started successfully.'), null);
assert.equal(matchDocumentedIssue('Unknown command'), null);
console.log('Needle documented exact-match fallback tests passed.');
