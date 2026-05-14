---
phase: 06-inline-code-review
plan: 05
subsystem: mandatory-review-gate-and-inline-comments
tags: [phase-6, wave-4, gate, merge, vscode-comments, admin-command, t-06-01, t-06-02, t-06-04, review-04, sc-3, collab-07]
requires:
  - "06-01 — BranchInfo.requireReview optional field; review types"
  - "06-02 — host relay; appendAndBroadcastSystemEvent (visibility widened here)"
  - "06-03 — ReviewState.getActiveReviewForPush (read by the gate)"
  - "06-04 — ReviewPanel lifecycle + extension.ts review-* wiring + openReview command"
provides:
  - "src/filesystem/BranchManager.ts — setRequireReview(name, requireReview) + getRequireReview(name) admin toggles; mirrors lockBranch shape; persists via existing saveMetadata"
  - "src/state/requireReviewGate.ts — pure-function checkRequireReviewGate(source, target, deps) returning {allow,reason}; unit-testable without VS Code"
  - "src/extension.ts — gate inserted at all 3 merge entry points (versioncon.mergeBranch, quickMergeFiles, structuredMergeBranch); on block: non-modal error toast + appendAndBroadcastSystemEvent('review-resolved', 'Merge blocked: needs review approval — {source} → {target}', ...)"
  - "src/extension.ts — versioncon.setBranchRequireReview admin command (QuickPick branch + Yes/No toggle); gated via permissions.canCreateBranch (v1 admin proxy)"
  - "src/extension.ts — vscode.comments.createCommentController per-open-review + registerInlineCommentsForReview helper + versioncon.review.replyToComment command for reply routing through the same wire path as the panel composer"
  - "src/ui/inlineReviewComments.ts — registerInlineCommentsForReview pure-function helper (no extension.ts dependency); groups review.comments by {filePath}:{line}, sorts by createdAt asc, wraps body in vscode.MarkdownString (T-06-02), canReply=true, commentingRangeProvider returns [] (v1)"
  - "src/ui/ReviewPanel.ts — addOwnedDisposable public method for injecting external disposables into the panel's cleanup chain (controller + thread disposables)"
  - "src/host/SessionHost.ts — appendAndBroadcastSystemEvent visibility widened from private to public (JSDoc notes the explicit scope: only SessionHost instance methods AND extension.ts with an activeHost ref may call it)"
  - "package.json — versioncon.setBranchRequireReview command declaration"
  - "src/test/suite/mandatoryReviewGate.test.ts — 25 tests across BranchManager toggle + gate behavior + 3-entry-point insertion"
  - "src/test/suite/reviewInlineComments.test.ts — 18 tests across registerInlineCommentsForReview behavior + source-grep wiring contract"
affects: []
tech-stack:
  added: []
  patterns:
    - "Pure-function gate extracted to its own module so the 3 merge entry points share one source of truth AND so the gate is unit-testable without a VS Code extension host (mirror of computeFileOverlap pattern from Plan 04-06)"
    - "Singleton-per-pushId CommentController lifecycle managed via panel.addOwnedDisposable — closing the ReviewPanel automatically tears down the inline gutter (mirrors the panel's owned-disposable pattern from ChatPanel Plan 04-10)"
    - "Full-rebuild-on-refresh for inline CommentThreads — bounded by host's 500-comment cap (Plan 06-02), so diff-and-patch overhead is unjustified"
    - "vscode.MarkdownString as the trust boundary for inline comment bodies — MarkdownString.isTrusted defaults to false; raw HTML escaped by VS Code's comment renderer (T-06-02 mirror of webview markdown-it html:false posture)"
    - "Admin gate via permissions.canCreateBranch (the v1 admin proxy per 06-SPEC.md frontmatter line 15); same pattern used by Plan 06-02's review-resolved override"
