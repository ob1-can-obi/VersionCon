import * as fs from 'fs/promises';
import * as path from 'path';
import type { ReviewRequest } from '../types/review.js';

/**
 * Per-review JSON persistence at .versioncon/branches/{branch}/reviews/{pushId}.json.
 *
 * Storage layout:
 *   .versioncon/
 *     branches/
 *       main/
 *         reviews/
 *           abc123.json   ← one ReviewRequest with pushId 'abc123'
 *           def456.json   ← one ReviewRequest with pushId 'def456'
 *
 * Persistence pattern mirrors PushHistory + ChatLog (Phase 3 + 4):
 *   - load on activate (per-branch scope — call load(branchName) per branch)
 *   - write WHOLE file on every mutation (no incremental diff; same
 *     posture as ChatLog.append which rewrites the whole chat-log.json)
 *   - in-memory index by pushId for O(1) lookup
 *
 * The store is branch-scoped: load(branchName) populates the in-memory
 * index for ONE branch. Wave 5 mergeBranch needs reviews from the SOURCE
 * branch to gate the merge into the TARGET — extension.ts orchestrates by
 * calling load(sourceBranch) before the gate check.
 *
 * Threat T-06-04 (file-system bypass): out of scope — same posture as
 * Phase 3 SyncTracker. A malicious user with OS-level write access to
 * .versioncon/branches/{branch}/reviews/*.json can craft fake approved
 * reviews. VersionCon's threat model assumes the disk is trusted; we are
 * not a defense against attackers with shell access to your machine.
 */
export class ReviewStore {
  /** memoized by pushId (the natural per-review key per 06-SPEC.md "Storage"). */
  private readonly reviewsByPushId: Map<string, ReviewRequest> = new Map();

  constructor(private readonly versionconDir: string) {}

  /**
   * Load every ReviewRequest under .versioncon/branches/{branchName}/reviews/
   * into the in-memory index. Missing dir → no-op (returns 0). Corrupt file
   * → console.error + skip (does not abort the load). Call on activate AND
   * on every branch switch.
   *
   * Returns the count of reviews loaded for the requested branch.
   */
  async load(branchName: string): Promise<number> {
    const dir = path.join(this.versionconDir, 'branches', branchName, 'reviews');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return 0;
    }
    let loaded = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const full = path.join(dir, entry);
      try {
        const raw = await fs.readFile(full, 'utf-8');
        const req = JSON.parse(raw) as ReviewRequest;
        if (typeof req.pushId === 'string' && typeof req.id === 'string') {
          this.reviewsByPushId.set(req.pushId, req);
          loaded += 1;
        }
      } catch (err) {
        console.error(`[ReviewStore] failed to load ${full}`, err);
      }
    }
    return loaded;
  }

  /**
   * Persist a ReviewRequest. Writes the WHOLE file (no diff). Updates the
   * in-memory index. Last write wins (mutation flows through this method
   * for both first-write and updates).
   *
   * Atomicity: no .tmp+rename. Same posture as PushHistory + ChatLog (a
   * mid-write crash could leave a half-written JSON file on disk, which
   * load() would catch via the corrupt-JSON skip path). Upgrading all
   * three persistence modules to atomic .tmp+rename is tracked as a
   * Phase 4 STRIDE register item (T-04-02-04) — when that lands,
   * ReviewStore upgrades together with PushHistory + ChatLog.
   *
   * Caller responsibility: req.id, req.pushId, req.branch, req.openedAt,
   * req.authorMemberId, req.authorDisplayName MUST be set before calling.
   * ReviewStore is dumb persistence — Wave 2 host handler is the gate
   * that constructs ReviewRequest objects with host-trusted fields.
   */
  async upsertRequest(req: ReviewRequest): Promise<void> {
    const dir = path.join(this.versionconDir, 'branches', req.branch, 'reviews');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${req.pushId}.json`);
    await fs.writeFile(file, JSON.stringify(req, null, 2));
    this.reviewsByPushId.set(req.pushId, req);
  }

  /**
   * Defensive deep copy via JSON round-trip — mutating the returned object
   * cannot corrupt the in-memory index. Mirrors PresenceMap.getSnapshot's
   * defensive-copy invariant (STATE.md decision from Plan 04-03).
   */
  getReview(pushId: string): ReviewRequest | undefined {
    const r = this.reviewsByPushId.get(pushId);
    return r ? JSON.parse(JSON.stringify(r)) as ReviewRequest : undefined;
  }

  /** All known reviews as a defensive copy. Ordering not guaranteed. */
  getAll(): ReviewRequest[] {
    return Array.from(this.reviewsByPushId.values()).map(
      r => JSON.parse(JSON.stringify(r)) as ReviewRequest,
    );
  }

  /** Open reviews for the given branch. Filters by status === 'open'. */
  getOpenForBranch(branch: string): ReviewRequest[] {
    const out: ReviewRequest[] = [];
    for (const r of this.reviewsByPushId.values()) {
      if (r.branch === branch && r.status === 'open') {
        out.push(JSON.parse(JSON.stringify(r)) as ReviewRequest);
      }
    }
    return out;
  }
}
