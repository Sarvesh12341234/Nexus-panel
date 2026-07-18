const { db } = require('../backend/db');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

async function main() {
  console.log('\n=== NexusPanel Password Reset ===\n');

  // List all users
  const users = db.prepare('SELECT id, email, name, role FROM users ORDER BY id').all();

  if (users.length === 0) {
    console.log('❌ No users found in database.');
    console.log('   Run: npm start (to create owner account)');
    process.exit(0);
  }

  console.log('Available users:\n');
  users.forEach((user, index) => {
    console.log(`${index + 1}. ${user.name} (${user.email}) [${user.role}]`);
  });

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const userIndexStr = await rl.question('\nSelect user number to reset password (or press Enter to cancel): ');
    
    if (!userIndexStr.trim()) {
      console.log('Cancelled.');
      process.exit(0);
    }

    const userIndex = parseInt(userIndexStr, 10) - 1;

    if (userIndex < 0 || userIndex >= users.length) {
      console.log('❌ Invalid selection.');
      process.exit(1);
    }

    const selectedUser = users[userIndex];
    console.log(`\nResetting password for: ${selectedUser.name} (${selectedUser.email})`);

    const newPassword = await rl.question('New password (12+ chars): ');

    if (!newPassword || newPassword.length < 12) {
      console.log('❌ Password must be at least 12 characters.');
      process.exit(1);
    }

    const hashedPassword = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashedPassword, selectedUser.id);

    console.log('\n✅ Password reset successfully!');
    console.log(`   User: ${selectedUser.email}`);
    console.log(`   New password: ${newPassword}`);
    console.log('\n💡 Run: npm start');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
