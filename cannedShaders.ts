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
  vec4 color = texture2D(u_texture, v_uv);
  float scanline = mod(floor(v_uv.y * u_resolution.y), 2.0);
  float scanline_factor = 1.0 - (scanline * 0.1);
  color.rgb *= scanline_factor;
  gl_FragColor = color;
}`,

  // Round 2, gemma4:e2b — uses mix() and multiplicative caustic to avoid blowout.
  Underwater: `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec4 color = texture2D(u_texture, v_uv);
  vec3 underwater_color = mix(color.rgb, vec3(0.1, 0.3, 0.5), 0.5);
  float wave1 = sin(v_uv.x * 10.0 + u_time * 2.0) * 0.5 + 0.5;
  float wave2 = cos(v_uv.y * 10.0 + u_time * 3.0) * 0.5 + 0.5;
  float caustic_pattern = (wave1 + wave2) * 0.5;
  vec3 final_color = underwater_color * (1.0 + caustic_pattern * 0.5);
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
