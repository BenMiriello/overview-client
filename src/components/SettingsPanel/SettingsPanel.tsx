import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Rabbit,
  Turtle,
  Zap,
  Wind,
  Eye,
  CloudLightning,
  Magnet,
  Droplet,
  Atom,
  Rotate3d,
  LucideIcon,
} from 'lucide-react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import './SettingsPanel.css';

export interface Settings {
  speed: number;
  detail: number;
  windSpeed: number;
  showCharge: boolean;
  showAtmospheric: boolean;
  showMoisture: boolean;
  showIonization: boolean;
  orbit: boolean;
}

interface SettingsPanelProps {
  onChange: (settings: Settings) => void;
}

const DEFAULT_SETTINGS: Settings = {
  speed: 1.0,  // Strike animation speed: 0.01x to 1.0x (log scale)
  detail: 1.0,
  windSpeed: 12,
  showCharge: true,
  showAtmospheric: false,
  showMoisture: false,
  showIonization: false,
  orbit: false,
};

// Convert linear slider value (0-1) to log scale speed (0.01-1.0)
const sliderToSpeed = (sliderValue: number): number => {
  // Map 0-1 linear to 0.01-1.0 logarithmic (2 decades, not 3)
  const clamped = Math.max(0, Math.min(1, sliderValue));
  return Math.pow(10, clamped * 2 - 2);
};

// Convert log scale speed to linear slider value
const speedToSlider = (speed: number): number => {
  // Handle edge cases and migration from old 0.1-2.0 range
  const clamped = Math.max(0.01, Math.min(1, speed));
  return (Math.log10(clamped) + 2) / 2;
};

// Format speed for display
const formatSpeed = (speed: number): string => {
  if (speed >= 0.995) return '1.0x';
  if (speed >= 0.1) return `${speed.toFixed(1)}x`;
  return `${speed.toFixed(2)}x`;
};

// Migrate old speed values (0.1-2.0 range) to new range (0.01-1.0)
const migrateSpeed = (stored: number): number => {
  // Old range was 0.1-2.0, new range is 0.01-1.0
  // If value > 1.0, it's from old system, clamp to 1.0
  if (stored > 1.0) return 1.0;
  // If value is valid in new range, keep it
  if (stored >= 0.01 && stored <= 1.0) return stored;
  // Default to 1.0x (real-time)
  return 1.0;
};

interface LayerConfig {
  key: keyof Settings;
  icon: LucideIcon;
  label: string;
}

const LAYERS: LayerConfig[] = [
  { key: 'showCharge', icon: CloudLightning, label: 'Cloud & Ground Charge' },
  { key: 'showAtmospheric', icon: Magnet, label: 'Atmospheric Charge' },
  { key: 'showMoisture', icon: Droplet, label: 'Moisture' },
  { key: 'showIonization', icon: Atom, label: 'Ionization' },
];

const SHOW_ATMOSPHERIC = import.meta.env.VITE_SHOW_ATMOSPHERIC_LAYERS === 'true';

