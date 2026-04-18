precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec2 uv = v_uv;

    // 1. Underwater Tint (Simulating blue/green water)
    vec3 color = texture2D(u_texture, uv).rgb;
    
    // Simple blue/cyan tint for the water effect
    vec3 water_tint = vec3(0.1, 0.4, 0.6);
    color = mix(color, water_tint, 0.3);

    // 2. Caustics Simulation
    // Create dynamic, moving caustic patterns using time and UV coordinates
    float caustic_pattern = sin(uv.x * 10.0 + u_time * 5.0) * cos(uv.y * 10.0 + u_time * 5.0);
    
    // Amplify the pattern to create bright lines/patches
    caustic_pattern = pow(caustic_pattern, 2.0);
    caustic_pattern = pow(caustic_pattern, 4.0); // Sharpen the effect

    // Use the caustic pattern to modulate the brightness or introduce light streaks
    // We use the pattern to brighten areas, simulating light refraction
    float caustic_light = caustic_pattern * 1.5;
    
    // Blend the original color with the caustic light
    color = color + caustic_light * 0.5;

    // 3. Final Clamping
    color = clamp(color, 0.0, 1.0);

    gl_FragColor = vec4(color, 1.0);
}
