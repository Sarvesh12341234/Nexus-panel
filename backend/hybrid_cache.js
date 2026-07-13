const DEFAULT_TTL_SECONDS = 10 * 60;
const LOCAL_LIMIT = 500;
const localCache = new Map();

let redisModule = null;
let client = null;
let clientPromise = null;
let idleTimer = null;
let lastError = '';
const stats = {
  hits: 0,
  misses: 0,
  writes: 0,
  errors: 0,
};

function enabled() {
  return process.env.NEXUSPANEL_REDIS_ENABLED !== '0';
}

function redisUrl() {
  return process.env.NEXUSPANEL_REDIS_URL || 'redis://127.0.0.1:6379';
}

function safeUrl() {
  return redisUrl().replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:<redacted>@');
}

function rememberLocal(key, value, ttlSeconds) {
  if (localCache.size >= LOCAL_LIMIT) {
    const first = localCache.keys().next().value;
    if (first) localCache.delete(first);
  }
  localCache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) * 1000,
  });
}

function localGet(key) {
  const hit = localCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    localCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function loadRedis() {
  if (redisModule !== null) return redisModule;
  try {
    redisModule = require('redis');
  } catch (error) {
    redisModule = false;
    lastError = `redis package unavailable: ${error.message}`;
  }
  return redisModule;
}

async function connectClient() {
  if (!enabled()) return null;
  const redis = loadRedis();
  if (!redis) return null;
  if (client?.isOpen) return client;
  if (clientPromise) return clientPromise;
  client = redis.createClient({
    url: redisUrl(),
    socket: {
      connectTimeout: 500,
      reconnectStrategy: (retries) => Math.min(2000, Math.max(100, retries * 150)),
    },
  });
  client.on('error', (error) => {
    stats.errors += 1;
    lastError = error.message;
  });
  clientPromise = client.connect()
    .then(() => client)
    .catch((error) => {
      stats.errors += 1;
      lastError = error.message;
      try { client?.destroy?.(); } catch {}
      client = null;
      return null;
    })
    .finally(() => {
      clientPromise = null;
    });
  return clientPromise;
}

function scheduleIdleClose() {
  if (process.env.NEXUSPANEL_REDIS_KEEPALIVE === '1') return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!client?.isOpen) return;
    client.quit().catch(() => {
      try { client?.destroy?.(); } catch {}
    }).finally(() => {
      client = null;
    });
  }, 2500);
  idleTimer.unref?.();
}

async function getJson(key) {
  const local = localGet(key);
  if (local !== undefined) {
    stats.hits += 1;
    return local;
  }
  const redisClient = await connectClient();
  if (!redisClient?.isOpen) {
    stats.misses += 1;
    return null;
  }
  try {
    const raw = await redisClient.get(key);
    if (!raw) {
      stats.misses += 1;
      scheduleIdleClose();
      return null;
    }
    const parsed = JSON.parse(raw);
    rememberLocal(key, parsed, DEFAULT_TTL_SECONDS);
    stats.hits += 1;
    scheduleIdleClose();
    return parsed;
  } catch (error) {
    stats.errors += 1;
    lastError = error.message;
    return null;
  }
}

async function setJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  rememberLocal(key, value, ttlSeconds);
  const redisClient = await connectClient();
  if (!redisClient?.isOpen) return false;
  try {
    await redisClient.set(key, JSON.stringify(value), { EX: Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) });
    stats.writes += 1;
    scheduleIdleClose();
    return true;
  } catch (error) {
    stats.errors += 1;
    lastError = error.message;
    return false;
  }
}

async function delPattern(pattern) {
  for (const key of [...localCache.keys()]) {
    if (new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`).test(key)) {
      localCache.delete(key);
    }
  }
  const redisClient = await connectClient();
  if (!redisClient?.isOpen) return 0;
  let deleted = 0;
  try {
    for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      await redisClient.del(key);
      deleted += 1;
    }
    scheduleIdleClose();
  } catch (error) {
    stats.errors += 1;
    lastError = error.message;
  }
  return deleted;
}

async function cachedJson(key, loader, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const cached = await getJson(key);
  if (cached !== null) return cached;
  const value = await loader();
  await setJson(key, value, ttlSeconds);
  return value;
}

function status() {
  return {
    durableStore: 'sqlite',
    hotCache: 'redis',
    enabled: enabled(),
    connected: Boolean(client?.isOpen),
    url: safeUrl(),
    localKeys: localCache.size,
    lastError,
    ...stats,
  };
}

module.exports = {
  cachedJson,
  delPattern,
  getJson,
  setJson,
  status,
};
