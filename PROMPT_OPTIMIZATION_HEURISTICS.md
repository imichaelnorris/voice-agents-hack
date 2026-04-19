# Heuristics for optimizing prompts on a small on-device model

Distilled from running ~5 rounds of system-prompt iteration against
`gemma-4-e2b-it` (INT4) for GLSL shader generation. None of these
were obvious going in; each cost real cycles to learn.

The setup these were learned in: ~50-prompt benchmark of 10 concepts × 5
runs, scored by real GLSL compile via `glslangValidator`. Mac runs the
same INT4 weights as the phone via Cactus's Python build.

## What works

1. **Show, don't tell.** A 4-line code snippet showing the correct
   pattern beats any prose rule, no matter how explicit. The model
   regurgitates the snippet line-for-line into the output. Pixelate
   went 30% → 100% with a 4-line snippet; the same prose rule got 20%.

2. **Pick the concept with the loudest failure first.** Concepts that
   are already at 4–5/5 have no headroom — interventions can only
   match. Hill-climbing the worst concept (1–3/5) is where every
   intervention hour goes.

3. **Always include a baseline (V0) variant in every per-concept hill.**
   Sampling noise at temperature 0.7 is real. You need V0 in the same
   batch to know whether your "improvement" is signal or just luck.

4. **Validate stacked changes against the full benchmark.** Edits that
   fix one concept can quietly hurt another (the new snippet biases
   structure for everything). One full-batch run after each lock-in is
   non-negotiable.

5. **Coordinate descent over the system prompt.** Lock one concept's
   fix, move to the next. Don't try to rebalance the whole prompt at
   once — Round 4 burned three full rounds doing that and netted ±0.

## What doesn't work

1. **Declarative rules in prose.** "Never assign a scalar to a vec3"
   is in the prompt, the model writes `vec3 r = color.r;` two lines
   below. Rules cost tokens for no measurable benefit — and may
   actively hurt by lengthening the prompt and biasing the model
   toward more elaborate (and more error-prone) code.

2. **Sample size of 5 per variant at temperature 0.7.** The natural
   sampling variance is ±2/5 for any prompt — you cannot distinguish
   real effects from noise. Use 10 minimum.

3. **Combining multiple changes in one variant.** If "rules + example"
   wins, you can't attribute the effect. One change per variant or
   the data is uninterpretable.

4. **Optimizing on a model that's not the deployment target.** Ollama
   `gemma4:e2b` (full precision) gets ~85% on the same prompts;
   Cactus INT4 gets 68%. Same architecture, different weights, very
   different failure rates. Iterate on the precision the user will run.

5. **Broad full-batch sweeps for prompt-edit search.** A 50-prompt
   benchmark gives you one number per round and 17 minutes per round.
   For search you want 5 variants × 10 runs of ONE concept (50
   inferences, ~10 min, 5× more decision-relevant data).

## Process recipe

```
for each concept worth optimizing (sorted by gap from ceiling):
  spec = generate 5 variants:
    V0 = baseline system prompt              (control — required)
    V1 = baseline + declarative rule         (usually loses; baseline)
    V2 = baseline + 4–7 line snippet         (usually wins)
    V3 = baseline + full reference shader    (matches V2; expensive)
    V4 = rephrased user prompt with the algo (sometimes wins; can't always rephrase)
  run spec × 10 runs each → 50 inferences (~10 min on Cactus Mac)
  pick winner by compile-pass rate; tie-break on token cost
  stack winner onto global system prompt
  full-batch re-validate (50 prompts) to catch cross-concept regressions
  if no regressions, lock into App.tsx's SHADER_SYSTEM_PROMPT
```

## Open questions / where this breaks

- **Token budget**: stacking N concept-specific snippets is O(N) tokens
  on every inference. Doesn't scale past ~5 concepts before prefill
  cost dominates demo latency. Need per-request snippet routing.
- **Same-shape bias**: a single example biases the model toward its
  structure for *all* concepts. Two diverse examples helps. We haven't
  measured how this scales.
- **Mac → phone transfer**: the iteration loop runs on Mac CPU with
  the same INT4 weights, but the phone runs the Apple Neural Engine
  variant. The compile-rate gap (Mac 68%, phone 54% on baseline) means
  numbers don't transfer 1:1 — only the ordering of variants is
  expected to. Validate winners on-device periodically.
- **Compile pass vs visual correctness**: glslang catches 100% of
  compile bugs but says nothing about whether the output looks like
  what was asked. Need a render+judge pipeline for the second metric.
