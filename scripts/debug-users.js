const { db } = require('../backend/db');

console.log('\n=== NexusPanel User Database ===\n');

const users = db.prepare('SELECT id, email, name, role, access_level, created_at FROM users ORDER BY created_at DESC').all();

if (users.length === 0) {
  console.log('❌ No users found in database.');
  console.log('   Run: npm start (to create owner account)');
  process.exit(0);
}

console.log(`Found ${users.length} user(s):\n`);

users.forEach((user, index) => {
  console.log(`${index + 1}. ${user.name} (${user.email})`);
  console.log(`   Role: ${user.role}`);
  console.log(`   Access Level: ${user.access_level}`);
  console.log(`   Created: ${user.created_at}`);
  console.log('');
});

console.log('=== Sessions ===\n');

const sessions = db.prepare('SELECT id, user_id, expires_at FROM sessions LIMIT 10').all();

if (sessions.length === 0) {
  console.log('No active sessions.');
} else {
  console.log(`${sessions.length} session(s):`);
  sessions.forEach((session, index) => {
    const isExpired = session.expires_at < Date.now();
    const status = isExpired ? '❌ EXPIRED' : '✅ ACTIVE';
    const expiresAt = new Date(session.expires_at).toLocaleString();
    console.log(`${index + 1}. User ${session.user_id} - ${status} (expires: ${expiresAt})`);
  });
}

console.log('');
process.exit(0);
