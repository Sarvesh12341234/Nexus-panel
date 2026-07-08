const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'api.stackexchange.com',
  'en.wikipedia.org',
  'learn.microsoft.com',
]);
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESULTS = 16;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const CIRCUIT_FAILURE_LIMIT = 3;
const CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000;
const STACK_SITES = Object.freeze([
  ['stackoverflow', 'Stack Overflow'],
  ['askubuntu', 'Ask Ubuntu'],
  ['unix', 'Unix & Linux'],
  ['serverfault', 'Server Fault'],
  ['gaming', 'Arqade'],
]);

const ENGLISH_INTENTS = Object.freeze([
  {
    id: 'apt-progress-stuck',
    patterns: [/apt (?:update|upgrade|install).*stuck/i, /terminal.*(?:progress|percent).*not.*show/i],
    query: 'apt update progress stuck non interactive terminal pseudo tty node pty',
    concepts: ['terminal', 'pty', 'apt', 'progress'],
  },
  {
    id: 'minecraft-memory-sizing',
    patterns: [/(\d+)\s*(?:gb|gib).*ram/i, /memory.*(?:turns|reset).*1000\s*mb/i],
    query: 'minecraft server memory allocation cgroup xmx native memory headroom',
    concepts: ['memory', 'xmx', 'cgroup'],
  },
  {
    id: 'cpu-core-limit',
    patterns: [/(\d+)\s*core/i, /cpu.*(?:quota|limit|throttle)/i],
    query: 'systemd CPUQuota multi core cgroup minecraft server',
    concepts: ['cpu', 'systemd', 'cgroup'],
  },
  {
    id: 'bedrock-leveldb-corruption',
    patterns: [/bedrock.*(?:world|leveldb|db).*corrupt/i, /missing.*\.ldb/i],
    query: 'Minecraft Bedrock LevelDB corruption backup save hold save query',
    concepts: ['bedrock', 'leveldb', 'backup'],
  },
  {
    id: 'server-properties-missing',
    patterns: [/server\.properties.*(?:not found|missing|invalid|syntax)/i],
    query: 'Minecraft server.properties not found working directory invalid syntax',
    concepts: ['server.properties', 'working-directory'],
  },
  {
    id: 'sqlite-corruption',
    patterns: [/sqlite|database.*(?:corrupt|malformed|locked)/i],
    query: 'SQLite WAL database disk image malformed recovery backup integrity check',
    concepts: ['sqlite', 'wal', 'recovery'],
  },
]);

