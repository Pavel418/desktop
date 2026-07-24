// Resource monitor: samples RAM and CPU of the Node script itself and of a Chrome process
// TREE (the browser PID plus all its descendants — Chrome spawns many renderer/GPU/utility
// children) at a fixed interval, logs a periodic snapshot, and returns a peak/average summary
// at stop().
//
// CPU is reported top-style: 100% = one CPU core fully used, so a busy multi-process Chrome tree
// can legitimately exceed 100%. RAM is resident set (working set) in MB.

import os from 'node:os';
import { execFile } from 'node:child_process';

function execFileAsync(cmd, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ err, stdout: String(stdout || '') });
    });
  });
}

const MB = 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;

// Parse a POSIX `ps` TIME field (e.g. "12:34", "1:02:03", "3-01:02:03") into seconds.
export function parsePosixCpuTime(field) {
  const s = String(field || '').trim();
  if (!s) return 0;
  let days = 0;
  let rest = s;
  const dash = s.indexOf('-');
  if (dash >= 0) {
    days = Number(s.slice(0, dash)) || 0;
    rest = s.slice(dash + 1);
  }
  const parts = rest.split(':').map((p) => Number(p) || 0);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return days * 86_400 + secs;
}

// Format a resource snapshot into one compact, human-readable line.
export function formatUsage(u) {
  if (!u) return 'resource: (no sample yet)';
  const chrome = u.chrome
    ? `chrome ${round1(u.chrome.rssMB)}MB / ${round1(u.chrome.cpuPct)}% (${u.chrome.procs} proc)`
    : 'chrome n/a';
  const script = `script ${round1(u.script.rssMB)}MB / ${round1(u.script.cpuPct)}%`;
  return `RAM+CPU — ${chrome} · ${script} · [100% = 1 core]`;
}

// Build the end-of-run summary line from aggregates.
export function formatSummary(agg) {
  const dur = Math.round((agg.lastTs - agg.startTs) / 1000);
  const chrome = agg.chrome.samples
    ? `chrome peak ${round1(agg.chrome.peakRssMB)}MB / avg ${round1(agg.chrome.sumRssMB / agg.chrome.samples)}MB RAM, ` +
      `peak ${round1(agg.chrome.peakCpuPct)}% / avg ${round1(agg.chrome.sumCpuPct / agg.chrome.samples)}% CPU`
    : 'chrome: no samples';
  const script = agg.script.samples
    ? `script peak ${round1(agg.script.peakRssMB)}MB / avg ${round1(agg.script.sumRssMB / agg.script.samples)}MB RAM, ` +
      `peak ${round1(agg.script.peakCpuPct)}% / avg ${round1(agg.script.sumCpuPct / agg.script.samples)}% CPU`
    : 'script: no samples';
  return `resource summary over ${dur}s (${agg.chrome.samples} samples) — ${chrome}; ${script} · [100% = 1 core]`;
}

export class ResourceMonitor {
  constructor({ chromePid = null, log = () => {}, intervalMs = 15_000, label = '📊' } = {}) {
    this.chromePid = chromePid;
    this.log = typeof log === 'function' ? log : () => {};
    this.intervalMs = Math.max(2_000, Number(intervalMs) || 15_000);
    this.label = label;
    this.cores = Math.max(1, os.cpus()?.length || 1);
    this.timer = null;
    this.latest = null;

    // Baselines for CPU-delta computation.
    this._scriptCpuPrev = process.cpuUsage(); // microseconds {user, system}
    this._scriptTsPrev = Date.now();
    this._chromeCpuPrev = null; // total processor seconds across the tree
    this._chromeTsPrev = null;

    this.agg = {
      startTs: Date.now(),
      lastTs: Date.now(),
      chrome: { samples: 0, peakRssMB: 0, sumRssMB: 0, peakCpuPct: 0, sumCpuPct: 0 },
      script: { samples: 0, peakRssMB: 0, sumRssMB: 0, peakCpuPct: 0, sumCpuPct: 0 }
    };
  }

  // Total CPU seconds + resident bytes for the Chrome tree rooted at chromePid.
  async _sampleChromeTree() {
    if (!this.chromePid) return null;
    if (process.platform === 'win32') return this._sampleChromeWindows();
    return this._sampleChromePosix();
  }

