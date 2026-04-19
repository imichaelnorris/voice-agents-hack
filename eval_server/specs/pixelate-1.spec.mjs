// Per-concept hill climb on pixelate. Baseline pixelate is 2/5 — model
// uses (pixel/u_res.x, 1.0) for cell size (non-square) and assigns vec4
// to vec3 in the box-blur step. Two distinct bugs.

const BASE_SYSTEM = `You generate GLSL ES 1.00 fragment shaders for WebGL 1. Output ONLY the shader source code — no explanation, no markdown code fences, no comments outside the shader.

The shader runs over a photo. Declare these uniforms and the varying at the top of your output:

  precision mediump float;
  uniform sampler2D u_texture;   // the input photo
  uniform float u_time;          // seconds since start
  uniform vec2 u_resolution;     // pixel dimensions
  varying vec2 v_uv;             // texture coords, 0..1

Write the final color to gl_FragColor. Modify the photo according to the user's request. Clamp the final RGB to [0, 1] so additive effects don't blow out to white.`;

const PIXELATE_REF = `precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec2 cell = vec2(16.0) / u_resolution;
  vec2 snapped = (floor(v_uv / cell) + 0.5) * cell;
  vec3 c = texture2D(u_texture, snapped).rgb;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export default {
  comment: 'Pixelate hill climb 1: 5 variants × 10 runs. Targets the cell-size-not-square + vec3=vec4 errors.',
  runs: 10,
  options: { temperature: 0.7, maxTokens: 1024 },
  prompt: 'pixelate the image with chunky 16x16 pixel blocks',
  variants: [
    {
      id: 'P0-baseline',
      systemPrompt: BASE_SYSTEM,
    },
    {
      id: 'P1-rule',
      systemPrompt: BASE_SYSTEM + `

Hint for grid/block effects: for square cells, compute cell size as vec2(BLOCK_PX) / u_resolution (NOT vec2(BLOCK_PX/u_res.x, 1.0)). Snap UVs with vec2 snapped = (floor(v_uv / cell) + 0.5) * cell.`,
    },
    {
      id: 'P2-snippet',
      systemPrompt: BASE_SYSTEM + `

Reference snippet for snapping UVs to a square grid:

  vec2 cell = vec2(16.0) / u_resolution;
  vec2 snapped = (floor(v_uv / cell) + 0.5) * cell;
  vec3 color = texture2D(u_texture, snapped).rgb;`,
    },
    {
      id: 'P3-fullshader',
      systemPrompt: BASE_SYSTEM + `

Reference shader for a square-cell pixelation effect:

` + PIXELATE_REF,
    },
    {
      id: 'P4-rephrase',
      prompt: 'snap UVs to a 16x16 grid using vec2 cell = vec2(16.0)/u_resolution and vec2 snapped = (floor(v_uv/cell) + 0.5) * cell, then sample once at the snapped coordinate',
      systemPrompt: BASE_SYSTEM,
    },
  ],
};
