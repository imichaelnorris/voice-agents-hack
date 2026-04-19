#!/usr/bin/env node
// Author per-concept variant specs for overnight PSTACK hills.
// Reads evals/prompts/p0.txt as the baseline; writes one spec file per
// concept under evals/prompts/hill-<concept>.json.
//
// Each spec has 5 variants per PSTACK:
//   V0 — baseline (p0 unchanged)
//   V1 — baseline + concept-specific declarative RULE
//   V2 — baseline + concept-specific 4–8 line SNIPPET
//   V3 — baseline + complete REFERENCE shader for the concept
//   V4 — baseline + general anti-truncation CONSTRAINT (shared across concepts)
//
// All variant edits are appended at the end of p0 so the structural
// scaffold is preserved.

import fs from 'node:fs';
import path from 'node:path';

const REPO = '/Users/michael/github/voice-agents-hack';
const P0 = fs.readFileSync(path.join(REPO, 'evals/prompts/p0.txt'), 'utf8');

const CONSTRAINT_V4 =
  '\n\nFinish the entire shader. The closing brace `}` of `void main()` MUST be the last character you output. If you would run out of space, write a shorter shader, but never stop mid-function.';

// Reference shader skeleton header, reused in V3 entries.
const REF_HEADER = `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;`;

const CONCEPTS = {
  invert: {
    user_prompt: 'invert the colors',
    rule: 'For color inversion: `vec3 inverted = vec3(1.0) - color.rgb;`',
    snippet: `Reference snippet for color inversion:

  vec3 color = texture2D(u_texture, v_uv).rgb;
  vec3 inverted = vec3(1.0) - color;
  gl_FragColor = vec4(clamp(inverted, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;
  vec3 inverted = vec3(1.0) - color;
  gl_FragColor = vec4(clamp(inverted, 0.0, 1.0), 1.0);
}`,
  },
  crt: {
    user_prompt: 'add a CRT scanline effect',
    rule: 'For CRT scanlines: use `mod(floor(v_uv.y * u_resolution.y), 2.0)` to alternate rows; multiply color by `1.0 - 0.3 * scanline` for a visible darkening.',
    snippet: `Reference snippet for CRT scanlines:

  vec3 color = texture2D(u_texture, v_uv).rgb;
  float scanline = mod(floor(v_uv.y * u_resolution.y), 2.0);
  color *= 1.0 - 0.3 * scanline;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;
  float scanline = mod(floor(v_uv.y * u_resolution.y), 2.0);
  color *= 1.0 - 0.3 * scanline;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,
  },
  underwater: {
    user_prompt: 'make it look like an underwater scene with caustics',
    rule: 'For underwater caustics: warp v_uv by a sin/cos function of u_time, then add a brightness modulation from a second sin pattern.',
    snippet: `Reference snippet for underwater caustics:

  vec2 uv = v_uv + 0.01 * vec2(sin(v_uv.y * 30.0 + u_time * 2.0), cos(v_uv.x * 30.0 + u_time * 2.0));
  vec3 color = texture2D(u_texture, uv).rgb;
  float caustic = 0.5 + 0.5 * sin(v_uv.x * 50.0 + u_time * 3.0) * sin(v_uv.y * 50.0 + u_time * 2.0);
  color *= mix(0.7, 1.3, caustic);
  color *= vec3(0.6, 0.9, 1.1);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec2 uv = v_uv + 0.01 * vec2(sin(v_uv.y * 30.0 + u_time * 2.0), cos(v_uv.x * 30.0 + u_time * 2.0));
  vec3 color = texture2D(u_texture, uv).rgb;
  float caustic = 0.5 + 0.5 * sin(v_uv.x * 50.0 + u_time * 3.0) * sin(v_uv.y * 50.0 + u_time * 2.0);
  color *= mix(0.7, 1.3, caustic);
  color *= vec3(0.6, 0.9, 1.1);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,
  },
  vignette: {
    user_prompt: 'apply a vignette that darkens the edges',
    rule: 'For a vignette: compute `vec2 d = v_uv - 0.5; float v = 1.0 - dot(d, d) * 2.0;` and multiply color by clamp(v, 0.0, 1.0).',
    snippet: `Reference snippet for vignette:

  vec3 color = texture2D(u_texture, v_uv).rgb;
  vec2 d = v_uv - 0.5;
  float vignette = 1.0 - dot(d, d) * 2.0;
  color *= clamp(vignette, 0.0, 1.0);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;
  vec2 d = v_uv - 0.5;
  float vignette = 1.0 - dot(d, d) * 2.0;
  color *= clamp(vignette, 0.0, 1.0);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,
  },
  neon: {
    user_prompt: 'turn it into a neon glow',
    rule: 'For neon: increase saturation, then add a bright additive term proportional to the original luminance.',
    snippet: `Reference snippet for neon glow:

  vec3 color = texture2D(u_texture, v_uv).rgb;
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 sat = mix(vec3(lum), color, 1.8);
  vec3 glow = sat * lum * 1.5;
  gl_FragColor = vec4(clamp(sat + glow * 0.4, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 sat = mix(vec3(lum), color, 1.8);
  vec3 glow = sat * lum * 1.5;
  gl_FragColor = vec4(clamp(sat + glow * 0.4, 0.0, 1.0), 1.0);
}`,
  },
  sepia: {
    user_prompt: 'make it look like a sepia-toned vintage photo',
    rule: 'For sepia: compute luminance, then multiply by sepia tint vec3(1.07, 0.74, 0.43).',
    snippet: `Reference snippet for sepia:

  vec3 color = texture2D(u_texture, v_uv).rgb;
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 sepia = vec3(lum) * vec3(1.07, 0.74, 0.43);
  gl_FragColor = vec4(clamp(sepia, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 sepia = vec3(lum) * vec3(1.07, 0.74, 0.43);
  gl_FragColor = vec4(clamp(sepia, 0.0, 1.0), 1.0);
}`,
  },
  posterize: {
    user_prompt: 'posterize the image to 4 color bands per channel',
    rule: 'For posterize: `vec3 posterized = floor(color * N) / N;` where N is the band count (4).',
    snippet: `Reference snippet for posterize (N bands per channel):

  vec3 color = texture2D(u_texture, v_uv).rgb;
  float N = 4.0;
  vec3 posterized = floor(color * N) / N;
  gl_FragColor = vec4(clamp(posterized, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec3 color = texture2D(u_texture, v_uv).rgb;
  float N = 4.0;
  vec3 posterized = floor(color * N) / N;
  gl_FragColor = vec4(clamp(posterized, 0.0, 1.0), 1.0);
}`,
  },
  pixelate: {
    user_prompt: 'pixelate the image with chunky 16x16 pixel blocks',
    rule: 'For pixelate: snap v_uv to the centre of 16-px blocks before sampling. (See the grid-snap reference snippet already in this prompt.)',
    snippet: `Reference snippet for pixelate (already present above — duplicated here for emphasis):

  vec2 cell = vec2(16.0) / u_resolution;
  vec2 snapped = (floor(v_uv / cell) + 0.5) * cell;
  vec3 color = texture2D(u_texture, snapped).rgb;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  vec2 cell = vec2(16.0) / u_resolution;
  vec2 snapped = (floor(v_uv / cell) + 0.5) * cell;
  vec3 color = texture2D(u_texture, snapped).rgb;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,
  },
  thermal: {
    user_prompt: 'render it as a thermal camera image with cool blacks and hot whites going through blue, purple, red, yellow',
    rule: 'For thermal: compute luminance, then map through a 5-stop gradient. (See the luminance-to-color-ramp snippet already in this prompt.)',
    snippet: `Reference snippet for thermal (already present above — duplicated here for emphasis):

  float t = dot(texture2D(u_texture, v_uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 col;
  if (t < 0.25)      col = mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.6), t / 0.25);
  else if (t < 0.5)  col = mix(vec3(0.0, 0.0, 0.6), vec3(0.5, 0.0, 0.6), (t - 0.25) / 0.25);
  else if (t < 0.75) col = mix(vec3(0.5, 0.0, 0.6), vec3(0.95, 0.1, 0.05), (t - 0.5) / 0.25);
  else               col = mix(vec3(0.95, 0.1, 0.05), vec3(1.0, 1.0, 0.2), (t - 0.75) / 0.25);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  float t = dot(texture2D(u_texture, v_uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 col;
  if (t < 0.25)      col = mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.6), t / 0.25);
  else if (t < 0.5)  col = mix(vec3(0.0, 0.0, 0.6), vec3(0.5, 0.0, 0.6), (t - 0.25) / 0.25);
  else if (t < 0.75) col = mix(vec3(0.5, 0.0, 0.6), vec3(0.95, 0.1, 0.05), (t - 0.5) / 0.25);
  else               col = mix(vec3(0.95, 0.1, 0.05), vec3(1.0, 1.0, 0.2), (t - 0.75) / 0.25);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
  },
  glitch: {
    user_prompt: 'add a chromatic-aberration glitch effect: sample red and blue channels with a slight horizontal offset',
    rule: 'For chromatic aberration: sample r/g/b separately with a small horizontal UV offset for r and -offset for b.',
    snippet: `Reference snippet for chromatic aberration:

  float off = 0.005;
  float r = texture2D(u_texture, v_uv + vec2(off, 0.0)).r;
  float g = texture2D(u_texture, v_uv).g;
  float b = texture2D(u_texture, v_uv - vec2(off, 0.0)).b;
  gl_FragColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);`,
    reference: `${REF_HEADER}
void main() {
  float off = 0.005;
  float r = texture2D(u_texture, v_uv + vec2(off, 0.0)).r;
  float g = texture2D(u_texture, v_uv).g;
  float b = texture2D(u_texture, v_uv - vec2(off, 0.0)).b;
  gl_FragColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}`,
  },
};

const PROMPTS_DIR = path.join(REPO, 'evals/prompts');
fs.mkdirSync(PROMPTS_DIR, { recursive: true });

for (const [label, c] of Object.entries(CONCEPTS)) {
  const spec = {
    label,
    user_prompt: c.user_prompt,
    variants: [
      { id: 'v0_baseline', system_prompt: P0 },
      { id: 'v1_rule', system_prompt: `${P0}\n\n${c.rule}` },
      { id: 'v2_snippet', system_prompt: `${P0}\n\n${c.snippet}` },
      { id: 'v3_reference', system_prompt: `${P0}\n\nComplete reference shader for this kind of effect:\n\n${c.reference}` },
      { id: 'v4_constraint', system_prompt: `${P0}${CONSTRAINT_V4}` },
    ],
  };
  const out = path.join(PROMPTS_DIR, `hill-${label}.json`);
  fs.writeFileSync(out, JSON.stringify(spec, null, 2));
  console.log(`wrote ${out}`);
}
