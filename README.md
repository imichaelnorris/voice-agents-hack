# DeepShades

> **Speak a photo filter into existence.**

Snap a photo, hold the mic, describe the look you want. **Gemma 4 E2B** writes a fragment shader on the fly and renders it over your photo — entirely on-device, no cloud round-trip.

> Tested on iPhone 17 Pro only. Other devices (including iPad) are untested.

## Demo flow

1. Open the app → camera live.
2. Tap shutter → review screen with the captured photo.
3. Hold the mic and say what you want — *"sepia"*, *"thermal cam"*, *"chromatic aberration"*, anything.
4. Gemma 4 E2B transcribes the audio (its own multimodal audio path), writes the GLSL, and a WebView compiles + renders the shader over the photo in real time.

For the safe-demo path: 9 hand-tuned canned shader chips at the bottom (Invert, CRT, Underwater, Vignette, Neon, Sepia, X-Pro 2, Overexposure, …) bypass Gemma entirely and render instantly.

## Deliverables

This submission is three artifacts in one repo.

### 1. The app

A React Native iOS app doing voice → on-device LLM → live GLSL rendering. **One model handles everything**: Gemma 4 E2B INT4 (~4.68 GB Cactus apple bundle) does both audio transcription (its multimodal audio encoder) and shader generation. No separate Whisper, no cloud calls, no second download.

Code: `App.tsx`, `ShaderWebView.tsx`, `cannedShaders.ts`.

### 2. PSTACK — system-prompt optimizer for small on-device models

Coordinate-descent algorithm for hill-climbing a single system prompt against a frozen evaluation set, holding the model constant. Built specifically for small on-device models, where the system prompt dominates output quality more than it does for frontier models.

**Run summary**: ~1,200 inferences overnight against Gemma 4 E2B INT4. Lifted GLSL compile-pass rate from **84% → 100%** on a frozen 50-prompt benchmark in 4 rounds. Headline finding: **a single 4–8 line in-context snippet shifts per-concept pass rate by +30 to +60 pp**, where a one-line declarative rule barely moves the needle. Stacking more snippets has a hidden cost (the model copies snippet structure and drops mandatory declarations), recoverable with a one-line anchor.

- Algorithm: [`PSTACK.md`](PSTACK.md)
- Full round-by-round writeup: [`evals/FINDINGS.md`](evals/FINDINGS.md)
- Raw inference outputs + scored JSON for every batch: [`evals/raw/`](evals/raw/), [`evals/rounds/`](evals/rounds/)

### 3. `cactus-react-native` patches (worth upstreaming)

The Cactus model downloader was the bottleneck on first launch — 4.68 GB at ~10 MB/s on a network where Safari pulled the same URL at ~100 MB/s. Patches in [`patches/cactus-react-native+1.13.0.patch`](patches/cactus-react-native+1.13.0.patch) (auto-applied via `postinstall`):

- **Shared-session parallel-Range downloader.** 6 concurrent `URLSessionDataTask`s sharing one `URLSession` so HTTP/3 multiplexes the range streams over a single QUIC connection — one handshake, one BBR slow-start, no stream-level head-of-line blocking. **Result: ~80 MB/s from R2 (HTTP/3) vs ~60 MB/s from HuggingFace (HTTP/1.1 origin)**, ~6× upstream's single-stream throughput.
- **Correctness defenses** for parallel chunks. A clean mid-body H3 disconnect resolves `didCompleteWithError` with `nil`, leaving zeros where bytes should be — symptom: next launch fails with *"Cannot map file: embed_tokens_per_layer.weights"*. Three guards close the gap: per-chunk `bytesReceived == expectedBytes` check, `SerialFileWriter` records first-write-error and surfaces it, post-download `stat` confirms exact byte count.
- **Registry patches**: admit int4-only models (upstream drops them), bump `RUNTIME_VERSION` to `1.14.0` for HF tag resolution, expose `setModelUrlOverride(slug, …)` for routing through private CDNs.
- **HTTP/3 opt-in + observability**: `URLRequest.assumesHTTP3Capable = true` everywhere, per-transaction `URLSessionTaskMetrics` logging, live `[cactus.dl.parallel.rate]` log every 2 s.

Full writeup in [`HACKATHON.md`](HACKATHON.md).

## Repo orientation

| Where | What |
|---|---|
| `App.tsx`, `ShaderWebView.tsx`, `cannedShaders.ts` | The app |
| `PSTACK.md` | Optimizer algorithm (model-agnostic) |
| `evals/FINDINGS.md` | Round-by-round writeup of the overnight run |
| `evals/` | Raw + scored data, scripts, hill specs |
| `patches/cactus-react-native+1.13.0.patch` | All Cactus patches |
| `HACKATHON.md` | Cactus patch deep-dive + Metro-over-ngrok dev setup |
| `eval_server/README.md` | Phone-as-runtime / Mac-as-driver eval rig (cloudflared broker) |

## Tech stack

- React Native 0.85 (iOS), TypeScript
- [Cactus](https://cactuscompute.com/) for on-device inference (`cactus-react-native@1.13.0` + patches)
- Gemma 4 E2B INT4 (apple variant; ANE-prefill via `.mlpackage` Core ML files)
- WebGL 1 / GLSL ES 1.00 in WKWebView for shader rendering
- `glslangValidator` (Khronos reference compiler) for offline scoring

---

## Upstream context (from cactus-compute/voice-agents-hack)

This repo is a fork of [cactus-compute/voice-agents-hack](https://github.com/cactus-compute/voice-agents-hack). The original hackathon brief, preserved verbatim:

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
