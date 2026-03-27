import { useCallback, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { NavigationIcons } from '../../components/Navigation';
import { SettingsPanel, Settings } from '../../components/SettingsPanel';
import './ShowcasePage.css';
import Scene from './Scene';

const ShowcasePage = () => {
  const [settings, setSettings] = useState<Settings>({
    speed: 1.0,
    detail: 2.0,
    windSpeed: 25,
    showCharge: true,
    showAtmospheric: false,
    showMoisture: false,
    showIonization: false,
    orbit: false,
  });

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
  }, []);

  return (
    <div className="showcase-page">
      <Canvas
        camera={{ position: [0, 0, 6], fov: 50 }}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        style={{ background: '#050510' }}
      >
        <Scene
          detail={settings.detail}
          speed={settings.speed}
          windSpeed={settings.windSpeed}
          showCharge={settings.showCharge}
          showAtmospheric={settings.showAtmospheric}
          showMoisture={settings.showMoisture}
          showIonization={settings.showIonization}
          orbit={settings.orbit}
        />
      </Canvas>

      <NavigationIcons currentPage="lightning" />
      <SettingsPanel onChange={handleSettingsChange} />
    </div>
  );
};

export default ShowcasePage;
