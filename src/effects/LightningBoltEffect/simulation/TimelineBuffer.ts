import {
  AtmosphereSnapshot,
  StrikeEvent,
  SimulationEvent,
} from './SimulationTimeline';

/**
 * Ring buffer for streaming simulation data.
 * Main thread writes incoming data, reads at playhead position.
 */
export class TimelineBuffer {
  private snapshots: AtmosphereSnapshot[] = [];
  private events: SimulationEvent[] = [];
  private maxSnapshots: number;

  // Timing state
  playheadMs: number = 0;
  bufferEndMs: number = 0;

  constructor(maxSnapshots: number = 200) {
    this.maxSnapshots = maxSnapshots;
  }

  /**
   * Current lead time (how far ahead the buffer is).
   */
  get leadTimeMs(): number {
    return this.bufferEndMs - this.playheadMs;
  }

  /**
   * Add a snapshot from the worker.
   */
  addSnapshot(snapshot: AtmosphereSnapshot): void {
    this.snapshots.push(snapshot);
    this.bufferEndMs = Math.max(this.bufferEndMs, snapshot.simTimeMs);

    // Trim old snapshots beyond playhead
    while (this.snapshots.length > this.maxSnapshots) {
      const oldest = this.snapshots[0];
      if (oldest.simTimeMs < this.playheadMs - 1000) {
        this.snapshots.shift();
      } else {
        break;
      }
    }
  }

  /**
   * Add a strike event from the worker.
   */
  addEvent(event: SimulationEvent): void {
    const beforeCount = this.events.length;
    this.events.push(event);
    this.events.sort((a, b) => a.simTimeMs - b.simTimeMs);

    // Trim old events
    this.events = this.events.filter(
      (e) => e.simTimeMs > this.playheadMs - 5000
    );
    console.log(`[TimelineBuffer] Event added: simTime=${event.simTimeMs.toFixed(0)}, playhead=${this.playheadMs.toFixed(0)}, events: ${beforeCount} -> ${this.events.length}`);
  }

  /**
   * Get the snapshot at or before the given time.
   * Returns the nearest snapshot without interpolation to avoid
   * artifacts from cell regeneration (cells teleporting when they go out of bounds).
   */
  getSnapshot(simTimeMs: number): AtmosphereSnapshot | null {
    if (this.snapshots.length === 0) return null;

    // Find the snapshot closest to the requested time
    let closest: AtmosphereSnapshot | null = null;
    let closestDist = Infinity;

    for (const snap of this.snapshots) {
      const dist = Math.abs(snap.simTimeMs - simTimeMs);
      if (dist < closestDist) {
        closestDist = dist;
        closest = snap;
      }
    }

    return closest;
  }

  /**
   * Get events within a time range (exclusive start, inclusive end).
   * Marks them as consumed.
   */
  consumeEvents(startMs: number, endMs: number): StrikeEvent[] {
    const consumed: StrikeEvent[] = [];
    const remaining: SimulationEvent[] = [];

    for (const event of this.events) {
      if (event.simTimeMs > startMs && event.simTimeMs <= endMs) {
        consumed.push(event);
      } else if (event.simTimeMs > endMs) {
        // Future event - keep it
        remaining.push(event);
      }
      // Events in the past (simTimeMs <= startMs) are dropped
    }

    if (consumed.length > 0) {
      console.log(`[TimelineBuffer] Consumed ${consumed.length} events in range [${startMs.toFixed(0)}, ${endMs.toFixed(0)}], ${remaining.length} remaining`);
    }

    this.events = remaining;
    return consumed;
  }

  /**
   * Peek at upcoming events without consuming.
   */
  peekEvents(startMs: number, endMs: number): StrikeEvent[] {
    return this.events.filter(
      (e) => e.simTimeMs > startMs && e.simTimeMs <= endMs
    );
  }

  /**
   * Check if we have any upcoming strike in the near future.
   */
  hasUpcomingStrike(withinMs: number): boolean {
    const deadline = this.playheadMs + withinMs;
    return this.events.some((e) => e.simTimeMs <= deadline);
  }

  /**
   * Advance playhead to new time.
   */
  advancePlayhead(newTimeMs: number): void {
    this.playheadMs = newTimeMs;
  }

  /**
   * Mark all data after a certain time as stale (for settings changes).
   */
  markStaleAfter(simTimeMs: number): void {
    this.snapshots = this.snapshots.filter((s) => s.simTimeMs <= simTimeMs);
    this.events = this.events.filter((e) => e.simTimeMs <= simTimeMs);
    this.bufferEndMs = Math.min(this.bufferEndMs, simTimeMs);
  }

  /**
   * Reset the buffer completely.
   */
  reset(): void {
    this.snapshots = [];
    this.events = [];
    this.playheadMs = 0;
    this.bufferEndMs = 0;
  }

  /**
   * Get buffer statistics for debugging.
   */
  getStats(): {
    snapshotCount: number;
    eventCount: number;
    leadTimeMs: number;
    playheadMs: number;
    bufferEndMs: number;
  } {
    return {
      snapshotCount: this.snapshots.length,
      eventCount: this.events.length,
      leadTimeMs: this.leadTimeMs,
      playheadMs: this.playheadMs,
      bufferEndMs: this.bufferEndMs,
    };
  }

}
