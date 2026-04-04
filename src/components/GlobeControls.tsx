import { Flame, RotateCcw } from 'lucide-react';
import './GlobeControls.css';

interface Hotspot {
  lat: number;
  lng: number;
  count: number;
}

interface GlobeControlsProps {
  is3D: boolean;
  isOrbiting: boolean;
  onToggle3D: () => void;
  onToggleOrbit: () => void;
  hotspot?: Hotspot | null;
  isViewingHotspot?: boolean;
  hasNewHotspot?: boolean;
  onGoToHotspot?: () => void;
}

export const GlobeControls: React.FC<GlobeControlsProps> = ({
  is3D,
  isOrbiting,
  onToggle3D,
  onToggleOrbit,
  hotspot,
  isViewingHotspot,
  hasNewHotspot,
  onGoToHotspot,
}) => {
  const hotspotClass = [
    'globe-ctrl-btn',
    'hotspot-btn',
    isViewingHotspot ? 'viewing' : '',
    hasNewHotspot ? 'new-hotspot' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="globe-controls">
      {hotspot && (
        <button
          className={hotspotClass}
          onClick={onGoToHotspot}
          title={
            isViewingHotspot
              ? "You're already viewing the most active hotspot. Click to re-center."
              : 'Go to the most active hotspot'
          }
          aria-label="Go to hotspot"
        >
          <Flame size={16} />
        </button>
      )}
      <button
        className={`globe-ctrl-btn ${isOrbiting ? 'active' : ''}`}
        onClick={onToggleOrbit}
        aria-label={isOrbiting ? 'Stop orbit' : 'Start orbit'}
      >
        <RotateCcw size={16} />
      </button>
      <button
        className={`globe-ctrl-btn ${is3D ? 'active' : ''}`}
        onClick={onToggle3D}
        aria-label={is3D ? 'Switch to 2D view' : 'Switch to 3D view'}
      >
        {is3D ? '3D' : '2D'}
      </button>
    </div>
  );
};
