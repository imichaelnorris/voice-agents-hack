precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
    vec4 color = texture2D(u_texture, v_uv);

    // 1. Underwater Color Shift (Deep Blue/Cyan)
    // Simulate light absorption and water color
    vec3 underwater_color = mix(color.rgb, vec3(0.1, 0.3, 0.5), 0.5);

    // 2. Caustics Simulation
    // Create dynamic, moving light patterns using sine waves
    float caustic_pattern = 0.0;
    
    // Use UV coordinates and time to create moving, wavy patterns
    float wave1 = sin(v_uv.x * 10.0 + u_time * 2.0) * 0.5 + 0.5;
    float wave2 = cos(v_uv.y * 10.0 + u_time * 3.0) * 0.5 + 0.5;
    
    // Combine waves to create a complex caustic effect
    caustic_pattern = (wave1 + wave2) * 0.5;
    
    // Apply the caustic pattern to enhance the light effect
    // We modulate the brightness based on the pattern
    vec3 final_color = underwater_color * (1.0 + caustic_pattern * 0.5);

    gl_FragColor = vec4(final_color, color.a);
}
