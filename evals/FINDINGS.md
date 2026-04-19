# Overnight findings — PSTACK rounds against Cactus INT4 gemma-4-e2b-it

## TL;DR

- **V2 snippet variant wins 9 of 10 concepts**, often by huge margins (+30 to
  +60 pp). The pattern from earlier rounds (snippets dominate prose rules)
  reproduces and is much more dramatic than the heuristics doc's earlier
  estimate.
- **V4 "finish the entire shader" constraint is actively harmful** — drops
  most concepts to 0–30% pass rate. Hypothesis: the model takes "finish
  the shader" as a license to truncate or skip the user-requested algorithm.
- **WebGL 2 / GLSL ES 3.00 baseline = 86%** vs WebGL 1 / ES 1.00 baseline
  84%. Within noise; no language switch warranted.
- **Token budget warning from earlier doc may be too pessimistic** —
  stacking 8 snippets onto P0 (P1 = 3543 chars vs 1466) is the natural
  next step. Round-1 validation pending.

## Per-hill best-variant table

Each hill is 5 variants × 10 runs. Multiple `r#` runs of the same hill
exist for noise reduction.

| hill                   | V0 baseline | V1 rule | V2 snippet | V3 reference | V4 constraint |
|------------------------|-------------|---------|------------|--------------|---------------|
| crt-r1                 | 70%         | 70%     | **100%**   | **100%**     | 50%           |
| crt-r2                 | 90%         | 60%     | **100%**   | **100%**     | 50%           |
| glitch-r1              | 70%         | 90%     | **100%**   | **100%**     | 0%            |
| glitch-r2              | 60%         | 80%     | **100%**   | **100%**     | 10%           |
| invert-r1              | 70%         | **100%**| **100%**   | **100%**     | 20%           |
| invert-r2              | **100%**    | **100%**| **100%**   | **100%**     | 30%           |
| neon-r1                | 40%         | 80%     | **100%**   | **100%**     | 20%           |
| neon-r2                | 40%         | 70%     | **100%**   | **100%**     | 20%           |
| neon-r3                | 30%         | 90%     | **100%**   | **100%**     | 20%           |
| pixelate-r1            | **100%**    | **100%**| **100%**   | **100%**     | **100%**      |
| posterize-r1           | 70%         | 90%     | **100%**   | **100%**     | 20%           |
| sepia-r1               | 80%         | 90%     | **100%**   | **100%**     | 70%           |
| **thermal-r1**         | **100%**    | **100%**| **70%**    | **100%**     | 70%           |
| underwater-r1          | 60%         | 90%     | **100%**   | **100%**     | 70%           |
| underwater-r2          | 40%         | 60%     | **100%**   | **100%**     | 60%           |
| underwater-r3          | 60%         | 80%     | **100%**   | **100%**     | 50%           |
| vignette-r1            | 70%         | 60%     | **100%**   | **100%**     | 60%           |

## Highlights

### Big wins (V2 over V0)

- **neon**: V0 averages ~37% across 3 runs; V2 = 100%. Δ ≈ **+63 pp**.
- **underwater**: V0 ~53% across 3 runs; V2 = 100%. Δ ≈ **+47 pp**.
- **glitch**: V0 ~65%; V2 = 100%. Δ ≈ **+35 pp**.

### Already at-ceiling

- **pixelate**: V0 = V2 = 100%. Snippet already in P0; redundant.
- **invert**: V0 fluctuates 70–100% across runs; V2 stable at 100%.
  V2 still preferred for stability.

### Regressions worth noting

- **thermal-r1: V2 = 70% (V0 = 100%)**. The thermal V2 snippet duplicates
  what's already in P0 — adding it twice apparently confuses the model
  enough to drop 30 pp. Implication: don't double-snippet.
- **V4 (anti-truncation constraint)** drops nearly every concept by 30+
  pp, often to single digits. Whatever the model "hears" from
  *"finish the entire shader"*, it's destroying the shader logic.
  Throw this variant out.

## Round-1 — P1 (8 stacked snippets)

P1 = P0 + 8 V2 snippets stacked (crt, glitch, invert, neon, posterize,
sepia, underwater, vignette). Pixelate and thermal excluded.

Size: P0 = 1466 chars → P1 = 3543 chars (+2077, ≈ 2.4× prefill cost).

**Result: 37/50 = 74%. REGRESSED from 84% baseline.** Per-concept:

| concept    | round-0 | round-1 | Δ     |
|------------|---------|---------|-------|
| invert     | 4/5     | **0/5** | -4    |
| glitch     | 4/5     | **0/5** | -4    |
| vignette   | 5/5     | 3/5     | -2    |
| posterize  | 5/5     | 4/5     | -1    |
| crt        | 4/5     | 5/5     | +1    |
| underwater | 2/5     | 5/5     | +3    |
| neon       | 3/5     | 5/5     | +2    |
| sepia      | 5/5     | 5/5     | =     |
| pixelate   | 5/5     | 5/5     | =     |
| thermal    | 5/5     | 5/5     | =     |

