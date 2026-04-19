#!/usr/bin/env node
// Generate a per-concept hill-climb batch JSON from a compact spec.
// Avoids the giant copy-pasted hand-written JSON files.
//
// Usage:
//   node eval_server/make_hill.mjs <spec.mjs> > eval_server/batches/<name>.json
//
// Spec module exports default { runs, options, prompt, variants: [{ id, systemPrompt, prompt? }] }

import fs from 'node:fs';
import path from 'node:path';

if (process.argv.length < 3) {
  console.error('usage: make_hill.mjs <spec.mjs>');
  process.exit(2);
}
const specPath = path.resolve(process.argv[2]);
const spec = (await import(specPath)).default;
if (!spec?.variants?.length) {
  console.error('spec must export default { variants: [{ id, systemPrompt, prompt? }, ...], runs, prompt, options }');
  process.exit(2);
}

const runs = spec.runs ?? 10;
const prompts = [];
for (const v of spec.variants) {
  for (let i = 1; i <= runs; i++) {
    prompts.push({
      id: `${v.id}-r${i}`,
      label: v.id,
      prompt: v.prompt ?? spec.prompt,
      systemPrompt: v.systemPrompt,
    });
  }
}

const out = {
  _comment: spec.comment ?? '',
  options: spec.options ?? { temperature: 0.7, maxTokens: 1024 },
  prompts,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
