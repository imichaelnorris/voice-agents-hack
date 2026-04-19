#!/usr/bin/env node
// Recover per-variant pass-rates from a hill's raw JSONL by parsing the
// variant prefix out of each row's `id` (e.g. "v2_snippet-r7" → "v2_snippet").
// Used because run_cactus.py drops extra fields like `variant` from the
// input batch, so the grouping done at append-time was useless.
//
// Usage: node evals/rescore_by_variant.mjs evals/raw/hill-<concept>-r<N>.jsonl

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('usage: rescore_by_variant.mjs <hill-results.jsonl>');
  process.exit(2);
}

const SHADER_TMP = path.join(os.tmpdir(), `rescore-${process.pid}.frag`);

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

const inPath = args[0];
const rows = fs.readFileSync(inPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// Variant = prefix of id up to "-r<digit>".
function variantOf(id) {
  const m = String(id ?? '').match(/^(.+?)-r\d+$/);
  return m ? m[1] : 'unknown';
}

const byVariant = new Map();
for (const r of rows) {
  const v = variantOf(r.id);
  if (!byVariant.has(v)) byVariant.set(v, { pass: 0, total: 0, fail_modes: {}, fails: [] });
  const b = byVariant.get(v);
  b.total += 1;
  const cls = classify(r);
  if (cls.kind === 'pass') b.pass += 1;
  else {
    b.fail_modes[cls.detail] = (b.fail_modes[cls.detail] ?? 0) + 1;
    b.fails.push({ id: r.id, kind: cls.kind, detail: cls.detail });
  }
}

const summary = {};
const variants = [...byVariant.keys()].sort();
let allPass = 0, allTotal = 0;
for (const v of variants) {
  const b = byVariant.get(v);
  summary[v] = {
    pass: b.pass,
    total: b.total,
    pct: b.total ? b.pass / b.total : 0,
    fail_modes: b.fail_modes,
  };
  allPass += b.pass;
  allTotal += b.total;
}

const out = {
  source: inPath,
  rows: rows.length,
  overall: { pass: allPass, total: allTotal, pct: allTotal ? allPass / allTotal : 0 },
  by_variant: summary,
};

console.log(JSON.stringify(out, null, 2));
