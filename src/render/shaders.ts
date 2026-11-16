/**
 * Shaders for the sky point clouds.
 *
 * Both shaders share the same idea: positions are unit-direction * sky radius,
 * and each point carries its own pixel size and colour. Stars are soft discs;
 * satellites are diamonds so they read differently against the star field.
 */

export const starVertexShader = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

export const starFragmentShader = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p);
    float alpha = smoothstep(0.5, 0.12, d);
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

export const satelliteVertexShader = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

export const satelliteFragmentShader = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    // Diamond: |x| + |y| < 0.42
    float d = abs(p.x) + abs(p.y);
    float alpha = smoothstep(0.42, 0.22, d);
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;
