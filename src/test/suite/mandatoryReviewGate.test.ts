/**
 * Phase 6 Wave 5 (Plan 06-05) — mandatory-review merge gate suite.
 *
 * Three suite groups, one per task:
 *
 *  1. Task 1 — BranchManager.setRequireReview + getRequireReview + the
 *     versioncon.setBranchRequireReview admin command. Round-trip persistence
 *     of the requireReview field through branch-metadata.json; admin-gating
 *     of the command (source-grep + package.json registration).
 *
 *  2. Task 2 — checkRequireReviewGate pure-function behavior at the three
 *     mergeBranch entry points (mergeBranch, quickMergeFiles,
 *     structuredMergeBranch). Covers all five vote/status combinations plus
 *     the no-pushes-on-source edge case + the appendAndBroadcastSystemEvent
 *     visibility widening (source-grep).
 *
 *  3. (Task 3 lives in reviewInlineComments.test.ts.)
 *
 * Pure-function tests in Task 2 use the extracted helper from
 * src/state/requireReviewGate.ts so that no vscode extension host is needed
 * for the gate logic — the gate IS the trust authority for the merge block,
 * so testing it in isolation gives the strongest correctness signal.
 *
 * The 3-entry-point insertion is pinned via source-grep on src/extension.ts.
 */
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BranchManager } from '../../filesystem/BranchManager.js';
import { checkRequireReviewGate } from '../../state/requireReviewGate.js';
import { PushHistory } from '../../filesystem/PushHistory.js';
import { ReviewState } from '../../state/ReviewState.js';
import type { ReviewRequest } from '../../types/review.js';
import type { PushRecord } from '../../types/push.js';

const repoRoot = process.cwd();
const readSrc = (rel: string): string =>
  fsSync.readFileSync(path.resolve(repoRoot, rel), 'utf-8');

