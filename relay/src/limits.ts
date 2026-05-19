/**
 * Relay defensive minimum (CONTEXT D-11, D-10; threat IDs T-07-06, T-07-07, T-07-08).
 *
 * Sliding-window rate limit ported from src/host/AuthHandler.ts:61-87 (extension).
 * AuthHandler uses a {attempts, lastAttempt} fixed-window struct; this relay-side
 * impl uses a TRUE sliding-window timestamp array because CONTEXT D-11 specifies
 * "30/min per source IP" as a rolling window (any 60s of traffic counts), not a
 * fixed bucket. Different shape, same algorithmic family.
 *
 * Pure-policy module — zero imports beyond Node stdlib (this file has zero
 * import statements). server.ts and SessionRegistry.ts are the wiring
 * orchestrators (see plan 07-10). limits.ts itself NEVER logs and NEVER
 * imports pino — callers do `logger.warn({event:'rate-limit', ip})` on reject.
 *
 * Locked env-var schema (CONTEXT D-11 + D-10 defaults, all overridable):
 *   VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP  default 30
 *   VERSIONCON_MAX_SESSIONS                    default 1000
 *   VERSIONCON_MAX_MEMBERS_PER_SESSION         default 50
 *   VERSIONCON_MAX_FRAME_BYTES                 default 1048576 (1 MiB)
 *   VERSIONCON_IDLE_REAP_MINUTES               default 30
 *   VERSIONCON_HOST_DROP_GRACE_SECONDS         default 60
 */

/**
 * Parse `process.env[key]` as a positive integer. Returns `fallback` if the
 * env var is absent, non-numeric, or `<= 0`. A negative or zero cap is
 * nonsense (it would disable the defense), so we fail-safe to the default.
 */
function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

// Module-load-time constants — read once from process.env.
const MAX_PER_MIN = parseEnvInt('VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP', 30);
const WINDOW_MS = 60_000;
const MAX_SESSIONS = parseEnvInt('VERSIONCON_MAX_SESSIONS', 1000);
const MAX_MEMBERS_PER_SESSION = parseEnvInt('VERSIONCON_MAX_MEMBERS_PER_SESSION', 50);
const MAX_FRAME_BYTES = parseEnvInt('VERSIONCON_MAX_FRAME_BYTES', 1024 * 1024);
const IDLE_REAP_MS = parseEnvInt('VERSIONCON_IDLE_REAP_MINUTES', 30) * 60_000;
const HOST_DROP_GRACE_MS = parseEnvInt('VERSIONCON_HOST_DROP_GRACE_SECONDS', 60) * 1_000;

// Sliding-window state — per-IP timestamp array. Pruned on every check.
const ipHits: Map<string, number[]> = new Map();

// GC counter — every 1024 checks we sweep the Map for empty entries so the
// Map size is bounded by ACTIVE (recently-hitting) IPs rather than historical
// (one-shot) IPs. Without this a long-running relay seeing many distinct IPs
// over hours leaks Map entries (T-07-15 defensive mitigation).
let cleanCounter = 0;
const CLEAN_EVERY = 1024;

/**
 * Sliding-window per-IP connection rate limit.
 *
 * Algorithm:
 *   1. Compute `cutoff = now - WINDOW_MS`.
 *   2. Look up the IP's timestamp array; default to empty.
 *   3. Drop every timestamp older than `cutoff` (prune step).
 *   4. If the pruned array has `>= MAX_PER_MIN` entries, reject (return false)
 *      and persist the pruned array so subsequent checks are cheaper.
 *   5. Otherwise, push `now` onto the pruned array, persist, and return true.
 *
 * Cost: O(k) per check where k is the number of timestamps in the IP's window
 * (bounded by MAX_PER_MIN = 30 — see threat T-07-18 in the plan).
 */
export function checkConnection(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const arr = ipHits.get(ip) ?? [];

  // Prune: find first index whose timestamp is in-window, then slice.
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  const pruned = i === 0 ? arr : arr.slice(i);

  // Periodic GC sweep — bounds the Map for long-running processes.
  cleanCounter++;
  if (cleanCounter >= CLEAN_EVERY) {
    cleanCounter = 0;
    for (const [k, v] of ipHits) {
      let j = 0;
      while (j < v.length && v[j] < cutoff) j++;
      if (j >= v.length) ipHits.delete(k);
      else if (j > 0) ipHits.set(k, v.slice(j));
    }
  }

  if (pruned.length >= MAX_PER_MIN) {
    ipHits.set(ip, pruned);
    return false;
  }
  pruned.push(now);
  ipHits.set(ip, pruned);
  return true;
}

/**
 * Hard cap on the total number of registered sessions per relay process.
 * Returns true when the next register would still be under the cap.
 * Caller is server.ts / SessionRegistry.register() — on false, the relay
 * closes the WSS connection with code 4429 (T-07-07).
 */
export function canRegisterSession(currentSessionCount: number): boolean {
  return currentSessionCount < MAX_SESSIONS;
}

/**
 * Hard cap on the number of attached members in a single session.
 * Returns true when the next attach would still be under the cap.
 * Caller is SessionRegistry.attachMember() — on false, the relay closes
 * the member WSS connection with code 4429 (T-07-13).
 */
export function canAttachMember(currentMemberCount: number): boolean {
  return currentMemberCount < MAX_MEMBERS_PER_SESSION;
}

/**
 * Maximum inbound frame size in bytes. Wired into the WebSocketServer
 * constructor as `maxPayload` — the `ws` library rejects oversized frames
 * at the protocol layer before they reach application code (T-07-08).
 */
export function getMaxPayloadBytes(): number {
  return MAX_FRAME_BYTES;
}

/**
 * Idle reaper threshold in ms. A session whose `lastActivity` is older
 * than this is reaped (closed) on the next reaper-pass tick.
 */
export function getIdleReapInterval(): number {
  return IDLE_REAP_MS;
}

/**
 * Host-drop grace period in ms. When the host socket on a registered
 * session closes, SessionRegistry.detach() starts a `setTimeout` of this
 * duration before tearing the session down. If the host re-registers
 * within the window, the timer is cancelled.
 */
export function getHostDropGraceMs(): number {
  return HOST_DROP_GRACE_MS;
}

/**
 * Test seam — clears the per-IP sliding-window state. Used by
 * `relay/test/limits.test.js` between tests so per-IP state does not leak
 * across tests. Prefix `__` marks this as an internal API; production code
 * MUST NOT call this.
 */
export function __resetForTesting(): void {
  ipHits.clear();
  cleanCounter = 0;
}
