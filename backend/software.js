const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
    key: 'fabric',
    name: 'Fabric',
    edition: 'java',
    pluginKinds: ['jar-plugin'],
    executable: 'fabric-server-launch.jar',
    folder: 'fabric',
    notes: 'Fabric mod loader for Java servers. Install server-side Fabric mods into the mods folder.',
    versionMode: 'fabric',
  },
  {
    key: 'forge',
    name: 'Forge',
    edition: 'java',
    pluginKinds: ['jar-plugin'],
    executable: process.platform === 'win32' ? 'start-forge.bat' : 'start-forge.sh',
    folder: 'forge',
    notes: 'Forge mod loader for Java servers. Installs the official Forge server layout.',
    versionMode: 'forge',
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
const CACHE_SECONDS = Math.round(CACHE_MS / 1000);
const cache = new Map();
const FALLBACK_MINECRAFT_VERSIONS = [
  '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1',
  '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.17.1',
  '1.16.5', '1.12.2', '1.8.9',
];
const FALLBACK_BEDROCK_VERSIONS = ['1.21.100.6', '1.21.93.1', '1.21.90.3', '1.21.84.1', '1.21.80.3'];

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
      || key.startsWith('fabric-')
      || key.startsWith('forge-')
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
        signal: AbortSignal.timeout(3500),
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

function parseVersionParts(value) {
  return String(value || '').split('.').map((part) => Number(part)).filter((part) => Number.isFinite(part));
}

function compareParts(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function parseJavaMajor(output) {
  const text = String(output || '');
  const legacy = text.match(/version\s+"1\.(\d+)/i)?.[1];
  if (legacy) return Number(legacy);
  const modern = text.match(/version\s+"(\d+)(?:[._]\d+)?/i)?.[1];
  if (modern) return Number(modern);
  return 0;
}

function installedJavaMajor() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return 0;
  return parseJavaMajor(`${result.stderr || ''}\n${result.stdout || ''}`);
}

function requiredJavaMajorForMinecraftVersion(version) {
  const value = String(version || '').trim();
  if (/^\d{2,}\./.test(value)) return 25;
  if (/^\d+w/i.test(value)) return 25;
  if (!/^1\.\d+(?:\.\d+)?$/.test(value)) return 21;
  if (compareParts(value, '1.20.5') >= 0) return 21;
  if (compareParts(value, '1.18') >= 0) return 17;
  if (compareParts(value, '1.17') >= 0) return 16;
  return 8;
}

function hostJavaCompatibleVersions(versions) {
  if (process.platform === 'linux' && process.env.NEXUSPANEL_HIDE_BUNDLED_JAVA_VERSIONS !== '1') return versions;
  const javaMajor = installedJavaMajor() || 21;
  return versions.filter((version) => requiredJavaMajorForMinecraftVersion(version) <= javaMajor);
}

async function minecraftVersions() {
  const manifest = await cached('mojang-version-manifest', () => fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
  return hostJavaCompatibleVersions(manifest.versions
    .filter((version) => version.type === 'release')
    .map((version) => version.id));
}

async function fabricGameVersions() {
  const versions = await cached('fabric-game-versions', () => fetchJson('https://meta.fabricmc.net/v2/versions/game'));
  return hostJavaCompatibleVersions(versions
    .filter((version) => version.stable)
    .map((version) => String(version.version || '').trim())
    .filter(Boolean));
}

async function latestFabricLoader() {
  const loaders = await cached('fabric-loader-versions', () => fetchJson('https://meta.fabricmc.net/v2/versions/loader'));
  return loaders.find((item) => item.stable)?.version || loaders[0]?.version;
}

async function latestFabricInstaller() {
  const installers = await cached('fabric-installer-versions', () => fetchJson('https://meta.fabricmc.net/v2/versions/installer'));
  return installers.find((item) => item.stable)?.version || installers[0]?.version;
}

function parseForgeVersions(xml) {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1])
    .filter(Boolean);
}

async function forgeArtifactVersions() {
  const xml = await cached('forge-maven-metadata', async () => {
    const response = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', {
      headers: { 'User-Agent': 'NexusPanel/2.0 (+https://github.com/Sarvesh12341234/Nexus-panel)' },
      signal: AbortSignal.timeout(4500),
    });
    if (!response.ok) throw new Error(`Forge metadata failed: ${response.status}`);
    return response.text();
  });
  return parseForgeVersions(xml).reverse();
}

async function forgeMinecraftVersions() {
  const versions = await forgeArtifactVersions();
  return hostJavaCompatibleVersions([...new Set(versions.map((version) => version.split('-')[0]).filter(Boolean))]);
}

async function resolveForgeArtifact(requestedVersion) {
  const versions = await forgeArtifactVersions();
  const selected = versions.find((version) => version.startsWith(`${requestedVersion}-`));
  if (!selected) throw new Error(`No Forge build is available for Minecraft ${requestedVersion}.`);
  return selected;
}

