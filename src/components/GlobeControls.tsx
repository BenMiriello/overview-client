import { useState, useRef, useCallback } from 'react';
import { Flame, RotateCcw, Moon, Earth, Cloud, CloudOff, Info, Zap, Thermometer } from 'lucide-react';
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
  cloudOpacity?: number;
  onToggleClouds?: () => void;
  onCloudOpacityChange?: (v: number) => void;
  lightningEnabled?: boolean;
  onToggleLightning?: () => void;
  temperatureEnabled?: boolean;
  onToggleTemperature?: () => void;
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
  cloudOpacity = 1,
  onCloudOpacityChange,
  onToggleClouds,
  lightningEnabled = true,
  onToggleLightning,
  temperatureEnabled = false,
  onToggleTemperature,
  connectionStatus,
  lastUpdate,
  lightningLayer,
}) => {
  const [infoVisible, setInfoVisible] = useState(false);
  const [cloudPanelOpen, setCloudPanelOpen] = useState(false);
  const cloudOuterRef = useRef<HTMLDivElement>(null);
  const sliderTrackRef = useRef<HTMLDivElement>(null);
  const cloudHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cloudDraggingRef = useRef(false);

  const cancelCloudHideTimer = useCallback(() => {
    if (cloudHideTimerRef.current) {
      clearTimeout(cloudHideTimerRef.current);
      cloudHideTimerRef.current = null;
    }
  }, []);

  const scheduleCloudHide = useCallback(() => {
    if (cloudDraggingRef.current) return;
    cancelCloudHideTimer();
    cloudHideTimerRef.current = setTimeout(() => {
      setCloudPanelOpen(false);
      cloudHideTimerRef.current = null;
    }, 500);
  }, [cancelCloudHideTimer]);

  const handleCloudBtnEnter = useCallback(() => {
    cancelCloudHideTimer();
    setCloudPanelOpen(true);
  }, [cancelCloudHideTimer]);

  const handleCloudOuterEnter = useCallback(() => {
    cancelCloudHideTimer();
  }, [cancelCloudHideTimer]);

  const handleCloudOuterLeave = useCallback(() => {
    scheduleCloudHide();
  }, [scheduleCloudHide]);

  const handleSliderInteraction = useCallback((clientY: number) => {
    const track = sliderTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
    onCloudOpacityChange?.(pct);
  }, [onCloudOpacityChange]);

  const handleSliderMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    cloudDraggingRef.current = true;
    handleSliderInteraction(e.clientY);
    const onMove = (ev: MouseEvent) => handleSliderInteraction(ev.clientY);
    const onUp = () => {
      cloudDraggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (cloudOuterRef.current && !cloudOuterRef.current.matches(':hover')) {
        scheduleCloudHide();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [handleSliderInteraction, scheduleCloudHide]);

  const isMoonView = viewTarget === 'moon';
  const hasData = !!hotspot;

  const hotspotClass = [
    'globe-ctrl-btn',
    'hotspot-btn',
    isMoonView || !hasData || !lightningEnabled ? 'inactive' : '',
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
      <div
        className={`cloud-ctrl-outer${cloudPanelOpen ? ' panel-open' : ''}`}
        ref={cloudOuterRef}
        onMouseEnter={handleCloudOuterEnter}
        onMouseLeave={handleCloudOuterLeave}
      >
        <div className="cloud-opacity-panel">
          <div className="cloud-opacity-row">
            <div className="cloud-slider-wrap">
              <div
                className="cloud-slider-track"
                ref={sliderTrackRef}
                onMouseDown={handleSliderMouseDown}
              >
                <div
                  className="cloud-slider-fill"
                  style={{ height: `${Math.round(cloudOpacity * 100)}%` }}
                />
                <div
                  className="cloud-slider-thumb"
                  style={{ bottom: `${Math.round(cloudOpacity * 100)}%` }}
                />
              </div>
            </div>
            <div className="cloud-opacity-side">
              <span className="cloud-opacity-pct">{Math.round(cloudOpacity * 100)}%</span>
              <button className="cloud-visibility-btn" onClick={onToggleClouds}>
                {cloudsEnabled ? 'Hide clouds' : 'Show clouds'}
              </button>
            </div>
          </div>
        </div>
        <button
          className={`globe-ctrl-btn ${cloudsEnabled ? 'active' : ''}`}
          onClick={onToggleClouds}
          onMouseEnter={handleCloudBtnEnter}
          aria-label={cloudsEnabled ? 'Hide clouds' : 'Show clouds'}
        >
          {cloudsEnabled ? <Cloud size={16} /> : <CloudOff size={16} />}
        </button>
      </div>
      <CtrlBtn
        className={`globe-ctrl-btn ${lightningEnabled ? 'active' : ''}`}
        onClick={onToggleLightning}
        ariaLabel={lightningEnabled ? 'Hide lightning' : 'Show lightning'}
        tooltip={lightningEnabled ? 'Hide lightning' : 'Show lightning'}
      >
        <Zap size={16} />
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${temperatureEnabled ? 'active' : ''}`}
        onClick={onToggleTemperature}
        ariaLabel={temperatureEnabled ? 'Hide temperature' : 'Show temperature'}
        tooltip={temperatureEnabled ? 'Hide temperature overlay' : 'Show temperature overlay'}
      >
        <Thermometer size={16} />
      </CtrlBtn>
      <CtrlBtn
        className={hotspotClass}
        onClick={onGoToHotspot}
        ariaLabel="Go to hotspot"
        tooltip={hotspotTooltip}
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
