#!/usr/bin/env node
// Drive the PSTACK hill-climb sequentially overnight. For each concept
// listed in evals/queue.json (in order), run a hill batch via
// run_cactus.py, score it, save the per-concept results, and append a
// summary row to evals/rounds/overnight.jsonl.
//
// Designed to run unattended: any subprocess failure is logged and
// skipped, not fatal. State written incrementally so an interrupted
// run can be resumed by editing queue.json.
//
// Usage:
//   node evals/run_overnight.mjs
//
// Queue file shape (evals/queue.json):
//   [
//     { "spec": "evals/prompts/hill-glitch.json", "out_prefix": "hill-glitch" },
//     { "spec": "evals/prompts/hill-underwater.json", "out_prefix": "hill-underwater" },
//     ...
//   ]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = '/Users/michael/github/voice-agents-hack';
const QUEUE = path.join(REPO, 'evals/queue.json');
const SUMMARY = path.join(REPO, 'evals/rounds/overnight.jsonl');
const PYTHON = `${process.env.HOME}/github/cactus/venv/bin/python`;

function logSummary(rec) {
  fs.appendFileSync(SUMMARY, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
}

function runStep(spec, outPrefix) {
  const batch = path.join(REPO, `evals/rounds/${outPrefix}-batch.json`);
  const raw = path.join(REPO, `evals/raw/${outPrefix}.jsonl`);
  const score = path.join(REPO, `evals/rounds/${outPrefix}-score.json`);

  // Build batch.
  const build = spawnSync('node', [
    path.join(REPO, 'evals/build_round.mjs'),
    '--variants', spec,
    '--out', batch,
    '--runs', '10',
  ], { encoding: 'utf8' });
  if (build.status !== 0) {
    logSummary({ stage: 'build', spec, ok: false, stderr: build.stderr });
    return;
  }

  // Run inference (this is the long step, ~10 min for 50 inferences).
  const startMs = Date.now();
  const inf = spawnSync(PYTHON, [
    path.join(REPO, 'eval_server/run_cactus.py'),
    batch,
    '--out', raw,
  ], { encoding: 'utf8', timeout: 60 * 60 * 1000 });
  const durMs = Date.now() - startMs;
  if (inf.status !== 0) {
    logSummary({ stage: 'infer', spec, ok: false, durMs, stderr: inf.stderr?.slice(-500) });
    return;
  }

  // Score.
  const sc = spawnSync('node', [path.join(REPO, 'evals/score.mjs'), raw], { encoding: 'utf8' });
  if (sc.status !== 0) {
    logSummary({ stage: 'score', spec, ok: false, stderr: sc.stderr });
    return;
  }
  fs.writeFileSync(score, sc.stdout);

  // Variant breakdown — read the raw, group by `variant` field, score per-variant.
  // The score.mjs default groups by `label` only. We re-classify per-variant
  // by piping each variant subset through the same scorer.
  const allRows = fs.readFileSync(raw, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const byVariant = {};
  for (const r of allRows) {
    const v = r.variant ?? 'unknown';
    if (!byVariant[v]) byVariant[v] = [];
    byVariant[v].push(r);
  }
  const perVariant = {};
  for (const [v, rows] of Object.entries(byVariant)) {
    const tmp = path.join(REPO, `evals/raw/${outPrefix}-${v}.jsonl`);
    fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const vsc = spawnSync('node', [path.join(REPO, 'evals/score.mjs'), tmp], { encoding: 'utf8' });
    if (vsc.status === 0) {
      perVariant[v] = JSON.parse(vsc.stdout).overall;
    } else {
      perVariant[v] = { error: vsc.stderr?.slice(-200) };
    }
  }
  const variantBreakdown = path.join(REPO, `evals/rounds/${outPrefix}-by-variant.json`);
  fs.writeFileSync(variantBreakdown, JSON.stringify(perVariant, null, 2));

  logSummary({ stage: 'done', spec, durMs, score: JSON.parse(sc.stdout).overall, perVariant });
  console.log(`[overnight] ${outPrefix} done in ${(durMs / 1000).toFixed(0)}s`);
}

const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
console.log(`[overnight] starting, ${queue.length} hills queued`);
logSummary({ stage: 'start', queue: queue.length });
for (const item of queue) {
  console.log(`[overnight] running ${item.out_prefix}`);
  runStep(path.join(REPO, item.spec), item.out_prefix);
}
console.log('[overnight] queue exhausted');
logSummary({ stage: 'finish', queue: queue.length });
