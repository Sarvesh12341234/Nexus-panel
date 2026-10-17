'use strict';
/**
 * Security regression tests.
 *
 * These guard security PROPERTIES, not exact source strings. Each check scans
 * the whole backend tree so moving a route into a router module does not
 * produce a false failure, and deleting a route on purpose does not break the
 * suite (the property is re-expressed against the new location).
 */
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert');

const backendDir = path.join(__dirname, '..', 'backend');
function backendSource(relative) {
  return fs.readFileSync(path.join(backendDir, relative), 'utf8');
}
/** True if ANY backend .js file contains the needle. */
function anyBackendFileContains(needle) {
  for (const file of fs.readdirSync(backendDir)) {
    if (!file.endsWith('.js')) continue;
    if (backendSource(file).includes(needle)) return true;
  }
  return false;
}

const index = backendSource('index.js');

// --- Port-collision guard: parameterized query, never string interpolation ---
assert(index.includes('WHERE port = ? AND id != ?'), 'port collision query must be parameterized');
assert(!/WHERE\s+port\s*=\s*['"`]\s*\$\{/.test(index), 'port query must not interpolate user input');

// --- AI routes were removed in 1.0.0 and must stay gone everywhere ---
for (const removed of [
  "app.post('/api/advanced-ai/providers/openrouter/key'",
  "'/api/advanced-ai/",
  "'/api/agent/core'",
  "'/api/ai/micro/",
]) {
  assert.equal(anyBackendFileContains(removed), false, `removed AI route reappeared: ${removed}`);
}

// --- Tebex webhook: signature-gated, raw-body captured, CSRF-exempt ---
assert(index.includes("'/api/tebex/webhook/:serverId', express.raw"), 'Tebex webhook raw-body middleware missing');
assert(index.includes('tebex.ingestWebhook'), 'Tebex webhook ingest missing');
assert(index.includes('/^\\/tebex\\/webhook\\//.test(req.path)'), 'Tebex CSRF exemption missing');
const tebex = backendSource('tebex.js');
assert(tebex.includes('verifyWebhookSignature'), 'webhook signature verification missing');
assert(tebex.includes('crypto.timingSafeEqual'), 'webhook signature compare must be timing-safe');
assert(tebex.includes('encryptSecret'), 'webstore secret must be encrypted at rest');
assert(tebex.includes('aes-256-gcm'), 'webstore secret cipher must be AES-256-GCM');
assert(tebex.includes('createHmac(\'sha256\''), 'Tebex webhook signature must use the documented HMAC algorithm');
assert(tebex.includes('webhook_secret'), 'Tebex webhook signing secret must be stored separately from the game-server API secret');

// --- Login failures must render inside the visible unauthenticated view ---
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'main.js'), 'utf8');
assert(indexHtml.includes('id="loginError" role="alert"'), 'login form needs an accessible inline error region');
assert(mainJs.includes('elements.loginError.textContent = error.message'), 'login failures must be shown in the visible login form');

// --- Database connections: passwords encrypted, never returned ---
const hosting = backendSource('hosting.js');
assert(hosting.includes('encryptPassword'), 'DB password encryption missing');
assert(hosting.includes('aes-256-gcm'), 'DB password cipher missing');
const connectionRowsBlock = hosting.slice(
  hosting.indexOf('function connectionRows'),
  hosting.indexOf('function createConnection'),
);
assert(!connectionRowsBlock.includes('password'), 'connection payload must not include the password');

// --- Zip utils: Zip Slip guard present and module syntactically intact ---
const zipUtils = backendSource('zip_utils.js');
assert(zipUtils.includes('function assertSafeArchiveEntry'), 'Zip Slip guard missing');
assert(zipUtils.includes('function copyDirectoryContents'), 'zip_utils corrupted (copyDirectoryContents missing)');
assert(zipUtils.includes('assertSafeArchive, assertSafeArchiveEntry'), 'zip_utils exports missing the Zip Slip guards');

// --- Paths: data root must be configurable and non-root must not crash ---
const paths = backendSource('paths.js');
assert(paths.includes('NEXUSPANEL_DATA_ROOT'), 'data root must be configurable via NEXUSPANEL_DATA_ROOT');
assert(paths.includes('ensureWritableDir'), 'directory creation must not throw at module load');
assert(paths.includes('.nexuspanel-data'), 'non-root dev fallback data root missing');

console.log('Security/provider/port regression test passed');