  async _sampleChromeWindows() {
    // One PowerShell pass: walk Win32_Process by ParentProcessId to collect the descendant set,
    // then sum working-set bytes and total processor seconds for those PIDs.
    const script = `
$root = ${Number(this.chromePid)}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId); $changed = $true
    }
  }
}
$rss = [double]0
foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $rss += [double]$p.WorkingSetSize } }
$cpu = [double]0
foreach ($id in $ids) { try { $cpu += (Get-Process -Id $id -ErrorAction Stop).CPU } catch {} }
[pscustomobject]@{ rss = $rss; cpuSeconds = $cpu; procs = $ids.Count } | ConvertTo-Json -Compress`;
    const { err, stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 12_000 }
    );
    if (err) return null;
    try {
      const o = JSON.parse(stdout.trim());
      return { rssBytes: Number(o.rss) || 0, cpuSeconds: Number(o.cpuSeconds) || 0, procs: Number(o.procs) || 0 };
    } catch {
      return null;
    }
  }

  async _sampleChromePosix() {
    const { err, stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,rss=,time='], { timeoutMs: 8_000 });
    if (err) return null;
    const rows = [];
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), cpu: parsePosixCpuTime(m[4]) });
    }
    const ids = new Set([Number(this.chromePid)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of rows) {
        if (ids.has(r.ppid) && !ids.has(r.pid)) { ids.add(r.pid); changed = true; }
      }
    }
    let rssBytes = 0;
    let cpuSeconds = 0;
    let procs = 0;
    for (const r of rows) {
      if (ids.has(r.pid)) { rssBytes += r.rssKB * 1024; cpuSeconds += r.cpu; procs += 1; }
    }
    return { rssBytes, cpuSeconds, procs };
  }

  // Take one sample, update aggregates, store as `latest`, and return it.
  async sample() {
    const now = Date.now();

    // Script CPU%: delta of this process's own CPU microseconds over wall-clock, top-style.
    const cpuNow = process.cpuUsage();
    const scriptCpuUs = (cpuNow.user - this._scriptCpuPrev.user) + (cpuNow.system - this._scriptCpuPrev.system);
    const scriptWallMs = Math.max(1, now - this._scriptTsPrev);
    const scriptCpuPct = (scriptCpuUs / 1000 / scriptWallMs) * 100;
    this._scriptCpuPrev = cpuNow;
    this._scriptTsPrev = now;
    const scriptRssMB = process.memoryUsage().rss / MB;

    let chrome = null;
    const tree = await this._sampleChromeTree();
    if (tree) {
      let chromeCpuPct = 0;
      if (this._chromeCpuPrev != null && this._chromeTsPrev != null) {
        const wallSec = Math.max(0.001, (now - this._chromeTsPrev) / 1000);
        chromeCpuPct = Math.max(0, (tree.cpuSeconds - this._chromeCpuPrev) / wallSec * 100);
      }
      this._chromeCpuPrev = tree.cpuSeconds;
      this._chromeTsPrev = now;
      chrome = { rssMB: tree.rssBytes / MB, cpuPct: chromeCpuPct, procs: tree.procs };
    }

    const usage = { ts: now, script: { rssMB: scriptRssMB, cpuPct: scriptCpuPct }, chrome };
    this.latest = usage;
    this.agg.lastTs = now;
    this._accumulate('script', usage.script);
    if (chrome) this._accumulate('chrome', chrome);
    return usage;
  }

  _accumulate(which, s) {
    const a = this.agg[which];
    a.samples += 1;
    a.sumRssMB += s.rssMB;
    a.sumCpuPct += s.cpuPct;
    if (s.rssMB > a.peakRssMB) a.peakRssMB = s.rssMB;
    if (s.cpuPct > a.peakCpuPct) a.peakCpuPct = s.cpuPct;
  }

  start() {
    if (this.timer) return this;
    // Seed CPU baselines with an immediate sample (its CPU% is meaningless but it primes deltas).
    this.sample().catch(() => {});
    this.timer = setInterval(() => {
      this.sample()
        .then((u) => this.log(`${this.label} ${formatUsage(u)}`))
        .catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  // Latest cached snapshot formatted for inline appending (no new sample taken).
  format() {
    return formatUsage(this.latest);
  }

  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.sample().catch(() => {});
    const summary = formatSummary(this.agg);
    this.log(`${this.label} ${summary}`);
    return { summary, agg: this.agg, latest: this.latest };
  }
}
