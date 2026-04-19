# Eval server — phone-as-runtime, Mac-as-driver

Used to run shader-prompt evals against the phone's on-device Gemma without
reshipping the app for every batch. The phone connects to a WebSocket broker
running on your Mac, the broker exposes an HTTP enqueue/results API, and a
small Node script pushes a batch JSON file through it.

## Topology

```
+--------+   wss://       +-------------------+   ws://localhost  +--------+
|  Mac   |  cloudflared   |  cloudflared edge | <---------------> | Mac    |
|  CLI   |  --------->    |   (free tunnel)   |                   | server |
| script |                +-------------------+                   |  :9000 |
+--------+                                                        +--------+
   ^                                                                  ^
   |     HTTP POST /enqueue, GET /results                             |
   |                                                                  |
   +------------------------------------------------------------------+
                               (same Mac)

Phone (PromptEval screen) <-------- WSS ---------+
                                                 |
                                              cloudflared
```

Phone holds a single WebSocket connection to the cloudflared `wss://` URL.
The broker queues inference requests pushed via HTTP and forwards them one at
a time. Results stream back over the WebSocket, the broker buffers them, and
the CLI script polls `GET /results` until the batch is complete.

## One-time setup

```bash
brew install cloudflared
cd eval_server
npm install
```

## Running a batch

Three terminals on the Mac.

**Terminal 1 — broker** (port 9000, no auth):

```bash
cd eval_server
npm start
# [eval] listening on http://localhost:9000
```

**Terminal 2 — public tunnel**. Cloudflare's free quick-tunnel rotates the
URL on every restart:

```bash
cd eval_server
npm run tunnel
# 2026-04-19T... INF +-----------------------------------------------+
# 2026-04-19T... INF |  https://<rand>-<rand>-<rand>-<rand>.trycloudflare.com  |
# 2026-04-19T... INF +-----------------------------------------------+
```

Copy the `https://...trycloudflare.com` URL. **Update
`EVAL_WS_URL` in `App.tsx` to the `wss://` form** (replace `https://` with
`wss://`) and reload the app — the change is JS-only, no rebuild needed.

```ts
// App.tsx
const EVAL_WS_URL = 'wss://<rand>-<rand>-<rand>-<rand>.trycloudflare.com';
```

On the phone: open the Prompt Eval screen and tap **Connect client**. The
broker logs `client connected` and the phone status flips to `connected`.

**Terminal 3 — push a batch**:

```bash
cd eval_server
node run_batch.mjs batches/baseline-50.json
# [batch] writing results to batches/baseline-50.results.jsonl
# [batch] enqueued 50 prompts; polling for results...
# ...
# [batch] done — 50/50 results in 612s
```

Results land at `batches/<name>.results.jsonl`. Score them with:

```bash
node analyze.mjs batches/baseline-50.results.jsonl
```

`analyze.mjs` runs each result through `glslangValidator` (install via
`brew install glslang`) and reports per-concept compile-pass rate.

## Pacing for thermals

The phone throttles after ~5 minutes of continuous inference. For long batches
add `--gap N` to wait N seconds between completions:

```bash
node run_batch.mjs batches/baseline-50.json --gap 30
```

## Per-concept hill climbs

Use `make_hill.mjs` to generate batches that test 5 prompt variants against a
single concept (10 runs each = 50 inferences ≈ 10 min on Cactus Mac):

```bash
node make_hill.mjs specs/pixelate.spec.mjs > batches/pixelate-hill.json
node run_batch.mjs batches/pixelate-hill.json
node analyze.mjs batches/pixelate-hill.results.jsonl
```

See `../PROMPT_OPTIMIZATION_HEURISTICS.md` for what's worked and what hasn't.

## Mac-only inference (no phone)

`run_local.mjs` is the same batch runner but routes through Ollama
(`gemma4:e2b`, full precision). Useful for fast iteration when you don't need
to validate against the phone's INT4 + Apple Neural Engine path:

```bash
ollama pull gemma4:e2b
node run_local.mjs batches/baseline-50.json
```

`run_cactus.py` is the third path: same INT4 weights the phone uses, run
through the Cactus Python build (`~/github/cactus/venv`). Use this when you
need parity with the phone's weights but don't want to wait on the WS round
trip:

```bash
source ~/github/cactus/venv/bin/activate
python run_cactus.py batches/baseline-50.json
```

## Troubleshooting

- **Phone shows `connecting…` forever** — broker isn't reachable. Verify the
  cloudflared URL prints `https://...trycloudflare.com` (not just `Logged in`),
  the `wss://` form is set in `App.tsx`, and the JS bundle reloaded.
- **`already generating` errors mid-batch** — the WS handler retries with
  backoff (App.tsx:1900, up to 6× × 200 ms). Persistent failures mean the
  hook-wrapped `lm.complete()` is reading a stale `isGenerating` closure;
  bump the `setTimeout(..., 80)` in `connectClient`.
- **Tunnel URL rotates** — Cloudflare free quick-tunnels get a new URL every
  restart. Update `App.tsx` and reload.