const SettingsPanel: React.FC<SettingsPanelProps> = ({ onChange }) => {
  const [speed, setSpeed] = useLocalStorage('lightning-speed', DEFAULT_SETTINGS.speed);
  const [detail, setDetail] = useLocalStorage('lightning-detail', DEFAULT_SETTINGS.detail);
  const [windSpeed, setWindSpeed] = useLocalStorage('lightning-windSpeed', DEFAULT_SETTINGS.windSpeed);
  const [showCharge, setShowCharge] = useLocalStorage('lightning-showCharge', DEFAULT_SETTINGS.showCharge);
  const [showAtmospheric, setShowAtmospheric] = useLocalStorage('lightning-showAtmospheric', DEFAULT_SETTINGS.showAtmospheric);
  const [showMoisture, setShowMoisture] = useLocalStorage('lightning-showMoisture', DEFAULT_SETTINGS.showMoisture);
  const [showIonization, setShowIonization] = useLocalStorage('lightning-showIonization', DEFAULT_SETTINGS.showIonization);
  const [orbit, setOrbit] = useLocalStorage('lightning-orbit', DEFAULT_SETTINGS.orbit);

  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const layerStates: Record<string, boolean> = {
    showCharge,
    showAtmospheric,
    showMoisture,
    showIonization,
  };

  const toggleLayer = useCallback((key: keyof Settings) => {
    switch (key) {
      case 'showCharge': setShowCharge(!showCharge); break;
      case 'showAtmospheric': setShowAtmospheric(!showAtmospheric); break;
      case 'showMoisture': setShowMoisture(!showMoisture); break;
      case 'showIonization': setShowIonization(!showIonization); break;
    }
  }, [showCharge, showAtmospheric, showMoisture, showIonization, setShowCharge, setShowAtmospheric, setShowMoisture, setShowIonization]);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.matchMedia('(hover: none)').matches);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Migrate old speed values on mount
  useEffect(() => {
    const migrated = migrateSpeed(speed);
    if (migrated !== speed) {
      setSpeed(migrated);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const migratedSpeed = migrateSpeed(speed);
    onChange({
      speed: migratedSpeed, detail, windSpeed, showCharge,
      showAtmospheric: SHOW_ATMOSPHERIC ? showAtmospheric : false,
      showMoisture: SHOW_ATMOSPHERIC ? showMoisture : false,
      showIonization: SHOW_ATMOSPHERIC ? showIonization : false,
      orbit,
    });
  }, [speed, detail, windSpeed, showCharge, showAtmospheric, showMoisture, showIonization, orbit, onChange]);

  useEffect(() => {
    if (!isMobile) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpandedSection(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [isMobile]);

  const handleSectionInteraction = (section: string) => {
    if (isMobile) {
      setExpandedSection(expandedSection === section ? null : section);
    }
  };

  const handleMouseEnter = (section: string) => {
    if (!isMobile) setExpandedSection(section);
  };

  const handleMouseLeave = () => {
    if (!isMobile) setExpandedSection(null);
  };

  return (
    <div className="settings-panel" ref={panelRef}>
      {/* Strike Speed Section */}
      <div
        className={`settings-section speed-section ${expandedSection === 'speed' ? 'expanded' : ''}`}
        onMouseEnter={() => handleMouseEnter('speed')}
        onMouseLeave={handleMouseLeave}
        onClick={() => handleSectionInteraction('speed')}
      >
        <div className="section-icon">
          {speed >= 0.5 ? <Rabbit size={20} /> : <Turtle size={20} />}
        </div>
        <div className="section-expandable">
          <span className="section-label">Strike {formatSpeed(speed)}</span>
          <div className="slider-row">
            <Turtle size={14} className="slider-icon" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={speedToSlider(speed)}
              onChange={(e) => setSpeed(sliderToSpeed(parseFloat(e.target.value)))}
            />
            <Rabbit size={14} className="slider-icon" />
          </div>
        </div>
      </div>

      {/* Detail Section */}
      <div
        className={`settings-section detail-section ${expandedSection === 'detail' ? 'expanded' : ''}`}
        onMouseEnter={() => handleMouseEnter('detail')}
        onMouseLeave={handleMouseLeave}
        onClick={() => handleSectionInteraction('detail')}
      >
        <div className="section-icon">
          <Zap size={20} />
        </div>
        <div className="section-expandable">
          <span className="section-label">Detail</span>
          <div className="slider-row">
            <Zap size={14} className="slider-icon" style={{ opacity: 0.25 }} />
            <input
              type="range"
              min="0.2"
              max="2"
              step="0.1"
              value={detail}
              onChange={(e) => setDetail(parseFloat(e.target.value))}
            />
            <Zap size={14} className="slider-icon" />
          </div>
        </div>
      </div>

      {/* Wind Section */}
      <div
        className={`settings-section wind-section ${expandedSection === 'wind' ? 'expanded' : ''}`}
        onMouseEnter={() => handleMouseEnter('wind')}
        onMouseLeave={handleMouseLeave}
        onClick={() => handleSectionInteraction('wind')}
      >
        <div className="section-icon">
          <Wind size={20} />
        </div>
        <div className="section-expandable">
          <span className="section-label">{windSpeed} kts</span>
          <div className="slider-row">
            <Wind size={14} className="slider-icon" style={{ opacity: 0.25 }} />
            <input
              type="range"
              min="0"
              max="60"
              step="1"
              value={windSpeed}
              onChange={(e) => setWindSpeed(Number(e.target.value))}
            />
            <Wind size={14} className="slider-icon" />
          </div>
        </div>
      </div>

      {/* Orbit Toggle */}
      <div
        className={`settings-section orbit-section ${orbit ? 'active' : ''} ${expandedSection === 'orbit' ? 'expanded' : ''}`}
        onMouseEnter={() => handleMouseEnter('orbit')}
        onMouseLeave={handleMouseLeave}
        onClick={() => setOrbit(!orbit)}
      >
        <div className="section-icon">
          <Rotate3d size={20} />
        </div>
        <div className="section-expandable">
          <span className="section-label">{`Orbit: ${orbit ? 'on' : 'off'}`}</span>
        </div>
      </div>

      {/* Charge Toggle (simple) or Full Layers Section */}
      {SHOW_ATMOSPHERIC ? (
        <div
          className={`settings-section layers-section ${expandedSection === 'layers' ? 'expanded' : ''}`}
          onMouseEnter={() => handleMouseEnter('layers')}
          onMouseLeave={handleMouseLeave}
          onClick={() => handleSectionInteraction('layers')}
        >
          <div className="layers-header">
            <div className="section-icon">
              <Eye size={20} />
            </div>
            <span className="section-label">Layer Visibility</span>
          </div>
          <div className="layers-items">
            {LAYERS.map((layer) => {
              const enabled = layerStates[layer.key];
              return (
                <div
                  key={layer.key}
                  className={`layer-item ${enabled ? 'enabled' : 'disabled'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLayer(layer.key);
                  }}
                >
                  <div className="layer-icon-wrapper">
                    <layer.icon size={16} />
                    {!enabled && <div className="slash-overlay" />}
                  </div>
                  <span className="layer-label">{layer.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          className={`settings-section charge-toggle-section ${showCharge ? 'active' : ''} ${expandedSection === 'charge' ? 'expanded' : ''}`}
          onMouseEnter={() => handleMouseEnter('charge')}
          onMouseLeave={handleMouseLeave}
          onClick={() => setShowCharge(!showCharge)}
        >
          <div className="section-icon">
            <CloudLightning size={20} />
          </div>
          <div className="section-expandable">
            <span className="section-label">{`Charge: ${showCharge ? 'on' : 'off'}`}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsPanel;
