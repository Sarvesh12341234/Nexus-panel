const path = require('node:path');
const { displayPath, softwareRoot } = require('./paths');

const SOFTWARE = [
  {
    key: 'bedrock-vanilla',
    name: 'Bedrock Dedicated Server',
    edition: 'bedrock',
    pluginKinds: ['resource-pack', 'behavior-pack'],
    executable: process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server',
    folder: 'bedrock-vanilla',
    notes: 'Official Bedrock server. Best for pure vanilla worlds and packs.',
    versionMode: 'bedrock',
  },
  {
    key: 'java-vanilla',
    name: 'Java Vanilla',
    edition: 'java',
    pluginKinds: [],
    executable: 'server.jar',
    folder: 'java-vanilla',
    notes: 'Official Java server. No plugin loader.',
    versionMode: 'mojang',
  },
  {
    key: 'paper',
    name: 'Paper',
    edition: 'java',
    pluginKinds: ['jar-plugin'],
    executable: 'paper.jar',
    folder: 'paper',
    notes: 'Fast Bukkit-compatible Java software with plugin support.',
    versionMode: 'papermc',
  },
  {
    key: 'purpur',
    name: 'Purpur',
    edition: 'java',
    pluginKinds: ['jar-plugin'],
    executable: 'purpur.jar',
    folder: 'purpur',
    notes: 'Paper-based Java server with more gameplay configuration.',
    versionMode: 'purpur',
  },
  {
    key: 'pocketmine',
    name: 'PocketMine-MP',
    edition: 'bedrock',
    pluginKinds: ['phar-plugin'],
    executable: process.platform === 'win32' ? 'PocketMine-MP.phar' : 'PocketMine-MP.phar',
    folder: 'pocketmine',
    notes: 'Bedrock plugin ecosystem. Great for minigames, not vanilla parity.',
    versionMode: 'github-latest',
  },
];

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}

function clearSoftwareVersionCache() {
  for (const key of [...cache.keys()]) {
    if (
      key.startsWith('papermc-')
      || key.startsWith('purpur-')
      || key.startsWith('mojang-')
      || key.startsWith('github-')
      || key.startsWith('vexyhost-')
    ) {
      cache.delete(key);
    }
  }
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'NexusPanel/2.0 (+https://github.com/Sarvesh12341234/Nexus-panel)' },
      });
      if (response.status === 404) throw new Error(`Upstream file not found: ${url}`);
      if (!response.ok) throw new Error(`Upstream request failed: ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

function softwareCatalog() {
  return SOFTWARE.map((item) => ({
    ...item,
    expectedPath: displayPath(path.join(softwareRoot, item.folder, item.executable)),
  }));
}

async function minecraftVersions() {
  const manifest = await cached('mojang-version-manifest', () => fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
  return manifest.versions
    .filter((version) => version.type === 'release')
    .map((version) => version.id);
}

async function softwareVersions(key) {
  const software = findSoftware(key);
  if (!software) throw new Error('Unknown software.');

  if (software.versionMode === 'papermc') {
    const project = await cached('papermc-paper-v3', () => fetchJson('https://fill.papermc.io/v3/projects/paper'));
    const groupedVersions = project.versions && typeof project.versions === 'object' && !Array.isArray(project.versions)
      ? Object.values(project.versions).flat()
      : project.versions;
    const versions = [...new Set((Array.isArray(groupedVersions) ? groupedVersions : [])
      .map((version) => String(version || '').trim())
      .filter(Boolean))];
    return versions.length ? versions : ['latest'];
  }

  if (software.versionMode === 'purpur') {
    const project = await cached('purpur-project', () => fetchJson('https://api.purpurmc.org/v2/purpur'));
    return [...project.versions].reverse();
  }

  if (software.versionMode === 'mojang') return minecraftVersions();
  if (software.versionMode === 'bedrock') {
    const urls = await bedrockDownloadUrls();
    const versions = [...new Set(urls
      .filter((url) => !url.includes('preview'))
      .map((url) => url.match(/bedrock-server-([0-9.]+)\.zip/i)?.[1])
      .filter(Boolean))];
    return versions.length ? versions : ['latest'];
  }
  if (software.key === 'pocketmine') {
    const releases = await cached('github-pocketmine-releases', () => fetchJson('https://api.github.com/repos/pmmp/PocketMine-MP/releases?per_page=80'));
    const versions = releases
      .filter((release) => !release.draft && !release.prerelease)
      .filter((release) => (release.assets || []).some((asset) => asset.name === 'PocketMine-MP.phar'))
      .map((release) => String(release.tag_name || '').replace(/^v/i, ''))
      .filter(Boolean);
    return versions.length ? versions : ['latest'];
  }
  if (software.versionMode === 'github-latest') return ['latest'];
  return ['manual'];
}

async function bedrockDownloadUrls() {
  return cached('vexyhost-bedrock-urls', async () => {
    const html = await fetch('https://jars.vexyhost.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 NexusPanel/1.0' },
    }).then((response) => response.text()).catch(() => '');
    const category = '6668191354eeb517d83f59e2';
    const start = html.indexOf(`x-show="selectedCategory === '${category}'"`);
    const end = html.indexOf('x-show="selectedCategory ===', start + 20);
    const section = start >= 0 ? html.slice(start, end > start ? end : start + 350000) : html;
    return [...new Set(section.match(/https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-(?:linux|win)(?:-preview)?\/bedrock-server-[0-9.]+\.zip/g) || [])];
  });
}

async function resolveBedrockUrl(platform, requestedVersion = 'latest') {
  const urls = await bedrockDownloadUrls();
  const channel = `bin-${platform}`;
  if (requestedVersion && requestedVersion !== 'latest' && requestedVersion !== 'manual') {
    const matched = urls.find((url) => url.includes(`/${channel}/`) && url.includes(`bedrock-server-${requestedVersion}.zip`));
    if (matched) return matched;
    return `https://www.minecraft.net/bedrockdedicatedserver/${channel}/bedrock-server-${requestedVersion}.zip`;
  }
  const vexyLatest = urls.find((url) => url.includes(`/${channel}/`) && !url.includes('preview'));
  if (vexyLatest) return vexyLatest;
  const html = await fetch('https://www.minecraft.net/en-us/download/server/bedrock', {
    headers: { 'User-Agent': 'Mozilla/5.0 NexusPanel/1.0' },
  }).then((response) => response.text()).catch(() => '');
  const pattern = /https?:[^"'\s]+bedrock-server-[0-9.]+\.zip/gi;
  const found = (html.match(pattern) || []).find((item) => item.includes(channel));
  if (found) return found.replaceAll('&amp;', '&');
  const fallbackVersion = process.env.NEXUSPANEL_BEDROCK_VERSION || '1.26.23.1';
  return `https://www.minecraft.net/bedrockdedicatedserver/bin-${platform}/bedrock-server-${fallbackVersion}.zip`;
}