function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;
  if (address === '::1' || address === '0.0.0.0') return true;
  if (address.startsWith('10.') || address.startsWith('127.') || address.startsWith('169.254.') || address.startsWith('192.168.')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  const lower = address.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:') || lower === '::';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<pre><code>/gi, '\n')
    .replace(/<\/code><\/pre>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function codeSnippets(value) {
  const text = String(value || '');
  const htmlCode = [...text.matchAll(/<code>([\s\S]*?)<\/code>/gi)].map((match) => stripHtml(match[1]));
  const fenced = [...text.matchAll(/```[a-z0-9_-]*\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  return [...new Set([...htmlCode, ...fenced])]
    .filter(Boolean)
    .slice(0, 3)
    .map((snippet) => redactResearchText(snippet).slice(0, 500));
}

function redactResearchText(value) {
  return String(value || '')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .replace(/\b(password|token|secret|api[-_]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=<redacted>')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|mfa\.[A-Za-z0-9_-]{20,})\b/g, '<credential>')
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/[A-Za-z]:\\[^\s"'<>]+|\/(?:[^\s/"'<>]+\/)+[^\s"'<>]+/g, '<path>')
    .replace(/[A-Fa-f0-9]{24,}/g, '<identifier>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

async function assertPublicAllowedUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('Research source is not allowlisted.');
  }
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Research source resolved to a private or invalid address.');
  }
  return url;
}

async function readBoundedJson(response) {
  if (!response.ok) throw new Error(`Research source returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error('Research response exceeded the size limit.');
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Research response exceeded the size limit.');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return JSON.parse(body);
}

async function fetchJson(rawUrl, headers = {}) {
  const url = await assertPublicAllowedUrl(rawUrl);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'NexusPanel-RepairAgent/1.2.0',
      ...headers,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return readBoundedJson(response);
}

function stackExchangeResults(payload, site) {
  return (payload.items || []).slice(0, 4).map((item) => ({
    source: site,
    title: stripHtml(item.title).slice(0, 180),
    excerpt: stripHtml(item.body || '').slice(0, 700),
    codeSnippets: codeSnippets(item.body || ''),
    url: String(item.link || ''),
    score: Number(item.score || 0),
    answered: Boolean(item.is_answered),
  }));
}

function githubResults(payload) {
  return (payload.items || []).slice(0, 5).map((item) => ({
    source: 'github-issues',
    title: stripHtml(item.title).slice(0, 180),
    excerpt: stripHtml(item.body || '').slice(0, 700),
    codeSnippets: codeSnippets(item.body || ''),
    url: String(item.html_url || ''),
    score: Number(item.score || 0),
    answered: String(item.state || '') === 'closed',
  }));
}

function microsoftLearnResults(payload) {
  return (payload.results || []).slice(0, 5).map((item) => ({
    source: 'microsoft-learn',
    title: stripHtml(item.title).slice(0, 180),
    excerpt: stripHtml(item.description || item.descriptions?.[0]?.content || '').slice(0, 700),
    codeSnippets: [],
    url: String(item.url || ''),
    score: 1,
    answered: true,
    authoritative: true,
  }));
}

function wikipediaResults(payload) {
  return (payload.query?.search || []).slice(0, 4).map((item) => ({
    source: 'wikipedia',
    title: stripHtml(item.title).slice(0, 180),
    excerpt: stripHtml(item.snippet || '').slice(0, 700),
    codeSnippets: [],
    url: `https://en.wikipedia.org/?curid=${Number(item.pageid)}`,
    score: 0,
    answered: true,
    authoritative: false,
  }));
}

function researchTokens(value) {
  const ignored = new Set(['the', 'and', 'for', 'with', 'from', 'server', 'minecraft', 'error', 'failed', 'exception']);
  const tokens = String(value).toLowerCase().match(/[a-z0-9_.+-]{3,}/g) || [];
  return new Set(tokens.flatMap((token) => [token, ...token.split(/[._+-]/)]).filter((token) => token.length >= 3 && !ignored.has(token)));
}

function unitToMb(amount, unit) {
  const number = Number(amount);
  if (!Number.isFinite(number)) return null;
  const normalized = String(unit || 'mb').toLowerCase();
  if (normalized.startsWith('g')) return Math.round(number * 1024);
  if (normalized.startsWith('t')) return Math.round(number * 1024 * 1024);
  return Math.round(number);
}

function simpleMathFacts(value) {
  const text = String(value || '');
  const facts = [];
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib|tb|tib)\b/gi)) {
    const mb = unitToMb(match[1], match[2]);
    if (mb != null) facts.push(`${match[0]}=${mb}MB`);
  }
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:core|cores|cpu)\b/gi)) {
    facts.push(`${match[1]}cores=${Number(match[1]) * 100}% CPUQuota`);
  }
  for (const match of text.matchAll(/\b(\d+)\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\b/gi)) {
    facts.push(`duration:${match[0].toLowerCase()}`);
  }
  return [...new Set(facts)].slice(0, 8);
}

function englishIntent(value) {
  const text = String(value || '');
  const matches = ENGLISH_INTENTS.filter((intent) => intent.patterns.some((pattern) => pattern.test(text)));
  return {
    ids: matches.map((item) => item.id),
    concepts: [...new Set(matches.flatMap((item) => item.concepts))],
    query: matches.map((item) => item.query).join(' '),
  };
}

function relevantResults(results, query) {
  const queryTokens = researchTokens(query);
  const normalizedQuery = String(query).toLowerCase();
  return results.map((item) => {
    const searchable = `${item.title} ${item.excerpt}`.toLowerCase();
    const textTokens = researchTokens(searchable);
    const overlap = [...queryTokens].filter((token) => textTokens.has(token)).length;
    const lexical = queryTokens.size ? overlap / queryTokens.size : 0;
    const exact = normalizedQuery.length >= 12 && searchable.includes(normalizedQuery) ? 0.2 : 0;
    const authority = item.authoritative ? 0.12 : 0;
    const resolved = item.answered ? 0.06 : 0;
    const relevance = Math.min(1, lexical + exact + authority + resolved);
    return { ...item, relevance: Number(relevance.toFixed(3)) };
  }).filter((item) => item.relevance >= 0.38)
    .sort((a, b) => b.relevance - a.relevance || Number(b.authoritative) - Number(a.authoritative) || Number(b.answered) - Number(a.answered) || b.score - a.score);
}

