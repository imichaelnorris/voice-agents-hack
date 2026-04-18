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
3. **Route the `gemma-4-e2b-it` apple zip through our Cloudflare R2 CDN** instead of HF. HF's Xet-bridge rate-limits anonymous download bandwidth, and the 4.68 GB Core ML zip is exactly the worst-case download. Hosted at `https://pub-59f20910ffb24ac4a79e942aec001bbb.r2.dev/gemma-4-e2b-it-int4-apple.zip`.

Regenerate the patch after cactus upgrades:

```
npx patch-package cactus-react-native
```