async function resolveDownload(software, requestedVersion = 'latest') {
  if (!software) throw new Error('Unknown software.');
  const versions = await softwareVersions(software.key);
  const version = !requestedVersion || requestedVersion === 'latest' ? versions[0] : requestedVersion;
  if (!versions.includes(version) && !['latest', 'manual'].includes(version)) {
    throw new Error(`Version ${version} is not available for ${software.name}.`);
  }

  if (software.key === 'bedrock-vanilla') {
    const platform = process.platform === 'win32' ? 'win' : 'linux';
    const url = await resolveBedrockUrl(platform, requestedVersion);
    const match = url.match(/bedrock-server-([0-9.]+)\.zip/i);
    return { version: match ? match[1] : 'latest', url, fileName: `bedrock-server-${platform}.zip`, archive: true };
  }

  if (software.versionMode === 'papermc') {
    const builds = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
    const rows = Array.isArray(builds) ? builds : (builds.builds || []);
    const build = rows.find((item) => item.channel === 'RECOMMENDED')
      || rows.find((item) => item.channel === 'STABLE')
      || rows[0];
    if (!build) throw new Error('No Paper build is available for this version.');
    const downloadUrl = build.downloads?.['server:default']?.url
      || build.downloads?.application?.url
      || '';
    if (!downloadUrl) throw new Error('No Paper server download is available for this version.');
    return {
      version,
      url: downloadUrl,
      fileName: software.executable,
    };
  }

  if (software.versionMode === 'purpur') {
    const builds = await fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`);
    const build = builds.builds?.latest;
    if (!build) throw new Error('No Purpur build is available for this version.');
    return {
      version,
      url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${build}/download`,
      fileName: software.executable,
    };
  }

  if (software.versionMode === 'mojang') {
    const manifest = await cached('mojang-version-manifest', () => fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
    const entry = manifest.versions.find((item) => item.id === version);
    if (!entry) throw new Error('Minecraft Java version not found.');
    const detail = await fetchJson(entry.url);
    const url = detail.downloads?.server?.url;
    if (!url) throw new Error('This Java version has no server download.');
    return { version, url, fileName: software.executable };
  }

  if (software.key === 'pocketmine') {
    if (version !== 'latest') {
      const releases = await cached('github-pocketmine-releases', () => fetchJson('https://api.github.com/repos/pmmp/PocketMine-MP/releases?per_page=80'));
      const release = releases.find((item) => String(item.tag_name || '').replace(/^v/i, '') === version);
      const asset = release && (release.assets || []).find((item) => item.name === 'PocketMine-MP.phar');
      if (!asset) throw new Error(`PocketMine-MP ${version} does not have a downloadable phar asset.`);
      return {
        version,
        url: asset.browser_download_url,
        fileName: software.executable,
      };
    }
    return {
      version: 'latest',
      url: 'https://github.com/pmmp/PocketMine-MP/releases/latest/download/PocketMine-MP.phar',
      fileName: software.executable,
    };
  }

  throw new Error(`${software.name} requires manual download because the provider does not expose a stable direct installer.`);
}

function findSoftware(key) {
  return SOFTWARE.find((item) => item.key === key) || null;
}

function defaultSoftware(type) {
  return type === 'java' ? findSoftware('paper') : findSoftware('bedrock-vanilla');
}

function compatibleSoftware(type) {
  return SOFTWARE.filter((item) => item.edition === type);
}

function pluginKindForFile(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.jar')) return 'jar-plugin';
  if (lower.endsWith('.phar')) return 'phar-plugin';
  if (lower.endsWith('.mcpack')) return 'resource-pack';
  if (lower.endsWith('.mcaddon')) return 'behavior-pack';
  return null;
}

module.exports = {
  compatibleSoftware,
  defaultSoftware,
  findSoftware,
  pluginKindForFile,
  resolveDownload,
  clearSoftwareVersionCache,
  softwareCatalog,
  softwareVersions,
};
