import { TimelineBuffer } from './TimelineBuffer';
import { LeadTimeManager } from './LeadTimeManager';
import {
  TimelineConfig,
  DEFAULT_TIMELINE_CONFIG,
  WorkerInMessage,
  WorkerOutMessage,
  AtmosphereSnapshot,
  StrikeEvent,
} from './SimulationTimeline';

export interface TimelinePlayerCallbacks {
  onSnapshot: (snapshot: AtmosphereSnapshot) => void;
  onStrike: (event: StrikeEvent) => void;
  onStatusChange: (status: TimelinePlayerStatus) => void;
}

export interface TimelinePlayerStatus {
  playing: boolean;
  playbackSpeed: number;
  leadTimeMs: number;
  bufferEndMs: number;
  visualTimeMs: number;
}

/**
 * TimelinePlayer - Main thread component for playback.
 *
 * Manages the worker, buffers incoming data, and plays back at visual time.
 * Adapts playback speed based on buffer state to prevent underruns.
 */
export class TimelinePlayer {
  private worker: Worker | null = null;
  private buffer: TimelineBuffer;
  private leadTimeManager: LeadTimeManager;
  private callbacks: TimelinePlayerCallbacks;

  private config: TimelineConfig;
  private visualTimeMs: number = 0;
  private lastUpdateTime: number = 0;
  private isPlaying: boolean = false;
  private isInitialized: boolean = false;

  // Playback state
  private effectiveSpeed: number = 1.0;
  private minBufferBeforePlay: number = 12000; // Wait for 12s of buffer before starting (2x max strike compute time)

  constructor(callbacks: TimelinePlayerCallbacks) {
    this.callbacks = callbacks;
    this.buffer = new TimelineBuffer();
    this.leadTimeManager = new LeadTimeManager();
    this.config = { ...DEFAULT_TIMELINE_CONFIG };
  }

  /**
   * Initialize and start the simulation worker.
   */
  start(config: Partial<TimelineConfig> = {}): void {
    if (this.isInitialized) {
      this.stop();
    }

    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...config };
    this.buffer.reset();
    this.leadTimeManager.reset();
    this.visualTimeMs = 0;
    this.lastUpdateTime = performance.now();