suite('Phase 6 Wave 5 — BranchManager.setRequireReview + admin command (Task 1)', () => {
  let tmpDir: string;
  let versionconDir: string;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-require-review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    versionconDir = path.join(tmpDir, '.versioncon');
    await fs.mkdir(versionconDir, { recursive: true });
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('setRequireReview(name, true) flips the in-memory flag', async () => {
    const mgr = new BranchManager(versionconDir);
    await mgr.initialize();
    await mgr.setRequireReview('main', true);
    assert.strictEqual(mgr.getRequireReview('main'), true);
  });

  test('setRequireReview(name, false) toggles back', async () => {
    const mgr = new BranchManager(versionconDir);
    await mgr.initialize();
    await mgr.setRequireReview('main', true);
    await mgr.setRequireReview('main', false);
    assert.strictEqual(mgr.getRequireReview('main'), false);
  });

  test('getRequireReview returns false for legacy branches with no field', async () => {
    const mgr = new BranchManager(versionconDir);
    await mgr.initialize();
    // initialize() creates 'main' with no requireReview field (undefined).
    assert.strictEqual(mgr.getRequireReview('main'), false);
  });

  test('setRequireReview round-trips through branch-metadata.json on disk', async () => {
    const mgr = new BranchManager(versionconDir);
    await mgr.initialize();
    await mgr.setRequireReview('main', true);
    // Read raw metadata file.
    const raw = await fs.readFile(path.join(versionconDir, 'branch-metadata.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Array<{ name: string; requireReview?: boolean }>;
    const mainEntry = parsed.find(b => b.name === 'main');
    assert.ok(mainEntry, 'main entry persisted');
    assert.strictEqual(mainEntry.requireReview, true);
  });

  test('setRequireReview survives a fresh BranchManager instance (load cycle)', async () => {
    const mgr1 = new BranchManager(versionconDir);
    await mgr1.initialize();
    await mgr1.setRequireReview('main', true);

    // Re-construct against the same dir — load existing metadata.
    const mgr2 = new BranchManager(versionconDir);
    await mgr2.initialize();
    assert.strictEqual(mgr2.getRequireReview('main'), true);
  });

  test('setRequireReview(unknown branch) throws descriptive error', async () => {
    const mgr = new BranchManager(versionconDir);
    await mgr.initialize();
    await assert.rejects(
      () => mgr.setRequireReview('does-not-exist', true),
      /does not exist/,
    );
  });

  test('lockBranch behavior is independent of requireReview (no regression)', async () => {
    const mgr = new BranchManager(versionconDir);
    await mgr.initialize();
    await mgr.lockBranch('main', ['someone']);
    await mgr.setRequireReview('main', true);
    const main = mgr.getBranch('main');
    assert.strictEqual(main?.locked, true, 'lock preserved');
    assert.strictEqual(main?.requireReview, true, 'requireReview set');
    assert.deepStrictEqual(main?.lockedPushers, ['someone']);
  });

  test('package.json declares versioncon.setBranchRequireReview command', () => {
    const pkg = JSON.parse(readSrc('package.json')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const found = pkg.contributes.commands.some(
      c => c.command === 'versioncon.setBranchRequireReview',
    );
    assert.ok(found, 'package.json should declare versioncon.setBranchRequireReview');
  });

  test('extension.ts registers versioncon.setBranchRequireReview via registerCommand', () => {
    const ext = readSrc('src/extension.ts');
    assert.match(
      ext,
      /registerCommand\(\s*['"]versioncon\.setBranchRequireReview['"]/,
      'extension.ts should registerCommand the new admin command',
    );
  });

  test('versioncon.setBranchRequireReview handler is admin-gated via canCreateBranch', () => {
    const ext = readSrc('src/extension.ts');
    // Locate the registerCommand block for setBranchRequireReview and grep
    // the next 60 lines for the admin gate.
    const idx = ext.indexOf("'versioncon.setBranchRequireReview'");
    assert.ok(idx > -1, 'setBranchRequireReview registerCommand call exists');
    const slice = ext.substring(idx, idx + 3000);
    assert.match(
      slice,
      /canCreateBranch\(/,
      'admin gate via permissions.canCreateBranch should appear within the handler',
    );
  });
});

// -----------------------------------------------------------------------------
// Task 2 — checkRequireReviewGate behaviour (extracted to src/state/requireReviewGate.ts)
// -----------------------------------------------------------------------------

function makeReview(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: overrides.id ?? 'review-1',
    pushId: overrides.pushId ?? 'push-1',
    branch: overrides.branch ?? 'feature',
    authorMemberId: 'author-1',
    authorDisplayName: 'Author',
    openedAt: Date.now() - 1000,
    status: overrides.status ?? 'open',
    votes: overrides.votes ?? [],
    comments: overrides.comments ?? [],
  };
}

function makePush(overrides: Partial<PushRecord> = {}): PushRecord {
  return {
    id: overrides.id ?? 'push-1',
    branch: overrides.branch ?? 'feature',
    memberId: overrides.memberId ?? 'author-1',
    memberDisplayName: overrides.memberDisplayName ?? 'Author',
    timestamp: overrides.timestamp ?? Date.now() - 2000,
    message: overrides.message ?? 'msg',
    files: overrides.files ?? [],
    reverted: overrides.reverted ?? false,
  };
}

suite('Phase 6 Wave 5 — checkRequireReviewGate behavior (Task 2)', () => {
  let tmpDir: string;
  let versionconDir: string;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-gate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    versionconDir = path.join(tmpDir, '.versioncon');
    await fs.mkdir(versionconDir, { recursive: true });
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('target.requireReview=false → gate.allow=true (no gate)', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    // main.requireReview is undefined / false by default.
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    const reviewState = new ReviewState();

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, true);
  });

  test('target.requireReview=undefined → gate.allow=true (legacy metadata safe)', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    // Explicitly leave requireReview undefined (default state).
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    const reviewState = new ReviewState();

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, true);
  });

  test('target.requireReview=true AND no pushes on source → blocked with no-pushes reason', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    await branchManager.setRequireReview('main', true);
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    const reviewState = new ReviewState();

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, false);
    assert.match(result.reason ?? '', /no pushes to review/);
  });

  test('target.requireReview=true AND source push but no review → blocked', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    await branchManager.setRequireReview('main', true);
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    await pushHistory.addRecord(makePush({ id: 'push-1', branch: 'feature' }));
    const reviewState = new ReviewState();

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, false);
    assert.match(result.reason ?? '', /no review opened/);
  });

  test('target.requireReview=true AND review status=open → blocked', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    await branchManager.setRequireReview('main', true);
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    await pushHistory.addRecord(makePush({ id: 'push-1', branch: 'feature' }));
    const reviewState = new ReviewState();
    reviewState.applyOpened(makeReview({ id: 'r1', pushId: 'push-1', status: 'open' }));

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, false);
    assert.match(result.reason ?? '', /current status: open/);
  });

  test('target.requireReview=true AND review status=changes-requested → blocked', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    await branchManager.setRequireReview('main', true);
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    await pushHistory.addRecord(makePush({ id: 'push-1', branch: 'feature' }));
    const reviewState = new ReviewState();
    reviewState.applyOpened(makeReview({ id: 'r1', pushId: 'push-1', status: 'open' }));
    reviewState.applyVote('r1', {
      reviewerMemberId: 'rev-1',
      reviewerDisplayName: 'Reviewer',
      vote: 'changes-requested',
      votedAt: Date.now(),
    });

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, false);
    assert.match(result.reason ?? '', /current status: changes-requested/);
  });

  test('target.requireReview=true AND review status=approved → allowed', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    await branchManager.setRequireReview('main', true);
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    await pushHistory.addRecord(makePush({ id: 'push-1', branch: 'feature' }));
    const reviewState = new ReviewState();
    reviewState.applyOpened(makeReview({ id: 'r1', pushId: 'push-1', status: 'open' }));
    reviewState.applyVote('r1', {
      reviewerMemberId: 'rev-1',
      reviewerDisplayName: 'Reviewer',
      vote: 'approved',
      votedAt: Date.now(),
    });

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, true);
  });

  test('target.requireReview=true AND review status=resolved → blocked (resolved ≠ approved)', async () => {
    // v1 contract: admin resolves a 'changes-requested' review to status='resolved'
    // — the override path does NOT auto-approve. Next merge still blocks until
    // an explicit approve vote lands.
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    await branchManager.setRequireReview('main', true);
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    await pushHistory.addRecord(makePush({ id: 'push-1', branch: 'feature' }));
    const reviewState = new ReviewState();
    reviewState.applyOpened(makeReview({ id: 'r1', pushId: 'push-1', status: 'open' }));
    reviewState.applyResolved('r1', 'admin', 'merged', Date.now());

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, false);
    // Resolved reviews are filtered by getActiveReviewForPush → "no review opened" branch
    assert.match(result.reason ?? '', /no review opened/);
  });

  test('gate picks the MOST-RECENT push on the source branch (multiple pushes)', async () => {
    const branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    await branchManager.setRequireReview('main', true);
    const pushHistory = new PushHistory(versionconDir);
    await pushHistory.load();
    // Older push first; newest pushes are at the end of records[].
    await pushHistory.addRecord(makePush({ id: 'push-old', branch: 'feature', timestamp: 1000 }));
    await pushHistory.addRecord(makePush({ id: 'push-new', branch: 'feature', timestamp: 2000 }));
    const reviewState = new ReviewState();
    // Approve only the OLD push — should NOT unblock the merge.
    reviewState.applyOpened(makeReview({ id: 'r-old', pushId: 'push-old', status: 'open' }));
    reviewState.applyVote('r-old', {
      reviewerMemberId: 'rev-1',
      reviewerDisplayName: 'Reviewer',
      vote: 'approved',
      votedAt: Date.now(),
    });

    const result = await checkRequireReviewGate('feature', 'main', {
      branchManager,
      pushHistory,
      reviewState,
    });
    assert.strictEqual(result.allow, false);
  });
});

