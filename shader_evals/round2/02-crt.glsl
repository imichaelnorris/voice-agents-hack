precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main()
{
    vec4 color = texture2D(u_texture, v_uv);

    // CRT Scanline Effect
    // We check the vertical position (v_uv.y) to create horizontal lines.
    // We use a slight offset and a threshold to simulate the scanline pattern.
    float scanline_intensity = 0.0;

    // Create a subtle, repeating horizontal pattern
    // This creates dark bands.
    float scanline_factor = sin(v_uv.y * 100.0 + u_time * 2.0) * 0.1 + 0.9;

    // Apply the effect: darken the image slightly based on the scanline pattern
    color.rgb *= scanline_factor;

    // Optional: Add a slight darkening to the edges for a more vintage look
    float edge_darkness = 1.0 - smoothstep(0.45, 0.55, v_uv.y);
    color.rgb *= edge_darkness;


    gl_FragColor = color;

    // Clamp the final RGB to [0, 1]
    if (color.r > 1.0) color.r = 1.0;
    if (color.g > 1.0) color.g = 1.0;
    if (color.b > 1.0) color.b = 1.0;
}
