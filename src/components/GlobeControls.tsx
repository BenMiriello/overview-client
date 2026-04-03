import { RotateCcw } from 'lucide-react';
import './GlobeControls.css';

interface GlobeControlsProps {
  is3D: boolean;
  isOrbiting: boolean;
  onToggle3D: () => void;
  onToggleOrbit: () => void;
}

export const GlobeControls: React.FC<GlobeControlsProps> = ({
  is3D,
  isOrbiting,
  onToggle3D,
  onToggleOrbit,
}) => {
  return (
    <div className="globe-controls">
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
