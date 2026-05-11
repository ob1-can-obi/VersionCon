/**
 * Phase 5 Wave 4 (Plan 05-04) — host-process AST coordinator.
 *
 * Owns one long-lived child_process.fork()'d worker (dist/ast-worker.js) and
 * mediates every analyzeChange call between the host and that worker. The
 * worker (src/ast/worker.ts) does ALL Wasm parsing / extracting / joining —
 * this file stays vscode-aware-but-vscode-free (no vscode imports) so the
 * worker module tree never accidentally pulls vscode in via the analyzer.
 *
 * Public API:
 *
 *   const analyzer = new AstAnalyzer(workspaceRoot, branchDir);
 *   const result = await analyzer.analyzeChange({
 *     changedFiles, memberTrackedFiles, memberDisplayNames,
 *   });
 *   analyzer.dispose();   // kills the worker
 *
 * Threat mitigations:
 *
 *   - **T-05-01 (worker crash)**: subscribe to the worker's `exit` event;
 *     on unexpected exit, settle all pending requests with empty
 *     AnalysisResult and clear the worker handle so the next analyzeChange
 *     lazy-forks fresh. After 3 consecutive failures (crash OR timeout),
 *     opens the 30s circuit — short-circuits without forking until the
 *     cooldown elapses. Prevents fork-bombing when the worker is reliably
 *     broken.
 *
 *   - **T-05-02 (slowloris parse)**: every analyzeChange wraps the worker's
 *     reply in setTimeout (default 5s; tests override to 200ms). On fire,
 *     the worker is SIGTERM-killed and the request resolves with the empty
 *     AnalysisResult. Worker is re-forked lazily on the next call.
 *
 *   - **T-05-03 (path escape)**: validateAndFilter runs BEFORE every IPC
 *     send. Rejects absolute paths (leading `/`, drive-letter `C:\\`),
 *     backslash separators, segment-aware traversal (`segments.includes('..')`
 *     mirrors Plan 04-15 CR-03-NEW), and overlong paths (>1024 chars).
 *     Rejected entries are silently dropped from the payload. If every entry
 *     is rejected, the analyzer returns the empty AnalysisResult without
 *     forking.
 *
 * Design choices:
 *
 *   - The analyzer is constructed lazily — the worker is not forked until
 *     the first analyzeChange call that survives path validation. Keeps
 *     test setup cheap and avoids paying the worker boot cost when there is
 *     nothing to analyze.
 *
 *   - One worker handles all concurrent requests via requestId-based dispatch.
 *     The worker is sync-safe (it processes messages in receive order; its
 *     handle() returns a Promise that the IPC layer fan-outs). Pending
 *     requests live in a Map<requestId, PendingRequest> on the host side.
 *
 *   - dispose() is idempotent. After dispose, a subsequent analyzeChange
 *     re-forks — mirrors how the host might call analyzeChange again after
 *     a session restart.
 */
import { fork, type ChildProcess } from 'child_process';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  AnalyzePayload,
  AnalysisResponse,
  AnalysisResult,
} from './types.js';

/** Default per-request timeout for the worker reply (T-05-02). */
const DEFAULT_TIMEOUT_MS = 5_000;
/** Consecutive failures before the circuit opens (T-05-01). */
const CIRCUIT_BREAK_AFTER = 3;
/** How long the circuit stays open before auto-recovery (T-05-01). */
const CIRCUIT_COOLDOWN_MS = 30_000;
/** Hard cap on per-path length — prevents pathological IPC blowups. */
const MAX_PATH_LENGTH = 1024;

