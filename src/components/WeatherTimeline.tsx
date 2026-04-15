import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import './WeatherTimeline.css';

interface FrameInfo {
  runId: string;
  timestamp: number;
}

interface Props {
  visible: boolean;
  frames: FrameInfo[];
  currentFrameId: string | null;
  onFrameChange: (runId: string) => void;
}

function formatHour(ts: number): string {
  const d = new Date(ts);
  const h = d.getUTCHours();
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function formatTimeFull(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${formatHour(ts)} UTC, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export const WeatherTimeline: React.FC<Props> = ({ visible, frames, currentFrameId, onFrameChange }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const currentIndex = frames.findIndex(f => f.runId === currentFrameId);
  const isAtNow = currentIndex === frames.length - 1;

  useEffect(() => {
    if (!isPlaying || frames.length < 2) {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
      playIntervalRef.current = null;
      return;
    }
    playIntervalRef.current = setInterval(() => {
      const idx = frames.findIndex(f => f.runId === currentFrameId);
      const nextIdx = (idx + 1) % frames.length;
      onFrameChange(frames[nextIdx].runId);
    }, 1000);
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying, frames, currentFrameId, onFrameChange]);

  useEffect(() => {
    if (!visible) setIsPlaying(false);
  }, [visible]);

  const handleTrackInteraction = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || frames.length < 2) return;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const idx = Math.round(pct * (frames.length - 1));
    onFrameChange(frames[idx].runId);
  }, [frames, onFrameChange]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsPlaying(false);
    handleTrackInteraction(e.clientX);
    const onMove = (ev: MouseEvent) => handleTrackInteraction(ev.clientX);
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [handleTrackInteraction]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (frames.length < 2) return;
    const idx = frames.findIndex(f => f.runId === currentFrameId);
    if (e.key === 'ArrowLeft' && idx > 0) {
      onFrameChange(frames[idx - 1].runId);
      setIsPlaying(false);
    } else if (e.key === 'ArrowRight' && idx < frames.length - 1) {
      onFrameChange(frames[idx + 1].runId);
      setIsPlaying(false);
    }
  }, [frames, currentFrameId, onFrameChange]);

  if (!visible || frames.length === 0) return null;

  const thumbPct = frames.length > 1
    ? (currentIndex / (frames.length - 1)) * 100
    : 50;

  const dateLabels: { pct: number; label: string }[] = [];
  let lastDate = '';
  frames.forEach((f, i) => {
    const d = formatDate(f.timestamp);
    if (d !== lastDate) {
      lastDate = d;
      dateLabels.push({
        pct: frames.length > 1 ? (i / (frames.length - 1)) * 100 : 50,
        label: d,
      });
    }
  });

  return (
    <div className="weather-timeline" tabIndex={0} onKeyDown={handleKeyDown}>
      <button
        className="weather-timeline-play"
        onClick={() => setIsPlaying(v => !v)}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div className="weather-timeline-track-wrap">
        <div className="weather-timeline-current">
          {currentIndex >= 0
            ? formatTimeFull(frames[currentIndex].timestamp)
            : ''}
        </div>
        <div
          className="weather-timeline-track"
          ref={trackRef}
          onMouseDown={handleMouseDown}
        >
          <div className="weather-timeline-fill" style={{ width: `${thumbPct}%` }} />
          {frames.map((f, i) => (
            <div
              key={f.runId}
              className={`weather-timeline-tick${f.runId === currentFrameId ? ' active' : ''}`}
              style={{ left: `${frames.length > 1 ? (i / (frames.length - 1)) * 100 : 50}%` }}
            />
          ))}
          <div
            className="weather-timeline-thumb"
            style={{ left: `${thumbPct}%` }}
          />
        </div>
        <div className="weather-timeline-labels">
          {frames.map((f, i) => (
            <div
              key={f.runId}
              className="weather-timeline-time-label"
              style={{ left: `${frames.length > 1 ? (i / (frames.length - 1)) * 100 : 50}%` }}
            >
              {formatHour(f.timestamp)}
            </div>
          ))}
        </div>
        {dateLabels.length > 1 && (
          <div className="weather-timeline-date-labels">
            {dateLabels.map(({ pct, label }) => (
              <div
                key={`${pct}-${label}`}
                className="weather-timeline-date-label"
                style={{ left: `${pct}%` }}
              >
                {label}
              </div>
            ))}
          </div>
        )}
        <div className="weather-timeline-now-label" style={{ left: '100%' }}>
          {isAtNow ? 'NOW' : ''}
        </div>
      </div>
    </div>
  );
};
