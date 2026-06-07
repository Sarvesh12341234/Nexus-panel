const NEXU_SCHEMA_VERSION = 1;

const BUILTIN_NEXU = [
  {
    nexuVersion: NEXU_SCHEMA_VERSION,
    key: 'bedrock-official',
    name: 'Bedrock Dedicated Server',
    game: { name: 'Minecraft Bedrock', family: 'minecraft', edition: 'bedrock' },
    runtime: {
      softwareKey: 'bedrock-vanilla',
      install: { mode: 'nexus-software', version: 'latest' },
      start: { executable: 'bedrock_server', args: [], stopCommand: 'stop' },
    },
    resources: { ramMb: 1024, cpuCores: 1, diskMb: 2048, ports: [{ name: 'game', port: 19132, protocol: 'udp' }] },
    requirements: [],
    paths: { root: '.', worlds: 'worlds', plugins: '', packs: 'packs', backups: 'backupfolder' },
    properties: { mode: 'bedrock', file: 'server.properties' },
    security: { nexusMark: { enabled: true, network: 'game-only', writeScope: 'server-root' } },
    description: 'Official Bedrock server with packs folders, allowlist, and automatic BDS install.',
    features: ['Automatic Bedrock zip install', 'Behavior/resource pack paths', 'Allowlist live reload'],
  },
  {
    nexuVersion: NEXU_SCHEMA_VERSION,
    key: 'java-crossplay',
    name: 'Java Crossplay',
    game: { name: 'Minecraft Java + Bedrock', family: 'minecraft', edition: 'java' },
    runtime: {
      softwareKey: 'paper',
      install: { mode: 'nexus-software', version: 'latest' },
      start: { executable: 'paper.jar', args: ['nogui'], stopCommand: 'stop' },
    },
    resources: { ramMb: 2048, cpuCores: 2, diskMb: 4096, ports: [{ name: 'java', port: 25565, protocol: 'tcp' }, { name: 'geyser', port: 19132, protocol: 'udp' }] },
    requirements: [{ key: 'java', name: 'Java 21+', install: 'auto-linux-package' }],
    paths: { root: '.', worlds: 'world', plugins: 'plugins', packs: 'plugins', backups: 'backupfolder' },
    properties: { mode: 'java', file: 'server.properties' },
    security: { nexusMark: { enabled: true, network: 'game-only', writeScope: 'server-root' } },
    description: 'Paper server prepared for Geyser/Floodgate through Modrinth plugin manager.',
    features: ['Paper latest builds', 'Modrinth plugin path', 'Recommended Geyser/Floodgate search'],
    recommendedPlugins: ['geyser', 'floodgate', 'viaversion'],
  },
  {
    nexuVersion: NEXU_SCHEMA_VERSION,
    key: 'bedrock-pocketmine',
    name: 'Bedrock PocketMine',
    game: { name: 'Minecraft Bedrock Plugins', family: 'minecraft', edition: 'bedrock' },
    runtime: {
      softwareKey: 'pocketmine',
      install: { mode: 'nexus-software', version: 'latest' },
      start: { executable: 'PocketMine-MP.phar', args: ['--no-wizard', '--disable-ansi'], stopCommand: 'stop' },
    },
    resources: { ramMb: 1024, cpuCores: 1, diskMb: 2048, ports: [{ name: 'game', port: 19132, protocol: 'udp' }] },
    requirements: [{ key: 'php-bundled', name: 'Bundled PHP runtime', install: 'nexus-bundled' }],
    paths: { root: '.', worlds: 'worlds', plugins: 'plugins', packs: 'resource_packs', backups: 'backupfolder' },
    properties: { mode: 'pocketmine', file: 'server.properties' },
    security: { nexusMark: { enabled: true, network: 'game-only', writeScope: 'server-root' } },
    description: 'PocketMine-MP with bundled PHP runtime and Poggit plugin flow.',
    features: ['Bundled PHP runtime', 'Poggit plugins', 'Minigame friendly'],
  },
  {
    nexuVersion: NEXU_SCHEMA_VERSION,
    key: 'java-performance',
    name: 'Java Performance',
    game: { name: 'Minecraft Java', family: 'minecraft', edition: 'java' },
    runtime: {
      softwareKey: 'purpur',
      install: { mode: 'nexus-software', version: 'latest' },
      start: { executable: 'purpur.jar', args: ['nogui'], stopCommand: 'stop' },
    },
    resources: { ramMb: 4096, cpuCores: 2, diskMb: 8192, ports: [{ name: 'java', port: 25565, protocol: 'tcp' }] },
    requirements: [{ key: 'java', name: 'Java 21+', install: 'auto-linux-package' }],
    paths: { root: '.', worlds: 'world', plugins: 'plugins', packs: 'plugins', backups: 'backupfolder' },
    properties: { mode: 'java', file: 'server.properties' },
    security: { nexusMark: { enabled: true, network: 'game-only', writeScope: 'server-root' } },
    description: 'Purpur performance template for survival/SMP servers.',
    features: ['Purpur latest builds', 'Plugin loader', 'RAM-aware JVM launch'],
  },
  {
    nexuVersion: NEXU_SCHEMA_VERSION,
    key: 'rust-server',
    name: 'Rust Dedicated',
    game: { name: 'Rust', family: 'steam', edition: 'linux' },
    runtime: {
      softwareKey: 'steamcmd-rust',
      install: {
        mode: 'steamcmd',
        version: 'latest',
        appId: '258550',
        commands: ['steamcmd +force_install_dir {{root}} +login anonymous +app_update 258550 validate +quit'],
      },
      start: {
        executable: 'RustDedicated',
        args: ['-batchmode', '+server.port', '{{port}}', '+server.identity', '{{serverName}}', '+server.maxplayers', '50'],
        stopCommand: 'quit',
      },
    },
    resources: { ramMb: 6144, cpuCores: 3, diskMb: 12288, ports: [{ name: 'game', port: 28015, protocol: 'udp' }, { name: 'rcon', port: 28016, protocol: 'tcp' }] },
    requirements: [{ key: 'steamcmd', name: 'SteamCMD', install: 'auto-linux-package', command: 'apt install -y steamcmd || dnf install -y steamcmd' }],
    paths: { root: '.', worlds: 'server/{{serverName}}', plugins: 'oxide/plugins', packs: 'oxide/data', backups: 'backupfolder' },
    properties: { mode: 'custom', file: 'server/{{serverName}}/cfg/server.cfg' },
    security: { nexusMark: { enabled: true, network: 'game-only', writeScope: 'server-root' } },
    description: 'Real SteamCMD Rust server blueprint using app 258550.',
    features: ['SteamCMD app 258550', 'RCON port metadata', 'Oxide/uMod-ready paths'],
  },
  {
    nexuVersion: NEXU_SCHEMA_VERSION,
    key: 'ark-survival',
    name: 'ARK Survival Ascended',
    game: { name: 'ARK Survival Ascended', family: 'steam', edition: 'windows' },
    runtime: {
      softwareKey: 'steamcmd-ark-asa',
      install: {
        mode: 'steamcmd',
        version: 'latest',
        appId: '2430930',
        commands: ['steamcmd +@sSteamCmdForcePlatformType windows +force_install_dir {{root}} +login anonymous +app_update 2430930 validate +quit'],
      },
      start: {
        executable: 'ShooterGame/Binaries/Win64/ArkAscendedServer.exe',
        args: ['TheIsland_WP?listen?SessionName={{serverName}}?ServerPassword=?ServerAdminPassword=changeme', '-NoBattlEye'],
        stopCommand: 'DoExit',
      },
    },
    resources: { ramMb: 12288, cpuCores: 4, diskMb: 32768, ports: [{ name: 'game', port: 7777, protocol: 'udp' }, { name: 'query', port: 27015, protocol: 'udp' }, { name: 'rcon', port: 27020, protocol: 'tcp' }] },
    requirements: [{ key: 'steamcmd', name: 'SteamCMD', install: 'auto-linux-package' }, { key: 'wine', name: 'Wine/Proton for Linux hosts', install: 'manual-or-proton' }],
    paths: { root: '.', worlds: 'ShooterGame/Saved', plugins: 'ShooterGame/Binaries', packs: 'ShooterGame/Content', backups: 'backupfolder' },
    properties: { mode: 'custom', file: 'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini' },
    security: { nexusMark: { enabled: true, network: 'game-only', writeScope: 'server-root' } },
    description: 'Real SteamCMD ARK Ascended blueprint using app 2430930. ASA is Windows-server based, so Linux needs Wine/Proton.',
    features: ['SteamCMD app 2430930', 'Query/RCON ports', 'Backup-first save path'],
  },
  ...[
    ['ark-evolved', 'ARK Survival Evolved', 'ARK Evolved', 7777, 8192, 4, ['steamcmd'], 'SteamCMD ARK Evolved server using app 376030.'],
    ['hytale-ready', 'Hytale Ready', 'Hytale', 25565, 4096, 2, ['java'], 'Future-proof Hytale template slot.'],
    ['valheim', 'Valheim', 'Valheim', 2456, 2048, 1, ['steamcmd'], 'Small VPS-friendly survival template.'],
    ['terraria', 'Terraria', 'Terraria', 7777, 1024, 1, ['mono'], 'Low-resource Terraria template.'],
    ['palworld', 'Palworld', 'Palworld', 8211, 8192, 4, ['steamcmd'], 'High-memory Palworld template.'],
    ['factorio', 'Factorio', 'Factorio', 34197, 1024, 1, [], 'Efficient automation server template.'],
    ['satisfactory', 'Satisfactory', 'Satisfactory', 7777, 6144, 3, ['steamcmd'], 'Factory server template for bigger hosts.'],
    ['project-zomboid', 'Project Zomboid', 'Project Zomboid', 16261, 4096, 2, ['steamcmd'], 'Persistent survival server template.'],
    ['custom-nexu', 'Custom Nexu Template', 'Any Game', 25565, 1024, 1, [], 'Import your own .nexu JSON template.'],
  ].map(([key, name, gameName, port, ramMb, cpuCores, requirementKeys, description]) => ({
    nexuVersion: NEXU_SCHEMA_VERSION,
    key,
    name,
    game: { name: gameName, family: 'custom', edition: 'custom' },
    runtime: {
      softwareKey: `custom-${key.replace(/-server$/, '')}`,
      install: key === 'ark-evolved'
        ? { mode: 'steamcmd', version: 'latest', appId: '376030', commands: ['steamcmd +force_install_dir {{root}} +login anonymous +app_update 376030 validate +quit'] }
        : { mode: 'nexu-script', commands: [] },
      start: { executable: '', args: [], stopCommand: 'stop' },
    },
    resources: { ramMb, cpuCores, diskMb: Math.max(2048, ramMb * 2), ports: [{ name: 'game', port, protocol: 'udp/tcp' }] },
    requirements: requirementKeys.map((item) => ({ key: item, name: item, install: 'planned' })),
    paths: { root: '.', worlds: 'worlds', plugins: 'plugins', packs: 'packs', backups: 'backupfolder' },
    properties: { mode: 'custom', file: '' },
    security: { nexusMark: { enabled: true, network: 'game-only', writeScope: 'server-root' } },
    description,
    features: ['Nexu JSON structure', 'Nexus-Mark resource profile', 'Safe isolated server root'],
  })),
];

