precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main()
{
    vec2 center = vec2(0.5);
    vec2 delta = v_uv - center;
    float dist_sq = dot(delta, delta);

    // Calculate vignette factor. We want the center (dist_sq near 0) to be bright (factor near 1.0)
    // and the edges (dist_sq large) to be dark (factor near 0.0).
    // We use a power function to control the falloff.
    float vignette = 1.0 - pow(dist_sq * 2.0, 1.5);

    vec4 color = texture2D(u_texture, v_uv);
    color.rgb *= vignette;

    gl_FragColor = color;
}
