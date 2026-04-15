import './WindLegend.css';

const GRADIENT = [
  { speed: 0,  rgb: [ 68,  68, 170] },
  { speed: 2,  rgb: [ 68, 136, 221] },
  { speed: 5,  rgb: [ 68, 204,  68] },
  { speed: 10, rgb: [221, 221,   0] },
  { speed: 15, rgb: [255, 136,   0] },
  { speed: 20, rgb: [204,   0,   0] },
  { speed: 30, rgb: [255,   0, 255] },
];

const BAR_H = 160;
const MAX_SPEED = 30;
const TICKS = [0, 5, 10, 15, 20, 30];

function speedToY(speed: number): number {
  return ((MAX_SPEED - speed) / MAX_SPEED) * BAR_H;
}

const gradientStops = [...GRADIENT].reverse().map(({ speed, rgb }) => {
  const pct = ((MAX_SPEED - speed) / MAX_SPEED) * 100;
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${pct.toFixed(1)}%`;
}).join(', ');

interface Props {
  visible: boolean;
  unit: 'ms' | 'kmh' | 'kts';
  onUnitChange: (u: 'ms' | 'kmh' | 'kts') => void;
}

function convertSpeed(ms: number, unit: 'ms' | 'kmh' | 'kts'): number {
  if (unit === 'kmh') return Math.round(ms * 3.6);
  if (unit === 'kts') return Math.round(ms * 1.944);
  return ms;
}

function unitLabel(unit: 'ms' | 'kmh' | 'kts'): string {
  if (unit === 'kmh') return 'km/h';
  if (unit === 'kts') return 'kts';
  return 'm/s';
}

export const WindLegend: React.FC<Props> = ({ visible, unit, onUnitChange }) => {
  if (!visible) return null;

  const nextUnit = unit === 'ms' ? 'kmh' : unit === 'kmh' ? 'kts' : 'ms';

  return (
    <div className="wind-legend">
      <div className="wind-legend-row">
        <div className="wind-legend-colorbar-wrap">
          <div
            className="wind-legend-bar"
            style={{ background: `linear-gradient(to bottom, ${gradientStops})`, height: BAR_H }}
          />
          <div className="wind-legend-ticks" style={{ height: BAR_H }}>
            {TICKS.map(speed => (
              <div key={speed} className="wind-legend-tick" style={{ top: speedToY(speed) }}>
                <span className="wind-legend-tick-dash" />
                <span className="wind-legend-tick-label">{convertSpeed(speed, unit)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="wind-legend-unit-wrap">
          <button
            className="wind-legend-unit-btn"
            onClick={() => onUnitChange(nextUnit)}
          >
            {unitLabel(unit)}
          </button>
        </div>
      </div>
    </div>
  );
};
