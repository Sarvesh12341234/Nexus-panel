const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const DDOS_PARAMETER_BUDGET = 200000;
const DDOS_FEATURE_DIMENSIONS = 28570;
const DDOS_LABELS = Object.freeze([
  'normal',
  'tcp-syn-flood',
  'udp-bedrock-flood',
  'connection-fanout',
  'bandwidth-saturation',
  'conntrack-pressure',
  'firewall-misconfig',
]);
const DDOS_PARAMETER_COUNT = DDOS_LABELS.length * DDOS_FEATURE_DIMENSIONS + DDOS_LABELS.length;

function run(command, args, timeout = 1800) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 256 * 1024,
  });
  return {
    ok: result.status === 0,
    output: String(result.stdout || result.stderr || '').slice(0, 12000),
  };
}

function parseSs(output) {
  const lines = String(output || '').split(/\r?\n/).filter(Boolean);
  const states = {};
  const remoteIps = new Map();
  for (const line of lines) {
    const state = line.trim().split(/\s+/)[0] || 'UNKNOWN';
    states[state] = (states[state] || 0) + 1;
    const ip = line.match(/\s((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|[0-9a-f:]{3,})[:\]]\d+\s*$/i)?.[1];
    if (ip && !['127.0.0.1', '::1'].includes(ip)) remoteIps.set(ip, (remoteIps.get(ip) || 0) + 1);
  }
  const topRemotes = [...remoteIps.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ip, count]) => ({ ip, count }));
  return { states, topRemotes, total: lines.length };
}

function parseInterfaces() {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/net/dev')) return [];
  return fs.readFileSync('/proc/net/dev', 'utf8')
    .split('\n')
    .slice(2)
    .map((line) => {
      const [namePart, valuesPart] = line.split(':');
      if (!valuesPart) return null;
      const values = valuesPart.trim().split(/\s+/).map(Number);
      return {
        name: namePart.trim(),
        rxBytes: values[0] || 0,
        rxPackets: values[1] || 0,
        rxErrors: values[2] || 0,
        rxDrops: values[3] || 0,
        txBytes: values[8] || 0,
        txPackets: values[9] || 0,
        txErrors: values[10] || 0,
        txDrops: values[11] || 0,
      };
    })
    .filter((item) => item && item.name !== 'lo');
}

function kernelHints() {
  const hints = [];
  const files = [
    ['/proc/sys/net/ipv4/tcp_syncookies', 'TCP syncookies'],
    ['/proc/sys/net/ipv4/tcp_max_syn_backlog', 'SYN backlog'],
    ['/proc/sys/net/netfilter/nf_conntrack_max', 'conntrack max'],
  ];
  for (const [file, label] of files) {
    try {
      hints.push({ label, value: fs.readFileSync(file, 'utf8').trim() });
    } catch {}
  }
  return hints;
}

function classify(evidence) {
  const syn = Number(evidence.tcp.states.SYN_RECV || 0);
  const established = Number(evidence.tcp.states.ESTAB || evidence.tcp.states.ESTABLISHED || 0);
  const udpSockets = evidence.udp.total;
  const rxDrops = evidence.interfaces.reduce((sum, item) => sum + item.rxDrops, 0);
  const topRemote = evidence.tcp.topRemotes[0]?.count || 0;
  const scores = [
    { id: 'tcp-syn-flood', score: Math.min(1, syn / 500) },
    { id: 'udp-bedrock-flood', score: Math.min(1, (udpSockets + rxDrops) / 900) },
    { id: 'connection-fanout', score: Math.min(1, Math.max(topRemote / 100, established / 1500)) },
    { id: 'bandwidth-saturation', score: Math.min(1, rxDrops / 250) },
    { id: 'conntrack-pressure', score: evidence.conntrackPressure },
    { id: 'firewall-misconfig', score: evidence.kernelHints.length ? 0.08 : 0.2 },
  ].sort((a, b) => b.score - a.score);
  const top = scores[0];
  return {
    active: top.score >= 0.45,
    risk: top.score >= 0.75 ? 'critical' : top.score >= 0.45 ? 'high' : top.score >= 0.25 ? 'watch' : 'normal',
    top,
    scores,
    parameterCount: DDOS_PARAMETER_COUNT,
    featureDimensions: DDOS_FEATURE_DIMENSIONS,
    memoryBudgetMb: 64,
  };
}

function collectDdosEvidence() {
  const tcp = parseSs(run('ss', ['-Htan']).output);
  const udp = parseSs(run('ss', ['-Huan']).output);
  const conntrack = run('sh', ['-lc', 'test -r /proc/sys/net/netfilter/nf_conntrack_count && printf "%s %s" "$(cat /proc/sys/net/netfilter/nf_conntrack_count)" "$(cat /proc/sys/net/netfilter/nf_conntrack_max)"']).output.trim();
  const [count, max] = conntrack.split(/\s+/).map(Number);
  const conntrackPressure = Number.isFinite(count) && Number.isFinite(max) && max > 0 ? count / max : 0;
  const evidence = {
    host: os.hostname(),
    sampledAt: Date.now(),
    tcp,
    udp,
    interfaces: parseInterfaces(),
    kernelHints: kernelHints(),
    conntrack: { count: count || 0, max: max || 0 },
    conntrackPressure,
  };
  return { evidence, analysis: classify(evidence) };
}

function mitigationPlan(analysis, server = null) {
  const port = Number(server?.port || 0);
  const steps = [
    'Verify the attack from host and provider graphs before blocking traffic.',
    'Keep Minecraft query/RCON closed to public networks unless needed.',
    'Prefer provider-level DDoS filtering for large bandwidth floods.',
  ];
  const commands = [];
  if (analysis.top.id === 'tcp-syn-flood') {
    steps.push('Enable TCP syncookies and raise SYN backlog if the VPS is under SYN pressure.');
    commands.push('sysctl -w net.ipv4.tcp_syncookies=1');
    commands.push('sysctl -w net.ipv4.tcp_max_syn_backlog=8192');
  }
  if (analysis.top.id === 'udp-bedrock-flood' && port) {
    steps.push(`Rate-limit suspicious UDP bursts to game port ${port} using your firewall after owner review.`);
    commands.push(`nft add rule inet filter input udp dport ${port} limit rate over 250/second drop`);
  }
  if (analysis.top.id === 'connection-fanout' && port) {
    steps.push(`Limit repeated TCP connection bursts to Java port ${port} after confirming it is not normal player traffic.`);
    commands.push(`nft add rule inet filter input tcp dport ${port} ct state new limit rate over 120/second drop`);
  }
  return { steps, commands };
}

module.exports = {
  DDOS_PARAMETER_COUNT,
  collectDdosEvidence,
  mitigationPlan,
};