async function softwareVersions(key) {
  const software = findSoftware(key);
  if (!software) throw new Error('Unknown software.');

  if (software.versionMode === 'papermc') {
    try {
      const project = await cached('papermc-paper-v3', () => fetchJson('https://fill.papermc.io/v3/projects/paper'));
      
      let versions = [];
      if (project.versions) {
        if (Array.isArray(project.versions)) {
          versions = project.versions;
        } else if (typeof project.versions === 'object') {
          // Flatten grouped versions from v3 API
          for (const group of Object.values(project.versions)) {
            if (Array.isArray(group)) {
              versions.push(...group);
            }
          }
        }
      }
      
      versions = [...new Set(versions.map(v => String(v).trim()).filter(Boolean))];
      const compatible = hostJavaCompatibleVersions(versions);
      if (compatible.length) return compatible;
    } catch (error) {
      console.error(`Failed to fetch Paper versions: ${error.message}`);
    }
    try {
      const project = await cached('papermc-paper-v2', () => fetchJson('https://api.papermc.io/v2/projects/paper'));
      const compatible = hostJavaCompatibleVersions([...(project.versions || [])].reverse());
      if (compatible.length) return compatible;
    } catch (error) {
      console.error(`Failed to fetch Paper v2 versions: ${error.message}`);
    }
    return hostJavaCompatibleVersions(FALLBACK_MINECRAFT_VERSIONS);
  }

  if (software.versionMode === 'purpur') {
    try {
      const project = await cached('purpur-project', () => fetchJson('https://api.purpurmc.org/v2/purpur'));
      const compatible = hostJavaCompatibleVersions([...project.versions].reverse());
      return compatible.length ? compatible : hostJavaCompatibleVersions(FALLBACK_MINECRAFT_VERSIONS);
    } catch (error) {
      console.error(`Failed to fetch Purpur versions: ${error.message}`);
      return hostJavaCompatibleVersions(FALLBACK_MINECRAFT_VERSIONS);
    }
  }

  if (software.versionMode === 'fabric') {
    try {
      return await fabricGameVersions();
    } catch (error) {
      console.error(`Failed to fetch Fabric versions: ${error.message}`);
      return hostJavaCompatibleVersions(FALLBACK_MINECRAFT_VERSIONS);
    }
  }
  if (software.versionMode === 'forge') {
    try {
      return await forgeMinecraftVersions();
    } catch (error) {
      console.error(`Failed to fetch Forge versions: ${error.message}`);
      return hostJavaCompatibleVersions(FALLBACK_MINECRAFT_VERSIONS);
    }
  }
  if (software.versionMode === 'mojang') {
    try {
      return await minecraftVersions();
    } catch (error) {
      console.error(`Failed to fetch Minecraft versions: ${error.message}`);
      return hostJavaCompatibleVersions(FALLBACK_MINECRAFT_VERSIONS);
    }
  }
  if (software.versionMode === 'bedrock') {
    try {
      const urls = await bedrockDownloadUrls();
      const versions = [...new Set(urls
        .filter((url) => !url.includes('preview'))
        .map((url) => url.match(/bedrock-server-([0-9.]+)\.zip/i)?.[1])
        .filter(Boolean))];
      return versions.length ? versions : FALLBACK_BEDROCK_VERSIONS;
    } catch (error) {
      console.error(`Failed to fetch Bedrock versions: ${error.message}`);
      return FALLBACK_BEDROCK_VERSIONS;
    }
  }
  if (software.key === 'pocketmine') {
    try {
      const releases = await cached('github-pocketmine-releases', () => fetchJson('https://api.github.com/repos/pmmp/PocketMine-MP/releases?per_page=80'));
      const versions = releases
        .filter((release) => !release.draft && !release.prerelease)
        .filter((release) => (release.assets || []).some((asset) => asset.name === 'PocketMine-MP.phar'))
        .map((release) => String(release.tag_name || '').replace(/^v/i, ''))
        .filter(Boolean);
      return versions.length ? versions : ['latest'];
    } catch (error) {
      console.error(`Failed to fetch PocketMine versions: ${error.message}`);
      return ['latest'];
    }
  }
  if (software.versionMode === 'github-latest') return ['latest'];
  return ['manual'];
}

async function bedrockDownloadUrls() {
  return cached('vexyhost-bedrock-urls', async () => {
    const html = await fetch('https://jars.vexyhost.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 NexusPanel/1.0' },
      signal: AbortSignal.timeout(5000),
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
    signal: AbortSignal.timeout(5000),
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
    try {
      // v3 API returns an array directly
      const builds = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
      
      // builds is already an array of build objects
      const rows = Array.isArray(builds) ? builds : (builds.builds || []);
      
      if (!rows.length) {
        throw new Error(`No Paper builds found for version ${version}`);
      }
      
      // Find the latest stable build
      let build = rows.find((item) => item.channel === 'STABLE')
        || rows.find((item) => item.channel === 'RECOMMENDED')
        || rows[rows.length - 1]; // Latest build
      
      if (!build) {
        throw new Error(`No Paper build available for ${version}`);
      }
      
      // The download info is under 'server:default' key
      const downloadInfo = build.downloads?.['server:default'];
      if (!downloadInfo || !downloadInfo.url) {
        throw new Error(`No download URL for Paper ${version}`);
      }
      
      return {
        version,
        url: downloadInfo.url,
        fileName: software.executable,
      };
    } catch (error) {
      console.error(`Paper download failed: ${error.message}`);
      throw error;
    }
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

  if (software.versionMode === 'fabric') {
    const loader = await latestFabricLoader();
    const installer = await latestFabricInstaller();
    if (!loader || !installer) throw new Error('Fabric loader metadata is unavailable.');
    return {
      version,
      url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`,
      fileName: software.executable,
      loaderVersion: loader,
      installerVersion: installer,
    };
  }

  if (software.versionMode === 'forge') {
    const forgeVersion = await resolveForgeArtifact(version);
    return {
      version,
      forgeVersion,
      installer: true,
      url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(forgeVersion)}/forge-${encodeURIComponent(forgeVersion)}-installer.jar`,
      fileName: `forge-${forgeVersion}-installer.jar`,
    };
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
  installedJavaMajor,
  pluginKindForFile,
  requiredJavaMajorForMinecraftVersion,
  resolveDownload,
  clearSoftwareVersionCache,
  softwareCatalog,
  softwareVersions,
};
