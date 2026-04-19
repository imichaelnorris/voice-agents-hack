# Shader Prompt Analysis

## Goal

Characterize shader-generation quality across a spectrum of Gemma 4 variants, from the biggest we can run on a Mac down to the quantized model that actually runs on an iPhone.

Path:

1. **Ollama `gemma4:e2b` on Mac** (this doc, initial) — the full-fat E2B checkpoint Ollama ships. Closest "upper bound" for what a Gemma 4 E2B system prompt can achieve without being compression-bottlenecked.
2. **Smaller Gemma 4 variants** (e.g. whatever 4B / sub-E2B checkpoints we can pull) — sanity-check that the prompt engineering transfers as we shrink the model.
3. **iPhone-quantized `gemma-4-e2b-it` int4 via Cactus** — the real deployment target. Diff the failure modes against (1) to see what's architectural vs. quantization-induced.

A harness that runs these prompts on the iPhone will come later. For now, everything is desktop-driven via the Ollama REST API (`http://localhost:11434/api/generate`).

## Methodology (round 1)

- **Model**: `gemma4:e2b` via Ollama.
- **Prompts**: 5 hand-picked, diverse in difficulty and intent.
- **System prompt**: minimal, constrains output to WebGL 1 / GLSL ES 1.00 fragment shader source with a fixed uniform interface. No few-shot examples in round 1 — we want to see the raw model behavior before we start steering it.
- **Scoring (round 1)**: eyeball only. Does it compile? Does it do anything non-trivial? What pathologies show up?

### System prompt (round 1)

```
You generate GLSL ES 1.00 fragment shaders for WebGL 1. Output ONLY the shader source code — no explanation, no markdown code fences, no comments outside the shader.

The shader runs over a photo. Declare these uniforms and the varying at the top of your output:

  precision mediump float;
  uniform sampler2D u_texture;   // the input photo
  uniform float u_time;          // seconds since start
  uniform vec2 u_resolution;     // pixel dimensions
  varying vec2 v_uv;             // texture coords, 0..1

Write the final color to gl_FragColor. Modify the photo according to the user's request.
```

### Prompts

1. `invert the colors`
2. `add a CRT scanline effect`
3. `make it look like an underwater scene with caustics`
4. `apply a vignette that darkens the edges`
5. `turn it into a neon glow`

## Round 1 — raw outputs

Raw shader files live in `shader_evals/round1/`. Reproduce with `shader_evals/round1/run.sh` (requires `ollama serve` running).

### Summary

All 5 prompts returned syntactically valid GLSL ES 1.00 with exactly the declared uniform/varying signature. No markdown fences, no prose, no `#version` mismatch, no hallucinated uniforms — **the format discipline is already strong with a minimal system prompt**.

| # | Prompt | Lines | Compile-look | Renders non-trivially | Matches intent |
|---|---|---|---|---|---|
| 1 | invert the colors | 11 | ✅ | ✅ | ✅ textbook |
| 2 | CRT scanlines | 24 | ✅ | ✅ | ✅ (subtle, 10% darken every other row) |
| 3 | underwater + caustics | 40 | ✅ | ⚠️ | partially — will blow out to white (additive caustics `* 2.0`, no clamp) |
| 4 | vignette edges | 21 | ✅ | ✅ | ✅ but harsh (`pow(dist*2.0, 2.0)` → edges fully black) |
| 5 | neon glow | 22 | ✅ | ✅ | ❌ does a magenta-tint + time-pulse; no blur/bloom, missed "glow" |

### Observations (Ollama `gemma4:e2b`, temp 0.2)

