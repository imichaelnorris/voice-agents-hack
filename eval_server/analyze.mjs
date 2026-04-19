#!/usr/bin/env node
// Analyze a batch of eval results: tally pass/fail per concept, classify
// failure modes, and dump a per-row table.
//
// Usage: node eval_server/analyze.mjs <results.jsonl> [<more.jsonl> ...]

import fs from 'node:fs';

if (process.argv.length < 3) {
  console.error('usage: analyze.mjs <results.jsonl> [...]');
  process.exit(2);
}

const rows = [];
for (const path of process.argv.slice(2)) {
  for (const line of fs.readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    rows.push(JSON.parse(line));
  }
}

// Cheap "compile-look" checks. None of these prove the shader compiles, but
// each false on a real-world shader is a strong signal something's off.
const CHECKS = [
  ['has_main',          r => /\bvoid\s+main\s*\(/m.test(r.response ?? '')],
  ['writes_gl_FragColor', r => /gl_FragColor\s*=/m.test(r.response ?? '')],
  ['has_precision',     r => /\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/m.test(r.response ?? '')],
  ['samples_u_texture', r => /texture2D\s*\(\s*u_texture\s*,/m.test(r.response ?? '')],
  ['no_md_fences',      r => !/```/.test(r.response ?? '')],
  ['nontrivial_length', r => (r.response ?? '').length >= 80],
];

function classify(row) {
  if (row.error) return { kind: 'native_error', detail: row.error.slice(0, 100) };
  const failed = CHECKS.filter(([_, fn]) => !fn(row)).map(([name]) => name);
  if (failed.length === 0) return { kind: 'pass', detail: '' };
  return { kind: 'shape_fail', detail: failed.join(',') };
}

const byConcept = new Map();
for (const r of rows) {
  const cls = classify(r);
  const key = r.label ?? 'unknown';
  if (!byConcept.has(key)) byConcept.set(key, { rows: [], pass: 0, fail: 0, fail_modes: new Map() });
  const bucket = byConcept.get(key);
  bucket.rows.push({ id: r.id, ...cls, durationMs: r.durationMs });
  if (cls.kind === 'pass') bucket.pass++;
  else {
    bucket.fail++;
    const m = bucket.fail_modes;
    m.set(cls.detail, (m.get(cls.detail) ?? 0) + 1);
  }
}

const concepts = [...byConcept.keys()].sort();
let totalPass = 0, totalFail = 0;
console.log('\n== per-concept summary ==');
console.log('concept'.padEnd(12) + 'pass/total  failure-modes');
for (const c of concepts) {
  const b = byConcept.get(c);
  const total = b.pass + b.fail;
  totalPass += b.pass;
  totalFail += b.fail;
  const modes = [...b.fail_modes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${n}× ${m}`)
    .join('  |  ');
  console.log(`${c.padEnd(12)}${b.pass}/${total}        ${modes}`);
}
console.log(`\noverall: ${totalPass}/${totalPass + totalFail} (${((totalPass / (totalPass + totalFail)) * 100).toFixed(1)}%)`);

console.log('\n== per-row ==');
console.log('id'.padEnd(18) + 'kind'.padEnd(14) + 'duration  detail');
for (const c of concepts) {
  for (const r of byConcept.get(c).rows) {
    const ms = r.durationMs == null ? '—' : `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`${r.id.padEnd(18)}${r.kind.padEnd(14)}${ms.padStart(7)}   ${r.detail}`);
  }
}
