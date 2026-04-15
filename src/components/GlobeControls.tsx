import { useState, useRef, useCallback, useEffect } from 'react';
import { Flame, RotateCcw, Moon, Earth, Cloud, CloudOff, Info, Zap, Thermometer, CloudRain, Wind, Play, X } from 'lucide-react';
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
  precipitationEnabled?: boolean;
  onTogglePrecipitation?: () => void;
  windEnabled?: boolean;
  onToggleWind?: () => void;
  tempHistoryOpen?: boolean;
  onToggleTempHistory?: () => void;
  precipHistoryOpen?: boolean;
  onTogglePrecipHistory?: () => void;
  windHistoryOpen?: boolean;
  onToggleWindHistory?: () => void;
  cloudHistoryOpen?: boolean;
  onToggleCloudHistory?: () => void;
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
  tooltipExtra?: React.ReactNode;
  hidden?: boolean;
  children: React.ReactNode;
}

// Tracks the deactivate function of the currently active interactive tooltip
let activeTooltipDeactivate: (() => void) | null = null;

const CtrlBtn: React.FC<CtrlBtnProps> = ({ className, onClick, ariaLabel, tooltip, leftAlignTooltip, tooltipExtra, hidden, children }) => {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnHovered = useRef(false);
  const hasExtra = !!tooltipExtra;

  const deactivateNow = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    tooltipRef.current?.classList.remove('tooltip-active');
  }, []);

  const activate = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    tooltipRef.current?.classList.add('tooltip-active');
    activeTooltipDeactivate = deactivateNow;
  }, [deactivateNow]);

  const cancelHide = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  const scheduleDeactivate = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      tooltipRef.current?.classList.remove('tooltip-active');
      hideTimer.current = null;
    }, 300);
  }, []);

  // When hasExtra becomes true while button is hovered, activate immediately
  useEffect(() => {
    if (hasExtra && btnHovered.current) activate();
  }, [hasExtra, activate]);

  return (
    <div className={`ctrl-btn-wrap${hidden ? ' ctrl-btn-hidden' : ''}`}>
      <button
        className={className}
        onClick={onClick}
        aria-label={ariaLabel}
        onMouseEnter={() => {
          btnHovered.current = true;
          // Close any other active interactive tooltip immediately
          if (activeTooltipDeactivate && activeTooltipDeactivate !== deactivateNow) {
            activeTooltipDeactivate();
            activeTooltipDeactivate = null;
          }
          if (hasExtra) activate();
        }}
        onMouseLeave={() => { btnHovered.current = false; if (hasExtra) scheduleDeactivate(); }}
      >
        {children}
      </button>
      <div
        ref={tooltipRef}
        className={`ctrl-tooltip${leftAlignTooltip ? ' left-align' : ''}${hasExtra ? ' tooltip-interactive' : ''}`}
        onMouseEnter={hasExtra ? cancelHide : undefined}
        onMouseLeave={hasExtra ? scheduleDeactivate : undefined}
      >
        {tooltip}
        {tooltipExtra}
      </div>
    </div>
  );
};

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
  precipitationEnabled = false,
  onTogglePrecipitation,
  windEnabled = false,
  onToggleWind,
  tempHistoryOpen,
  onToggleTempHistory,
  precipHistoryOpen,
  onTogglePrecipHistory,
  windHistoryOpen,
  onToggleWindHistory,
  cloudHistoryOpen,
  onToggleCloudHistory,
  connectionStatus,
  lastUpdate,
  lightningLayer,
}) => {
  const [infoVisible, setInfoVisible] = useState(false);
  const sliderTrackRef = useRef<HTMLDivElement>(null);

  const handleSliderInteraction = useCallback((clientX: number) => {
    const track = sliderTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onCloudOpacityChange?.(pct);
  }, [onCloudOpacityChange]);

  const handleSliderMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handleSliderInteraction(e.clientX);
    const onMove = (ev: MouseEvent) => handleSliderInteraction(ev.clientX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [handleSliderInteraction]);

  const isMoonView = viewTarget === 'moon';
  const hasData = !!hotspot;

  const historyRow = (
    isOpen: boolean | undefined,
    onToggle: (() => void) | undefined,
    layerActive: boolean,
    onActivateLayer?: () => void,
  ) => {
    if (!onToggle) return null;
    const handleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!layerActive && onActivateLayer) {
        onActivateLayer();
        onToggle();
      } else {
        onToggle();
      }
    };
    return (
      <div className={`ctrl-tooltip-history${!layerActive ? ' inactive' : ''}`} onClick={handleClick}>
        {isOpen && layerActive ? <X size={10} /> : <Play size={10} />}
        <span>{isOpen && layerActive ? 'Close history' : 'View history'}</span>
      </div>
    );
  };

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
      <CtrlBtn
        className={`globe-ctrl-btn ${cloudsEnabled ? 'active' : ''}`}
        onClick={onToggleClouds}
        ariaLabel={cloudsEnabled ? 'Hide clouds' : 'Show clouds'}
        tooltip="Clouds"
        hidden={isMoonView}
        tooltipExtra={
          <>
            <div className="cloud-slider-inline">
              <span className="cloud-slider-pct">{Math.round(cloudOpacity * 100)}% visibility</span>
              <div
                className="cloud-slider-track"
                ref={sliderTrackRef}
                onMouseDown={handleSliderMouseDown}
              >
                <div
                  className="cloud-slider-fill"
                  style={{ width: `${Math.round(cloudOpacity * 100)}%` }}
                />
                <div
                  className="cloud-slider-thumb"
                  style={{ left: `${Math.round(cloudOpacity * 100)}%` }}
                />
              </div>
            </div>
            {historyRow(cloudHistoryOpen, onToggleCloudHistory, cloudsEnabled, onToggleClouds)}
          </>
        }
      >
        {cloudsEnabled ? <Cloud size={16} /> : <CloudOff size={16} />}
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${lightningEnabled ? 'active' : ''}`}
        onClick={onToggleLightning}
        ariaLabel={lightningEnabled ? 'Hide lightning' : 'Show lightning'}
        tooltip={lightningEnabled ? 'Hide lightning' : 'Show lightning'}
        hidden={isMoonView}
        tooltipExtra={
          <div
            className={`ctrl-tooltip-history${
              isMoonView || !hasData || !lightningEnabled ? ' inactive' : ''
            }${!isMoonView && hasData && hasNewHotspot ? ' new-hotspot' : ''}`}
            onClick={(e) => { e.stopPropagation(); onGoToHotspot?.(); }}
          >
            <Flame size={10} />
            <span className="hotspot-row-text">{
              isMoonView
                ? 'Hotspots on Earth'
                : !hasData
                  ? 'Finding hotspot...'
                  : isViewingHotspot
                    ? 'At hotspot'
                    : 'Go to hotspot'
            }</span>
          </div>
        }
      >
        <Zap size={16} />
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${temperatureEnabled ? 'active' : ''}`}
        onClick={onToggleTemperature}
        ariaLabel={temperatureEnabled ? 'Hide temperature' : 'Show temperature'}
        tooltip={temperatureEnabled ? 'Hide temperature overlay' : 'Show temperature overlay'}
        hidden={isMoonView}
        tooltipExtra={historyRow(tempHistoryOpen, onToggleTempHistory, temperatureEnabled, onToggleTemperature)}
      >
        <Thermometer size={16} />
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${precipitationEnabled ? 'active' : ''}`}
        onClick={onTogglePrecipitation}
        ariaLabel={precipitationEnabled ? 'Hide precipitation' : 'Show precipitation'}
        tooltip={precipitationEnabled ? 'Hide precipitation overlay' : 'Show precipitation overlay'}
        hidden={isMoonView}
        tooltipExtra={historyRow(precipHistoryOpen, onTogglePrecipHistory, precipitationEnabled, onTogglePrecipitation)}
      >
        <CloudRain size={16} />
      </CtrlBtn>
      <CtrlBtn
        className={`globe-ctrl-btn ${windEnabled ? 'active' : ''}`}
        onClick={onToggleWind}
        ariaLabel={windEnabled ? 'Hide wind' : 'Show wind'}
        tooltip={windEnabled ? 'Hide wind overlay' : 'Show wind overlay'}
        hidden={isMoonView}
        tooltipExtra={historyRow(windHistoryOpen, onToggleWindHistory, windEnabled, onToggleWind)}
      >
        <Wind size={16} />
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
        className={`globe-ctrl-btn ${isOrbiting ? 'active' : ''}`}
        onClick={onToggleOrbit}
        ariaLabel={isOrbiting ? 'Stop orbit' : 'Start orbit'}
        tooltip={isOrbiting ? 'Stop auto-rotation' : 'Start auto-rotation'}
      >
        <RotateCcw size={16} />
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