- **Format adherence is ~100% already.** Uniform declarations match, no markdown, pure source. That's the cheap win the system prompt is already buying.
- **In-shader comments are consistent** even though the system prompt said "no comments outside the shader". Model interpreted the qualifier correctly and commented *inside* the shader, which is fine for us — but it burns ~15-30% of the output tokens on commentary. We can push back on this if we want to shorten outputs for latency.
- **Correctness pathologies in round 1:**
  - *Additive overlays aren't clamped* (underwater caustics). This is the kind of thing a system-prompt note can fix: "clamp any additive light contribution so final color ∈ [0, 1]".
  - *Aggressive constants chosen by default* (vignette power of 2, underwater caustics `* 2.0`). The model picks maximalist values without being asked — can be steered.
- **Semantic gap: "glow" → color tint.** Gemma 4 E2B interpreted "neon glow" as "tint it pink and pulse" instead of a multi-pass bloom. This is expected for a small model — real bloom needs multiple samples / framebuffers which it didn't attempt. Either we expand the harness so a shader can request auxiliary passes, or we steer the model to approximate glow with samples-per-pixel bloom.

### Hypotheses to test next

1. Adding **explicit constraints to the system prompt** ("clamp final RGB to [0, 1]", "avoid additive overlays brighter than 0.3") should fix the blow-out cases without hurting the easy ones.
2. **Few-shot bloom example** → should close the semantic gap on "glow"-like prompts by showing a single-pass multi-sample bloom pattern.
3. **Temperature sensitivity**: rerun the same 5 at temps [0.0, 0.5, 1.0] to see how stable the format discipline is under higher variance — informs whether we can safely crank temperature for creative prompts or have to stay conservative.

These are cheap to run. Once we have a desktop harness that automates (run → compile-check → tally) we can start running real evals instead of eyeballing.

## Round 2 — outputs (system prompt + clamp directive)

Same model (`gemma4:e2b` via Ollama, temp 0.2), same 5 prompts, but the system prompt now matches `App.tsx`'s `SHADER_SYSTEM_PROMPT` — the only delta from round 1 is one new line:

> Clamp the final RGB to [0, 1] so additive effects don't blow out to white.

Aimed at fixing #3 (underwater blowout). Raw outputs in `shader_evals/round2/`. Reproduce with `shader_evals/round2/run.sh`.

| # | Prompt | Δ vs round 1 | Compile-look | Renders non-trivially | Matches intent |
|---|---|---|---|---|---|
| 1 | invert the colors | **REGRESSION** | ❌ no `void main() { ... }`, just bare statements | ❌ | ❌ won't compile |
| 2 | CRT scanlines | mostly same; tacked clamp code AFTER `gl_FragColor` (dead) + bizarre vertical-center darkening | ✅ | ✅ | weaker — animated scanlines + misplaced edge darkening |
| 3 | underwater + caustics | **FIXED** — uses `mix(color, blue, 0.5)` and multiplicative caustic factor `(1 + p * 0.5)` instead of additive overlay | ✅ | ✅ | ✅ no blowout |
| 4 | vignette edges | `pow(dist_sq * 2.0, 1.5)` (was 2.0); slightly less harsh | ✅ | ✅ | ✅ |
| 5 | neon glow | unchanged — magenta tint + time pulse, no bloom | ✅ | ✅ | ❌ same semantic miss |

### What the clamp directive actually did

Cure: round 1's underwater blowout is gone. The model interpreted "clamp additive effects" correctly there — used `mix()` and multiplicative modulation, no `+` overlays.

Cost: at least one regression and one weakening. The longer prompt seems to have nudged the model toward including clamp-related code somewhere even when it wasn't load-bearing — the CRT shader has an `if (color.r > 1.0) color.r = 1.0;` block dropped in *after* `gl_FragColor` is already assigned, and the invert shader lost its `main()` entirely. Both feel like the model trying to "show its work" on the new constraint and corrupting structure in the process.

