# 🔐 NexusPanel Authentication Troubleshooting Guide

## ❌ Login Issues

### Problem: "Invalid email or password" even with correct credentials
---

## ✅ Step-by-Step Troubleshooting

### Step 1: Check if Owner Account Exists

```bash
npm run debug-users
```

**Expected output:**
```
Found 1 user(s):

1. Owner (admin@example.com)
   Role: owner
   Access Level: 100
   Created: 2026-05-31 12:00:00
```

**If NO users found:**
- Delete the database: `del data\nexuspanel.sqlite`
- Run: `npm start`
- Follow the terminal prompts to create owner account

---

### Step 2: Verify Password Hashing Works

```bash
npm run test-auth
```

**Expected output:**
```
=== Password Hashing Test ===

Test password: testpass123

Hashed: scrypt:...

Verify with correct password: ✅ PASS
Verify with wrong password: ✅ PASS
```

---

### Step 3: Reset Your Password

If you forgot your password:

```bash
npm run reset-password
```

Follow the prompts to select user and set new password.

---

### Step 4: Check Browser Console

1. Open NexusPanel: `http://localhost:3000`
2. Press **F12** to open Developer Tools
3. Click **Console** tab
4. Try logging in
5. Look for error messages

**Common errors:**
- `"Invalid email or password"` - Check credentials
- `"Network error"` - Server not running or firewall issue
- `"401 Unauthorized"` - Session not saved, check cookies

---

### Step 5: Enable Cookies in Browser

**Chrome/Edge:**
1. Settings → Privacy and security → Cookies
2. Ensure "Allow all cookies" is selected

**Firefox:**
1. Settings → Privacy & Security → Cookies
2. Ensure "Allow websites to set cookies" is enabled

---

## 🔄 Complete Reset (Nuclear Option)

If everything is broken, do a complete reset:

```bash
# 1. Delete the database
del data\nexuspanel.sqlite

# 2. Delete node_modules and reinstall
rmdir /s /q node_modules
npm install

# 3. Start fresh
npm start
```

Then create a new owner account in the terminal.

---

## 📋 Account Information

### Owner Account (Created on First Run)
- **Role**: owner
- **Access Level**: 100 (full access)
- **Permissions**: Everything

### Admin Accounts (Created by Owner)
- **Role**: admin
- **Access Level**: 0-100 (customizable)
- **Permissions**: Based on access level

---

## 🔑 Permission Levels

| Level | Name | Permissions |
|-------|------|-------------|
| 0-19 | View Only | View servers only |
| 20-39 | View Console | Read console logs |
| 40-59 | Send Commands | Send server commands |
| 60-79 | Manage Servers | Create/edit servers |
| 80-99 | Manage Files | Upload/download files |
| 100 | Owner | Everything |

---

## 🛠️ Manual Database Check

### View All Users

```bash
node -e "const {db}=require('./backend/db.js');console.log(db.prepare('SELECT id,email,name,role FROM users').all());"
```

### View Database Stats

```bash
node -e "const {db}=require('./backend/db.js');const users=db.prepare('SELECT COUNT(*) as count FROM users').get();const sessions=db.prepare('SELECT COUNT(*) as count FROM sessions').get();console.log('Users:',users.count,'Sessions:',sessions.count);"
```

---

## 🐛 Debug Mode

Enable verbose logging by setting environment variables:

```bash
set NODE_DEBUG=http
set DEBUG=*
npm start
```

---

## 📞 Common Solutions

### Issue: "Port 3000 already in use"
```bash
npm start -- --port 3001
```

### Issue: "Cannot find module"
```bash
npm install
npm start
```

### Issue: Cookies not working
1. Clear browser cache (Ctrl+Shift+Del)
2. Make sure you're on `http://localhost:3000` (not 127.0.0.1)
3. Check browser console for cookie warnings

### Issue: Stuck on login page after entering credentials
1. Press F12 → Console
2. Look for error messages
3. Check browser Network tab (F12 → Network) for failed requests

---

## ✨ Expected Workflow

1. **First Run**: Owner account created in terminal
2. **Login**: Go to `http://localhost:3000`, enter credentials
3. **Dashboard**: See servers and options
4. **Admin Creation**: Owner creates admin accounts with custom permissions
5. **Admin Login**: Admins login with their email and password

---

## 🎯 Quick Checklist

- [ ] Database exists: `data/nexuspanel.sqlite`
- [ ] Owner account created: `npm run debug-users`
- [ ] Node.js 22+ installed: `node --version`
- [ ] Express running: `npm start`
- [ ] Port 3000 accessible: `http://localhost:3000`
- [ ] Cookies enabled in browser
- [ ] Correct email/password entered
- [ ] No JavaScript errors in console (F12)

---

## 💡 Still Having Issues?

1. Run: `npm run debug-users`
2. Run: `npm run test-auth`
3. Check browser Console (F12)
4. Delete database and start over: `del data\nexuspanel.sqlite`
5. Post error message from console in terminal

---

**NexusPanel v1.0** - Minecraft Server Panel