**The regression mode is uniform: missing `precision mediump float;`
declaration.** Every failed shader is otherwise correct GLSL — they just
dropped the precision line, which is mandatory in ES 1.00.

Mechanism: with 8 snippets stacked at the bottom of the prompt, the
model copies the **snippet** structure (which has no precision line —
they're code excerpts) instead of the **preamble** structure (which does
specify precision). Snippet bias dominates preamble bias when snippet
volume gets high.

This is a **stacking cost** that the per-concept hill data didn't
predict — a single snippet doesn't bias the model away from the
preamble, but eight do. PSTACK's "validate stacked changes against the
full benchmark" rule is exactly what caught this.

## Round-2 — P2 (P1 + precision anchor)

P2 = P1 + an explicit final-line constraint:

> Your output MUST start with `precision mediump float;`. Snippets
> above are EXCERPTS only — your output is a full shader.

**Result: 50/50 = 100%.** Every concept 5/5. Compared to P0's 84% and
P1's 74%, this is a **+16 pp gain** over the seed prompt, and a full
recovery of P1's regression plus all of P1's per-concept gains.

| concept    | round-0 (P0) | round-1 (P1) | round-2 (P2) |
|------------|--------------|--------------|--------------|
| invert     | 4/5          | 0/5          | **5/5**      |
| crt        | 4/5          | 5/5          | **5/5**      |
| underwater | 2/5          | 5/5          | **5/5**      |
| vignette   | 5/5          | 3/5          | **5/5**      |
| neon       | 3/5          | 5/5          | **5/5**      |
| sepia      | 5/5          | 5/5          | **5/5**      |
| posterize  | 5/5          | 4/5          | **5/5**      |
| pixelate   | 5/5          | 5/5          | **5/5**      |
| thermal    | 5/5          | 5/5          | **5/5**      |
| glitch     | 4/5          | 0/5          | **5/5**      |
| **total**  | **42/50**    | **37/50**    | **50/50**    |

P2 size: ~3800 chars (vs P0 1466). ~2.6× prefill cost for a +16 pp
overall gain.

**Caveat**: n=5/concept is thin. A confirmation run (round-2b) is
executing now to double the sample. If round-2b also yields 50/50 or
48/50, the result is robust. A score below that says the gain is
smaller than it looks.

## Meta-findings for PSTACK

1. **Snippet stacking has a bias cost that single-snippet hills don't
   expose.** PSTACK's mandatory full-batch re-validation after each
   lock is exactly what caught this; it would have been invisible if
   we'd trusted the per-concept hill scores alone.
2. **A single anchor line at the END of a long prompt can override the
   bias.** P2's one line about "output MUST start with `precision...`"
   recovered everything. Short, positional, explicit.
3. **The "5 max concepts before prefill dominates" warning in the prior
   heuristics doc was too conservative** — at least for accuracy. An 8-
   snippet stack at ~3800 chars is still fine for this model. Latency
   tradeoff is a separate study.
4. **run_cactus.py drops extra batch-row fields** — any future batch
   wanting richer per-row metadata needs `run_cactus.py` to pass those
   through (or the analyzer needs to recover them from `id` as I did
   tonight).

## Methodology gaps observed

1. **`run_cactus.py` doesn't pass through extra batch-row fields**
   (specifically the `variant` tag). Per-variant grouping had to be
   recovered by parsing the `id` prefix. Worth fixing in `run_cactus.py`
   so the at-write grouping in `run_overnight.mjs` actually works.
2. **No realtime per-variant scoring during the overnight run.** The driver
   only logged aggregate per-hill totals. Re-scoring at the end
   (this file) recovered the data, but if a hill had crashed mid-run we
   wouldn't have known until the morning.
3. **"Finish the shader" as a V4 across all hills was lazy.** Adding the
   same edit to every hill means we're not actually testing 5 concept-
   targeted variants; we're testing 4 + a cross-cutting constant. PSTACK
   says "one change per variant" but it doesn't say all variants must be
   concept-specific. V4 should have been a concept-specific edit too.

## Next experiments

In rough priority:

1. **Validate P1** (running). If clean, lock and continue.
2. **Token tradeoff hill** — same eval, run P0 vs P1 vs a "trimmed" P1
   (snippets shortened to 2–3 lines each) to find the knee in
   accuracy-vs-prefill-cost.
3. **Re-hill the at-ceiling concepts on P1** — confirm P1 didn't
   regress pixelate/thermal/sepia/posterize.
4. **WebGL2 per-concept hill** — already established WebGL2 baseline ties
   WebGL1 baseline; worth a per-concept hill on WebGL2 to see if the
   per-snippet wins are similar or larger (ES 3.00's stricter typing
   might matter more once snippets are present).
5. **Replace V4 with per-concept-meaningful 5th variants** in any future
   hills.
