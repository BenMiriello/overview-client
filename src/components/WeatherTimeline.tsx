import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Loader2, X } from 'lucide-react';
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
  readyFrameIds?: Set<string>;
  onRequestPrefetch?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  onClose?: () => void;
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

export const WeatherTimeline: React.FC<Props> = ({
  visible, frames, currentFrameId, onFrameChange,
  readyFrameIds, onRequestPrefetch, onPlayingChange, onClose,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const currentIndex = frames.findIndex(f => f.runId === currentFrameId);

  const allReady = !readyFrameIds
    ? true
    : frames.every(f => readyFrameIds.has(f.runId));

  // Notify parent of playing state changes
  useEffect(() => {
    onPlayingChange?.(isPlaying);
  }, [isPlaying, onPlayingChange]);

  // When loading and all frames become ready, start playback
  useEffect(() => {
    if (isLoading && allReady) {
      setIsLoading(false);
      setIsPlaying(true);
    }
  }, [isLoading, allReady]);

  // Playback interval — only advances to ready frames
  useEffect(() => {
    if (!isPlaying || frames.length < 2) {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
      playIntervalRef.current = null;
      return;
    }
    playIntervalRef.current = setInterval(() => {
      const idx = frames.findIndex(f => f.runId === currentFrameId);
      const nextIdx = (idx + 1) % frames.length;
      const nextId = frames[nextIdx].runId;
      if (readyFrameIds && !readyFrameIds.has(nextId)) {
        setIsPlaying(false);
        return;
      }
      onFrameChange(nextId);
    }, 1000);
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying, frames, currentFrameId, onFrameChange, readyFrameIds]);

  useEffect(() => {
    if (!visible) { setIsPlaying(false); setIsLoading(false); }
  }, [visible]);

  const handlePlayClick = useCallback(() => {
    if (isLoading) {
      setIsLoading(false);
      return;
    }
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (allReady) {
      setIsPlaying(true);
    } else {
      setIsLoading(true);
      onRequestPrefetch?.();
    }
  }, [isPlaying, isLoading, allReady, onRequestPrefetch]);

  const cancelPlayback = useCallback(() => {
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

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
    cancelPlayback();
    handleTrackInteraction(e.clientX);
    const onMove = (ev: MouseEvent) => handleTrackInteraction(ev.clientX);
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [handleTrackInteraction, cancelPlayback]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (frames.length < 2) return;
    const idx = frames.findIndex(f => f.runId === currentFrameId);
    if (e.key === 'ArrowLeft' && idx > 0) {
      onFrameChange(frames[idx - 1].runId);
      cancelPlayback();
    } else if (e.key === 'ArrowRight' && idx < frames.length - 1) {
      onFrameChange(frames[idx + 1].runId);
      cancelPlayback();
    }
  }, [frames, currentFrameId, onFrameChange, cancelPlayback]);

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
        className={`weather-timeline-play${isLoading ? ' loading' : ''}`}
        onClick={handlePlayClick}
        aria-label={isLoading ? 'Cancel loading' : isPlaying ? 'Pause' : 'Play'}
      >
        {isLoading
          ? <Loader2 size={14} className="weather-timeline-spinner" />
          : isPlaying
            ? <Pause size={14} />
            : <Play size={14} />
        }
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
      </div>
      <div
        className="weather-timeline-now-label"
        onClick={() => {
          if (frames.length > 0) {
            onFrameChange(frames[frames.length - 1].runId);
            cancelPlayback();
          }
        }}
      >
        NOW
      </div>
      {onClose && (
        <button
          className="weather-timeline-close"
          onClick={() => { cancelPlayback(); onClose(); }}
          aria-label="Close timeline"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};
