import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as THREE from 'three';
import './NavigationIcons.css'

interface NavigationIconsProps {
  currentPage: 'globe' | 'lightning' | 'bibliography';
}

const NavigationIcons: React.FC<NavigationIconsProps> = ({ currentPage }) => {
  const globeIconRef = useRef<HTMLDivElement>(null);

  // Simple globe wireframe animation
  useEffect(() => {
    if (!globeIconRef.current || currentPage === 'globe') return;

    // Create a mini globe animation
    const container = globeIconRef.current;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.z = 2.7;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(40, 40);
    renderer.setClearColor(0x000000, 0);

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    container.appendChild(renderer.domElement);

    const geometry = new THREE.SphereGeometry(1, 12, 8);
    const wireframe = new THREE.WireframeGeometry(geometry);
    const line = new THREE.LineSegments(
      wireframe,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 })
    );
    scene.add(line);

    const animate = () => {
      line.rotation.y += 0.01;
      renderer.render(scene, camera);
      return requestAnimationFrame(animate);
    };

    const animationId = animate();

    return () => {
      cancelAnimationFrame(animationId);
      renderer.dispose();
      geometry.dispose();
      wireframe.dispose();
      if (line.material instanceof THREE.Material) {
        line.material.dispose();
      }
    };
  }, [currentPage]);

  return (
    <>
      {/* Globe icon - top left */}
      {currentPage !== 'globe' && (
        <Link 
          to="/" 
          className="nav-icon globe-icon"
          aria-label="Go to Globe view"
        >
          <div ref={globeIconRef}></div>
        </Link>
      )}

      {/* Lightning icon - top right */}
      {/* {currentPage !== 'lightning' && ( */}
      {
        <Link 
          to="/lightning" 
          className="nav-icon lightning-icon"
          aria-label="Go to Lightning showcase"
        >
          <svg viewBox="0 0 24 24" width="100%" height="100%" stroke="white" fill="none">
            <path 
              d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      }

      {/* Bibliography icon - bottom right */}
      {currentPage !== 'bibliography' && (
        <Link 
          to="/bibliography" 
          className="nav-icon bibliography-icon"
          aria-label="View bibliography"
        >
          <svg viewBox="0 0 24 24" width="100%" height="100%" stroke="white" fill="none">
            <path 
              d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" 
              strokeWidth="2" 
              strokeLinecap="round" 
            />
            <path 
              d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" 
              strokeWidth="2" 
              strokeLinecap="round" 
            />
          </svg>
        </Link>
      )}
    </>
  );
};

export default NavigationIcons;
