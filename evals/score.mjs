#!/usr/bin/env node
// PSTACK scorer: read a results.jsonl, compile each shader via
// glslangValidator, emit per-concept + overall pass rates as JSON to
// stdout. Drives the optimizer programmatically — analyze.mjs is the
// human-readable cousin of this.
//
// Usage: node evals/score.mjs <results.jsonl>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('usage: score.mjs <results.jsonl>');
  process.exit(2);
}

const SHADER_TMP = path.join(os.tmpdir(), `score-${process.pid}.frag`);

function compileGLSL(source) {
  const withVersion = /^\s*#version\s/m.test(source) ? source : '#version 100\n' + source;
  fs.writeFileSync(SHADER_TMP, withVersion);
  try {
    execFileSync('glslangValidator', ['-S', 'frag', SHADER_TMP], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { compiled: true, errors: [] };
  } catch (err) {
    const stdout = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
    const errors = stdout
      .split('\n')
      .filter(line => line.startsWith('ERROR:') && !line.includes('compilation terminated'))
      .map(line => line.replace(/^ERROR:\s*\d+:\d+:\s*/, '').trim());
    return { compiled: false, errors };
  }
}

const SHAPE_CHECKS = [
  ['has_main', r => /\bvoid\s+main\s*\(/m.test(r)],
  ['writes_gl_FragColor', r => /gl_FragColor\s*=/m.test(r)],
  ['has_precision', r => /\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/m.test(r)],
  ['samples_u_texture', r => /texture2D\s*\(\s*u_texture\s*,/m.test(r)],
  ['no_md_fences', r => !/```/.test(r)],
  ['nontrivial_length', r => r.length >= 80],
];

function classify(row) {
  if (row.error) return { kind: 'native_error', detail: String(row.error).slice(0, 100) };
  const src = row.response ?? '';
  const failedShape = SHAPE_CHECKS.filter(([, fn]) => !fn(src)).map(([n]) => n);
  if (failedShape.length > 0) return { kind: 'shape_fail', detail: failedShape.join(',') };
  const c = compileGLSL(src);
  if (!c.compiled) return { kind: 'compile_fail', detail: (c.errors[0] ?? 'unknown').slice(0, 80) };
  return { kind: 'pass', detail: '' };
}

const rows = [];
for (const p of args) {
  for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    rows.push(JSON.parse(line));
  }
}

const byConcept = new Map();
for (const r of rows) {
  const cls = classify(r);
  const key = r.label ?? r.id?.split('-')[0] ?? 'unknown';
  if (!byConcept.has(key)) byConcept.set(key, { pass: 0, total: 0, fail_modes: {} });
  const b = byConcept.get(key);
  b.total += 1;
  if (cls.kind === 'pass') b.pass += 1;
  else b.fail_modes[cls.detail] = (b.fail_modes[cls.detail] ?? 0) + 1;
}

const concepts = {};
let pass = 0, total = 0;
for (const [c, b] of byConcept.entries()) {
  concepts[c] = { pass: b.pass, total: b.total, pct: b.pass / b.total, fail_modes: b.fail_modes };
  pass += b.pass;
  total += b.total;
}

console.log(JSON.stringify({
  overall: { pass, total, pct: total > 0 ? pass / total : 0 },
  by_concept: concepts,
  rows_count: rows.length,
}, null, 2));
