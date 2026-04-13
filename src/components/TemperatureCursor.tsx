import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { tempToRGB } from '../layers/TemperatureLayer';
import './TemperatureCursor.css';

interface CursorData {
  x: number;
  y: number;
  lat: number;
  lng: number;
  tempC: number;
}

export interface TemperatureCursorHandle {
  update: (data: CursorData | null) => void;
}

function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
}

function formatLng(lng: number): string {
  return `${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? 'E' : 'W'}`;
}

interface Props {
  unit: 'C' | 'F';
}

export const TemperatureCursor = forwardRef<TemperatureCursorHandle, Props>(({ unit }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dotRef       = useRef<HTMLSpanElement>(null);
  const tempRef      = useRef<HTMLSpanElement>(null);
  const latRef       = useRef<HTMLDivElement>(null);
  const lngRef       = useRef<HTMLDivElement>(null);
  const lastDataRef  = useRef<CursorData | null>(null);
  const unitRef      = useRef(unit);
  unitRef.current = unit;

  const renderDOM = useCallback((data: CursorData | null, u: 'C' | 'F') => {
    const el = containerRef.current;
    if (!el || !dotRef.current || !tempRef.current || !latRef.current || !lngRef.current) return;
    if (!data) {
      el.style.display = 'none';
      lastDataRef.current = null;
      return;
    }
    lastDataRef.current = data;
    const displayTemp = u === 'C' ? Math.round(data.tempC) : Math.round(data.tempC * 9 / 5 + 32);
    const [r, g, b] = tempToRGB(data.tempC);
    el.style.display = 'block';
    el.style.left = `${data.x + 16}px`;
    el.style.top  = `${data.y}px`;
    dotRef.current.style.background = `rgb(${r},${g},${b})`;
    tempRef.current.textContent = `${displayTemp}°${u}`;
    latRef.current.textContent  = formatLat(data.lat);
    lngRef.current.textContent  = formatLng(data.lng);
  }, []);

  // Re-render displayed value immediately when unit is toggled
  useEffect(() => {
    if (lastDataRef.current) renderDOM(lastDataRef.current, unit);
  }, [unit, renderDOM]);

  useImperativeHandle(ref, () => ({
    update: (data) => renderDOM(data, unitRef.current),
  }), [renderDOM]);

  return (
    <div ref={containerRef} className="temp-cursor" style={{ display: 'none' }}>
      <div className="temp-cursor-temp">
        <span ref={dotRef} className="temp-cursor-dot" />
        <span ref={tempRef} />
      </div>
      <div ref={latRef} className="temp-cursor-coord" />
      <div ref={lngRef} className="temp-cursor-coord" />
    </div>
  );
});