Net: 1 win (underwater), 1 regression (invert won't compile), 1 weakening (CRT). Not an unambiguous improvement.

### Hypotheses for round 3

1. **Move the clamp directive out of the open-ended free text** and into the example uniform block as an inline comment, e.g. `// gl_FragColor.rgb = clamp(rgb, 0.0, 1.0); // suggested but not required`. The model is more likely to mirror code patterns than to internalize prose constraints.
2. **Add one explicit positive few-shot example** showing a complete, well-formed shader with `void main()`. Round 2 lost `main` on the easiest prompt — that's a structure-preservation problem, not a semantic one. A canonical example anchors the structure.
3. **Try temperature 0.0** to remove the variance, or temperature 0.7 to escape local minima — the round 1 → round 2 regressions on invert/CRT might be a local-minimum effect of low-temp + slightly-different prompt.

Cheapest test for #2: rerun round 2 with one prepended assistant turn (the round 1 invert output, which was perfect). If invert stops regressing, structure preservation is the dominant failure mode and few-shot examples are the right lever.

## Round 3 — on-device baseline via WebSocket eval harness

First eval against the actual deployment target: `gemma-4-e2b-it-int4-pro` running through Cactus on iPhone, driven from `node eval_server/run_batch.mjs eval_server/batches/baseline-50.json` (10 concepts × 5 runs at temperature 0.7). Same `SHADER_SYSTEM_PROMPT` as App.tsx (with the `clamp final RGB to [0,1]` directive).

50 prompts attempted; 45 returned a shader, 5 native-errored (Cactus/iOS thermal kills, not model output). Of the 45 returns, all 45 pass the cheap shape check (`has main`, `writes gl_FragColor`, `samples u_texture`, etc.) — but **eyeballing the actual GLSL shows the 90% pass rate is massively overstated**.

### Real failure modes seen in the 45 returns

The shape check only looks for the right shape of declarations and a `gl_FragColor` write. It does not catch GLSL type errors, semantic emptiness, or degenerate parameters. Tally of what the model actually does wrong:

| failure mode | example | hits | fix lever |
|---|---|---|---|
| `pow(vec3, float)` | `pow(color.rgb, 1.5)` (no such overload in GLSL ES 1.00) | 5/5 neon, scattered elsewhere | system prompt rule: broadcast scalar exponents with `vec3(x)` |
| `vec3 = mix(scalar, scalar, scalar)` | `vec3 sepia_color = mix(0.9, 0.7, s);` (mix of scalars returns scalar) | sepia-r2, underwater-r1 | system prompt rule on `mix` arg type matching |
| `vec3 = floor(scalar)` | `vec3 r = floor(color.r * 4.0) / 4.0;` | posterize-r1 | "construct vec3 with `vec3(...)`, never assign a scalar directly" |
| variable redeclared | `float caustics = ...; ... float caustics = ...;` | underwater-r2 | "do not redeclare variables in the same scope" |
| `gl_FragColor = vec3` (missing alpha) | `gl_FragColor = clamp(finalColorVec, 0., 1.);` (vec3 not vec4) | thermal-r1 | "always wrap final color in `vec4(rgb, 1.0)`" |
| degenerate params → no effect | `smoothstep(scanline - s, scanline - s + s, 0.0)` (edges equal → 0) | crt-r1 | hard to fix via prompt; would need eval-driven rejection |
| ad-hoc effect formula | sepia uses random tan colors instead of the standard luminance matrix; thermal does nonsense channel arithmetic instead of a piecewise color ramp | sepia × all, thermal × all | few-shot examples for the textbook formulas |
| missing semantic intent | "neon glow" → magenta tint with time pulse, no actual bloom (multi-sample blur) | all 5 neon | architectural — bloom needs multi-pass or many texture samples; small models don't reach for it |

Concept-by-concept actually-rendering rate (my eyeball, not automated):
- **invert** 5/5 ✅ — textbook, only minor variation in alpha handling
- **crt** 2/5 ⚠️ — most have visible-but-weak scanlines; one has degenerate `smoothstep(a,a,…)` so no effect
- **underwater** 2/5 ⚠️ — r4/r5 work; r1 has type errors, r2 redeclares, r3 blows out
- **vignette** 3/5 ⚠️ — most work, some have scalar/vec confusion in the falloff math
- **neon** 0/5 ❌ — all have `pow(vec3, float)` type error → won't compile at all
- **sepia** 1/5 ❌ — none use the canonical sepia matrix; r2 has mix type error
- **posterize** 4/5 ✅ — r1 type-errors with vec3=scalar, rest are clean
- **pixelate** 0/5 ❌ — all have weird arithmetic on `pixelSizeVec`; some use texCoord wrong; outputs look broken
- **thermal** 0/4 ❌ — all do nonsense channel arithmetic instead of a luminance ramp; none produce a recognizable thermal palette
- **glitch** 1/1 (only one returned) ⚠️ — too few samples to judge

True realistic-render rate: **~18/41 ≈ 44%**, dramatically below the 90% shape-only number.

### Round 4 plan: targeted system-prompt edits

These are the cheap, high-leverage edits to test next:

1. **Add a "GLSL ES 1.00 type rules" section** to the system prompt:
   - "When using `pow`, `mix`, `min`, `max`, `clamp` with vector first args, broadcast scalars: `pow(rgb, vec3(2.0))`, not `pow(rgb, 2.0)`."
   - "Construct vec3 values with `vec3(x)` or three components — never assign a scalar to a vec3."
   - "`gl_FragColor` is a `vec4` — wrap with `vec4(rgb, 1.0)`."
2. **Few-shot the canonical formulas** for color-transform concepts (sepia matrix, thermal LUT) — current model invents them.
3. **For "glow"-style prompts**, either
   - add a one-shot multi-tap-bloom example, or
   - keep accepting the lossier semantics and reframe the chip as "neon tint" instead of "neon glow" so we don't measure against an unmet expectation.
4. **Build a real GLSL compile check** in `analyze.mjs`: pipe each shader through `glslang`/`naga`/headless WebGL so the analyzer reflects truth instead of shape. Without this we'll keep flying blind on prompt edits.

Item (4) is the most leveraged — it makes the loop honest. Item (1) probably moves real-pass-rate from ~44% to ~70% on its own (eliminates the type-error class).

## Eval infrastructure (current state)

Three runners feeding the same `analyze.mjs` so every batch is scored by the same rubric.

| runner | model surface | precision | speed | use when |
|---|---|---|---|---|
| `eval_server/run_batch.mjs` | iPhone via WebSocket (eval server + cloudflared tunnel) | int4 + Apple Neural Engine `.mlpackage` | ~12s/inference, thermal-bound at 30+ in a row | only for final ground-truth before claiming a prompt works |
| `eval_server/run_cactus.py` | Cactus python → same INT4 weights as the phone, but Mac CPU (no Neural Engine) | int4 (identical bytes) | ~17 min for 50 prompts | **the iteration loop** — closest behaviour we can run locally |
| `eval_server/run_local.mjs` | Ollama `gemma4:e2b` (full precision, ~7 GB) | full / Q8-ish | ~1–10 s/inference | quick experiments where exact behaviour doesn't matter |

All three emit JSONL in the same shape; `analyze.mjs` runs each shader through `glslangValidator` (Khronos reference compiler) so pass/fail is an actual GLSL ES 1.00 compile, not a string-shape regex.

Batches live in `eval_server/batches/<name>.json` with optional `systemPrompt` and per-prompt overrides. `run_batch.mjs --gap N` paces prompts to the phone for thermal cooldown.

## Eval rounds so far (compile pass-rates)

| round | model surface | system prompt | result | notes |
|---|---|---|---|---|
| 1 (Ollama) | full-precision gemma4:e2b | minimal | eyeball ~80% | shape-only check, no compile |
| 2 (Ollama) | full-precision gemma4:e2b | + clamp-RGB directive | eyeball mixed | introduced regressions |
| 3 (phone) | iPhone INT4 + ANE | round-2 prompt (current `SHADER_SYSTEM_PROMPT` in `App.tsx`) | **27 / 50 = 54%** | baseline; underwater, vignette, neon, pixelate, thermal, glitch all <60% |
| 3.5 (Cactus on Mac) | same INT4 weights as phone, CPU only | same as round 3 | **34 / 50 = 68%** | Mac is +14% absolute over phone with identical weights — sampler nondeterminism + CPU vs ANE small differences. Failure *patterns* match, so prompt fixes here should transfer; absolute numbers won't. |
| 4 Variant A (Cactus on Mac) | same | + 6 explicit GLSL ES 1.00 type rules in system prompt (`pow(vec3,scalar)`, `mix` return type, `vec3 = scalar`, alpha on gl_FragColor, no redeclare, `vec3(0.0)` not `0.0`) | **29 / 50 = 58% — REGRESSION** vs baseline 68% | declarative rules don't bind. Glitch dropped 4/5 → 0/5 with the same `vec3 = float` error the rule explicitly forbids (the model literally writes `vec3 red = color.r;` in glitch-r1). Crt picked up new failure modes (`undeclared identifier`, `redefinition`) — the longer system prompt seems to push the model toward more elaborate code with more places to mess up. |

## Dominant failure modes (counted from round 3)

These are what the type-rules system prompt targets:

| failure mode | sample error from glslang | round-3 count | example concept |
|---|---|---|---|
| `pow(vec3, float)` | `'pow' : no matching overloaded function found` | 3+ | neon (5/5) |
| vec3 ← scalar/vec2/vec4 assignment | `cannot convert from ' temp mediump float' to ' temp mediump 3-component vector of float'` | 8+ | sepia, posterize, pixelate, vignette |
| variable redefinition | `'caustics' : redefinition` | 1 | underwater-r2 |
| `gl_FragColor` set to vec3 | constructor-arity error | 1+ | thermal-r4 |
| ad-hoc formula instead of canonical | semantic — sepia tan instead of luminance matrix; thermal channel-mush instead of color ramp | most of sepia, all of thermal | sepia, thermal |
| missing semantic intent | "neon glow" → magenta tint with no actual bloom | 5/5 | neon |

Type-rule class (top 4 rows) accounts for the bulk of compile failures. Round 4 Variant A targets exactly this. If it works, round 5 adds canonical-formula few-shots for the bottom-two semantic-miss rows.

## Round 4 plan (revised after Variant A regressed)

Variant A taught us: **declarative type rules don't bind on this model.** The model echoes the constraint phrase but still emits the forbidden pattern. Pivot to in-context demonstration.

- **Variant A** (done): type rules in prose. **58% — regression.** Cut.
- **Variant B** (next): one full canonical example shader prepended as a prior assistant turn. Pick a concept that exercises every rule we care about (e.g. invert with explicit `vec4(1.0 - rgb, 1.0)` final, no scalar/vec confusion). Measures: does showing > telling close the compile gap?
- **Variant C** (queued): B + a second example (concept that uses `mix`, `pow(vec3, vec3(...))`, multi-tap sample) so the model has two patterns to imitate.
- **Variant D** (queued): A + B — combine declarative rules with examples in case the rules help when grounded by an example.

After we land a winner on Mac, validate on the iPhone. Phone numbers will be lower than Mac numbers but the relative ordering between variants should hold — that's what the iteration loop is buying us.

## Files to know

- `App.tsx` — `SHADER_SYSTEM_PROMPT` constant (line ~42) is the production prompt; `EVAL_WS_URL` (line ~308) is the cloudflared tunnel URL the phone connects to in client mode.
- `eval_server/server.mjs` — WebSocket broker. `node eval_server/server.mjs` then `cloudflared tunnel --url http://localhost:9000` for the public URL.
- `eval_server/run_*.{mjs,py}` — three runners.
- `eval_server/analyze.mjs <results.jsonl> [...]` — score with real GLSL compile.
- `eval_server/batches/*.json` — batch definitions; results land alongside as `<batch>.<runner>.results.jsonl`.
- `eval_server/ground_truth.json` — hand-written reference shaders per concept for semantic comparison.

