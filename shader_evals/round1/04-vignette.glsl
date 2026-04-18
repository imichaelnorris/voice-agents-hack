precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec2 center = vec2(0.5);
    vec2 delta = v_uv - center;
    float dist = length(delta);

    // Calculate vignette factor. We want the center (dist=0) to be fully bright (factor=1.0)
    // and the edges (max dist ~0.707) to be darker.
    // We use a power function to control the falloff smoothly.
    float vignette = 1.0 - pow(dist * 2.0, 2.0);

    vec3 color = texture2D(u_texture, v_uv).rgb;
    color *= vignette;

    gl_FragColor = vec4(color, 1.0);
}
