import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { NavigationIcons } from '../../components/Navigation';
import './ShowcasePage.css';
import Scene from './Scene';

const ShowcasePage = () => {
  const [detail, setDetail] = useState(1.0);

  return (
    <div className="showcase-page">
      <Canvas 
        camera={{ position: [0, 0, 8], fov: 50 }}
        style={{ background: '#000' }}
      >
        <Scene detail={detail} />
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
      </div>
    </div>
  );
};

export default ShowcasePage;
