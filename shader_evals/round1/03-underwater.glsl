precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec2 uv = v_uv;

    // 1. Underwater Color Shift (Blue/Cyan tint)
    vec3 original_color = texture2D(u_texture, uv).rgb;
    
    // Simple underwater tint
    vec3 underwater_color = vec3(0.1, 0.4, 0.6) * original_color;

    // 2. Caustics Simulation
    // Create a moving, wavy pattern using time and UVs
    float caustics = 0.0;
    
    // Use time to animate the movement
    float time_factor = u_time * 2.0;
    
    // Create a complex, moving pattern using sine waves
    float pattern1 = sin(uv.x * 10.0 + time_factor * 1.5) * 0.5 + 0.5;
    float pattern2 = cos(uv.y * 10.0 + time_factor * 1.2) * 0.5 + 0.5;
    
    // Combine patterns to create a flowing caustic effect
    float caustic_intensity = (pattern1 + pattern2) * 0.5;
    
    // Make the caustics brighter and more defined
    caustics = pow(caustic_intensity, 2.0);
    
    // Apply caustics as a bright light overlay
    vec3 caustic_light = vec3(1.0, 1.0, 1.0) * caustics * 2.0;

    // 3. Final Color Combination
    vec3 final_color = underwater_color + caustic_light;

    gl_FragColor = vec4(final_color, 1.0);
}
