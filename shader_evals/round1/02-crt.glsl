precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main()
{
    vec4 color = texture2D(u_texture, v_uv);

    // Calculate scanline effect based on the vertical position (v_uv.y)
    // We use a fixed pattern to simulate horizontal lines.
    // The effect is based on the fractional part of the row index.
    float scanline = mod(floor(v_uv.y * u_resolution.y), 2.0);

    // Apply a subtle darkening/lightening effect to simulate CRT lines
    // Lines are typically darker or lighter depending on the desired aesthetic.
    // Here we darken every other line slightly.
    float scanline_factor = 1.0 - (scanline * 0.1);

    color.rgb *= scanline_factor;

    gl_FragColor = color;
}
