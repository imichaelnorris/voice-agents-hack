theme is voice agents

realtime local handoff when cloud isn't available?

cactus: key featuer: hybrid routing, once on-device makes errors ti gets routed to cloud

interesting UX for camera app, camera in center on first screen, after taking photo: X circle bottom left, microphone on middle, load image right

gemma text model output at the top in a rounded square

https://github.com/cactus-compute/voice-agents-hack

## Dev: Metro on a hostile network (conference WiFi)

Conference WiFi has client isolation — the phone can't reach Metro on the Mac's LAN IP even when both are on the same SSID. Personal Hotspot kills the Mac's internet (Claude Code stops working). Workaround: expose Metro through ngrok.

1. `npx ngrok http 8081` in a terminal (keep running).
2. Grab the public URL: `curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url'`
3. Paste the host into `ios/VoiceAgentsHack/AppDelegate.swift`'s `bundleURL()` `#if DEBUG` branch:
   ```
   provider.jsLocation = "<your-ngrok>.ngrok-free.dev:443"
   provider.packagerScheme = "https"
   ```
   (Setting these on `RCTBundleURLProvider.sharedSettings()` routes the bundle download **and** the HMR websocket through the tunnel — hardcoding just the bundle URL leaves HMR pointed at localhost and gives a "not connected" status.)
4. Rebuild in Xcode (native change, not a Metro reload).

Free-tier ngrok gives a new subdomain each restart, so update step 3 each session. Configure Bundler in the RN dev menu won't work here — RN hardcodes `http://` and iOS ATS blocks plain HTTP.

## Patch: cactus-react-native registry

`patches/cactus-react-native+1.13.0.patch` is applied automatically on `npm install` via the `postinstall` script (`patch-package`). It patches JS (`modelRegistry.ts/.js` + `index`) and native (`ios/HybridCactusFileSystem.swift`).

### JS: `modelRegistry`

1. **Admit int4-only models.** Upstream excludes any model that doesn't publish *both* int4 and int8 weights. Several Gemma 4 variants (incl. `gemma-4-e2b-it`, `gemma-4-e4b-it`, `gemma-3n-e2b-it`) ship only int4, so they never land in the registry and `lm.download()` throws "model … with specified options not found" even with `quantization: 'int4'` set. The patch lets a model in if it has *either* quant, and only builds the entry that actually exists.
2. **Bump `RUNTIME_VERSION` to `1.14.0`.** The `int4-apple` variant of `gemma-4-e2b-it` (the one with the Core ML `.mlpackage` files needed for Neural Engine inference) only exists at HF tag `v1.14`. Upstream pins to `v1.13`, which 404s.
3. **Expose `setModelUrlOverride(slug, { proApple, url })`.** A module-level override map applied after the registry fetch so apps can route specific model downloads through a private CDN or local tunnel without editing the patch. Empty by default — HF URLs resolve normally.

Regenerate the patch after cactus upgrades:

```
npx patch-package cactus-react-native
```

### Native: parallel-Range downloader for model zips

Upstream's `HybridCactusFileSystem.downloadModel` issues a single `URLSessionDownloadTask` with default config. On our test network the 4.68 GB `gemma-4-e2b-it-int4-apple.zip` crawled at ~10 MB/s (80 Mbps) while Safari on the same iPhone clocked ~100 Mbps on the same URL. `URLSessionTaskMetrics` showed `proto=http/1.1` on the bytes transaction (the HF origin returns a 302 → AWS S3 which serves only HTTP/1.1 — no h2, no h3 available on this origin), so protocol negotiation wasn't the lever. Parallelism was.

Patched flow (in `ios/HybridCactusFileSystem.swift`):

1. Try **`downloadParallelRanges(numChunks: 6)`**:
   - HEAD the URL, follow the 302, read `Content-Length` and `Accept-Ranges: bytes`.
   - Pre-allocate the destination zip at full size via `FileHandle.truncate(atOffset:)`.
   - Fire 6 concurrent `URLSessionDataTask`s inside a `withThrowingTaskGroup`, each with its own `URLSession(configuration:)` so every one gets its own connection pool (one shared session would share `httpMaximumConnectionsPerHost`).
   - Each task runs a `ChunkStreamDelegate` that streams bytes in `didReceive` and writes at `startOffset + bytesReceived` through a `SerialFileWriter` (atomic `seek` + `write` behind a dispatch queue).
   - `ParallelProgressState` aggregates bytes across all six with a 250 ms throttle so the JS progress callback isn't swamped. Tracks per-chunk byte counts so a failed-chunk retry can rewind its contribution before the next attempt counts again.
   - Per-chunk: 3 retries with exponential backoff. Non-206 response (server didn't honor the Range header, or returned 416) causes `cancel` → the task throws → caller falls back to single-stream.
   - Logs one `[cactus.dl.parallel.metrics] chunk=N proto=… status=206 bytes=… remote=…` line per chunk after completion.
2. On any error in the parallel path, fall through to **`downloadSingleStream`** — the old single-task path, extracted and kept as a safety net.
3. Once the zip is on disk, the original unzip step runs unchanged.

Other native tweaks kept from earlier iterations:
- `URLSessionConfiguration.default` (foreground). We tried `.background(withIdentifier:)` to survive app suspension; iOS throttles background sessions to low-single-digit Mbps regardless of network, so the throughput cost wasn't worth it. User has to keep the app foregrounded during install.
- `request.assumesHTTP3Capable = true` on all requests — a no-op against the current S3 origin, but cheap to leave on so we'll negotiate h3 if the URL is ever moved to an h3-capable CDN.

After touching the Swift side, re-run `pod install` in `ios/` — the native patch only takes effect once CocoaPods re-copies the Cactus source into `Pods/`.

## TODO

- **Upstream the parallel-Range downloader** to `cactus-compute/cactus-react-native`. Every downstream app pulling large zips from S3-backed origins (which is most of them) will see the same 2–3× throughput cliff against what browsers do on the same URL. Worth filing after the hackathon.
- **Upstream the registry patches** — int4-only admission and the `setModelUrlOverride` hook would both be broadly useful.
- **Also worth flagging** in the upstream issue: the background-URLSession story. We removed it for speed, but production apps shipping Cactus will eventually want both — the correct fix is a background session *and* Apple-approved throughput (which requires some combination of `sessionSendsLaunchEvents`, proper AppDelegate wiring, and accepting iOS's bandwidth priority bucket). Out of scope for us.
- **Wire per-chunk progress** into a visible UI if the current single aggregate bar isn't enough. Each `ChunkStreamDelegate` already knows its bytes received; exposing that as an array on the JS side is a small patch if we want the race-style visual.
