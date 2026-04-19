#!/usr/bin/env node
// PSTACK round builder: given a current system prompt, a target concept,
// the user prompts for that concept, and a list of variant edits, emit
// a batch JSON ready for run_cactus.py.
//
// Usage:
//   node evals/build_round.mjs \
//     --prompt evals/prompts/p0.txt \
//     --concept thermal \
//     --user-prompt "render it as a thermal camera image..." \
//     --runs 10 \
//     --variants evals/prompts/round-N-variants.json \
//     --out evals/rounds/round-N-batch.json
//
// variants.json shape:
//   {
//     "label": "thermal",
//     "user_prompt": "...",                         // the eval prompt
//     "variants": [
//       { "id": "v0_baseline", "system_prompt": "..." },
//       { "id": "v1_rule",     "system_prompt": "..." },
//       { "id": "v2_snippet",  "system_prompt": "..." },
//       ...
//     ]
//   }

import fs from 'node:fs';

const args = process.argv.slice(2);
function arg(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : fallback;
}

const variantsPath = arg('--variants');
const out = arg('--out');
const runs = Number(arg('--runs', '10'));

if (!variantsPath || !out) {
  console.error('usage: build_round.mjs --variants FILE --out FILE [--runs N]');
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(variantsPath, 'utf8'));
const prompts = [];
for (const v of spec.variants) {
  for (let i = 1; i <= runs; i++) {
    prompts.push({
      id: `${v.id}-r${i}`,
      label: spec.label,
      variant: v.id,
      prompt: spec.user_prompt,
      systemPrompt: v.system_prompt,
    });
  }
}

const batch = {
  _comment: `PSTACK hill: concept=${spec.label}, ${spec.variants.length} variants × ${runs} runs = ${prompts.length} inferences.`,
  options: { temperature: 0.7, maxTokens: 1024 },
  prompts,
};

fs.writeFileSync(out, JSON.stringify(batch, null, 2));
console.log(`wrote ${out}: ${prompts.length} prompts, ${spec.variants.length} variants`);
