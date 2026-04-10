import { useState } from 'react';
import { Flame, RotateCcw, Moon, Earth, Cloud, CloudOff, Info } from 'lucide-react';
import { ConnectionStatus } from '../services/dataStreams/hooks';
import { LightningLayer } from '../layers';
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
  viewTarget?: 'earth' | 'moon';
  onToggleViewTarget?: () => void;
  cloudsEnabled?: boolean;
  onToggleClouds?: () => void;
  connectionStatus?: ConnectionStatus;
  lastUpdate?: string;
  lightningLayer?: LightningLayer | null;
}

interface CtrlBtnProps {
  className: string;
  onClick?: () => void;
  ariaLabel: string;
  tooltip: string;
  leftAlignTooltip?: boolean;
  children: React.ReactNode;
}

const CtrlBtn: React.FC<CtrlBtnProps> = ({ className, onClick, ariaLabel, tooltip, leftAlignTooltip, children }) => (
  <div className="ctrl-btn-wrap">
    <button className={className} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
    <div className={`ctrl-tooltip${leftAlignTooltip ? ' left-align' : ''}`}>
      {tooltip}
    </div>
  </div>
);

export const GlobeControls: React.FC<GlobeControlsProps> = ({
  is3D,
  isOrbiting,
  onToggle3D,
  onToggleOrbit,
  hotspot,
  isViewingHotspot,
  hasNewHotspot,
  onGoToHotspot,
  viewTarget = 'earth',
  onToggleViewTarget,
  cloudsEnabled = true,
  onToggleClouds,
  connectionStatus,
  lastUpdate,
  lightningLayer,
}) => {
  const [infoVisible, setInfoVisible] = useState(false);
  const isMoonView = viewTarget === 'moon';
  const hasData = !!hotspot;

  const hotspotClass = [
    'globe-ctrl-btn',
    'hotspot-btn',
    isMoonView || !hasData ? 'inactive' : '',
    !isMoonView && hasData && isViewingHotspot ? 'viewing' : '',
    !isMoonView && hasData && hasNewHotspot ? 'new-hotspot' : '',
  ].filter(Boolean).join(' ');

  const hotspotTooltip = isMoonView
    ? 'View the latest lightning hotspots on Earth'
    : !hasData
      ? 'Gathering more data to determine the current hotspot location'
      : isViewingHotspot
        ? "You're already viewing the most active hotspot. Click to re-center."
        : 'Go to the most active hotspot';

  const infoText = (() => {
    if (connectionStatus === 'connected') {
      return `Connected | Lightning: ${lightningLayer?.getActiveLightningBoltCount() ?? 0} | Markers: ${lightningLayer?.getMarkerCount() ?? 0} | ${lastUpdate}`;
    }
    if (connectionStatus === 'reconnecting') return 'Reconnecting to server...';
    return 'Disconnected from server';
  })();

  return (
    <div className="globe-controls">
      <CtrlBtn
        className="globe-ctrl-btn active"
        onClick={onToggleViewTarget}
        ariaLabel={viewTarget === 'moon' ? 'Switch to Earth view' : 'Switch to Moon view'}
        tooltip={viewTarget === 'moon' ? 'Switch to Earth view' : 'Switch to Moon view'}
      >
        {viewTarget === 'moon' ?
          <Moon size={16} />
        : <Earth size={16} />
        }
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${cloudsEnabled ? 'active' : ''}`}
        onClick={onToggleClouds}
        ariaLabel={cloudsEnabled ? 'Hide clouds' : 'Show clouds'}
        tooltip={cloudsEnabled ? 'Hide clouds' : 'Show clouds'}
      >
        {cloudsEnabled ? <Cloud size={16} /> : <CloudOff size={16} />}
      </CtrlBtn>
      <CtrlBtn
        className={hotspotClass}
        onClick={onGoToHotspot}
        ariaLabel="Go to hotspot"
        tooltip={hotspotTooltip}
        leftAlignTooltip
      >
        <Flame size={16} />
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${isOrbiting ? 'active' : ''}`}
        onClick={onToggleOrbit}
        ariaLabel={isOrbiting ? 'Stop orbit' : 'Start orbit'}
        tooltip={isOrbiting ? 'Stop auto-rotation' : 'Start auto-rotation'}
      >
        <RotateCcw size={16} />
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${is3D ? 'active' : ''}`}
        onClick={onToggle3D}
        ariaLabel={is3D ? 'Switch to 2D view' : 'Switch to 3D view'}
        tooltip={is3D ? 'Switch to 2D view' : 'Switch to 3D view'}
      >
        {is3D ? '3D' : '2D'}
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${infoVisible ? 'active' : ''}`}
        onClick={() => setInfoVisible(v => !v)}
        ariaLabel={infoVisible ? 'Hide info' : 'Show info'}
        tooltip={infoVisible ? 'Hide connection info' : 'Show connection info'}
      >
        <Info size={16} />
      </CtrlBtn>
      <div className={`globe-controls-info${infoVisible ? ' visible' : ''}`}>
        {infoText}
      </div>
    </div>
  );
};
