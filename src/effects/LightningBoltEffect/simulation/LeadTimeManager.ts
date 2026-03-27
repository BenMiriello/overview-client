/**
 * Manages adaptive lead time based on device performance.
 * Ensures the worker stays far enough ahead to avoid buffer underruns.
 */
export class LeadTimeManager {
  private computeHistory: number[] = [];
  private strikeComputeHistory: number[] = [];
  private maxHistorySize = 20;

  // Conservative estimate based on detail level BEFORE we have actual strike data
  private defaultStrikeTimeMs: number;

  // Configurable thresholds (in ms)
  // With async geometry, snapshots flow continuously - lower thresholds needed
  private minLeadTime = 3000;
  private targetLeadTime = 8000;
  private maxLeadTime = 15000;

  constructor(detail: number = 1.0) {
    // Conservative: detail=1.0→15s, detail=2.0→35s
    this.defaultStrikeTimeMs = Math.max(10000, detail * 17500);
  }

  /**
   * Record a snapshot computation time.
   */
  recordSnapshotCompute(durationMs: number): void {
    this.computeHistory.push(durationMs);
    if (this.computeHistory.length > this.maxHistorySize) {
      this.computeHistory.shift();
    }
  }

  /**
   * Record a strike computation time (these are much longer).
   */
  recordStrikeCompute(durationMs: number): void {
    this.strikeComputeHistory.push(durationMs);
    if (this.strikeComputeHistory.length > this.maxHistorySize) {
      this.strikeComputeHistory.shift();
    }
  }

  /**
   * Get the required lead time based on observed performance.
   * This is the minimum buffer we need to avoid underruns.
   */
  getRequiredLeadTime(): number {
    // Use conservative default until we have actual strike data
    const maxStrikeTime =
      this.strikeComputeHistory.length > 0
        ? Math.max(...this.strikeComputeHistory)
        : this.defaultStrikeTimeMs;

    // Add safety margin (2x worst case)
    const required = Math.max(this.minLeadTime, maxStrikeTime * 2);
    return Math.min(required, this.maxLeadTime);
  }

  /**
   * Get the target lead time we should try to maintain.
   */
  getTargetLeadTime(): number {
    return Math.max(this.targetLeadTime, this.getRequiredLeadTime() * 1.5);
  }

  /**
   * Check if current lead time is sufficient.
   */
  isLeadTimeSufficient(currentLeadTimeMs: number): boolean {
    return currentLeadTimeMs >= this.getRequiredLeadTime();
  }

  /**
   * Suggest a playback speed multiplier based on buffer state.
   *
   * Uses gradual slowdown when buffer is getting low to avoid jarring pauses.
   * This is a deliberate tradeoff: very slow playback looks slightly odd,
   * but complete freezes for 1-2 minutes are much worse UX.
   *
   * The slowdown is aggressive enough that the buffer will catch up
   * during long strike computations (25+ seconds).
   */
  suggestPlaybackSpeed(currentLeadTimeMs: number): number {
    const required = this.getRequiredLeadTime();

    // Plenty of buffer - play at full speed
    if (currentLeadTimeMs >= required) {
      return 1.0;
    }

    // Critical threshold: below 2 seconds, pause completely
    const criticalMs = 2000;
    if (currentLeadTimeMs < criticalMs) {
      return 0.0;
    }

    // Gradual slowdown between critical and required
    // At half required, play at 0.25x; at quarter required, play at 0.1x
    const ratio = (currentLeadTimeMs - criticalMs) / (required - criticalMs);
    const speed = 0.1 + ratio * 0.9; // Range: 0.1 to 1.0
    return Math.min(1.0, Math.max(0.1, speed));
  }

  /**
   * Get average snapshot compute time (for debugging/tuning).
   */
  getAverageSnapshotTime(): number {
    if (this.computeHistory.length === 0) return 0;
    const sum = this.computeHistory.reduce((a, b) => a + b, 0);
    return sum / this.computeHistory.length;
  }

  /**
   * Get average strike compute time (for debugging/tuning).
   */
  getAverageStrikeTime(): number {
    if (this.strikeComputeHistory.length === 0) return 0;
    const sum = this.strikeComputeHistory.reduce((a, b) => a + b, 0);
    return sum / this.strikeComputeHistory.length;
  }

  /**
   * Reset all history (e.g., on settings change).
   */
  reset(): void {
    this.computeHistory = [];
    this.strikeComputeHistory = [];
  }

  /**
   * Get statistics for debugging.
   */
  getStats(): {
    requiredLeadTime: number;
    targetLeadTime: number;
    avgSnapshotTime: number;
    avgStrikeTime: number;
    maxStrikeTime: number;
    sampleCount: number;
  } {
    return {
      requiredLeadTime: this.getRequiredLeadTime(),
      targetLeadTime: this.getTargetLeadTime(),
      avgSnapshotTime: this.getAverageSnapshotTime(),
      avgStrikeTime: this.getAverageStrikeTime(),
      maxStrikeTime:
        this.strikeComputeHistory.length > 0
          ? Math.max(...this.strikeComputeHistory)
          : 0,
      sampleCount:
        this.computeHistory.length + this.strikeComputeHistory.length,
    };
  }
}
