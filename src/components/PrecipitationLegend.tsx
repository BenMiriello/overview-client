import './PrecipitationLegend.css';

const RAIN_GRADIENT = [
  { rate: 0.1, rgb: [136, 204,  68] },
  { rate: 1,   rgb: [ 68, 170,   0] },
  { rate: 4,   rgb: [221, 221,   0] },
  { rate: 8,   rgb: [255, 136,   0] },
  { rate: 16,  rgb: [204,   0,   0] },
];

const SNOW_GRADIENT = [
  { rate: 0.1, rgb: [187, 170, 221] },
  { rate: 1,   rgb: [136, 102, 204] },
  { rate: 3,   rgb: [255, 102, 170] },
];

const BAR_H = 120;

const RAIN_TICKS = [1, 4, 8, 16];
const SNOW_TICKS = [0.1, 1, 3];

function makeGradient(stops: { rate: number; rgb: number[] }[], maxRate: number): string {
  return [...stops].reverse().map(({ rate, rgb }) => {
    const pct = ((maxRate - rate) / maxRate) * 100;
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${pct.toFixed(1)}%`;
  }).join(', ');
}

const rainGradient = makeGradient(RAIN_GRADIENT, 16);
const snowGradient = makeGradient(SNOW_GRADIENT, 3);

function rateToY(rate: number, maxRate: number, barH: number): number {
  return ((maxRate - rate) / maxRate) * barH;
}

function formatRate(r: number): string {
  return r < 1 ? r.toFixed(1) : String(Math.round(r));
}

interface Props {
  visible: boolean;
}

export const PrecipitationLegend: React.FC<Props> = ({ visible }) => {
  if (!visible) return null;

  return (
    <div className="precip-legend">
      <div className="precip-legend-section">
        <div className="precip-legend-label">Rain</div>
        <div className="precip-legend-colorbar-wrap">
          <div
            className="precip-legend-bar"
            style={{ background: `linear-gradient(to bottom, ${rainGradient})`, height: BAR_H }}
          />
          <div className="precip-legend-ticks" style={{ height: BAR_H }}>
            {RAIN_TICKS.map(rate => (
              <div key={rate} className="precip-legend-tick" style={{ top: rateToY(rate, 16, BAR_H) }}>
                <span className="precip-legend-tick-dash" />
                <span className="precip-legend-tick-label">{formatRate(rate)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="precip-legend-section">
        <div className="precip-legend-label">Snow</div>
        <div className="precip-legend-colorbar-wrap">
          <div
            className="precip-legend-bar"
            style={{ background: `linear-gradient(to bottom, ${snowGradient})`, height: 60 }}
          />
          <div className="precip-legend-ticks" style={{ height: 60 }}>
            {SNOW_TICKS.map(rate => (
              <div key={rate} className="precip-legend-tick" style={{ top: rateToY(rate, 3, 60) }}>
                <span className="precip-legend-tick-dash" />
                <span className="precip-legend-tick-label">{formatRate(rate)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="precip-legend-unit">mm/h</div>
    </div>
  );
};
