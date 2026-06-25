const crypto = require('node:crypto');

// Test password hashing
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, original] = String(storedHash || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !original) return false;

  const derived = crypto.scryptSync(password, salt, 64);
  const originalBuffer = Buffer.from(original, 'hex');
  return originalBuffer.length === derived.length && crypto.timingSafeEqual(originalBuffer, derived);
}

console.log('\n=== Password Hashing Test ===\n');

const testPassword = 'testpass123';
console.log(`Test password: ${testPassword}\n`);

const hashedPassword = hashPassword(testPassword);
console.log(`Hashed: ${hashedPassword}\n`);

const isCorrect = verifyPassword(testPassword, hashedPassword);
console.log(`Verify with correct password: ${isCorrect ? '✅ PASS' : '❌ FAIL'}`);

const isIncorrect = verifyPassword('wrongpassword', hashedPassword);
console.log(`Verify with wrong password: ${isIncorrect ? '❌ FAIL (should be false)' : '✅ PASS'}`);

console.log('\n=== Database Connection Test ===\n');

try {
  const { db } = require('./db');
  
  const result = db.prepare('SELECT COUNT(*) as count FROM users').get();
  console.log(`✅ Database connection: OK`);
  console.log(`   Total users: ${result.count}`);
  
  if (result.count === 0) {
    console.log('\n⚠️  No users in database. Run: npm start');
  }
} catch (error) {
  console.log(`❌ Database error: ${error.message}`);
}

console.log('');
process.exit(0);