key-files:
  created:
    - "src/state/requireReviewGate.ts (87 lines)"
    - "src/ui/inlineReviewComments.ts (112 lines)"
    - "src/test/suite/mandatoryReviewGate.test.ts (440 lines, 25 tests)"
    - "src/test/suite/reviewInlineComments.test.ts (313 lines, 18 tests)"
  modified:
    - "src/filesystem/BranchManager.ts (+33 lines — setRequireReview + getRequireReview)"
    - "src/host/SessionHost.ts (+15 lines doc / visibility change — appendAndBroadcastSystemEvent public)"
    - "src/extension.ts (+~190 lines — gate import + 3 gate insertions + setBranchRequireReview command + commentController lifecycle + replyToComment command + rebuildInlineReviewComments + host/client listener rebuild hooks)"
    - "src/ui/ReviewPanel.ts (+13 lines — addOwnedDisposable method)"
    - "package.json (+5 lines — versioncon.setBranchRequireReview command declaration)"
decisions:
  - "Extracted checkRequireReviewGate to src/state/requireReviewGate.ts (plan-recommended REFACTOR posture) — cleaner test surface AND keeps extension.ts smaller. The helper signature accepts a deps object ({ branchManager, pushHistory, reviewState }) so it remains pure-function + unit-testable. extension.ts imports + calls at 3 sites."
  - "appendAndBroadcastSystemEvent visibility widened from private to public (the smaller diff per the plan). JSDoc explicitly pins the scope: ONLY SessionHost instance methods AND extension.ts (with an activeHost reference) may call it. Other call sites would regress the T-04-04-04 trust posture."
  - "Reused 'review-resolved' SystemEventSubKind for the merge-block event rather than introducing a 6th sub-kind. The body string 'Merge blocked: needs review approval — {source} → {target}' carries the merge-block specifics; adding a new sub-kind would churn Wave 1 + Wave 2 contract surfaces for one UI string (per plan instruction)."
  - "Resolved-review state explicitly does NOT count as approved for the gate. Admin overrides a 'changes-requested' review to 'resolved' (Plan 06-02 override path), but the next merge still blocks until an explicit approve vote lands. ReviewState.getActiveReviewForPush filters resolved+abandoned, so the gate naturally falls into the 'no review opened' branch — pinned by a behavior test."
  - "vscode.commentController lifecycle managed at module scope (activeReviewController + activeReviewThreadDisposables + activeReviewPushIdForController), wired into ReviewPanel.addOwnedDisposable so panel.close() tears down the controller. Singleton-per-pushId mirrors ReviewPanel.currentPanel — opening a different pushId disposes the prior controller before constructing the new one. Cleaner than a Map<pushId, controller> for v1."
  - "Full rebuild of inline comment threads on every review-comment / review-opened / review-state-sync event (vs. diff-and-patch). The per-review comment count is bounded by host's 500-cap (Plan 06-02), so 500 threads × 3 rebuilds-per-second is well within VS Code's API budget. Diff-and-patch would introduce a per-comment id→thread map that must stay in sync with reviewState — not worth the complexity for v1."
  - "Reply routing via the contributed versioncon.review.replyToComment command — invoked by VS Code's built-in 'Reply' UI on threads with thread.canReply=true. The CommentReply event carries thread.uri + thread.range; we map back to {filePath, line} relative to the active branch dir and forward through the same buildReviewPanelCallbacks().onCommentRequested() path as the panel's per-file composer. Identity override stays the same (host-trusted)."
  - "v1 contract: NO bare-line gutter 'Add comment' affordance. commentingRangeProvider returns [] for all lines. Users compose new threads via the ReviewPanel webview's per-file-row composer. Adding a gutter add-comment surface is a Phase 6.x deliverable (mentioned in the plan's must_haves.truths)."
  - "No wire broadcast on setRequireReview toggle for v1 — the gate is read on the local host process during merge attempts. A future plan can add 'branch-require-review-changed' wire propagation; out of scope here."
metrics:
  duration_minutes: 25
  tasks_completed: 3
  files_created: 4
  files_modified: 5
  tests_added: 43
  tests_total_pre: 824
  tests_total_post: 867
  completed: "2026-05-14"
---

# Phase 6 Plan 05: Mandatory-Review Gate + Inline Comments Summary