function focusedResearchQuery(query) {
  const text = String(query);
  const intent = englishIntent(text);
  const math = simpleMathFacts(text);
  const exceptions = text.match(/(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)\b/g) || [];
  const phrases = [
    /class file version/i,
    /has been compiled by a more recent version/i,
    /only recognizes class file versions/i,
    /address already in use/i,
    /no route to host/i,
    /connection refused/i,
    /permission denied/i,
    /out of memory/i,
    /unable to access jarfile/i,
    /invalid or corrupt jarfile/i,
    /failed to start transient (?:service )?unit/i,
  ].map((pattern) => text.match(pattern)?.[0]).filter(Boolean);
  if (exceptions.length || phrases.length) {
    return [...new Set([...exceptions.slice(-2), ...phrases.slice(0, 2), intent.query, ...math])].filter(Boolean).join(' ').slice(0, 220);
  }
  if (intent.query || math.length) {
    return [...new Set([intent.query, ...math, text.split(/\r?\n/).at(-1)])].filter(Boolean).join(' ').slice(0, 220);
  }
  const lines = text.split(/\s*\|\s*|\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) || text).replace(/\b(?:0x)?[a-f0-9]{12,}\b/gi, '<id>').slice(0, 180);
}

class RepairWebResearch {
  constructor(db) {
    this.db = db;
    this.inFlight = new Map();
    this.sourceHealth = new Map();
  }

  sourceAvailable(name) {
    return Number(this.sourceHealth.get(name)?.disabledUntil || 0) <= Date.now();
  }

  async runSource(name, request) {
    if (!this.sourceAvailable(name)) throw new Error('source circuit is cooling down');
    try {
      const value = await request();
      this.sourceHealth.set(name, { failures: 0, disabledUntil: 0, lastSuccessAt: Date.now(), lastError: '' });
      return value;
    } catch (error) {
      const previous = this.sourceHealth.get(name) || {};
      const failures = Number(previous.failures || 0) + 1;
      this.sourceHealth.set(name, {
        ...previous,
        failures,
        disabledUntil: failures >= CIRCUIT_FAILURE_LIMIT ? Date.now() + CIRCUIT_COOLDOWN_MS : 0,
        lastFailureAt: Date.now(),
        lastError: String(error.message || error).slice(0, 160),
      });
      throw error;
    }
  }

