/**
 * Per-connection bandwidth monitoring with periodic rate sampling.
 *
 * Tracks bytes sent/received per member and calculates throughput rates (KB/s)
 * using a configurable sampling interval. Used by SessionHost to monitor
 * bandwidth usage per connection (NET-08, T-01-08).
 */

interface MemberStats {
  bytesSent: number;
  bytesReceived: number;
  lastSample: number;
  /** Bytes sent at last sample point (for rate calculation) */
  prevBytesSent: number;
  /** Bytes received at last sample point (for rate calculation) */
  prevBytesReceived: number;
  rateOut: number; // KB/s
  rateIn: number;  // KB/s
}

export interface BandwidthStats {
  bytesSent: number;
  bytesReceived: number;
  rateOutKBps: number;
  rateInKBps: number;
}

export interface MemberBandwidthSummary {
  memberId: string;
  rateOutKBps: number;
  rateInKBps: number;
}

export class BandwidthMonitor {
  private readonly stats: Map<string, MemberStats> = new Map();
  private readonly sampleIntervalMs: number;

  constructor(sampleIntervalMs: number = 5000) {
    this.sampleIntervalMs = sampleIntervalMs;
  }

  /** Record bytes sent to a member. */
  recordSent(memberId: string, bytes: number): void {
    const entry = this.ensureEntry(memberId);
    entry.bytesSent += bytes;
    this.maybeRecalculate(entry);
  }

  /** Record bytes received from a member. */
  recordReceived(memberId: string, bytes: number): void {
    const entry = this.ensureEntry(memberId);
    entry.bytesReceived += bytes;
    this.maybeRecalculate(entry);
  }

  /** Get bandwidth stats for a single member. Returns null if member not tracked. */
  getStats(memberId: string): BandwidthStats | null {
    const entry = this.stats.get(memberId);
    if (!entry) {
      return null;
    }
    this.maybeRecalculate(entry);
    return {
      bytesSent: entry.bytesSent,
      bytesReceived: entry.bytesReceived,
      rateOutKBps: entry.rateOut,
      rateInKBps: entry.rateIn,
    };
  }

  /** Get bandwidth summary for all tracked members. */
  getAllStats(): MemberBandwidthSummary[] {
    const result: MemberBandwidthSummary[] = [];
    for (const [memberId, entry] of this.stats) {
      this.maybeRecalculate(entry);
      result.push({
        memberId,
        rateOutKBps: entry.rateOut,
        rateInKBps: entry.rateIn,
      });
    }
    return result;
  }

  /** Remove tracking for a disconnected member. */
  removeMember(memberId: string): void {
    this.stats.delete(memberId);
  }

  /** Clear all internal state. */
  dispose(): void {
    this.stats.clear();
  }

  /** Ensure a stats entry exists for the member. */
  private ensureEntry(memberId: string): MemberStats {
    let entry = this.stats.get(memberId);
    if (!entry) {
      entry = {
        bytesSent: 0,
        bytesReceived: 0,
        lastSample: Date.now(),
        prevBytesSent: 0,
        prevBytesReceived: 0,
        rateOut: 0,
        rateIn: 0,
      };
      this.stats.set(memberId, entry);
    }
    return entry;
  }

  /** Recalculate rates if enough time has elapsed since the last sample. */
  private maybeRecalculate(entry: MemberStats): void {
    const now = Date.now();
    const elapsed = now - entry.lastSample;
    if (elapsed >= this.sampleIntervalMs) {
      this.calculateRate(entry, elapsed);
      entry.lastSample = now;
    }
  }

  /** Compute KB/s from delta bytes / delta time. */
  private calculateRate(entry: MemberStats, elapsedMs: number): void {
    const elapsedSeconds = elapsedMs / 1000;
    if (elapsedSeconds <= 0) {
      return;
    }

    const deltaSent = entry.bytesSent - entry.prevBytesSent;
    const deltaReceived = entry.bytesReceived - entry.prevBytesReceived;

    entry.rateOut = deltaSent / 1024 / elapsedSeconds;
    entry.rateIn = deltaReceived / 1024 / elapsedSeconds;

    entry.prevBytesSent = entry.bytesSent;
    entry.prevBytesReceived = entry.bytesReceived;
  }
}
