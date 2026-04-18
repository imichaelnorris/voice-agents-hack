# DeepShades

A voice-prompted shader generator running Gemma 4 E2B on-device via [Cactus](https://cactuscompute.com/).

Take a photo, hold the mic, say what you want the photo to look like. The on-device model produces a fragment shader, which renders over the photo in a WebView.

The hackathon frame is in the cactus-compute [voice-agents-hack brief](https://github.com/cactus-compute/voice-agents-hack) (preserved at the bottom of this file for reference). This repo is a fork.

## Stages

The work is broken into three stages. Stage 0 is the working app. Stage 1 is the research core. Stage 2 is the generalizable artifact.

### Stage 0 — Scaffold (done)

A React Native iOS app that:

1. Opens the camera on launch.
2. After the shutter, shows a review screen with the captured photo.
3. Holds a mic button; audio is transcribed by Whisper (via Cactus) into a prompt.
4. Passes `{photo, prompt}` to Gemma 4 E2B (via Cactus).

The app scaffold, camera capture, voice capture, model download/init, and on-device inference hookup are in place. See `App.tsx`.

### Stage 1 — Shader generation, optimized (current)

Turn the transcribed voice prompt into a fragment shader and render it over the photo.

- **Render target**: WebView. Shader is injected into an HTML page that draws a WebGL quad, using the photo as a texture input.
- **Generation**: Gemma 4 E2B emits the shader source. The system prompt is the main lever we're optimizing.
- **Eval loop** (desktop first, mobile later): a seed set of ~100 user prompts; for each, ask Gemma for a shader; score pass/fail on "compiles + renders non-trivially", with Claude Code as the judge for ambiguous cases.
- **Deliverable**: a hand-tuned system prompt that pushes eval pass rate as high as possible. The interesting sub-problem is discovering Gemma 4 E2B's failure modes (hallucinated GLSL builtins? mis-declared `precision`? wrong `gl_FragCoord` conventions?) and writing the system prompt to steer around them.

### Stage 2 — Prompt optimizer (future, separate repo)

The tools we build in Stage 1 want to generalize. Stage 2 extracts them into a standalone optimizer:

- **Inputs**: a frozen model, a seed system prompt, a target output spec, a desired-outcome metric.
- **Loop**: generate a dataset → run evals → propose system-prompt edits → re-eval. Driven by Claude Code so a human isn't the one iterating by hand.
- **Hypothesis**: for small on-device models, the system prompt dominates output quality more than it does for frontier models. If that's right, a focused optimizer for small-model system prompts is a useful artifact.

This is Karpathy-autoresearch-shaped but scoped to prompt-for-small-model optimization.

---

## Dev notes

See [`HACKATHON.md`](HACKATHON.md) for:

- Running Metro from behind a hostile network (ngrok tunnel + AppDelegate wiring).
- The `cactus-react-native` registry patch that admits int4-only models (Gemma 4 E2B, included).
- Self-hosting the model weights on Cloudflare R2 (instead of the default HuggingFace download).

### Why host the model weights ourselves?

Spoke with the Cactus team — clients shipping Cactus in production often prefer serving model weights from their own object storage rather than HuggingFace:

- **Rate limits**: HF throttles anonymous download bandwidth and request counts; a popular app hitting their CDN can get its users 429'd.
- **Control**: versioning, rollback, and deletion are all local decisions.
- **Latency**: CDNs like Cloudflare R2 are often noticeably faster than HF's Xet-bridge, especially for the 4+ GB Apple/Core ML variants.

This repo routes the `gemma-4-e2b-it-int4-pro` (Apple Neural Engine variant) download through R2. The `cactus-react-native` patch substitutes the registry URL for that one model; everything else still resolves against HF. See the patch section in `HACKATHON.md` for the mechanics.

---

## Upstream context (from cactus-compute/voice-agents-hack)

### Context
- Cactus (YC S25) is a low-latency engine for mobile devices & wearables.
- Cactus runs locally on edge devices with hybrid routing of complex tasks to cloud models like Gemini.
- Google DeepMind just released Gemma 4, the first on-device model you can voice-prompt.
- Gemma 4 on Cactus is multimodal, supporting voice, vision, function calling, transcription and more!

### Challenge
- All teams MUST build products that use Gemma 4 on Cactus.
- All products MUST leverage voice functionality in some way.
- All submissions MUST be working MVPs capable of venture backing.
- Winner takes all: Guaranteed YC Interview + GCP Credits.

### Special Tracks
- Best On-Device Enterprise Agent (B2B): Highest commercial viability for offline tools.
- Ultimate Consumer Voice Experience (B2C): Best use of low-latency compute to create ultra-natural, instantaneous voice interaction.
- Deepest Technical Integration: Pushing the boundaries of the hardware/software stack (e.g., novel routing, multi-agent on-device setups, extreme power optimization).

### Judging
- **Rubric 1**: The relevance and realness of the problem and appeal to enterprises and VCs.
- **Rubric 2**: Correctness & quality of the MVP and demo.

### Cactus setup
- `git clone https://github.com/cactus-compute/cactus`
- `cd cactus && source ./setup && cd ..`
- `cactus build --python`
- `cactus download google/functiongemma-270m-it --reconvert`
- Get cactus key from the [cactus website](https://cactuscompute.com/dashboard/api-keys)
- `cactus auth`
- `pip install google-genai` (cloud fallback)
- Get Gemini API key from [Google AI Studio](https://aistudio.google.com/api-keys) (cloud fallback)
- `export GEMINI_API_KEY="your-key"` (cloud fallback)

### Links
- Cactus docs: https://docs.cactuscompute.com/latest/
- Gemma 4 on Cactus walkthrough: https://docs.cactuscompute.com/latest/blog/gemma4/
