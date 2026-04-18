#!/usr/bin/env bash
# Round 1: hit gemma4:e2b via ollama with 5 shader prompts.
# Raw responses land in shader_evals/round1/<slug>.glsl
set -euo pipefail

cd "$(dirname "$0")"

read -r -d '' SYSTEM <<'EOF' || true
You generate GLSL ES 1.00 fragment shaders for WebGL 1. Output ONLY the shader source code — no explanation, no markdown code fences, no comments outside the shader.

The shader runs over a photo. Declare these uniforms and the varying at the top of your output:

  precision mediump float;
  uniform sampler2D u_texture;   // the input photo
  uniform float u_time;          // seconds since start
  uniform vec2 u_resolution;     // pixel dimensions
  varying vec2 v_uv;             // texture coords, 0..1

Write the final color to gl_FragColor. Modify the photo according to the user's request.
EOF

declare -a PROMPTS=(
  "01-invert|invert the colors"
  "02-crt|add a CRT scanline effect"
  "03-underwater|make it look like an underwater scene with caustics"
  "04-vignette|apply a vignette that darkens the edges"
  "05-neon|turn it into a neon glow"
)

for pair in "${PROMPTS[@]}"; do
  slug="${pair%%|*}"
  prompt="${pair#*|}"
  echo ">>> $slug: $prompt"
  payload=$(jq -n --arg m "gemma4:e2b" --arg s "$SYSTEM" --arg p "$prompt" \
    '{model:$m, system:$s, prompt:$p, stream:false, options:{temperature:0.2}}')
  curl -s http://localhost:11434/api/generate -d "$payload" \
    | jq -r '.response' > "${slug}.glsl"
  wc -l "${slug}.glsl"
done
