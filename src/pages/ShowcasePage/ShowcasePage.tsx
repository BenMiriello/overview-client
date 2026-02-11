import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { NavigationIcons } from '../../components/Navigation';
import './ShowcasePage.css';
import Scene from './Scene';

const ShowcasePage = () => {
  const [detail, setDetail] = useState<number>(1.0);
  const [speed, setSpeed] = useState<number>(1.0);
  const [showCharge, setShowCharge] = useState<boolean>(true);
  const [showAtmospheric, setShowAtmospheric] = useState<boolean>(true);
  const [showMoisture, setShowMoisture] = useState<boolean>(true);

  return (
    <div className="showcase-page">
      <Canvas 
        camera={{ position: [0, 0, 6], fov: 50 }}
        style={{ background: '#000' }}
      >
        <Scene detail={detail} speed={speed} showCharge={showCharge} showAtmospheric={showAtmospheric} showMoisture={showMoisture} />
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

        <div className="slider-container">
          <label htmlFor="charge-toggle">Show Charge:</label>
          <input
            id="charge-toggle"
            type="checkbox"
            checked={showCharge}
            onChange={(e) => setShowCharge(e.target.checked)}
          />
        </div>

        <div className="slider-container">
          <label htmlFor="atmospheric-toggle">3D Charge:</label>
          <input
            id="atmospheric-toggle"
            type="checkbox"
            checked={showAtmospheric}
            onChange={(e) => setShowAtmospheric(e.target.checked)}
          />
        </div>

        <div className="slider-container">
          <label htmlFor="moisture-toggle">Moisture:</label>
          <input
            id="moisture-toggle"
            type="checkbox"
            checked={showMoisture}
            onChange={(e) => setShowMoisture(e.target.checked)}
          />
        </div>
      </div>
    </div>
  );
};

export default ShowcasePage;
