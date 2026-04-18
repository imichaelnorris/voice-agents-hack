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

