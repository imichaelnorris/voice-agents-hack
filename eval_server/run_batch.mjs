#!/usr/bin/env node
// Push a batch of prompts to the eval server and wait for results.
//
// Usage:
//   node eval_server/run_batch.mjs <batch.json> [--out results.jsonl] [--server http://localhost:9000] [--gap 0]
//
// --gap N enqueues prompts one at a time with N seconds of waiting after each
// completion. Useful when the phone is thermally throttling — pacing inferences
// gives the SoC time to dissipate heat between runs.
//
// Batch JSON shape:
//   {
//     "systemPrompt": "...",            // optional default for every prompt
//     "options": { "temperature": 0.2, "maxTokens": 1024 },
//     "prompts": [
//       { "id": "underwater-r1", "label": "underwater", "prompt": "make it ..." },
//       { "id": "underwater-r2", "label": "underwater", "prompt": "make it ...",
//         "systemPrompt": "override for this row only" }
//     ]
//   }
//
// Results are written one JSON-line per row, including the original prompt
// metadata so they're self-contained for downstream analysis.

import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('usage: run_batch.mjs <batch.json> [--out results.jsonl] [--server URL]');
  process.exit(2);
}
const batchPath = args[0];
const outPath = (() => {
  const i = args.indexOf('--out');
  return i !== -1 ? args[i + 1] : batchPath.replace(/\.json$/, '') + '.results.jsonl';
})();
const server = (() => {
  const i = args.indexOf('--server');
  return i !== -1 ? args[i + 1] : 'http://localhost:9000';
})();
const gapSec = (() => {
  const i = args.indexOf('--gap');
  return i !== -1 ? Number(args[i + 1]) || 0 : 0;
})();

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const prompts = Array.isArray(batch.prompts) ? batch.prompts : [];
if (prompts.length === 0) {
  console.error('no prompts in batch');
  process.exit(2);
}

// Server tags every result with the same id we send. Build a map so we can
// fold the original metadata back into each result line.
const meta = new Map();
for (const p of prompts) {
  if (!p.id) p.id = `${p.label ?? 'p'}-${Math.random().toString(36).slice(2, 8)}`;
  meta.set(p.id, p);
}

console.log(`[batch] ${prompts.length} prompts → ${server}`);

async function check() {
  const res = await fetch(`${server}/status`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

const status = await check();
console.log(`[server] connected=${status.connected} queued=${status.queued} inFlight=${status.inFlight}`);
if (!status.connected) {
  console.error('[server] no phone connected — start client mode in the app first');
  process.exit(1);
}

const out = fs.createWriteStream(outPath, { flags: 'w' });
console.log(`[batch] writing results to ${outPath}`);
const seen = new Set();
const startedAt = Date.now();

async function recordIfNew(rec) {
  if (!rec || seen.has(rec.id)) return false;
  seen.add(rec.id);
  const m = meta.get(rec.id) ?? {};
  const merged = {
    id: rec.id,
    label: m.label,
    prompt: m.prompt,
    systemPrompt: m.systemPrompt ?? batch.systemPrompt,
    response: rec.response,
    error: rec.error,
    durationMs: rec.durationMs,
    receivedAt: rec.receivedAt,
  };
  out.write(JSON.stringify(merged) + '\n');
  const tag = rec.error ? 'err' : 'ok ';
  const preview = (rec.response ?? rec.error ?? '').slice(0, 80).replace(/\n/g, '↵');
  console.log(`[${tag}] ${rec.id} (${rec.durationMs}ms) ${preview}`);
  return true;
}

async function pollOnce() {
  const res = await fetch(`${server}/results`);
  if (res.status === 204) return;
  const text = await res.text();
  for (const line of text.split('\n').filter(Boolean)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    await recordIfNew(rec);
  }
}

if (gapSec > 0) {
  // Paced mode: enqueue one prompt, wait for its result, sleep `gap` seconds,
  // then enqueue the next. Lets the phone's SoC cool between inferences.
  console.log(`[batch] paced mode: ${gapSec}s gap between prompts`);
  for (const p of prompts) {
    const enqRes = await fetch(`${server}/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: batch.systemPrompt,
        options: batch.options,
        prompts: [p],
      }),
    });
    if (!enqRes.ok) {
      console.error(`[server] enqueue failed for ${p.id}: ${enqRes.status}`);
      continue;
    }
    while (!seen.has(p.id)) {
      await new Promise(r => setTimeout(r, 1500));
      await pollOnce();
    }
    if (gapSec > 0) {
      console.log(`[batch] sleeping ${gapSec}s for thermal cooldown...`);
      await new Promise(r => setTimeout(r, gapSec * 1000));
    }
  }
} else {
  // Burst mode: dump everything into the queue, poll until all back.
  const enqRes = await fetch(`${server}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemPrompt: batch.systemPrompt,
      options: batch.options,
      prompts,
    }),
  });
  if (!enqRes.ok) {
    console.error(`[server] enqueue failed: ${enqRes.status} ${await enqRes.text()}`);
    process.exit(1);
  }
  console.log('[server]', await enqRes.json());
  while (seen.size < prompts.length) {
    await new Promise(r => setTimeout(r, 1500));
    await pollOnce();
  }
}

out.end();
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`[batch] done — ${seen.size}/${prompts.length} results in ${elapsed}s`);
