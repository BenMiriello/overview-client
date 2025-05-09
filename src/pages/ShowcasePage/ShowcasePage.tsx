import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { NavigationIcons } from '../../components/Navigation';
import './ShowcasePage.css';
import Scene from './Scene';

const ShowcasePage = () => {
  const [detail, setDetail] = useState<number>(1.0);
  const [speed, setSpeed] = useState<number>(1.0);

  return (
    <div className="showcase-page">
      <Canvas 
        camera={{ position: [0, 0, 6], fov: 50 }}
        style={{ background: '#000' }}
      >
        <Scene detail={detail} speed={speed} />
      </Canvas>

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
        
        <div className="slider-container">
          <label htmlFor="speed-slider">Speed:</label>
          <input
            id="speed-slider"
            type="range"
            min="0.1"
            max="2"
            step="0.1"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
          />
          <span>{speed.toFixed(1)}x</span>
        </div>
      </div>
    </div>
  );
};

export default ShowcasePage;
