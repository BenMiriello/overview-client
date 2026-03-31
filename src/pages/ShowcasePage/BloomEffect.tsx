import { useRef, useEffect, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import * as THREE from 'three';

const BloomEffect = () => {
  const { gl, scene, camera, size } = useThree();
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomRef = useRef<UnrealBloomPass | null>(null);

  useMemo(() => {
    if (composerRef.current) {
      composerRef.current.dispose();
    }

    // Disable renderer's automatic sRGB encoding so we control it via OutputPass only
    const savedColorSpace = gl.outputColorSpace;
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;

    const comp = new EffectComposer(gl);
    comp.addPass(new RenderPass(scene, camera));

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.width, size.height),
      0.8,   // strength
      0.3,   // radius - tighter glow to prevent scene wash
      0.85   // threshold - only bright bolt core triggers bloom
    );
    comp.addPass(bloomPass);
    bloomRef.current = bloomPass;

    comp.addPass(new OutputPass());

    composerRef.current = comp;

    // Restore original color space for any non-composer rendering
    gl.outputColorSpace = savedColorSpace;
  }, [gl, scene, camera]);

  useEffect(() => {
    composerRef.current?.setSize(size.width, size.height);
    if (bloomRef.current) {
      bloomRef.current.resolution.set(size.width, size.height);
    }
  }, [size.width, size.height]);

  useEffect(() => {
    return () => {
      composerRef.current?.dispose();
    };
  }, []);

  // Priority 1 takes over rendering from r3f
  useFrame(() => {
    if (!composerRef.current) return;

    // Temporarily disable sRGB on renderer so RenderPass outputs linear
    const saved = gl.outputColorSpace;
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    composerRef.current.render();
    gl.outputColorSpace = saved;
  }, 1);

  return null;
};

export default BloomEffect;