function cleanKey(value, fallback = 'custom-nexu') {
  return String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || fallback;
}

function cleanString(value, fallback = '', limit = 120) {
  const text = String(value ?? fallback).trim();
  return (text || fallback).slice(0, limit);
}

function cleanNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeRequirement(requirement) {
  if (typeof requirement === 'string') return { key: cleanKey(requirement, 'requirement'), name: cleanString(requirement, 'Requirement'), install: 'planned' };
  return {
    key: cleanKey(requirement?.key || requirement?.name, 'requirement'),
    name: cleanString(requirement?.name || requirement?.key, 'Requirement'),
    install: cleanString(requirement?.install, 'planned', 80),
    command: cleanString(requirement?.command, '', 240),
  };
}

function normalizeNexuTemplate(input) {
  const source = input || {};
  const oldEdition = source.edition;
  const oldSoftwareKey = source.softwareKey;
  const oldPort = source.port;
  const oldMemory = source.memoryMb;
  const edition = cleanString(source.game?.edition || oldEdition || 'custom', 'custom', 24);
  const key = cleanKey(source.key);
  const name = cleanString(source.name, 'Custom Nexu Template', 80);
  const resources = source.resources || {};
  const runtime = source.runtime || {};
  const ports = Array.isArray(resources.ports) && resources.ports.length
    ? resources.ports.slice(0, 8).map((port) => ({
      name: cleanString(port.name, 'game', 32),
      port: cleanNumber(port.port, 1, 65535, cleanNumber(oldPort, 1, 65535, 25565)),
      protocol: cleanString(port.protocol, 'tcp', 12),
    }))
    : [{ name: 'game', port: cleanNumber(oldPort, 1, 65535, edition === 'bedrock' ? 19132 : 25565), protocol: edition === 'bedrock' ? 'udp' : 'tcp' }];

  return {
    nexuVersion: cleanNumber(source.nexuVersion, 1, NEXU_SCHEMA_VERSION, NEXU_SCHEMA_VERSION),
    key,
    name,
    game: {
      name: cleanString(source.game?.name || source.game || 'Custom Game', 'Custom Game', 80),
      family: cleanString(source.game?.family, edition === 'custom' ? 'custom' : 'minecraft', 40),
      edition,
    },
    runtime: {
      softwareKey: cleanString(runtime.softwareKey || oldSoftwareKey || `custom-${key}`, `custom-${key}`, 80),
      install: {
        mode: cleanString(runtime.install?.mode, runtime.softwareKey || oldSoftwareKey ? 'nexus-software' : 'nexu-script', 40),
        version: cleanString(runtime.install?.version, 'latest', 40),
        appId: cleanString(runtime.install?.appId, '', 24),
        commands: Array.isArray(runtime.install?.commands) ? runtime.install.commands.slice(0, 20).map((item) => cleanString(item, '', 240)).filter(Boolean) : [],
      },
      start: {
        executable: cleanString(runtime.start?.executable, '', 160),
        args: Array.isArray(runtime.start?.args) ? runtime.start.args.slice(0, 32).map((item) => cleanString(item, '', 120)) : [],
        stopCommand: cleanString(runtime.start?.stopCommand, 'stop', 80),
      },
    },
    resources: {
      ramMb: cleanNumber(resources.ramMb || oldMemory, 256, 262144, 1024),
      cpuCores: cleanNumber(resources.cpuCores, 1, 256, 1),
      diskMb: cleanNumber(resources.diskMb, 256, 1048576, 2048),
      ports,
    },
    requirements: Array.isArray(source.requirements) ? source.requirements.slice(0, 16).map(normalizeRequirement) : [],
    paths: {
      root: cleanString(source.paths?.root, '.', 80),
      worlds: cleanString(source.paths?.worlds, 'worlds', 80),
      plugins: cleanString(source.paths?.plugins, 'plugins', 80),
      packs: cleanString(source.paths?.packs, 'packs', 80),
      backups: cleanString(source.paths?.backups, 'backupfolder', 80),
    },
    properties: {
      mode: cleanString(source.properties?.mode || source.propertyMode, edition === 'custom' ? 'custom' : edition, 40),
      file: cleanString(source.properties?.file, edition === 'custom' ? '' : 'server.properties', 120),
    },
    security: {
      nexusMark: {
        enabled: source.security?.nexusMark?.enabled !== false,
        network: cleanString(source.security?.nexusMark?.network, 'game-only', 40),
        writeScope: cleanString(source.security?.nexusMark?.writeScope, 'server-root', 40),
      },
    },
    description: cleanString(source.description, 'Nexu JSON server template.', 260),
    features: Array.isArray(source.features) ? source.features.slice(0, 16).map((item) => cleanString(item, '', 90)).filter(Boolean) : [],
    recommendedPlugins: Array.isArray(source.recommendedPlugins) ? source.recommendedPlugins.slice(0, 16).map((item) => cleanString(item, '', 60)).filter(Boolean) : [],
  };
}

