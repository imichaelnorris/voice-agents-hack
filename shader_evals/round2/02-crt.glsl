precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec4 color = texture2D(u_texture, v_uv);

    // Calculate scanline effect based on the vertical position (v_uv.y)
    // We use a fixed pattern to simulate horizontal lines.
    // The effect is based on whether the pixel is on an odd or even row.
    float scanline = mod(v_uv.y * u_resolution.y, 2.0) / u_resolution.y;

    // Apply a darkening effect to simulate the scanlines
    // We want the lines to be dark (e.g., 0.1) and the lines between them to be brighter.
    // A simple approach is to darken based on the fractional part of the row index.
    float scanline_intensity = sin(v_uv.y * 100.0) * 0.1 + 0.9; // Creates a subtle wavy effect
    
    // A more direct scanline approach:
    float scanline_mask = sin(v_uv.y * 10.0) * 0.1 + 0.9; // Creates horizontal bands
    
    color.rgb *= scanline_mask;

    gl_FragColor = color;
}
