precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec4 color = texture2D(u_texture, v_uv);
    vec3 inverted_color = 1.0 - color.rgb;
    gl_FragColor = vec4(inverted_color, color.a);
}