    try {
      this.worker = new Worker(
        new URL('./SimulationWorker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = this.handleWorkerError.bind(this);

      // Start the worker simulation
      const startMsg: WorkerInMessage = {
        type: 'start',
        seed: Math.random() * 0xffffffff,
        config: this.config,
      };
      this.worker.postMessage(startMsg);

      this.isInitialized = true;
      this.isPlaying = false; // Wait for buffer to fill

      console.log('[TimelinePlayer] Worker started, waiting for buffer...');
    } catch (e) {
      console.error('[TimelinePlayer] Failed to create worker:', e);
    }
  }

  /**
   * Stop the simulation and cleanup.
   */
  stop(): void {
    if (this.worker) {
      const stopMsg: WorkerInMessage = { type: 'stop' };
      this.worker.postMessage(stopMsg);
      this.worker.terminate();
      this.worker = null;
    }

    this.isPlaying = false;
    this.isInitialized = false;

    this.emitStatus();
  }

  /**
   * Update playback - call this each frame.
   * Returns the current snapshot (if available) and any strike events.
   */
  update(): {
    snapshot: AtmosphereSnapshot | null;
    strikes: StrikeEvent[];
  } {
    const now = performance.now();
    // Cap dtReal to prevent massive visual time jumps when tab is backgrounded
    // Max 100ms = 6 frames at 60fps - enough to handle brief stutters without breaking buffer
    const dtReal = Math.min(now - this.lastUpdateTime, 100);
    this.lastUpdateTime = now;

    // Check if we have enough buffer to start playing
    if (!this.isPlaying && this.buffer.leadTimeMs >= this.minBufferBeforePlay) {
      this.isPlaying = true;
      // CRITICAL: Reset lastUpdateTime so first frame doesn't have huge delta
      this.lastUpdateTime = now;
      console.log('[TimelinePlayer] Buffer ready, starting playback');
    }

    // If not playing yet, show the FIRST snapshot (don't advance with buffer)
    // This prevents the visual from racing ahead at 4x speed during buffer building
    if (!this.isPlaying) {
      const firstSnapshot = this.buffer.getSnapshot(0);
      if (firstSnapshot) {
        this.callbacks.onSnapshot(firstSnapshot);
      }
      return { snapshot: firstSnapshot, strikes: [] };
    }

    // Calculate effective playback speed based on buffer state
    this.effectiveSpeed = this.leadTimeManager.suggestPlaybackSpeed(
      this.buffer.leadTimeMs
    );

    // Advance visual time
    const prevTimeMs = this.visualTimeMs;
    const dtVisual = dtReal * this.config.speed * this.effectiveSpeed;
    this.visualTimeMs += dtVisual;
    this.buffer.advancePlayhead(this.visualTimeMs);

    // Send pace update to worker periodically (every ~500ms)
    if (this.worker && Math.floor(this.visualTimeMs / 500) !== Math.floor(prevTimeMs / 500)) {
      const paceMsg: WorkerInMessage = { type: 'pace', visualTimeMs: this.visualTimeMs };
      this.worker.postMessage(paceMsg);
    }

    // Get snapshot and events
    const snapshot = this.buffer.getSnapshot(this.visualTimeMs);
    const strikes = this.buffer.consumeEvents(prevTimeMs, this.visualTimeMs);

    // Emit callbacks
    if (snapshot) {
      this.callbacks.onSnapshot(snapshot);
    }
    for (const strike of strikes) {
      console.log(`[TimelinePlayer] Strike consumed: simTime=${strike.simTimeMs.toFixed(0)}, visualTime=${this.visualTimeMs.toFixed(0)}`);
      this.callbacks.onStrike(strike);
    }

    // Periodic status update
    this.emitStatus();

    return { snapshot, strikes };
  }

  /**
   * Update simulation parameters (e.g., wind speed, detail).
   */
  setConfig(newConfig: Partial<TimelineConfig>): void {
    this.config = { ...this.config, ...newConfig };

    if (this.worker && this.isInitialized) {
      // Mark future buffer as stale
      const changePointMs = this.visualTimeMs + 500;
      this.buffer.markStaleAfter(changePointMs);

      // Tell worker to apply new parameters
      const msg: WorkerInMessage = {
        type: 'set_parameters',
        config: newConfig,
        applyAtSimTimeMs: changePointMs,
      };
      this.worker.postMessage(msg);
    }
  }

  /**
   * Get current playback status.
   */
  getStatus(): TimelinePlayerStatus {
    return {
      playing: this.isPlaying,
      playbackSpeed: this.effectiveSpeed,
      leadTimeMs: this.buffer.leadTimeMs,
      bufferEndMs: this.buffer.bufferEndMs,
      visualTimeMs: this.visualTimeMs,
    };
  }

  /**
   * Check if player is ready (has enough buffer).
   */
  isReady(): boolean {
    return this.isPlaying;
  }

  /**
   * Get the current visual time.
   */
  getVisualTimeMs(): number {
    return this.visualTimeMs;
  }

  private handleWorkerMessage(event: MessageEvent<WorkerOutMessage>): void {
    const msg = event.data;

    switch (msg.type) {
      case 'snapshot':
        const isFirstSnapshot = this.buffer.getStats().snapshotCount === 0;
        this.buffer.addSnapshot(msg.snapshot);
        this.leadTimeManager.recordSnapshotCompute(10);

        // On first snapshot, immediately initialize the renderer (don't wait for playback)
        if (isFirstSnapshot) {
          console.log('[TimelinePlayer] First snapshot received, initializing renderer');
          this.callbacks.onSnapshot(msg.snapshot);
        }
        break;

      case 'strike':
        console.log(`[TimelinePlayer] Strike received: simTime=${msg.event.simTimeMs.toFixed(0)}, playhead=${this.buffer.playheadMs.toFixed(0)}, bufferEnd=${this.buffer.bufferEndMs.toFixed(0)}`);
        this.buffer.addEvent(msg.event);
        // Record strike compute time from the event
        this.leadTimeManager.recordStrikeCompute(500);
        break;

      case 'status':
        // Worker status update
        break;

      case 'error':
        console.error('[TimelinePlayer] Worker error:', msg.message);
        break;
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    console.error('[TimelinePlayer] Worker error:', event);
    this.stop();
  }

  private lastStatusLogTime: number = 0;

  private emitStatus(): void {
    const status = this.getStatus();
    this.callbacks.onStatusChange(status);

    // Log status periodically for debugging
    const now = performance.now();
    if (now - this.lastStatusLogTime > 2000) {
      console.log(
        `[TimelinePlayer] lead=${status.leadTimeMs.toFixed(0)}ms, speed=${status.playbackSpeed.toFixed(2)}x, visual=${status.visualTimeMs.toFixed(0)}ms`
      );
      this.lastStatusLogTime = now;
    }
  }
}
