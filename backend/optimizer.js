const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const SYSCTL_TWEAKS = [
  ['net.core.rmem_max', '134217728', 'UDP receive ceiling for Bedrock traffic bursts'],
  ['net.core.wmem_max', '134217728', 'UDP send ceiling for tunnel and proxy bursts'],
  ['net.core.rmem_default', '1048576', 'Higher default socket receive buffer'],
  ['net.core.wmem_default', '1048576', 'Higher default socket send buffer'],
  ['net.core.somaxconn', '4096', 'More pending TCP connections for panel and Java status pings'],
  ['net.ipv4.tcp_congestion_control', 'bbr', 'Modern TCP congestion control for VPS routes'],
  ['net.core.default_qdisc', 'fq', 'Fair queueing pairs well with BBR'],
  ['net.ipv4.tcp_fastopen', '3', 'Faster repeat TCP handshakes where supported'],
  ['net.ipv4.tcp_mtu_probing', '1', 'Avoids black-hole MTU issues on tunnels'],
  ['net.ipv4.tcp_slow_start_after_idle', '0', 'Keeps TCP throughput responsive after idle periods'],
  ['net.ipv4.tcp_tw_reuse', '1', 'Reuses safe TIME_WAIT sockets for outbound checks'],
  ['net.ipv4.ip_local_port_range', '1024 65535', 'Larger outbound ephemeral port range'],
  ['fs.file-max', '1048576', 'Higher system file descriptor ceiling'],
  ['vm.swappiness', '10', 'Reduces swapping on low-memory hosts'],
  ['vm.vfs_cache_pressure', '50', 'Keeps filesystem cache warmer for worlds and backups'],
];

const DNS_PROFILES = [
  {
    id: 'cloudflare',
    name: 'Cloudflare low-latency',
    servers: ['1.1.1.1', '1.0.0.1', '2606:4700:4700::1111'],
    notes: 'Fast global resolver; good default for most hosts.',
  },
  {
    id: 'quad9',
    name: 'Quad9 security',
    servers: ['9.9.9.9', '149.112.112.112', '2620:fe::fe'],
    notes: 'Blocks known malicious domains; useful for public VPS panels.',
  },
  {
    id: 'google',
    name: 'Google public DNS',
    servers: ['8.8.8.8', '8.8.4.4', '2001:4860:4860::8888'],
    notes: 'Reliable fallback with broad anycast coverage.',
  },
];

const TECHNIQUE_PACK = [
  {
    name: 'NIC queue depth',
    command: 'ip link set dev <interface> txqueuelen 10000',
    reason: 'Helps absorb packet bursts on busy VPS network adapters.',
  },
  {
    name: 'NIC offload check',
    command: 'ethtool -k <interface>',
    reason: 'Shows GRO/GSO/TSO offload state without changing anything.',
  },
  {
    name: 'CPU governor',
    command: 'cpupower frequency-set -g performance',
    reason: 'Reduces latency spikes on hosts that downclock aggressively.',
  },
  {
    name: 'Systemd server limits',
    command: 'LimitNOFILE=1048576',
    reason: 'Keeps file/socket limits high for the Minecraft service unit.',
  },
  {
    name: 'World disk mount',
    command: 'noatime',
    reason: 'Avoids extra access-time writes on world and backup storage.',
  },
  {
    name: 'Java network compression',
    command: 'network-compression-threshold=256',
    reason: 'Keeps Java bandwidth lower without making CPU usage silly.',
  },
  {
    name: 'DNS cache and DoT',
    command: 'DNSOverTLS=opportunistic; Cache=yes',
    reason: 'Improves resolver privacy and repeat lookup speed on systemd-resolved hosts.',
  },
  {
    name: 'Firewall sanity',
    command: 'ufw allow 19132/udp; ufw allow 25565/tcp',
    reason: 'Keeps Bedrock UDP and Java TCP reachable on VPS installs.',
  },
];

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1200,
    }).trim();
  } catch {
    return '';
  }
}

