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

The goal is to demonstrate dynamically producing *compilable code* (GLSL) on-device from a voice prompt. That capability is practical for photo apps, games, and any other real-time graphics surface where shaders are the native unit of visual effect.

- **Render target**: WebView. Shader is injected into an HTML page that draws a WebGL quad, using the photo as a texture input.
- **Generation**: Gemma 4 E2B emits the shader source. The system prompt is the main lever we're optimizing.
- **Eval loop** (desktop first, mobile later): a seed set of ~100 user prompts; for each, ask Gemma for a shader; score pass/fail on "compiles + renders non-trivially", with Claude Code as the judge for ambiguous cases.
- **Deliverable**: a hand-tuned system prompt that pushes eval pass rate as high as possible. The interesting sub-problem is discovering Gemma 4 E2B's failure modes (hallucinated GLSL builtins? mis-declared `precision`? wrong `gl_FragCoord` conventions?) and writing the system prompt to steer around them.
- **Shareable outputs** (planned): export the shaded photo as an image, and — if the shader is animated (`iTime`-dependent) — record a short loop and export as a video. Makes the output something a user can actually send to a friend.

### Stage 2 — Prompt optimizer (future, separate repo)

The tools we build in Stage 1 want to generalize. Stage 2 extracts them into a standalone optimizer:

- **Inputs**: a frozen model, a seed system prompt, a target output spec, a desired-outcome metric.
- **Loop**: generate a dataset → run evals → propose system-prompt edits → re-eval. Driven by Claude Code so a human isn't the one iterating by hand.
- **Hypothesis**: for small on-device models, the system prompt dominates output quality more than it does for frontier models. If that's right, a focused optimizer for small-model system prompts is a useful artifact.

This is Karpathy-autoresearch-shaped but scoped to prompt-for-small-model optimization.

### Side deliverable — Cactus native-download optimization

While bringing the app up we ended up doing enough patching to `cactus-react-native@1.13.0` that it's a secondary hackathon deliverable in its own right. The full diff lives in `patches/cactus-react-native+1.13.0.patch` (applied automatically via `postinstall: npx patch-package`); headline changes:

- **Shared-session Range downloader for large model zips.** Upstream ships a single `URLSessionDownloadTask`; Safari on the same iPhone + Wi-Fi could pull the 4.68 GB Gemma 4 E2B apple zip at ~100 MB/s while URLSession topped out around ~10 MB/s. The first parallel-Range iteration split the download across six `Range`-requested chunks on six separate `URLSession`s — still slower than Safari because each chunk paid its own QUIC handshake serially before any bytes flowed. The fix was to share one `URLSession` across all 6 chunks with per-task `URLSessionDataDelegate`s (iOS 15+), so HTTP/3 multiplexes the range streams over a single QUIC connection: one handshake, one BBR slow-start, no stream-level HoL blocking. After the shared-session fix, throughput on a 5 GHz Wi-Fi network was ~**80 MB/s from a Cloudflare R2 bucket** with H3 enabled vs ~60 MB/s from HuggingFace (whose AWS S3 origin is HTTP/1.1-only). Six concurrent `URLSessionDataTask`s stream into a pre-allocated destination file via serial `FileHandle.seek`/`write`, with per-chunk 3× retry, 250 ms throttled aggregate progress, and automatic fallback to single-stream if the server refuses ranges.
- **Correctness fixes discovered along the way.** A naive parallel-chunk implementation can silently produce a truncated zip — a clean mid-body disconnect on H3 resolves `didCompleteWithError` with `nil`, leaving pre-allocated zeros where bytes should be. The symptom is the next app launch failing init with `Cactus init failed: Cannot map file: embed_tokens_per_layer.weights`. Three defenses added: (a) chunk completion verifies `bytesReceived == expectedBytes` or throws to force a retry, (b) `SerialFileWriter` records the first disk-write error and the chunk queries it at completion rather than swallowing it, (c) post-download `stat` confirms the zip is exactly `totalBytes`.
- **Registry patches** — admit int4-only models (upstream drops them), bump `RUNTIME_VERSION` to `1.14.0` so HF resolves the tag where `int4-apple` lives, expose `setModelUrlOverride(slug, {proApple, url})` so apps can route specific models through private CDNs.
- **HTTP/3 opt-in + observability**: `URLRequest.assumesHTTP3Capable = true` on every request; per-transaction `URLSessionTaskMetrics` logging for protocol/remote/reused signals; live `[cactus.dl.parallel.rate]` log every 2s with instantaneous and average MB/s so you don't have to wait for a chunk to finish to see throughput.

Worth upstreaming (see TODO in `HACKATHON.md`).

---

## Dev notes

See [`HACKATHON.md`](HACKATHON.md) for:

- Running Metro from behind a hostile network (ngrok tunnel + AppDelegate wiring).
- Full writeup of the `cactus-react-native` patch (registry fixes + parallel-Range downloader).

See [`eval_server/README.md`](eval_server/README.md) for running prompt-eval batches against the phone's on-device Gemma (broker + cloudflared tunnel + per-concept hill climbs).

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