function legacyTemplate(template) {
  const nexu = normalizeNexuTemplate(template);
  return {
    ...nexu,
    game: nexu.game.name,
    edition: nexu.game.edition,
    softwareKey: nexu.runtime.softwareKey,
    port: nexu.resources.ports[0]?.port || 25565,
    memoryMb: nexu.resources.ramMb,
    cpuCores: nexu.resources.cpuCores,
    diskMb: nexu.resources.diskMb,
    startArgs: nexu.runtime.start.args,
    requirements: nexu.requirements,
    propertyMode: nexu.properties.mode,
    nexu,
  };
}

function builtinTemplates() {
  return BUILTIN_NEXU.map(legacyTemplate);
}

function findTemplate(key) {
  return builtinTemplates().find((item) => item.key === key) || null;
}

function nexuExample() {
  return normalizeNexuTemplate({
    key: 'my-game',
    name: 'My Game Server',
    game: { name: 'My Game', family: 'custom', edition: 'custom' },
    runtime: {
      softwareKey: 'custom-my-game',
      install: { mode: 'nexu-script', commands: ['echo install command here'] },
      start: { executable: 'server-binary', args: ['--port', '{{port}}'], stopCommand: 'stop' },
    },
    resources: { ramMb: 2048, cpuCores: 2, diskMb: 4096, ports: [{ name: 'game', port: 25565, protocol: 'tcp' }] },
    requirements: [{ key: 'java', name: 'Java 21+', install: 'auto-linux-package' }],
  });
}

module.exports = {
  NEXU_SCHEMA_VERSION,
  builtinTemplates,
  findTemplate,
  nexuExample,
  normalizeNexuTemplate,
};
