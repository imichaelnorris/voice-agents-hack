precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec4 color = texture2D(u_texture, v_uv);
    
    // Simple dynamic neon effect based on time and texture brightness
    float brightness = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722)); // Luminance approximation
    
    // Create a shifting neon color effect
    vec3 neon_color = vec3(1.0, 0.0, 0.0); // Start with red
    
    // Use time to shift the color and create a glow effect
    float glow_intensity = 0.5 + 0.5 * sin(u_time * 3.0 + v_uv.x * 10.0);
    
    // Apply the glow by mixing the original color with a bright, shifting neon color
    vec3 final_color = mix(color.rgb, neon_color * glow_intensity, 0.5);
    
    // Add a subtle ambient glow effect
    final_color += color.rgb * 0.1;
    
    gl_FragColor = vec4(final_color, color.a);
}
