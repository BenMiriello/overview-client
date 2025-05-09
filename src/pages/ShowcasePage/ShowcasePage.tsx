import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { LightningBoltEffect, DEFAULT_LIGHTNING_BOLT_CONFIG } from '../../effects/LightningBoltEffect';
import { NavigationIcons } from '../../components/Navigation';
import './ShowcasePage.css';

const ShowcasePage = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<number>(1.0);

  useEffect(() => {
    if (!containerRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Camera setup
    const camera = new THREE.PerspectiveCamera(
      45, 
      window.innerWidth / window.innerHeight, 
      0.1, 
      1000
    );
    camera.position.set(0, 0, 5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    containerRef.current.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const ambientLight = new THREE.AmbientLight(0x202020);
    scene.add(ambientLight);

    const groundGrid = new THREE.GridHelper(10, 20, 0x555555, 0x222222);
    groundGrid.position.y = -2;
    groundGrid.material.opacity = 0.2;
    groundGrid.material.transparent = true;
    scene.add(groundGrid);

    const cloudGrid = new THREE.GridHelper(10, 20, 0x444444, 0x222222);
    cloudGrid.position.y = 2;
    cloudGrid.material.opacity = 0.2;
    cloudGrid.material.transparent = true;
    scene.add(cloudGrid);

    const bloomPass = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        intensity: { value: 1.5 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float intensity;
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          gl_FragColor = color * intensity;
        }
      `
    });

    // Lightning strikes collection
    const strikes: LightningBoltEffect[] = [];
    let nextStrikeTime = 0;

    // Mock globe element to support the existing lightning effect
    const mockGlobeEl = {
      getCoords: (lat: number, lng: number, alt: number) => {
        // In our showcase, we'll use a flat coordinate system
        // Convert lat/lng to x/z and use y for altitude
        const theta = (lng / 180) * Math.PI;
        const phi = (90 - lat) / 180 * Math.PI;

        const x = Math.sin(phi) * Math.cos(theta) * 3;
        const z = Math.sin(phi) * Math.sin(theta) * 3;
        const y = alt * 4 - 2; // Scale altitude to fit between our grids

        return new THREE.Vector3(x, y, z);
      },
      // Add properties needed by the lightning effect
      _mainSphere: {
        geometry: {
          parameters: {
            radius: 3
          }
        }
      }
    };

    // Animation loop
    const clock = new THREE.Clock();
    const animate = () => {
      const currentTime = Date.now();
      const deltaTime = clock.getDelta();

      // Generate a new strike at random intervals
      if (currentTime > nextStrikeTime) {
        // Random position
        const lat = (Math.random() * 180) - 90;
        const lng = (Math.random() * 360) - 180;

        // Create new strike with adjusted parameters based on detail level
        const config = {
          ...DEFAULT_LIGHTNING_BOLT_CONFIG,
          startAltitude: 1.0, // Fixed since we're using a different coordinate system
          endAltitude: 0.01,
          lineSegments: Math.floor(12 * detail),
          lineWidth: 3 * detail,
          jitterAmount: 0.004 * Math.sqrt(detail),
          branchChance: 0.4 * detail,
          maxBranches: Math.floor(4 * detail),
          randomSeed: Math.random() * 10000
        };

        const strike = new LightningBoltEffect(lat, lng, config);
        strike.initialize(scene, mockGlobeEl);
        strikes.push(strike);

        nextStrikeTime = currentTime + 500 + Math.random() * 5000;

        if (strikes.length > 10) {
          const oldStrike = strikes.shift();
          oldStrike?.terminateImmediately();
        }
      }

      // Update existing strikes
      for (let i = strikes.length - 1; i >= 0; i--) {
        if (!strikes[i].update(currentTime)) {
          strikes.splice(i, 1);
        }
      }

      controls.update();

      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };

    animate();

    const handleResize = () => {
      if (!containerRef.current) return;

      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      strikes.forEach(strike => strike.terminateImmediately());
      if (containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [detail]);

  return (
    <div className="showcase-page">
      <div 
        ref={containerRef} 
        style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}
      />

      <NavigationIcons currentPage="lightning" />

      <div className="controls">
        <div className="slider-container">
          <label htmlFor="detail-slider">Detail:</label>
          <input
            id="detail-slider"
            type="range"
            min="0.2"
            max="2"
            step="0.1"
            value={detail}
            onChange={(e) => setDetail(parseFloat(e.target.value))}
          />
          <span>{detail.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
};

export default ShowcasePage;
