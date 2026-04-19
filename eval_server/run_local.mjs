#!/usr/bin/env node
// Run a batch of prompts through a local Ollama model. Same input/output
// format as run_batch.mjs (which targets the phone), so analyze.mjs can
// score the results uniformly.
//
// Usage:
//   ollama serve  # in another terminal
//   node eval_server/run_local.mjs <batch.json> [--model gemma4:e2b] [--out file.jsonl]

import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('usage: run_local.mjs <batch.json> [--model NAME] [--out file.jsonl] [--ollama URL]');
  process.exit(2);
}
const batchPath = args[0];
const model = ((i = args.indexOf('--model')) => i !== -1 ? args[i + 1] : 'gemma4:e2b')();
const outPath = ((i = args.indexOf('--out')) => i !== -1 ? args[i + 1] : batchPath.replace(/\.json$/, '') + `.${model.replace(/[:/]/g, '_')}.results.jsonl`)();
const ollamaUrl = ((i = args.indexOf('--ollama')) => i !== -1 ? args[i + 1] : 'http://localhost:11434')();

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const prompts = Array.isArray(batch.prompts) ? batch.prompts : [];
if (prompts.length === 0) { console.error('no prompts'); process.exit(2); }

const out = fs.createWriteStream(outPath, { flags: 'w' });
console.log(`[local] ${prompts.length} prompts → ${model} via ${ollamaUrl}`);
console.log(`[local] writing to ${outPath}`);

const startedAt = Date.now();
let pass = 0, fail = 0;
for (const p of prompts) {
  const id = p.id ?? `${p.label ?? 'p'}-${Math.random().toString(36).slice(2, 8)}`;
  const systemPrompt = p.systemPrompt ?? batch.systemPrompt;
  const reqOptions = p.options ?? batch.options ?? {};
  const tStart = Date.now();
  let response = null, error = null;
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        prompt: p.prompt,
        stream: false,
        options: {
          temperature: reqOptions.temperature ?? 0.7,
          num_predict: reqOptions.maxTokens ?? 1024,
        },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const data = await res.json();
    response = data.response;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - tStart;
  const rec = {
    id,
    label: p.label,
    prompt: p.prompt,
    systemPrompt,
    response,
    error,
    durationMs,
    receivedAt: Date.now(),
  };
  out.write(JSON.stringify(rec) + '\n');
  const tag = error ? 'err' : 'ok ';
  const preview = (response ?? error ?? '').slice(0, 80).replace(/\n/g, '↵');
  console.log(`[${tag}] ${id} (${(durationMs / 1000).toFixed(1)}s) ${preview}`);
  if (error) fail++; else pass++;
}
out.end();
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`[local] done — ${pass} ok, ${fail} err in ${elapsed}s → ${outPath}`);
