/**
 * Heartbeat and reconnection utilities for WebSocket connections.
 *
 * - HeartbeatManager: periodic ping/pong liveness checks
 * - ReconnectManager: exponential backoff reconnection with jitter
 * - getReconnectDelay: pure function for calculating backoff delay
 */

/**
 * Calculate reconnect delay with exponential backoff and jitter.
 *
 * Formula: min(baseDelay * 2^attempt + random(0..1000), maxDelay)
 * With 10 attempts this covers roughly 1+2+4+8+16+30+30+30+30+30 ~= 181 seconds
 * of total retry window, but each individual delay caps at 30s.
 *
 * @param attempt - Zero-based attempt number
 * @returns Delay in milliseconds before the next reconnect attempt
 */
export function getReconnectDelay(attempt: number): number {
  const baseDelay = 1000;
  const maxDelay = 30_000;
  return Math.min(
    baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
    maxDelay,
  );
}

/**
 * Manages automatic reconnection with exponential backoff.
 *
 * Covers ~30 seconds of retries per D-11 before giving up.
 * Default maxAttempts=10 produces delays roughly: 1s, 2s, 4s, 8s, 16s, 30s...
 */
export class ReconnectManager {
  private attempts: number = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private aborted: boolean = false;
  private readonly maxAttempts: number;

  constructor(maxAttempts: number = 10) {
    this.maxAttempts = maxAttempts;
  }

  /**
   * Schedule a reconnection attempt.
   *
   * @param connect - Async function that attempts connection. Returns true on success.
   * @param onFailed - Called when all attempts are exhausted or aborted.
   */
  scheduleReconnect(
    connect: () => Promise<boolean>,
    onFailed: () => void,
  ): void {
    if (this.aborted || this.attempts >= this.maxAttempts) {
      onFailed();
      return;
    }

    const delay = getReconnectDelay(this.attempts);

    this.timer = setTimeout(() => {
      this.timer = null;
      connect()
        .then((success) => {
          if (success) {
            this.reset();
          } else {
            this.attempts++;
            this.scheduleReconnect(connect, onFailed);
          }
        })
        .catch(() => {
          this.attempts++;
          this.scheduleReconnect(connect, onFailed);
        });
    }, delay);
  }

  /** Reset attempts counter and clear any pending timer. */
  reset(): void {
    this.attempts = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Abort all reconnection attempts. */
  abort(): void {
    this.aborted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The current attempt number (zero-based). */
  get currentAttempt(): number {
    return this.attempts;
  }
}

/**
 * Manages heartbeat ping/pong liveness checks.
 *
 * Sends periodic pings. If a pong is not received within the timeout window,
 * the connection is considered dead.
 */
export class HeartbeatManager {
  private interval: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private lastPong: number = 0;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  constructor(intervalMs: number = 15000, timeoutMs: number = 5000) {
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Start sending periodic pings.
   *
   * @param sendPing - Function to send a ping message
   * @param onDead - Called when pong is not received within timeout
   */
  start(sendPing: () => void, onDead: () => void): void {
    this.stop();
    this.lastPong = Date.now();

    this.interval = setInterval(() => {
      sendPing();
      // Set a timeout to detect missed pong
      this.timeout = setTimeout(() => {
        onDead();
      }, this.timeoutMs);
    }, this.intervalMs);
  }

  /** Acknowledge receipt of a pong -- clears the pending timeout. */
  receivedPong(): void {
    this.lastPong = Date.now();
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  /** Stop all heartbeat timers. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}