  queryFromLogs(logs, server, software) {
    const candidates = (logs || [])
      .map((line) => String(line).replace(/^\[[^\]]+\]\s*/, ''))
      .filter((line) => line && !line.includes('[NexusPanel]'))
      .slice(-8);
    const exact = candidates.slice(-3).join(' | ') || `${software?.key || server.software_key || server.type} server failed`;
    const math = simpleMathFacts(exact).join(' ');
    const intent = englishIntent(exact);
    return redactResearchText(`${server.type} ${software?.key || server.software_key || ''} ${intent.query} ${math} ${exact}`);
  }

  async research(query) {
    const safeQuery = redactResearchText(query);
    if (safeQuery.length < 8) return { query: safeQuery, results: [], cached: false, errors: ['Error text was too short to research.'] };
    const queryHash = crypto.createHash('sha256').update(`v5|${safeQuery}`).digest('hex');
    const cached = this.db.prepare('SELECT * FROM repair_web_cache WHERE query_hash = ? AND expires_at > ?').get(queryHash, Date.now());
    if (cached) {
      return { query: cached.query_text, results: JSON.parse(cached.results_json || '[]'), cached: true, errors: [] };
    }
    if (this.inFlight.has(queryHash)) return this.inFlight.get(queryHash);
    const task = this.fetchResearch(safeQuery, queryHash).finally(() => this.inFlight.delete(queryHash));
    this.inFlight.set(queryHash, task);
    return task;
  }

  async fetchResearch(query, queryHash) {
    const errors = [];
    const compact = focusedResearchQuery(query);
    const intent = englishIntent(query);
    const mathFacts = simpleMathFacts(query);
    const githubUrl = new URL('https://api.github.com/search/issues');
    githubUrl.search = new URLSearchParams({
      q: `"${compact.slice(0, 120)}" in:title,body is:issue`,
      per_page: '5',
    }).toString();
    const learnUrl = new URL('https://learn.microsoft.com/api/search/');
    learnUrl.search = new URLSearchParams({
      search: compact,
      locale: 'en-us',
      $filter: "(category eq 'Documentation')",
    }).toString();
    const wikipediaUrl = new URL('https://en.wikipedia.org/w/api.php');
    wikipediaUrl.search = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: compact,
      format: 'json',
      utf8: '1',
      srlimit: '4',
    }).toString();
    const sourceRequests = STACK_SITES.map(([site, label]) => {
      const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
      url.search = new URLSearchParams({
        order: 'desc',
        sort: 'relevance',
        q: compact,
        site,
        filter: 'withbody',
        pagesize: '4',
      }).toString();
      return {
        name: site,
        label,
        request: () => fetchJson(url).then((payload) => stackExchangeResults(payload, site)),
      };
    });
    sourceRequests.push(
      {
        name: 'github-issues',
        label: 'GitHub Issues',
        request: () => fetchJson(githubUrl, { 'X-GitHub-Api-Version': '2022-11-28' }).then(githubResults),
      },
      {
        name: 'microsoft-learn',
        label: 'Microsoft Learn',
        request: () => fetchJson(learnUrl).then(microsoftLearnResults),
      },
      {
        name: 'wikipedia',
        label: 'Wikipedia',
        request: () => fetchJson(wikipediaUrl).then(wikipediaResults),
      },
    );
    const requests = sourceRequests.map((source) => this.runSource(source.name, source.request));
    const settled = await Promise.allSettled(requests);
    const results = [];
    settled.forEach((entry, index) => {
      if (entry.status === 'fulfilled') results.push(...entry.value);
      else errors.push(`${sourceRequests[index].label}: ${entry.reason?.message || 'request failed'}`);
    });
    const unique = relevantResults(
      [...new Map(results.filter((item) => item.url.startsWith('https://')).map((item) => [item.url, item])).values()],
      compact,
    )
      .slice(0, MAX_RESULTS);
    const ttl = unique.length ? CACHE_TTL_MS : 5 * 60 * 1000;
    this.db.prepare(`
      INSERT INTO repair_web_cache (query_hash, query_text, results_json, fetched_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(query_hash) DO UPDATE SET
        query_text = excluded.query_text,
        results_json = excluded.results_json,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    `).run(queryHash, query, JSON.stringify(unique), Date.now(), Date.now() + ttl);
    this.db.prepare('DELETE FROM repair_web_cache WHERE expires_at <= ?').run(Date.now());
    return {
      query,
      focusedQuery: compact,
      intentIds: intent.ids,
      concepts: intent.concepts,
      mathFacts,
      results: unique,
      cached: false,
      errors,
    };
  }

  status() {
    const cache = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(fetched_at), 0) AS last_fetch FROM repair_web_cache').get();
    return {
      enabledSources: [...STACK_SITES.map(([site]) => site), 'github-issues', 'microsoft-learn', 'wikipedia'],
      allowlistedHosts: [...ALLOWED_HOSTS],
      sourceHealth: Object.fromEntries([...this.sourceHealth.entries()].map(([name, value]) => [name, {
        healthy: Number(value.disabledUntil || 0) <= Date.now(),
        failures: Number(value.failures || 0),
        disabledUntil: Number(value.disabledUntil || 0),
        lastSuccessAt: Number(value.lastSuccessAt || 0),
        lastFailureAt: Number(value.lastFailureAt || 0),
        lastError: value.lastError || '',
      }])),
      cachedQueries: Number(cache.count || 0),
      lastFetchAt: Number(cache.last_fetch || 0),
      maxResponseKb: MAX_RESPONSE_BYTES / 1024,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResults: MAX_RESULTS,
      languageUnderstanding: {
        naturalLanguageIntents: ENGLISH_INTENTS.length,
        simpleMath: ['memory-unit-conversion', 'cpuquota-percent', 'duration-extraction'],
      },
      privacy: 'redacted-errors-only',
      execution: 'never',
    };
  }
}

module.exports = {
  ALLOWED_HOSTS,
  RepairWebResearch,
  focusedResearchQuery,
  redactResearchText,
};
