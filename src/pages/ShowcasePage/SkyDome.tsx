import { useMemo } from 'react';
import * as THREE from 'three';

const SkyDome = () => {
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldPosition;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
                     mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.0 + vec2(100.0);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          // Normalized height: 0 at horizon, 1 at zenith
          vec3 dir = normalize(vWorldPosition - cameraPosition);
          float elevation = dir.y * 0.5 + 0.5;

          // Storm sky gradient
          vec3 zenith = vec3(0.02, 0.02, 0.06);
          vec3 horizon = vec3(0.07, 0.07, 0.11);
          vec3 belowHorizon = vec3(0.03, 0.03, 0.05);

          vec3 skyColor;
          if (elevation > 0.5) {
            skyColor = mix(horizon, zenith, (elevation - 0.5) * 2.0);
          } else {
            skyColor = mix(belowHorizon, horizon, elevation * 2.0);
          }

          // Subtle horizon glow band
          float horizonDist = abs(elevation - 0.5);
          float horizonGlow = exp(-horizonDist * horizonDist * 80.0) * 0.04;
          skyColor += vec3(horizonGlow * 0.8, horizonGlow * 0.7, horizonGlow);

          // Subtle cloud-like noise variation
          vec2 skyUV = dir.xz / max(abs(dir.y) + 0.1, 0.1) * 0.3;
          float cloudNoise = fbm(skyUV * 2.0) * 0.03;
          skyColor += vec3(cloudNoise);

          gl_FragColor = vec4(skyColor, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
  }, []);

  return (
    <mesh scale={[50, 50, 50]}>
      <sphereGeometry args={[1, 32, 16]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

export default SkyDome;