One-liner: Wave 4 closes Phase 6 — admin-toggleable per-branch requireReview gate enforced at all 3 mergeBranch entry points (REVIEW-04 / SC-3), with a non-modal toast + system chat event on block (COLLAB-07), AND a per-open-review vscode.commentController surface that renders existing ReviewComments as gutter threads with reply-routing through the same wire path as the panel composer (SC-2 inline-comments end-to-end), plus an admin QuickPick command for the toggle — 43 new tests covering all 5 review-status variants of the gate, persistence round-trip, 3-entry-point insertion, controller lifecycle, thread grouping/sorting/range conversion, and reply routing.

## What Shipped

### Task 1 — Admin-toggleable per-branch requireReview flag

`BranchManager` gains two new methods that mirror the `lockBranch` shape:

```ts
async setRequireReview(name: string, requireReview: boolean): Promise<void>
getRequireReview(name: string): boolean
```

The setter mutates `BranchInfo.requireReview` in-memory then awaits `saveMetadata` (same persistence pattern as `lockBranch`). Throws `Branch "{name}" does not exist` on unknown branch. The getter returns `false` for branches whose `requireReview` is undefined — legacy `branch-metadata.json` without the field is safe.

`versioncon.setBranchRequireReview` admin command is registered in `package.json` (`category: "VersionCon"`) and `extension.ts` (between `versioncon.mergeBranch` and `versioncon.quickMergeFiles`). Flow:

1. Admin gate via `permissions.canCreateBranch(currentMemberId)` — non-admins get an error toast and the QuickPick never opens.
2. QuickPick of branches with description `(currently requires review)` or `(no review required)`.
3. Yes/No QuickPick: "Require review for merges into '{branch}'?"
4. On confirm: `await branchManager.setRequireReview(branch, value)`, refresh the all-branches tree provider, show a success info message.

No wire propagation in v1 — the gate is local-only on the host process during merge attempts. Peer joiners route their merge attempts to the host's local filesystem ops (Phase 3 quickMergeFiles posture) and either succeed against the host's local view OR fail with the host's error.

### Task 2 — Mandatory-review merge gate (REVIEW-04 / SC-3)

Extracted to `src/state/requireReviewGate.ts` as a pure function with a deps object:

```ts
export async function checkRequireReviewGate(
  sourceBranchName: string,
  targetBranchName: string,
  deps: {
    branchManager: BranchManager;
    pushHistory: PushHistory;
    reviewState: ReviewState | null;
  },
): Promise<{ allow: boolean; reason?: string }>
```

Gate logic:

1. `branchManager.getRequireReview(target) === false` → `{ allow: true }`.
2. Find the most-recent push on the SOURCE branch via `pushHistory.getRecords().find(r => r.branch === sourceBranchName)` (PushHistory returns newest-first).
3. No push found → `{ allow: false, reason: '... has no pushes to review.' }`.
4. `reviewState.getActiveReviewForPush(pushId)?.status === 'approved'` → `{ allow: true }`. Otherwise → `{ allow: false, reason: '... requires an approving review of push {shortId} (current status: {status} | no review opened).' }`.

Inserted at all 3 merge entry points in `extension.ts`:

| Entry point                              | Insertion site                                          |
| ---------------------------------------- | ------------------------------------------------------- |
| `versioncon.mergeBranch`                 | AFTER `canMergeToMain` check, BEFORE confirm modal      |
| `versioncon.quickMergeFiles`             | AFTER `canMergeToMain` + lock check, BEFORE file picker |
| `versioncon.structuredMergeBranch`       | AFTER `canMergeToMain` + lock check, BEFORE walkthrough |

On block path at every site:

```ts
void vscode.window.showErrorMessage(`VersionCon: ${gate.reason}`);   // non-modal toast
if (activeHost) {
  activeHost.appendAndBroadcastSystemEvent(
    'review-resolved',
    `Merge blocked: needs review approval — ${source} → ${target}`,
    Date.now(),
    { branch: target },
    currentSelfMemberId,
    currentSelfDisplayName,
  );
}
return;
```

`SessionHost.appendAndBroadcastSystemEvent` visibility was widened from `private` to `public` with a JSDoc note explicitly scoping the legitimate callers (only SessionHost instance methods AND extension.ts with an `activeHost` reference).

### Task 3 — vscode.commentController inline-comment surface

`src/ui/inlineReviewComments.ts` exports `registerInlineCommentsForReview(controller, review, branchDir, onReplyRequested)`:

- Groups `review.comments` by `{filePath}::{line}` into a `Map<string, ReviewComment[]>`.
- For each group, constructs a `vscode.Uri.file(path.join(branchDir, filePath))` + `vscode.Range(line-1, 0, line-1, 0)` (zero-based, defensively clamped to ≥ 0), then `controller.createCommentThread(uri, range, comments[])` with comments sorted by `createdAt` ascending.
- Each Comment's body is wrapped in `new vscode.MarkdownString(c.body)` — T-06-02 mitigation; `isTrusted` defaults to `false`, so raw HTML in the body is escaped by VS Code's comment renderer.
- Sets `thread.canReply = true`, `thread.collapsibleState = Expanded`, `thread.label = '{N} comment(s)'`.
- `controller.commentingRangeProvider.provideCommentingRanges` returns `[]` — v1 contract has no bare-line "Add comment" gutter affordance (Phase 6.x).

`ReviewPanel.addOwnedDisposable(d)` is a new public method that pushes external disposables into the panel's existing `disposables[]` array. extension.ts uses this to attach a synthetic disposable that tears down the per-review `CommentController` + its thread disposables + the module-level controller refs when the panel closes.

extension.ts orchestrates the lifecycle via three module-level vars:

```ts
let activeReviewController: vscode.CommentController | null = null;
let activeReviewThreadDisposables: vscode.Disposable[] = [];
let activeReviewPushIdForController: string | null = null;
```

After `ReviewPanel.createOrShow` in `openReviewCommandImpl`, the controller is constructed (`versioncon.review.{pushId}` id + `Review: push {shortId}` label), added to the panel's owned-disposable chain via a synthetic disposable that clears all three refs on dispose, then `rebuildInlineReviewComments()` populates the threads. On every subsequent `review-state-sync` / `review-opened` / `review-comment` event (in BOTH `wireClientEvents` AND `wireHostEvents`), `rebuildInlineReviewComments()` disposes the prior threads and re-registers — full-rebuild posture, bounded by host's 500-cap.

`versioncon.review.replyToComment` command is invoked by VS Code's built-in "Reply" UI when `thread.canReply === true`. The handler reads `reply.thread.uri.fsPath` + `reply.thread.range.start.line`, maps back to `{filePath, line}` relative to the active branch dir, and forwards through `buildReviewPanelCallbacks().onCommentRequested(reviewId, filePath, line, body)` — identical to the panel composer's wire path, so identity override + rate-limit + 500-cap apply uniformly.

### Test coverage delta

| Suite                                                                                  | Tests | Status |
| -------------------------------------------------------------------------------------- | ----- | ------ |
| `Phase 6 Wave 5 — BranchManager.setRequireReview + admin command (Task 1)`             | 10    | All pass |
| `Phase 6 Wave 5 — checkRequireReviewGate behavior (Task 2)`                            | 9     | All pass |
| `Phase 6 Wave 5 — gate insertion at 3 merge entry points + system event (Task 2)`      | 6     | All pass |
| `Phase 6 Wave 5 — registerInlineCommentsForReview (Task 3 behavior)`                   | 10    | All pass |
| `Phase 6 Wave 5 — vscode.commentController wiring source-grep (Task 3)`                | 8     | All pass |
| Existing suites                                                                        | 824   | All pass (no regressions) |
| **Total**                                                                              | **867** (was 824) | **+43 tests** |

Pending count unchanged at 66.

## TDD Gate Compliance

| Task    | RED commit | GREEN commit |
| ------- | ---------- | ------------ |
| 1 + 2   | `458dbce` `test(06-05): add failing mandatoryReviewGate suite — Tasks 1+2 (RED)` | `a71fec6` `feat(06-05): BranchManager.setRequireReview + 3-merge-entry-point gate (GREEN)` |
| 3       | `2f4ef5e` `test(06-05): add failing reviewInlineComments suite — Task 3 (RED)`   | `c72e0ed` `feat(06-05): vscode.commentController inline-comment surface (GREEN)` |

