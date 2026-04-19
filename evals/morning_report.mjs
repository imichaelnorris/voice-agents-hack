#!/usr/bin/env node
// Summarize what the overnight queue produced. Reads
// evals/rounds/overnight.jsonl + every per-variant breakdown file and
// emits a compact human-readable status report.
//
// Usage: node evals/morning_report.mjs

import fs from 'node:fs';
import path from 'node:path';

const REPO = '/Users/michael/github/voice-agents-hack';
const SUMMARY = path.join(REPO, 'evals/rounds/overnight.jsonl');

if (!fs.existsSync(SUMMARY)) {
  console.log('no overnight log yet at', SUMMARY);
  process.exit(0);
}

const events = fs
  .readFileSync(SUMMARY, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(l => JSON.parse(l));

console.log('=== overnight summary ===');
const start = events.find(e => e.stage === 'start');
const finish = events.find(e => e.stage === 'finish');
const dones = events.filter(e => e.stage === 'done');
const fails = events.filter(e => e.ok === false);

if (start) console.log(`started: ${start.ts}, queue size: ${start.queue}`);
if (finish) console.log(`finished: ${finish.ts}`);
console.log(`hills completed: ${dones.length}`);
console.log(`hills failed: ${fails.length}`);

// Per-concept best variant table.
console.log('\n=== per-hill best variant (sorted by improvement over baseline) ===');
console.log('hill'.padEnd(28) + 'baseline'.padEnd(12) + 'best'.padEnd(20) + 'best_pct'.padEnd(12) + 'delta');
const rows = [];
for (const d of dones) {
  const pv = d.perVariant ?? {};
  const v0 = pv.v0_baseline?.pct ?? null;
  let best = null;
  let bestPct = -1;
  for (const [vn, v] of Object.entries(pv)) {
    if (typeof v?.pct === 'number' && v.pct > bestPct) {
      bestPct = v.pct;
      best = vn;
    }
  }
  const delta = v0 != null && bestPct >= 0 ? bestPct - v0 : null;
  const name = path.basename(d.spec, '.json');
  rows.push({ name, v0, best, bestPct, delta });
}
rows.sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
for (const r of rows) {
  const v0s = r.v0 == null ? '-' : (r.v0 * 100).toFixed(0) + '%';
  const bs = r.bestPct < 0 ? '-' : (r.bestPct * 100).toFixed(0) + '%';
  const ds = r.delta == null ? '-' : (r.delta >= 0 ? '+' : '') + (r.delta * 100).toFixed(0) + 'pp';
  console.log(r.name.padEnd(28) + v0s.padEnd(12) + (r.best ?? '-').padEnd(20) + bs.padEnd(12) + ds);
}

if (fails.length > 0) {
  console.log('\n=== failures ===');
  for (const f of fails) {
    console.log(`- ${f.stage} on ${f.spec}: ${(f.stderr ?? '').slice(0, 200)}`);
  }
}

console.log('\n=== next steps for resume ===');
console.log('1. Review per-hill best variants above. A "delta" of >+10pp suggests a real win (vs ~±10pp single-batch noise at n=10).');
console.log('2. For wins, confirm with a second hill run (re-queue with -r3 suffix in queue.json).');
console.log('3. To lock a winner, append the winning variant\'s edit (rule/snippet/reference) to evals/prompts/p0.txt → p1.txt; run a fresh full baseline against p1.');
console.log('4. Per-row per-variant raw is at evals/raw/<hill>-<variant>.jsonl — re-score or hand-inspect.');
