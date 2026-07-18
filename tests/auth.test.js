const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../backend/auth');
const { db, verifyDatabase } = require('../backend/db');

const password = 'testpass123';
const hash = hashPassword(password);
assert.equal(verifyPassword(password, hash), true, 'correct password must verify');
assert.equal(verifyPassword('wrongpassword', hash), false, 'incorrect password must fail');
assert.equal(verifyPassword(password, 'invalid'), false, 'malformed hash must fail');

const integrity = verifyDatabase();
assert.equal(integrity.ok, true, `database integrity failed: ${JSON.stringify(integrity)}`);
const userCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count || 0);
db.close();

console.log(`Authentication and database test passed (${userCount} users).`);