Tasks 1 and 2 share a single RED/GREEN pair because they live in the same test file (`mandatoryReviewGate.test.ts`) and share the BranchManager.setRequireReview dependency — RED would otherwise have to land Task 1 alone, then re-emit the same TS2307 error for Task 2 in a second RED commit. The single-shared-RED posture mirrors Plan 06-04's combined Tasks 2+3 commit decision.

A separate REFACTOR phase was not required — the GREEN code is idiomatic. The plan-prescribed REFACTOR DEVIATION (extract the gate to `src/state/requireReviewGate.ts`) was adopted in Task 2 GREEN.

## Deviations from Plan

### Plan-prescribed work (not auto-fixes, but worth noting)

- **REFACTOR DEVIATION (plan-permitted)**: extracted `checkRequireReviewGate` to `src/state/requireReviewGate.ts` rather than as an IIFE-scoped inline helper in extension.ts. The plan explicitly allowed this posture and noted it was the cleaner option. Tests import the helper directly; extension.ts imports + calls at 3 sites.
- **Tasks 1+2 shared RED commit**: a single test file (`mandatoryReviewGate.test.ts`) covers both tasks per the plan's `<files>` list. The RED commit fails to compile because of both `BranchManager.setRequireReview` AND `src/state/requireReviewGate.ts` being absent — landed both in a combined GREEN.

### Auto-fixed Issues

**1. [Rule 1 — TS narrowing] CommentReply.thread.range is optional in @types/vscode**

- **Found during:** Task 3 GREEN type-check after writing the `versioncon.review.replyToComment` handler.
- **Issue:** `vscode.CommentThread.range` is typed as `Range | undefined` (a `CommentThread2` can have an undefined range when the thread is collapsed in the gutter without a line anchor). TypeScript flagged `reply.thread.range.start.line` as TS18048 "'reply.thread.range' is possibly 'undefined'".
- **Fix:** Captured `range` into a local + added an explicit null guard with a warning toast before computing `range.start.line + 1`. Defensive — in v1 we never create threads with undefined ranges (every thread is anchored to a `{filePath}:{line}` group), but the guard documents the contract for future thread shapes (e.g. file-level threads).
- **Files modified:** `src/extension.ts` (versioncon.review.replyToComment handler).
- **Commit:** `c72e0ed` (Task 3 GREEN — included with the wiring).

No structural deviations from the plan. The plan's action blocks were followed verbatim aside from the explicit REFACTOR DEVIATION described above.

## Threat Mitigation Audit

