import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { windSpeedToRGB } from '../layers/WindLayer';
import './WindCursor.css';

interface CursorData {
  x: number;
  y: number;
  lat: number;
  lng: number;
  speed: number;
  direction: number;
}

export interface WindCursorHandle {
  update: (data: CursorData | null) => void;
}

function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(2)}\u00B0 ${lat >= 0 ? 'N' : 'S'}`;
}

function formatLng(lng: number): string {
  return `${Math.abs(lng).toFixed(2)}\u00B0 ${lng >= 0 ? 'E' : 'W'}`;
}

function directionToCardinal(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

interface Props {
  unit: 'ms' | 'kmh' | 'kts';
}

export const WindCursor = forwardRef<WindCursorHandle, Props>(({ unit }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dotRef       = useRef<HTMLSpanElement>(null);
  const speedRef     = useRef<HTMLSpanElement>(null);
  const dirRef       = useRef<HTMLDivElement>(null);
  const latRef       = useRef<HTMLDivElement>(null);
  const lngRef       = useRef<HTMLDivElement>(null);
  const lastDataRef  = useRef<CursorData | null>(null);
  const unitRef      = useRef(unit);
  unitRef.current = unit;

  const formatSpeed = (ms: number, u: 'ms' | 'kmh' | 'kts'): string => {
    if (u === 'kmh') return `${(ms * 3.6).toFixed(1)} km/h`;
    if (u === 'kts') return `${(ms * 1.944).toFixed(1)} kts`;
    return `${ms.toFixed(1)} m/s`;
  };

  const renderDOM = useCallback((data: CursorData | null, u: 'ms' | 'kmh' | 'kts') => {
    const el = containerRef.current;
    if (!el || !dotRef.current || !speedRef.current || !dirRef.current || !latRef.current || !lngRef.current) return;
    if (!data) {
      el.style.display = 'none';
      lastDataRef.current = null;
      return;
    }
    lastDataRef.current = data;
    const [r, g, b] = windSpeedToRGB(data.speed);
    el.style.display = 'block';
    el.style.left = `${data.x + 16}px`;
    el.style.top  = `${data.y}px`;
    dotRef.current.style.background = `rgb(${r},${g},${b})`;
    speedRef.current.textContent = formatSpeed(data.speed, u);
    dirRef.current.textContent = `${directionToCardinal(data.direction)} (${data.direction}\u00B0)`;
    latRef.current.textContent  = formatLat(data.lat);
    lngRef.current.textContent  = formatLng(data.lng);
  }, []);

  useEffect(() => {
    if (lastDataRef.current) renderDOM(lastDataRef.current, unit);
  }, [unit, renderDOM]);

  useImperativeHandle(ref, () => ({
    update: (data) => renderDOM(data, unitRef.current),
  }), [renderDOM]);

  return (
    <div ref={containerRef} className="wind-cursor" style={{ display: 'none' }}>
      <div className="wind-cursor-speed">
        <span ref={dotRef} className="wind-cursor-dot" />
        <span ref={speedRef} />
      </div>
      <div ref={dirRef} className="wind-cursor-dir" />
      <div ref={latRef} className="wind-cursor-coord" />
      <div ref={lngRef} className="wind-cursor-coord" />
    </div>
  );
});
