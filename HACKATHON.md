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

`patches/cactus-react-native+1.13.0.patch` is applied automatically on `npm install` via the `postinstall` script (`patch-package`). It stacks three fixes against `cactus-react-native@1.13.0`'s `modelRegistry`:

1. **Admit int4-only models.** Upstream excludes any model that doesn't publish *both* int4 and int8 weights. Several Gemma 4 variants (incl. `gemma-4-e2b-it`, `gemma-4-e4b-it`, `gemma-3n-e2b-it`) ship only int4, so they never land in the registry and `lm.download()` throws "model … with specified options not found" even with `quantization: 'int4'` set. The patch lets a model in if it has *either* quant, and only builds the entry that actually exists.
2. **Bump `RUNTIME_VERSION` to `1.14.0`.** The `int4-apple` variant of `gemma-4-e2b-it` (the one with the Core ML `.mlpackage` files needed for Neural Engine inference) only exists at HF tag `v1.14`. Upstream pins to `v1.13`, which 404s.

Regenerate the patch after cactus upgrades:

```
npx patch-package cactus-react-native
```

### Native patch: background URLSession for model downloads

`patches/cactus-react-native+1.13.0.patch` also touches Swift: `ios/HybridCactusFileSystem.swift`. Upstream creates the session with `URLSessionConfiguration.default` which is a foreground session — iOS suspends it when the user backgrounds the app, and after the suspension window the connection drops with `NSURLErrorTimedOut` (-1001).

We swap in `URLSessionConfiguration.background(withIdentifier:)`. Background sessions keep running while the app is suspended and have iOS hand off completion events to us when we return. The continuation/await pattern in `DownloadProgressDelegate` continues to work because iOS resumes delivery of delegate callbacks to our live process when it reactivates (for the common "switched away briefly" case).

Limitations we are not handling yet:

- If iOS fully terminates the app (rare for 4.68 GB downloads, but possible under memory pressure), the `CheckedContinuation` is gone. A future fix would persist the in-flight download info and re-attach when the app relaunches.
- `sessionSendsLaunchEvents = false`: we don't wake the app in the background to finish the download. If the download completes while the user is away, iOS holds the completion until the app next comes to the foreground (fine for our UX).

After touching the Swift side, re-run `pod install` in `ios/` — the native patch only takes effect once CocoaPods re-copies the Cactus source into `Pods/`.

## TODO

- **Upstream the background-URLSession fix** to `cactus-compute/cactus-react-native`. The current foreground session guarantees anyone shipping a production Cactus app runs into `NSURLErrorTimedOut` (-1001) the first time a user switches apps mid-download. Our patch is ~10 lines of Swift and is the kind of thing that belongs in the library rather than every downstream app's patches directory. File an issue + PR once the hackathon dust settles.
- **Harden for app-kill during download.** Persist `{ model, url, session_identifier }` in `UserDefaults` when a download starts. On app launch, check for pending downloads and re-create the `URLSession` with the same identifier to re-attach to the system's in-flight task. Required for the "iOS killed the app under memory pressure during a 4.68 GB download" case; not needed for the typical suspend/resume.
- **Stable background-session identifier.** We use `com.cactus.download.{model}.{uuid}` which is unique per invocation. Apple recommends reusing a single identifier per session role. Not a bug but leaks session configs to iOS over time.
- **AppDelegate hook.** If we ever want iOS to launch the app in the background to deliver completion events (e.g. so `onProgress(1.0)` fires even when user never returns), we'd need to wire up `application(_:handleEventsForBackgroundURLSession:completionHandler:)` and set `sessionSendsLaunchEvents = true`.
