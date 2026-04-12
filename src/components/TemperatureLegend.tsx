import { useState } from 'react';
import './TemperatureLegend.css';

// Color stops — used only for the gradient
const COLORMAP = [
  { temp: -40, rgb: [120,   0, 180] as const },
  { temp: -25, rgb: [ 30,  30, 220] as const },
  { temp: -10, rgb: [  0, 130, 255] as const },
  { temp:   0, rgb: [  0, 220, 220] as const },
  { temp:  10, rgb: [  0, 200,  60] as const },
  { temp:  20, rgb: [200, 230,   0] as const },
  { temp:  28, rgb: [255, 165,   0] as const },
  { temp:  38, rgb: [220,   0,   0] as const },
  { temp:  48, rgb: [120,   0,  40] as const },
];

// Uniform 10°C tick marks
const TICKS = [-40, -30, -20, -10, 0, 10, 20, 30, 40];

const BAR_H = 200;
const MAX_T = 40;   // matches top tick — bar range = tick range, so top/bottom are symmetric
const MIN_T = -40;
const RANGE = MAX_T - MIN_T;

function tempToY(temp: number): number {
  return ((MAX_T - temp) / RANGE) * BAR_H;
}

function cToF(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

const gradientStops = [...COLORMAP].reverse().map(({ temp, rgb }) => {
  const pct = ((MAX_T - temp) / RANGE) * 100;
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${pct.toFixed(1)}%`;
}).join(', ');

interface Props {
  visible: boolean;
}

export const TemperatureLegend: React.FC<Props> = ({ visible }) => {
  const [unit, setUnit] = useState<'C' | 'F'>('C');

  if (!visible) return null;

  return (
    <div className="temp-legend">
      <div className="temp-legend-row">
        <div className="temp-legend-colorbar-wrap">
          <div
            className="temp-legend-bar"
            style={{ background: `linear-gradient(to bottom, ${gradientStops})` }}
          />
          <div className="temp-legend-ticks">
            {TICKS.map(temp => (
              <div key={temp} className="temp-legend-tick" style={{ top: tempToY(temp) }}>
                <span className="temp-legend-tick-dash" />
                <span className="temp-legend-tick-label">
                  {unit === 'C' ? `${temp}°` : `${cToF(temp)}°`}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="temp-legend-unit-wrap">
          <button
            className="temp-legend-unit-btn"
            onClick={() => setUnit(u => u === 'C' ? 'F' : 'C')}
          >
            {unit === 'C' ? '°C' : '°F'}
          </button>
        </div>
      </div>
    </div>
  );
};
