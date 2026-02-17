import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Rabbit,
  Turtle,
  Zap,
  Eye,
  CloudLightning,
  Magnet,
  Droplet,
  Atom,
  LucideIcon,
} from 'lucide-react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import './SettingsPanel.css';

export interface Settings {
  speed: number;
  detail: number;
  showCharge: boolean;
  showAtmospheric: boolean;
  showMoisture: boolean;
  showIonization: boolean;
}

interface SettingsPanelProps {
  onChange: (settings: Settings) => void;
}

const DEFAULT_SETTINGS: Settings = {
  speed: 1.0,
  detail: 2.0,
  showCharge: true,
  showAtmospheric: false,
  showMoisture: false,
  showIonization: false,
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

const SettingsPanel: React.FC<SettingsPanelProps> = ({ onChange }) => {
  const [speed, setSpeed] = useLocalStorage('lightning-speed', DEFAULT_SETTINGS.speed);
  const [detail, setDetail] = useLocalStorage('lightning-detail', DEFAULT_SETTINGS.detail);
  const [showCharge, setShowCharge] = useLocalStorage('lightning-showCharge', DEFAULT_SETTINGS.showCharge);
  const [showAtmospheric, setShowAtmospheric] = useLocalStorage('lightning-showAtmospheric', DEFAULT_SETTINGS.showAtmospheric);
  const [showMoisture, setShowMoisture] = useLocalStorage('lightning-showMoisture', DEFAULT_SETTINGS.showMoisture);
  const [showIonization, setShowIonization] = useLocalStorage('lightning-showIonization', DEFAULT_SETTINGS.showIonization);

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

  useEffect(() => {
    onChange({ speed, detail, showCharge, showAtmospheric, showMoisture, showIonization });
  }, [speed, detail, showCharge, showAtmospheric, showMoisture, showIonization, onChange]);

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

  const enabledLayers = LAYERS.filter(l => layerStates[l.key]);

  return (
    <div className="settings-panel" ref={panelRef}>
      {/* Speed Section */}
      <div
        className={`settings-section speed-section ${expandedSection === 'speed' ? 'expanded' : ''}`}
        onMouseEnter={() => handleMouseEnter('speed')}
        onMouseLeave={handleMouseLeave}
        onClick={() => handleSectionInteraction('speed')}
      >
        <div className="section-icon">
          {speed >= 1.0 ? <Rabbit size={20} /> : <Turtle size={20} />}
        </div>
        <div className="section-expandable">
          <span className="section-label">Speed</span>
          <div className="slider-row">
            <Turtle size={14} className="slider-icon" />
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.1"
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              onClick={(e) => e.stopPropagation()}
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
              onClick={(e) => e.stopPropagation()}
            />
            <Zap size={14} className="slider-icon" />
          </div>
        </div>
      </div>

      {/* Layers Section */}
      <div
        className={`settings-section layers-section ${expandedSection === 'layers' ? 'expanded' : ''}`}
        onMouseEnter={() => handleMouseEnter('layers')}
        onMouseLeave={handleMouseLeave}
        onClick={() => handleSectionInteraction('layers')}
      >
        {/* Collapsed: Eye icon + enabled layer icons stacked below */}
        {expandedSection !== 'layers' && (
          <div className="layers-collapsed">
            <div className="section-icon">
              <Eye size={20} />
            </div>
            {enabledLayers.map((layer) => (
              <div key={layer.key} className="collapsed-layer-icon">
                <layer.icon size={16} />
              </div>
            ))}
          </div>
        )}
        {/* Expanded: Header row + indented layer rows below */}
        {expandedSection === 'layers' && (
          <div className="layers-expanded">
            <div className="layers-header">
              <div className="section-icon">
                <Eye size={20} />
              </div>
              <span className="section-label">Layers</span>
            </div>
            <div className="layers-list">
              {LAYERS.map((layer) => {
                const enabled = layerStates[layer.key];
                return (
                  <div
                    key={layer.key}
                    className={`layer-row ${enabled ? 'enabled' : 'disabled'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLayer(layer.key);
                    }}
                  >
                    <div className="layer-icon-wrapper">
                      <layer.icon size={14} />
                      {!enabled && <div className="slash-overlay" />}
                    </div>
                    <span className="layer-label">{layer.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsPanel;
