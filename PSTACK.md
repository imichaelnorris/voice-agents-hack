# PSTACK — Prompt-Stacking Optimization

A coordinate-descent algorithm for hill-climbing a single system prompt
against a fixed evaluation set, holding the model constant. Designed for
small on-device models where the system prompt dominates output quality
and the cost of a full eval is non-trivial.

## Inputs

- **Model `M`**: a frozen weights set served through a deterministic-ish
  inference path (same quantization, same runtime, same options).
- **Seed prompt `P_0`**: the starting system prompt.
- **Evaluation set `E`**: a frozen list of `(concept, user_prompt)` pairs,
  with multiple runs per concept (≥10) to absorb sampling variance.
- **Score function `score(output) → bool`**: a deterministic pass/fail
  judgment on a single output. Aggregates to a per-concept pass-rate
  and an overall pass-rate.
- **Variant generator `propose(P, concept, history) → [P_1, …, P_k]`**:
  given the current prompt and target concept, propose `k` distinct
  candidate edits. The generator is the optimizer's intelligence.

## Invariants

1. **Model is held constant.** Every comparison must use the same weights,
   quantization, and runtime. No quiet swaps.
2. **Eval set is held constant.** Adding prompts mid-run leaks signal and
   destroys round-over-round comparability. If the eval set is wrong,
   freeze a new one and restart from `P_0`.
3. **Sampling variance is real.** Every variant is run `n ≥ 10` times.
   Single-run scores are noise.
4. **Every hill climb includes the unmodified baseline `V_0` as a
   variant.** This is the control. Without it you cannot distinguish
   "this edit improved the prompt" from "I happened to sample a better
   batch this round".
5. **One change per variant.** If V_2 stacks two edits and wins, you
   cannot attribute the win. Single-axis variants make results
   interpretable.

## Algorithm

```
P ← P_0
H ← ∅                                # history of locked edits
loop:
  scores ← evaluate(P, E, n)         # full-batch, n runs per (concept, prompt)
  if no concept has headroom > ε:    # ε ≈ 1 / n; gap from per-concept ceiling
    return P
  c ← argmin over concepts where headroom > ε   # worst concept first
  V ← propose(P, c, H, k=5)          # k variants, V[0] = P (baseline control)
  hill ← evaluate_concept(V, c, n)   # nk inferences targeting one concept
  winner ← argmax(hill, by per-concept pass-rate; tie-break on token cost)
  if winner == V_0 (baseline) or winner_score == V_0_score:
    mark c as ceiling-bound, skip in future rounds
    continue
  P' ← winner
  re-scores ← evaluate(P', E, n)     # full-batch validation
  if re-scores show regression on any other concept:
    record regression in H, try a smaller-edit variant or skip
    continue
  P ← P'
  H ← H ∪ {(c, edit_summary, +Δ on c, regressions seen)}
```

Stopping criteria — any of:

- All concepts at ceiling for the given budget.
- Three consecutive rounds yield no improvement (`P` stable).
- Token budget exceeded (the prompt is now expensive enough that runtime
  cost outweighs further accuracy gain).

## Variant generation guidelines

The variant generator `propose` is where domain knowledge lives. Defaults
that have empirically worked across small on-device models:

- **V_0 — control**: the unmodified current prompt. Required.
- **V_1 — declarative rule**: add a one-line constraint addressing the
  observed failure. Often loses; included as a baseline for "did
  prose-rule work?".
- **V_2 — in-context example (snippet)**: a 4–8 line code/text snippet
  showing the correct pattern. Usually the strongest single-axis edit
  for small models, which copy structure verbatim.
- **V_3 — full reference output**: a complete worked example. Often
  matches V_2 at much higher token cost — keep V_2 unless V_3 is
  decisively better.
- **V_4 — user-prompt rephrase**: rewrite the user prompt itself (when
  the eval allows it) to disambiguate. Sometimes wins; not always
  applicable.

A variant is ONE of these. Never combine two within the same variant —
attribution becomes impossible.

## Decision rules

- **Pass-rate vs token cost tradeoff**: if two variants tie on pass-rate,
  pick the one with fewer added tokens. Prompt size compounds across all
  future inferences.
- **Regression veto**: any winner that drops another concept by more than
  `2/n` (i.e. 2 runs out of `n`) is rejected. Try a smaller-edit
  variant; if none avoids the regression, that concept is locked out for
  the remainder of the run.
- **Ceiling marking**: a concept whose baseline (`V_0`) wins or ties its
  hill is at-ceiling for the current generator. Mark it and stop
  spending hill-climb budget there.

## What NOT to do (anti-patterns)

- **Optimize on a different model than the deployment target.** Even the
  same architecture at different quantization (full-precision vs INT4) or
  different runtime (CPU vs accelerator) produces different failure modes.
  Iterate on the deployment configuration.
- **Combine multiple edits in one variant** — attribution is destroyed.
- **Skip the baseline `V_0`** — sampling noise will fool you into locking
  in null edits.
- **Run a single sample per variant** — at any non-zero temperature, single
  samples are noise. Use ≥10.
- **Broad parallel sweeps over the whole prompt** when the cost-per-eval
  is high. A targeted concept hill (5 variants × 10 runs = 50 inferences)
  produces 5× more decision-relevant data than a single full-batch run
  in the same time.
- **Add to the evaluation set during the run** to "fix" a missing case.
  This leaks signal and breaks round-over-round comparability. Freeze
  the new set, reset to `P_0`, and start over.
- **Trust prose rules to bind on small models.** They often don't — the
  model regurgitates structure from the most recent example regardless
  of declarative constraints. Demonstrate the desired pattern instead of
  asserting it.

## State and reproducibility

Every round records to disk:

- Round number, timestamp.
- The prompt `P` (full text, not a diff).
- The hill spec (concept, variants).
- Raw outputs (every inference, not just summaries) so retrospective
  re-scoring with a different `score` function is possible.
- Per-concept and overall pass-rates.
- Decision: lock / skip / regression-veto, with reason.

Without this state, an interrupted run cannot be resumed and a surprising
result cannot be audited.