interface PendingRequest {
  resolve: (resp: AnalysisResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Construction-time overrides. All optional — production callers use the
 * defaults; tests inject `workerScriptPath` (point at a stub worker),
 * `env` (forward STUB_MODE etc. to the child), `timeoutMs` (fast iteration),
 * and `now` (fake clock for circuit cooldown).
 */
export interface AstAnalyzerOptions {
  /** Override the per-request timeout. Default 5s. */
  timeoutMs?: number;
  /** Override the worker script path. Default `<__dirname>/../ast-worker.js`. */
  workerScriptPath?: string;
  /** Test clock injection — `now()` returns a millisecond timestamp. Default Date.now. */
  now?: () => number;
  /** Extra env vars forwarded to the forked child. Merged on top of process.env. */
  env?: Record<string, string>;
}

/**
 * Returns true if `rel` is a safe workspace-relative path for IPC. Same gate
 * as Plan 04-15 CR-03-NEW (src/host/SessionHost.ts presence-update handler).
 *
 * Rejects:
 *   - Empty / non-string.
 *   - Overlong (>1024 chars).
 *   - Backslash-separated (Windows callers must posix-normalize before send).
 *   - Absolute paths (leading `/` or drive letter `C:[\\/]`).
 *   - Any segment equal to `..` — segment-aware traversal check.
 */
function isSafePath(rel: unknown): rel is string {
  if (typeof rel !== 'string') return false;
  if (rel.length === 0 || rel.length > MAX_PATH_LENGTH) return false;
  if (rel.includes('\\')) return false;
  if (rel.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return false;
  const segments = rel.split('/');
  if (segments.includes('..')) return false;
  return true;
}

export class AstAnalyzer {
  private worker: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly workerScript: string;
  private readonly now: () => number;
  private readonly extraEnv: Record<string, string>;

  /**
   * @param workspaceRoot  Absolute path to the user's workspace root. Stored
   *                       for future per-instance path-base validation; v1
   *                       gate is rel-path-only (Plan 04-15 pattern). Wave 5
   *                       may extend the validator to require the joined
   *                       absolute path stay under workspaceRoot OR branchDir.
   * @param branchDir      Absolute path to .versioncon/branches/<active>/.
   *                       Same purpose as workspaceRoot — reserved for v1.x.
   * @param opts           AstAnalyzerOptions (test-only overrides).
   */
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _workspaceRoot: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _branchDir: string,
    opts: AstAnalyzerOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workerScript =
      opts.workerScriptPath ?? path.join(__dirname, '..', 'ast-worker.js');
    this.now = opts.now ?? Date.now;
    this.extraEnv = opts.env ?? {};
    void _workspaceRoot;
    void _branchDir;
  }

  /**
   * Analyze a push: validate paths, send to the worker, race against the
   * timeout, return an AnalysisResult.
   *
   * Returns the empty AnalysisResult on any of:
   *   - Circuit open (within 30s cooldown).
   *   - All paths rejected by validation.
   *   - Fork failed.
   *   - Worker timed out (T-05-02).
   *   - Worker crashed before replying (T-05-01).
   *   - Worker replied with `ok: false`.
   *
   * Caller treats empty AnalysisResult as the SC-3 file-level fallback — the
   * push still broadcasts; the affectedSymbols stamp is just omitted.
   */
  async analyzeChange(args: {
    changedFiles: AnalyzePayload['changedFiles'];
    memberTrackedFiles: AnalyzePayload['memberTrackedFiles'];
    memberDisplayNames: AnalyzePayload['memberDisplayNames'];
  }): Promise<AnalysisResult> {
    const emptyResult: AnalysisResult = {
      affectedSymbols: [],
      perMember: {},
      unsupportedLanguages: [],
    };

    if (this.disposed) {
      // Allow analyzeChange after dispose by clearing the disposed flag —
      // the next call re-forks. Mirrors how host code might call after a
      // session restart.
      this.disposed = false;
    }

    // T-05-01: short-circuit when the circuit is open.
    if (this.circuitOpenUntil > this.now()) {
      return emptyResult;
    }

    // T-05-03: validate every path; silently drop unsafe entries.
    const safe = this.validateAndFilter(args);
    if (safe.changedFiles.length === 0) {
      return emptyResult;
    }

    const worker = this.ensureWorker();
    if (!worker) {
      return emptyResult;
    }

    const requestId = crypto.randomUUID();
    const payload: AnalyzePayload = {
      requestId,
      changedFiles: safe.changedFiles,
      memberTrackedFiles: safe.memberTrackedFiles,
      memberDisplayNames: args.memberDisplayNames,
    };

    return new Promise<AnalysisResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.killAndMark();
        resolve(emptyResult);
      }, this.timeoutMs);

      this.pending.set(requestId, {
        timer,
        resolve: (resp) => {
          clearTimeout(timer);
          if (resp.ok) {
            this.consecutiveFailures = 0;
            resolve(resp.result);
          } else {
            this.markFailure();
            resolve(emptyResult);
          }
        },
      });

      try {
        worker.send(payload);
      } catch (err) {
        // send() can throw if the worker disconnected between ensureWorker
        // and now. Settle synchronously with empty.
        clearTimeout(timer);
        this.pending.delete(requestId);
        this.markFailure();
        this.worker = null;
        console.error('[AstAnalyzer] worker.send failed', err);
        resolve(emptyResult);
      }
    });
  }

  /**
   * Tear down the worker + clear pending state. Idempotent. After dispose,
   * a subsequent analyzeChange will lazy-fork a new worker.
   */
  dispose(): void {
    this.disposed = true;
    if (this.worker) {
      try {
        this.worker.kill('SIGTERM');
      } catch {
        // worker may already be dead
      }
      this.worker = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
  }

  /**
   * Lazy-fork the worker on first use (and re-fork after crash/dispose).
   * Returns null when fork itself fails (e.g. worker script missing).
   *
   * Race-safe: the 'exit' handler captures a reference to the specific
   * forked process and ONLY clears `this.worker` when that exact reference
   * is still installed. Otherwise a stale exit event from a previously
   * killed worker would clobber the newly re-forked worker. (Seen during
   * Plan 05-04 Task 3 circuit-recovery tests — Rule 1 fix.)
   */
  private ensureWorker(): ChildProcess | null {
    if (this.worker) return this.worker;
    let child: ChildProcess;
    try {
      child = fork(this.workerScript, [], {
        silent: false,
        env: { ...process.env, ...this.extraEnv },
      });
    } catch (err) {
      console.error('[AstAnalyzer] fork failed', err);
      this.markFailure();
      this.worker = null;
      return null;
    }
    this.worker = child;
    child.on('message', (msg: AnalysisResponse) => {
      if (!msg || typeof msg.requestId !== 'string') return;
      const p = this.pending.get(msg.requestId);
      if (p) {
        this.pending.delete(msg.requestId);
        p.resolve(msg);
      }
    });
    child.on('exit', () => {
      // Only settle pending requests + nullify the worker handle if this
      // specific child is still the active one. Otherwise a stale exit
      // event from a previously-killed worker would (a) clobber the
      // newly re-forked worker handle, and (b) settle pending requests
      // belonging to the new worker — both lead to the wrong empty result.
      if (this.worker === child) {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ requestId: id, ok: false, error: 'worker exited' });
        }
        this.pending.clear();
        this.worker = null;
      }
    });
    child.on('error', (err) => {
      console.error('[AstAnalyzer] worker error event', err);
    });
    return this.worker;
  }

  /** Kill the worker (after timeout) and mark a failure for the circuit. */
  private killAndMark(): void {
    if (this.worker) {
      try {
        this.worker.kill('SIGTERM');
      } catch {
        // worker may already be dead
      }
      this.worker = null;
    }
    this.markFailure();
  }

  /** Bump the failure counter and open the circuit if we've crossed the threshold. */
  private markFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_BREAK_AFTER) {
      this.circuitOpenUntil = this.now() + CIRCUIT_COOLDOWN_MS;
      // Reset the counter so subsequent failures after cooldown don't
      // instantly re-open. The cooldown itself is the gate.
      this.consecutiveFailures = 0;
    }
  }

  /**
   * T-05-03 mitigation: drop unsafe paths from changedFiles +
   * memberTrackedFiles before they ever cross the IPC wire. Mirrors Plan
   * 04-15 CR-03-NEW's segment-aware traversal check.
   */
  private validateAndFilter(args: {
    changedFiles: AnalyzePayload['changedFiles'];
    memberTrackedFiles: AnalyzePayload['memberTrackedFiles'];
    memberDisplayNames: AnalyzePayload['memberDisplayNames'];
  }): {
    changedFiles: AnalyzePayload['changedFiles'];
    memberTrackedFiles: AnalyzePayload['memberTrackedFiles'];
  } {
    const cf = (args.changedFiles ?? []).filter((f) =>
      isSafePath(f?.relativePath),
    );
    const mtf: AnalyzePayload['memberTrackedFiles'] = {};
    for (const [memberId, files] of Object.entries(
      args.memberTrackedFiles ?? {},
    )) {
      const filtered = (files ?? []).filter((f) => isSafePath(f?.relativePath));
      if (filtered.length > 0) mtf[memberId] = filtered;
    }
    return { changedFiles: cf, memberTrackedFiles: mtf };
  }
}