suite('Phase 6 Wave 5 — gate insertion at 3 merge entry points + system event (Task 2 source-grep)', () => {
  test('extension.ts imports checkRequireReviewGate', () => {
    const ext = readSrc('src/extension.ts');
    assert.match(ext, /checkRequireReviewGate/);
  });

  test('versioncon.mergeBranch handler calls checkRequireReviewGate', () => {
    const ext = readSrc('src/extension.ts');
    const idx = ext.indexOf("'versioncon.mergeBranch'");
    assert.ok(idx > -1, 'mergeBranch registerCommand present');
    const slice = ext.substring(idx, idx + 6000);
    assert.match(slice, /checkRequireReviewGate\(/);
  });

  test('versioncon.quickMergeFiles handler calls checkRequireReviewGate', () => {
    const ext = readSrc('src/extension.ts');
    const idx = ext.indexOf("'versioncon.quickMergeFiles'");
    assert.ok(idx > -1, 'quickMergeFiles registerCommand present');
    const slice = ext.substring(idx, idx + 8000);
    assert.match(slice, /checkRequireReviewGate\(/);
  });

  test('versioncon.structuredMergeBranch handler calls checkRequireReviewGate', () => {
    const ext = readSrc('src/extension.ts');
    const idx = ext.indexOf("'versioncon.structuredMergeBranch'");
    assert.ok(idx > -1, 'structuredMergeBranch registerCommand present');
    const slice = ext.substring(idx, idx + 12000);
    assert.match(slice, /checkRequireReviewGate\(/);
  });

  test('gate-blocked path fires appendAndBroadcastSystemEvent with review-resolved subKind', () => {
    const ext = readSrc('src/extension.ts');
    // Search for the merge-blocked literal that the gate-block path emits.
    assert.match(
      ext,
      /Merge blocked: needs review approval/,
      'gate-block path should emit the standard merge-blocked system-event body',
    );
    assert.match(
      ext,
      /appendAndBroadcastSystemEvent/,
      'extension.ts should call activeHost.appendAndBroadcastSystemEvent on block',
    );
  });

  test('SessionHost.appendAndBroadcastSystemEvent visibility widened to public', () => {
    const sh = readSrc('src/host/SessionHost.ts');
    assert.match(
      sh,
      /public\s+appendAndBroadcastSystemEvent/,
      'appendAndBroadcastSystemEvent should be public (was private pre-Plan 06-05)',
    );
  });
});
