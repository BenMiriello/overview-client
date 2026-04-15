import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { precipToRGBA, PRECIP_TYPE_LABELS } from '../layers/PrecipitationLayer';
import './PrecipitationCursor.css';

interface CursorData {
  x: number;
  y: number;
  lat: number;
  lng: number;
  rate: number;
  type: number;
}

export interface PrecipitationCursorHandle {
  update: (data: CursorData | null) => void;
}

function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(2)}\u00B0 ${lat >= 0 ? 'N' : 'S'}`;
}

function formatLng(lng: number): string {
  return `${Math.abs(lng).toFixed(2)}\u00B0 ${lng >= 0 ? 'E' : 'W'}`;
}

export const PrecipitationCursor = forwardRef<PrecipitationCursorHandle>((_props, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dotRef       = useRef<HTMLSpanElement>(null);
  const rateRef      = useRef<HTMLSpanElement>(null);
  const typeRef      = useRef<HTMLDivElement>(null);
  const latRef       = useRef<HTMLDivElement>(null);
  const lngRef       = useRef<HTMLDivElement>(null);

  const renderDOM = useCallback((data: CursorData | null) => {
    const el = containerRef.current;
    if (!el || !dotRef.current || !rateRef.current || !typeRef.current || !latRef.current || !lngRef.current) return;
    if (!data) {
      el.style.display = 'none';
      return;
    }
    const [r, g, b, a] = precipToRGBA(data.rate, data.type);
    const hasColor = a > 0;
    el.style.display = 'block';
    el.style.left = `${data.x + 16}px`;
    el.style.top  = `${data.y}px`;
    dotRef.current.style.background = hasColor ? `rgb(${r},${g},${b})` : 'rgba(255,255,255,0.2)';
    rateRef.current.textContent = data.rate >= 0.1 ? `${data.rate.toFixed(1)} mm/h` : 'None';
    typeRef.current.textContent = PRECIP_TYPE_LABELS[data.type] ?? 'None';
    typeRef.current.style.display = data.rate >= 0.1 ? 'block' : 'none';
    latRef.current.textContent  = formatLat(data.lat);
    lngRef.current.textContent  = formatLng(data.lng);
  }, []);

  useImperativeHandle(ref, () => ({
    update: (data) => renderDOM(data),
  }), [renderDOM]);

  return (
    <div ref={containerRef} className="precip-cursor" style={{ display: 'none' }}>
      <div className="precip-cursor-rate">
        <span ref={dotRef} className="precip-cursor-dot" />
        <span ref={rateRef} />
      </div>
      <div ref={typeRef} className="precip-cursor-type" />
      <div ref={latRef} className="precip-cursor-coord" />
      <div ref={lngRef} className="precip-cursor-coord" />
    </div>
  );
});