| Threat | Status | Evidence |
| ------ | ------ | -------- |
| **T-06-04 (revisited)** (mandatory-review bypass via direct file edit) | **accepted** | Per 06-SPEC.md frontmatter line 116 — out of scope, same posture as Phase 3 SyncTracker. The gate runs on host-process merge ops (versioncon.mergeBranch / quickMergeFiles / structuredMergeBranch); users with OS-level write access to `.versioncon/branches/main/foo.ts` can bypass any VersionCon-mediated gate. Documented explicitly here. |
| **T-06-01** (Spoofing — versioncon.setBranchRequireReview from a non-admin) | **CLOSED** | Admin gate at command entry checks `permissions.canCreateBranch(currentMemberId)`; non-admins receive an error toast and the QuickPick never opens. Pinned by source-grep test "versioncon.setBranchRequireReview handler is admin-gated via canCreateBranch". |
| **T-06-02** (XSS — inline comment body via MarkdownString) | **CLOSED** | `vscode.MarkdownString` wraps every Comment.body; `isTrusted` defaults to `false` (we never set it to `true`), so VS Code's comment renderer escapes raw HTML. Source-grep test pins the `MarkdownString` reference in `src/ui/inlineReviewComments.ts`. Mirrors Plan 04-10 / Plan 06-04 webview markdown-it `html:false` posture. |
| **T-06-03** (Denial of Service — spam replies via inline gutter) | **CLOSED inherited** | Replies via `versioncon.review.replyToComment` route through `buildReviewPanelCallbacks().onCommentRequested` → host's `handleLocalReviewComment` (or `activeClient.sendMessage`) → SessionHost.processReviewComment which enforces the per-member 30/min rate-limit + per-review 500-cap (Plan 06-02). The CommentController surface is just another UI for the same wire frame. |
| **T-06-05** (Spoofing — state-sync replay) | **CLOSED inherited** | Inline comment threads are rebuilt from `reviewState.getActiveReviewForPush(...)` — `ReviewState` is fed only by `SessionClient.handleMessage` (single host ws) AND `SessionHost.this.emit('review-*', ...)` (host's own loop). No peer-to-peer path; no new ingress added in this plan. |

## Threat Flags

No new security-relevant surface introduced beyond the plan's `<threat_model>`. The new wire surface is zero (no new wire types) — the gate is read-only, the admin command writes through existing `BranchManager.saveMetadata`, and the reply routing reuses the existing `review-comment` wire frame.

## Self-Check: PASSED

**Files created:**
- FOUND: `src/state/requireReviewGate.ts` (87 lines)
- FOUND: `src/ui/inlineReviewComments.ts` (112 lines)
- FOUND: `src/test/suite/mandatoryReviewGate.test.ts` (440 lines, 25 tests)
- FOUND: `src/test/suite/reviewInlineComments.test.ts` (313 lines, 18 tests)

**Files modified:**
- FOUND: `src/filesystem/BranchManager.ts` (+33 lines — setRequireReview + getRequireReview)
- FOUND: `src/host/SessionHost.ts` (+15 lines doc / visibility change)
- FOUND: `src/extension.ts` (~+190 lines across gate import, 3 gate insertions, setBranchRequireReview command, commentController lifecycle, replyToComment command, rebuild hooks in both wireClient + wireHost listeners)
- FOUND: `src/ui/ReviewPanel.ts` (+13 lines — addOwnedDisposable method)
- FOUND: `package.json` (+5 lines — versioncon.setBranchRequireReview command declaration)

**Commits (in order):**
- FOUND: `458dbce` test(06-05): add failing mandatoryReviewGate suite — Tasks 1+2 (RED)
- FOUND: `a71fec6` feat(06-05): BranchManager.setRequireReview + 3-merge-entry-point gate (GREEN)
- FOUND: `2f4ef5e` test(06-05): add failing reviewInlineComments suite — Task 3 (RED)
- FOUND: `c72e0ed` feat(06-05): vscode.commentController inline-comment surface (GREEN)

**Verification outputs:**
- `npx tsc --noEmit` — clean (no output)
- `npm run build` — clean (esbuild succeeds)
- `npm test` — **867 passing, 0 failing, 66 pending** (was 824 after Plan 06-04)
- `npm test -- --grep "Phase 6 Wave 5"` — **43 passing** (10 + 9 + 6 + 10 + 8 across the 5 suites)
- `grep -c "checkRequireReviewGate" src/extension.ts` — **4** (1 import + 3 call sites at the merge entry points)
- `grep -c "vscode\.comments\.createCommentController" src/extension.ts` — **1**
- `grep "public appendAndBroadcastSystemEvent" src/host/SessionHost.ts` — 1 match (visibility widened)

**Min-lines compliance vs plan's must_haves.artifacts targets:**
- mandatoryReviewGate.test.ts: 440 (target ≥ 250) ✓
- reviewInlineComments.test.ts: 313 (target ≥ 150) ✓

## Phase 6 Completion Note

Plan 06-05 is the final wave of Phase 6 (Inline Code Review). All four Success Criteria from 06-SPEC.md are end-to-end-supported by code:

- **SC-1** (side-by-side diff per change): Plan 06-04 — ReviewPanel + vscode.diff invocation against push-snapshots + branch dir.
- **SC-2** (approve / request-changes / line comments inside VS Code): Plan 06-04 panel composer + Plan 06-05 vscode.commentController inline gutter + reply routing.
- **SC-3** (mandatory review gate): Plan 06-05 — `checkRequireReviewGate` at all 3 mergeBranch entry points + admin toggle command.
- **SC-4** (review comments in chat thread): Plan 06-02 — every review-opened/comment/vote/resolved fires `appendAndBroadcastSystemEvent` → chat-log.json `kind:'system', subKind:'review-*'`. Plan 06-05 extends this to merge-blocked rejections (subKind:'review-resolved' with the merge-block body).

UAT folds into a future `/gsd-verify-work 6` pass; Phase 6 is feature-complete at this commit.
