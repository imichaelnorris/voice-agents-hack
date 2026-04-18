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

## Patch: cactus-react-native registry (int4-only models)

`cactus-react-native@1.13.0`'s `modelRegistry.ts` excludes any model that doesn't publish **both** int4 and int8 weights. Several Gemma 4 variants (incl. `gemma-4-e2b-it`, `gemma-4-e4b-it`, `gemma-3n-e2b-it`) ship only int4, so they never land in the registry and `lm.download()` throws "model … with specified options not found" even with `quantization: 'int4'` set.

Fix lives in `patches/cactus-react-native+1.13.0.patch` — applied automatically on `npm install` via the `postinstall` script (`patch-package`). The patch lets a model into the registry if it has **either** int4 or int8, and only builds the quantization entry that actually exists (so an int4-only model still 404s if you ask it for int8, but at least the registry lookup succeeds).

If the patch ever stops applying cleanly after a cactus upgrade, regenerate with:

```
npx patch-package cactus-react-native
```