function isLinux() {
  return process.platform === 'linux';
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function currentSysctl(key) {
  if (!isLinux()) return null;
  const value = run('sysctl', ['-n', key]);
  return value || null;
}

function detectVps() {
  if (!isLinux()) return { detected: false, vendor: 'unknown' };

  const vendorText = [
    readText('/sys/class/dmi/id/sys_vendor'),
    readText('/sys/class/dmi/id/product_name'),
    readText('/sys/class/dmi/id/board_vendor'),
  ].join(' ').toLowerCase();

  const vendors = ['kvm', 'qemu', 'vmware', 'virtualbox', 'xen', 'openstack', 'amazon', 'ec2', 'google', 'azure', 'digitalocean', 'linode', 'vultr', 'hetzner'];
  const vendor = vendors.find((name) => vendorText.includes(name));
  return { detected: Boolean(vendor), vendor: vendor || 'bare-metal-or-unknown' };
}

function dnsStatus() {
  if (!isLinux()) {
    return {
      currentServers: [],
      profiles: DNS_PROFILES,
      supported: false,
      reason: 'DNS optimization is disabled on Windows in NexusPanel.',
    };
  }

  const resolvConf = readText('/etc/resolv.conf');
  const currentServers = resolvConf
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('nameserver '))
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean);

  return {
    currentServers,
    profiles: DNS_PROFILES,
    supported: true,
    reason: 'Use the generated commands if you want to change resolvers.',
  };
}

function tweakRows() {
  return SYSCTL_TWEAKS.map(([key, target, description]) => {
    const current = currentSysctl(key);
    return {
      key,
      target,
      current,
      description,
      ready: isLinux() && current !== null,
      optimized: current !== null && String(current).trim() === target,
      command: `sysctl -w ${key}="${target}"`,
    };
  });
}

function optimizerStatus() {
  const platform = process.platform;
  const supported = isLinux();
  const vps = detectVps();
  const kernel = isLinux() ? os.release() : os.type();

  return {
    platform,
    supported,
    canApply: supported && isRoot(),
    kernel,
    vps,
    cpuCount: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    dns: dnsStatus(),
    tweaks: tweakRows(),
    techniques: TECHNIQUE_PACK,
    plan: planCommands(),
    message: supported
      ? 'Linux optimization is available. Apply requires running NexusPanel as root.'
      : 'Windows detected. NexusPanel will not run OS/network optimization here.',
  };
}

function planCommands() {
  const commands = SYSCTL_TWEAKS.map(([key, target]) => `sysctl -w ${key}="${target}"`);
  const persistLines = SYSCTL_TWEAKS.map(([key, target]) => `${key} = ${target}`);

  return {
    supported: isLinux(),
    commands,
    persistFile: '/etc/sysctl.d/99-nexuspanel-minecraft.conf',
    persistContent: persistLines.join('\n'),
    dnsExamples: DNS_PROFILES.map((profile) => ({
      id: profile.id,
      name: profile.name,
      commands: [
        'mkdir -p /etc/systemd/resolved.conf.d',
        `printf "[Resolve]\\nDNS=${profile.servers.join(' ')}\\nDNSOverTLS=opportunistic\\nCache=yes\\n" > /etc/systemd/resolved.conf.d/nexuspanel.conf`,
        'systemctl restart systemd-resolved',
      ],
    })),
  };
}

function applyTweaks() {
  if (!isLinux()) {
    return { applied: false, error: 'Windows optimization is disabled.' };
  }

  if (!isRoot()) {
    return { applied: false, error: 'Run NexusPanel as root to apply OS tweaks.' };
  }

  const applied = [];
  const failed = [];

  for (const [key, target] of SYSCTL_TWEAKS) {
    const output = run('sysctl', ['-w', `${key}=${target}`]);
    if (output) applied.push({ key, target, output });
    else failed.push({ key, target });
  }

  return { applied: true, appliedTweaks: applied, failedTweaks: failed };
}

module.exports = {
  optimizerStatus,
  planCommands,
  applyTweaks,
};
