const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLK_TCK = 100;
const cache = new Map();
const unitCgroupCache = new Map();

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function linuxChildren(rootPid) {
  const root = Number(rootPid);
  if (!root || process.platform !== 'linux') return [root].filter(Boolean);
  const childrenByParent = new Map();
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const status = readText(`/proc/${pid}/status`);
    const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] || 0);
    if (!ppid) continue;
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid).push(pid);
  }
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const child of childrenByParent.get(current) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

function linuxProcMetrics(pid) {
  const stat = readText(`/proc/${pid}/stat`);
  const status = readText(`/proc/${pid}/status`);
  if (!stat || !status) return null;
  const tail = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
  const utime = Number(tail[11] || 0);
  const stime = Number(tail[12] || 0);
  const rssKb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
  return { cpuTicks: utime + stime, rssBytes: rssKb * 1024 };
}

function linuxCgroupMetrics(unit) {
  if (!unit || process.platform !== 'linux') return null;
  const now = Date.now();
  let cachedGroup = unitCgroupCache.get(unit);
  if (!cachedGroup || cachedGroup.expiresAt <= now) {
    const show = spawnSync('systemctl', ['show', unit, '-p', 'ControlGroup', '--value'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    cachedGroup = { value: String(show.stdout || '').trim(), expiresAt: now + 30000 };
    unitCgroupCache.set(unit, cachedGroup);
  }
  const controlGroup = cachedGroup.value;
  if (!controlGroup) return null;
  const cgroup = path.join('/sys/fs/cgroup', controlGroup);
  const memoryCurrent = Number(readText(path.join(cgroup, 'memory.current')).trim());
  const cpuStat = readText(path.join(cgroup, 'cpu.stat'));
  const usageUsec = Number(cpuStat.match(/^usage_usec\s+(\d+)/m)?.[1] || 0);
  const nrThrottled = Number(cpuStat.match(/^nr_throttled\s+(\d+)/m)?.[1] || 0);
  const throttledUsec = Number(cpuStat.match(/^throttled_usec\s+(\d+)/m)?.[1] || 0);
  const memoryEventsText = readText(path.join(cgroup, 'memory.events'));
  const memoryEvents = Object.fromEntries([...memoryEventsText.matchAll(/^(\w+)\s+(\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
  const pressure = {};
  for (const resource of ['cpu', 'memory', 'io']) {
    const text = readText(path.join(cgroup, `${resource}.pressure`));
    const some = Number(text.match(/^some\s+avg10=([0-9.]+)/m)?.[1] || 0);
    const full = Number(text.match(/^full\s+avg10=([0-9.]+)/m)?.[1] || 0);
    pressure[resource] = { someAvg10: some, fullAvg10: full };
  }
  const pids = readText(path.join(cgroup, 'cgroup.procs'))
    .split(/\s+/)
    .map(Number)
    .filter(Boolean);
  return {
    pids,
    rssBytes: Number.isFinite(memoryCurrent) ? memoryCurrent : 0,
    cpuTicks: Number.isFinite(usageUsec) ? usageUsec / (1000000 / CLK_TCK) : 0,
    source: 'cgroup',
    memoryEvents,
    pressure,
    nrThrottled,
    throttledUsec,
  };
}

function windowsProcessMetrics(pid) {
  const powershell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
  const result = spawnSync(powershell, [
    '-NoProfile',
    '-Command',
    `$root=${Number(pid)}; $all=Get-CimInstance Win32_Process; $ids=@($root); $changed=$true; while($changed){ $changed=$false; foreach($p in $all){ if($ids -contains [int]$p.ParentProcessId -and -not ($ids -contains [int]$p.ProcessId)){ $ids += [int]$p.ProcessId; $changed=$true } } }; $sum=0; foreach($id in $ids){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){ $sum += $p.WorkingSet64 } }; [Console]::WriteLine("{0} {1}", $sum, ($ids -join ','))`,
  ], { encoding: 'utf8', windowsHide: true });
  const [rss, pidList] = String(result.stdout || '').trim().split(/\s+/, 2);
  return {
    rssBytes: Number(rss) || 0,
    cpuTicks: 0,
    pids: String(pidList || '').split(',').map(Number).filter(Boolean),
    source: 'process-tree',
  };
}

function processTreeMetrics({ pid, unit, cacheKey }) {
  const key = cacheKey || `${pid || 0}:${unit || ''}`;
  const now = Date.now();
  const previous = cache.get(key);
  if (previous && now - previous.sampledAt < 1200) return previous.payload;
  let sample = null;
  if (process.platform === 'linux') {
    sample = linuxCgroupMetrics(unit);
    if (!sample && pid) {
      const pids = linuxChildren(pid);
      const totals = pids.map(linuxProcMetrics).filter(Boolean).reduce((acc, item) => ({
        rssBytes: acc.rssBytes + item.rssBytes,
        cpuTicks: acc.cpuTicks + item.cpuTicks,
      }), { rssBytes: 0, cpuTicks: 0 });
      sample = { ...totals, pids, source: 'process-tree' };
    }
  } else if (process.platform === 'win32' && pid) {
    sample = windowsProcessMetrics(pid);
  }
  sample ||= { rssBytes: 0, cpuTicks: 0, pids: pid ? [pid] : [], source: 'unavailable' };
  let cpuPercent = 0;
  if (previous?.raw && sample.cpuTicks >= previous.raw.cpuTicks) {
    const elapsed = Math.max(1, now - previous.sampledAt) / 1000;
    cpuPercent = Math.round(((sample.cpuTicks - previous.raw.cpuTicks) / CLK_TCK / elapsed) * 100);
  }
  const payload = {
    pid: pid || null,
    pids: sample.pids || [],
    rssMb: Math.round((sample.rssBytes || 0) / 1024 / 1024),
    cpuPercent: Math.max(0, Math.min(999, cpuPercent)),
    source: sample.source,
    memoryEvents: sample.memoryEvents || {},
    pressure: sample.pressure || {},
    nrThrottled: Number(sample.nrThrottled || 0),
    throttledUsec: Number(sample.throttledUsec || 0),
  };
  cache.set(key, { sampledAt: now, raw: sample, payload });
  return payload;
}

module.exports = { processTreeMetrics };
