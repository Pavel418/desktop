import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePosixCpuTime, formatUsage, formatSummary, ResourceMonitor } from '../resource-monitor.mjs';

test('parsePosixCpuTime parses mm:ss, hh:mm:ss, and d-hh:mm:ss', () => {
  assert.equal(parsePosixCpuTime('00:00'), 0);
  assert.equal(parsePosixCpuTime('12:34'), 12 * 60 + 34);
  assert.equal(parsePosixCpuTime('1:02:03'), 3600 + 2 * 60 + 3);
  assert.equal(parsePosixCpuTime('3-01:00:00'), 3 * 86_400 + 3600);
  assert.equal(parsePosixCpuTime(''), 0);
});

test('formatUsage renders chrome + script, and tolerates a missing chrome sample', () => {
  const withChrome = formatUsage({
    ts: 0,
    script: { rssMB: 210.44, cpuPct: 12.34 },
    chrome: { rssMB: 1234.5, cpuPct: 145.6, procs: 18 }
  });
  assert.match(withChrome, /chrome 1234\.5MB \/ 145\.6% \(18 proc\)/);
  assert.match(withChrome, /script 210\.4MB \/ 12\.3%/);

  const noChrome = formatUsage({ ts: 0, script: { rssMB: 50, cpuPct: 1 }, chrome: null });
  assert.match(noChrome, /chrome n\/a/);
  assert.equal(formatUsage(null), 'resource: (no sample yet)');
});

test('formatSummary reports peaks and averages with sample count and duration', () => {
  const agg = {
    startTs: 1000, lastTs: 61_000,
    chrome: { samples: 2, peakRssMB: 200, sumRssMB: 300, peakCpuPct: 150, sumCpuPct: 200 },
    script: { samples: 2, peakRssMB: 40, sumRssMB: 60, peakCpuPct: 10, sumCpuPct: 14 }
  };
  const line = formatSummary(agg);
  assert.match(line, /over 60s \(2 samples\)/);
  assert.match(line, /chrome peak 200MB \/ avg 150MB RAM, peak 150% \/ avg 100% CPU/);
  assert.match(line, /script peak 40MB \/ avg 30MB RAM, peak 10% \/ avg 7% CPU/);
});

test('ResourceMonitor.sample records the script process and aggregates peaks', async () => {
  const mon = new ResourceMonitor({ chromePid: null, log: () => {}, intervalMs: 3000 });
  const u = await mon.sample();
  assert.ok(u.script.rssMB > 0, 'script RSS is measured');
  assert.equal(u.chrome, null, 'no chrome sample when chromePid is null');
  assert.equal(mon.agg.script.samples, 1);
  assert.ok(mon.agg.script.peakRssMB > 0);
});
