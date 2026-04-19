// Hand-picked shaders from the eval rounds in SHADER_PROMPT_ANALYSIS.md.
// Tapping a chip with one of these embedded skips Gemma entirely and feeds
// the WebView directly — useful for testing the renderer and for demoing
// without paying Gemma's ~30s inference latency on int4 weights.

export const CANNED_SHADERS: { [label: string]: string } = {
  // Round 1, gemma4:e2b — textbook.
  Invert: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec4 color = texture2D(u_texture, v_uv);
  vec3 inverted_color = 1.0 - color.rgb;
  gl_FragColor = vec4(inverted_color, color.a);
}`,

  // Round 1, gemma4:e2b — subtle every-other-row 10% darken.
  CRT: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;

  // Hard scanlines that slowly roll downward — sin() gives soft bands,
  // pow() squeezes them so the dark stripes are clearly defined. Density
  // is fixed in screen-space so the bands stay the same thickness across
  // resolutions. u_time shifts the phase ~0.6 cycles/sec.
  float scanY = v_uv.y * u_resolution.y * 0.5 - u_time * 30.0;
  float scan = pow(0.5 + 0.5 * sin(scanY), 1.5);
  scan = mix(0.35, 1.0, scan);

  // Subpixel RGB phosphor mask — every third column biases toward R/G/B
  // for that classic shadow-mask shimmer.
  float colX = mod(floor(v_uv.x * u_resolution.x), 3.0);
  vec3 mask = vec3(0.7);
  if (colX < 1.0) mask.r = 1.4;
  else if (colX < 2.0) mask.g = 1.4;
  else mask.b = 1.4;

  // Slow brightness pulse + edge vignette for tube curvature.
  float flicker = 0.97 + 0.03 * sin(u_time * 8.0);
  vec2 d = v_uv - 0.5;
  float vignette = 1.0 - dot(d, d) * 0.9;

  color *= scan * vignette * flicker;
  color *= mask;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,

  // Hand-tuned. Adds UV-space ripple distortion on top of the Round-2 caustic
  // so the whole image sways — the original sampled static UVs and only the
  // brightness wobbled, which read as near-static on a photo.
  Underwater: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  // Two-axis ripple distortion of the sample coords.
  float rx = sin(v_uv.y * 18.0 + u_time * 2.8) * 0.012;
  float ry = cos(v_uv.x * 14.0 + u_time * 2.2) * 0.012;
  vec2 uv = v_uv + vec2(rx, ry);
  vec4 color = texture2D(u_texture, uv);
  vec3 underwater_color = mix(color.rgb, vec3(0.1, 0.3, 0.5), 0.5);
  // Faster, higher-frequency caustics with a cross-term so the pattern drifts
  // rather than pulsing in place.
  float wave1 = sin(uv.x * 14.0 + uv.y * 6.0 + u_time * 3.2) * 0.5 + 0.5;
  float wave2 = cos(uv.y * 12.0 - uv.x * 4.0 + u_time * 4.1) * 0.5 + 0.5;
  float caustic_pattern = (wave1 + wave2) * 0.5;
  vec3 final_color = underwater_color * (0.85 + caustic_pattern * 0.9);
  gl_FragColor = vec4(final_color, color.a);
}`,

  // Round 1, gemma4:e2b — distance-based vignette.
  Vignette: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec2 center = vec2(0.5);
  vec2 delta = v_uv - center;
  float dist = length(delta);
  float vignette = 1.0 - pow(dist * 1.5, 2.0);
  vec3 color = texture2D(u_texture, v_uv).rgb;
  color *= max(vignette, 0.0);
  gl_FragColor = vec4(color, 1.0);
}`,

  // Standard sepia-tone matrix — same coefficients you'll find in any
  // photo-edit library. Each output channel is a fixed weighting of the
  // three input channels (rather than the simpler luminance-times-tint
  // approach, which loses chroma information).
  Sepia: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;
  vec3 sepia;
  sepia.r = dot(color, vec3(0.393, 0.769, 0.189));
  sepia.g = dot(color, vec3(0.349, 0.686, 0.168));
  sepia.b = dot(color, vec3(0.272, 0.534, 0.131));
  gl_FragColor = vec4(clamp(sepia, 0.0, 1.0), 1.0);
}`,

  // Approximation of the X-Pro II Instagram filter: aggressive contrast
  // around mid-grey, saturation boost, warm highlight / cool-greenish
  // shadow split-tone, and a heavy vignette.
  'X-Pro 2': `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;

  // Contrast bump pivoted around 0.5.
  color = (color - 0.5) * 1.25 + 0.5;

  // Saturation boost.
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(lum), color, 1.4);

  // Split-tone: cool/green shadows, warm highlights. Linear blend by
  // luminance so the curve doesn't band.
  vec3 shadowTint    = vec3(-0.02, 0.05, 0.05);
  vec3 highlightTint = vec3(0.05, 0.04, -0.05);
  color += mix(shadowTint, highlightTint, lum);

  // Strong vignette.
  vec2 d = v_uv - 0.5;
  float vig = 1.0 - dot(d, d) * 1.6;
  color *= clamp(vig, 0.0, 1.0);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,

  // Overexposure: animated. Exposure ramps up with u_time so the photo
  // gradually blows out to white. (Gemma-generated; user-picked over the
  // static version.)
  Overexposure: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;
void main()
{
    vec4 color = texture2D(u_texture, v_uv);
    float exposure = 1.0 + u_time * 0.5;
    color = clamp(color * exposure, 0.0, 1.0);
    gl_FragColor = color;
}`,

  // Hand-written stand-in. Both eval rounds missed the "glow" intent —
  // just tinted magenta. This adds a real bloom approximation via
  // multiple offset samples averaged together.
  Neon: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec3 base = texture2D(u_texture, v_uv).rgb;
  // Multi-tap blur as a cheap bloom.
  vec2 px = 1.0 / u_resolution;
  vec3 bloom = vec3(0.0);
  float weight = 0.0;
  for (float dx = -3.0; dx <= 3.0; dx += 1.0) {
    for (float dy = -3.0; dy <= 3.0; dy += 1.0) {
      vec3 s = texture2D(u_texture, v_uv + vec2(dx, dy) * px * 2.0).rgb;
      // Threshold: only bright pixels contribute to bloom.
      float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
      float w = smoothstep(0.5, 0.9, lum);
      bloom += s * w;
      weight += w;
    }
  }
  bloom /= max(weight, 1.0);
  // Pulse the bloom + tint slightly cyan for that neon look.
  float pulse = 0.7 + 0.3 * sin(u_time * 2.5);
  vec3 neon_tint = mix(bloom, bloom.brg, 0.5) * pulse;
  vec3 final_color = base + neon_tint * 1.2;
  gl_FragColor = vec4(clamp(final_color, 0.0, 1.0), 1.0);
}`,
};
