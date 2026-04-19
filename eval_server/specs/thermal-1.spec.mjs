// Per-concept hill climb on thermal. Baseline 2/5 — model has no
// idea what a thermal LUT is, does ad-hoc per-channel arithmetic.
// Same pattern as pixelate-1: snippet showing the canonical "luminance
// → piecewise color ramp" formula should fix it.

const BASE_SYSTEM = `You generate GLSL ES 1.00 fragment shaders for WebGL 1. Output ONLY the shader source code — no explanation, no markdown code fences, no comments outside the shader.

The shader runs over a photo. Declare these uniforms and the varying at the top of your output:

  precision mediump float;
  uniform sampler2D u_texture;   // the input photo
  uniform float u_time;          // seconds since start
  uniform vec2 u_resolution;     // pixel dimensions
  varying vec2 v_uv;             // texture coords, 0..1

Write the final color to gl_FragColor. Modify the photo according to the user's request. Clamp the final RGB to [0, 1] so additive effects don't blow out to white.`;

// 7-line snippet covering the entire pattern: read photo, compute luminance,
// piecewise mix through the color ramp, write vec4.
const RAMP_SNIPPET = `Reference snippet for luminance-to-color-ramp shaders (e.g. thermal/false-color):

  float t = dot(texture2D(u_texture, v_uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 col;
  if (t < 0.25)      col = mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.6), t / 0.25);
  else if (t < 0.5)  col = mix(vec3(0.0, 0.0, 0.6), vec3(0.5, 0.0, 0.6), (t - 0.25) / 0.25);
  else if (t < 0.75) col = mix(vec3(0.5, 0.0, 0.6), vec3(0.95, 0.1, 0.05), (t - 0.5) / 0.25);
  else               col = mix(vec3(0.95, 0.1, 0.05), vec3(1.0, 1.0, 0.2), (t - 0.75) / 0.25);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);`;

const THERMAL_REF = `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  float t = dot(texture2D(u_texture, v_uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 col;
  if (t < 0.25)      col = mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.6), t / 0.25);
  else if (t < 0.5)  col = mix(vec3(0.0, 0.0, 0.6), vec3(0.5, 0.0, 0.6), (t - 0.25) / 0.25);
  else if (t < 0.75) col = mix(vec3(0.5, 0.0, 0.6), vec3(0.95, 0.1, 0.05), (t - 0.5) / 0.25);
  else               col = mix(vec3(0.95, 0.1, 0.05), vec3(1.0, 1.0, 0.2), (t - 0.75) / 0.25);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export default {
  comment: 'Thermal hill climb 1: 5 variants × 10 runs. Targets the "no idea what a thermal LUT looks like" failure — model invents nonsense channel arithmetic.',
  runs: 10,
  options: { temperature: 0.7, maxTokens: 1024 },
  prompt: 'render it as a thermal camera image with cool blacks and hot whites going through blue, purple, red, yellow',
  variants: [
    { id: 'T0-baseline', systemPrompt: BASE_SYSTEM },
    {
      id: 'T1-rule',
      systemPrompt: BASE_SYSTEM + `

Hint for false-color/thermal effects: compute luminance = dot(rgb, vec3(0.2126, 0.7152, 0.0722)), then piecewise mix() through the color stops. Don't do per-channel arithmetic.`,
    },
    {
      id: 'T2-snippet',
      systemPrompt: BASE_SYSTEM + `

` + RAMP_SNIPPET,
    },
    {
      id: 'T3-fullshader',
      systemPrompt: BASE_SYSTEM + `

Reference shader for a thermal/heatmap effect:

` + THERMAL_REF,
    },
    {
      id: 'T4-rephrase',
      prompt: 'compute luminance = dot(rgb, vec3(0.2126,0.7152,0.0722)) of each pixel, then map it through a piecewise-linear color ramp using mix() — black 0.0 → blue 0.25 → purple 0.5 → red 0.75 → yellow 1.0',
      systemPrompt: BASE_SYSTEM,
    },
  ],
};
