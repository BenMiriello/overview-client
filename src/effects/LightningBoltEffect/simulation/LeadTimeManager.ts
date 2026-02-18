/**
 * Manages adaptive lead time based on device performance.
 * Ensures the worker stays far enough ahead to avoid buffer underruns.
 */
export class LeadTimeManager {
  private computeHistory: number[] = [];
  private strikeComputeHistory: number[] = [];
  private maxHistorySize = 20;

  // Configurable thresholds (in ms)
  // Must account for strike computation (4-6 seconds)
  private minLeadTime = 6000;
  private targetLeadTime = 10000;
  private maxLeadTime = 20000;

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
    // Worst-case strike time (or default if no data)
    const maxStrikeTime =
      this.strikeComputeHistory.length > 0
        ? Math.max(...this.strikeComputeHistory)
        : 3000;

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
   * Returns 1.0 (play) or 0.0 (pause) - binary decision only.
   *
   * IMPORTANT: Variable speed (0.25x, 0.5x, etc.) causes slow-motion physics
   * which looks wrong. We only ever play at full speed or pause completely.
   */
  suggestPlaybackSpeed(currentLeadTimeMs: number): number {
    const required = this.getRequiredLeadTime();
    return currentLeadTimeMs >= required ? 1.0 : 0.0;
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
