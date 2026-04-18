precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec4 color = texture2D(u_texture, v_uv);

    // Simple neon color palette shift
    vec3 neon_color = vec3(1.0, 0.0, 1.0); // Pink/Magenta base
    
    // Apply glow effect by increasing brightness and saturation based on texture intensity
    float intensity = dot(color.rgb, vec3(0.2126, 0.5854, 0.1140)); // Luminance approximation
    
    // Create a pulsing glow effect using time
    float glow_factor = 1.0 + 0.5 * sin(u_time * 3.0);
    
    vec3 final_color = mix(color.rgb, neon_color, 0.5) * glow_factor;

    gl_FragColor = vec4(final_color, color.a);
}
