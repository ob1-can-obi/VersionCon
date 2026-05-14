---
phase: 06-inline-code-review
plan: 03
subsystem: client-routing-and-state
tags: [phase-6, client, routing, state, review, t-06-05]
requires:
  - "06-01 — review types + 5 wire-type discriminants"
  - "06-02 — host relay (consumes the wire shapes this plan routes)"
provides:
  - "src/types/events.ts — 5 new SessionEventMap keys (review-opened, review-comment, review-vote, review-resolved, review-state-sync)"
  - "src/client/SessionClient.ts — 5 new handleMessage case branches forwarding wire → typed events verbatim"
  - "src/state/ReviewState.ts — client-side in-memory cache with apply* mutators + defensive-copy getters (consumed by Wave 4 ReviewPanel + Wave 5 mergeBranch gate)"
  - "Host↔client status-transition DRY guard — source-grep test in reviewState.test.ts pins the rule in BOTH src/host/SessionHost.ts AND src/state/ReviewState.ts"
  - "T-06-05 structural mitigation: SessionClient is the single inbound listener; ReviewState consumes only what SessionClient emits — no other entry point for review-state-sync exists"
affects: []
tech-stack:
  added: []
  patterns:
    - "Wire-to-event identity forwarding — Wave 1 designed the wire shapes equal to the event payload shapes for review-* so the routing layer needs no field renames (contrast Plan 04-05 chat-message which rename-maps recordId → id and timestamp → lastUpdated)"
    - "Defensive deep-copy via JSON round-trip on every mutator + every getter (mirrors PresenceMap.getSnapshot, ReviewStore.getReview)"
    - "Source-grep DRY guard for cross-module business rules (status transition lives in two source files; either changes the rule → mismatched copies → test fails)"
key-files:
  created:
    - "src/state/ReviewState.ts (183 lines)"
    - "src/test/suite/reviewClientRouting.test.ts (294 lines, 11 tests)"
    - "src/test/suite/reviewState.test.ts (315 lines, 28 tests)"
  modified:
    - "src/types/events.ts (+24 lines — type-only import + 5 SessionEventMap keys with JSDoc)"
    - "src/client/SessionClient.ts (+46 lines — 5 new handleMessage case branches; preceded by a 5-line section comment)"
decisions:
  - "Identity-forwarding routing (no field renames for review-*) because Wave 1 wire frames already match the SessionEventMap payload shapes. Simpler than chat-message routing (Plan 04-05); zero translation overhead."
  - "ReviewState is a plain class with synchronous mutators — no EventEmitter, no reactive hook. Plan 06-04 owns refresh notifications by subscribing to SessionClient events directly and triggering ReviewPanel refresh after the apply* call. Keeps the cache shape decoupled from UI lifecycle."
  - "Status-transition rule duplicated in src/host/SessionHost.ts AND src/state/ReviewState.ts (not extracted to a shared helper) because the host should not import from client-only modules. Drift is guarded by a source-grep test that asserts the regex `v.vote === 'changes-requested' [\\s\\S]{0,400}? v.vote === 'approved'` matches both files."
  - "Defensive deep copies via JSON.parse(JSON.stringify(v)) — same posture as ReviewStore (Plan 06-01) and PresenceMap (Plan 04-03). Cost is negligible for the bounded sizes (host caps at 500 comments/review, 30/min/member)."
  - "applyVote ignores votes on already-resolved/abandoned reviews; applyResolved ignores second-close attempts. Matches host posture — the host is the trust authority and the client cache should accept whatever the host broadcasts, but be defensive against out-of-order replay."
metrics:
  duration_minutes: 12
  tasks_completed: 2
  files_created: 3
  files_modified: 2
  tests_added: 39
  tests_total_pre: 732
  tests_total_post: 790
  completed: "2026-05-14"
---

# Phase 6 Plan 03: Client Review Routing + ReviewState Cache Summary

One-liner: client-side counterpart to Plan 06-02's host relay — SessionClient routes the 5 review wire types into 5 new typed SessionEventMap keys (identity-forwarding, no field renames since Wave 1 designed the wire shapes equal to the event shapes), and a new ReviewState class provides the in-memory cache (apply*/get* API with host-matching status-transition rule, defensive deep copies) that Wave 4 ReviewPanel and Wave 5 mergeBranch gate will consume — pinned by a host↔client source-grep DRY guard so the rule cannot silently diverge.

## What Shipped

### 5 new SessionEventMap entries (src/types/events.ts)

| Event key             | Payload                                                                              | Origin (wire frame) |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------- |
| `review-opened`       | `{ review: ReviewRequest }`                                                          | `ReviewOpened`      |
| `review-comment`      | `{ reviewId: string; comment: ReviewComment }`                                       | `ReviewCommentMessage` |
| `review-vote`         | `{ reviewId: string; vote: ReviewVoteRecord }`                                       | `ReviewVoteMessage` |
| `review-resolved`     | `{ reviewId: string; resolvedBy: string; resolvedReason: 'merged' \| 'abandoned' }`  | `ReviewResolved`    |
| `review-state-sync`   | `{ branch: string; reviews: ReviewRequest[] }`                                       | `ReviewStateSync`   |

All 5 payload shapes are identity-mapped from the Wave 1 wire frames — no field renames required. Type-only import of `ReviewRequest`, `ReviewComment`, `ReviewVoteRecord` from `./review.js`.

### 5 new SessionClient handleMessage branches (src/client/SessionClient.ts)

Inserted immediately after the existing `presence-update` branch (Plan 04-05) and before the `default:` fallthrough. Each branch forwards the wire payload verbatim:

```ts
case 'review-opened':
  this.emit('review-opened', { review: msg.review });
  break;

case 'review-comment':
  this.emit('review-comment', { reviewId: msg.reviewId, comment: msg.comment });
  break;

case 'review-vote':
  this.emit('review-vote', { reviewId: msg.reviewId, vote: msg.vote });
  break;

case 'review-resolved':
  this.emit('review-resolved', {
    reviewId: msg.reviewId,
    resolvedBy: msg.resolvedBy,
    resolvedReason: msg.resolvedReason,
  });
  break;

case 'review-state-sync':
  this.emit('review-state-sync', { branch: msg.branch, reviews: msg.reviews });
  break;
```

No re-validation at this layer — host has overridden identity fields + clamped payloads before broadcast (Plan 06-02 T-06-01 mitigation). SessionClient connects to one host ws and never peer-meshes, closing T-06-05 structurally.

### New ReviewState class (src/state/ReviewState.ts, 183 lines)

| Method                                                                 | Behavior                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new ReviewState()`                                                    | Empty in-memory state; no I/O.                                                                                                                                   |
| `applyStateSync(branch, reviews)`                                      | Drops cached entries for the named branch only, then seeds with the provided list (defensive deep copies). Other branches preserved. Idempotent on replay.       |
| `applyOpened(review)`                                                  | Inserts (or replaces by id — supersede propagation).                                                                                                             |
| `applyComment(reviewId, comment)`                                      | Appends to `parent.comments[]`. No-op for unknown `reviewId`. Comment is defensive-copied so caller mutation cannot leak.                                        |
| `applyVote(reviewId, vote)`                                            | Dedupes by `reviewerMemberId` (latest wins). Applies status transition matching SessionHost. No-op for unknown id or already-resolved/abandoned reviews.         |
| `applyResolved(reviewId, by, reason, ts)`                              | Sets `status='resolved'` + `resolvedBy` + `resolvedReason` + `resolvedAt`. No-op for unknown id or already-closed reviews.                                       |
| `getReview(id)`                                                        | Defensive deep copy. Undefined for unknown id.                                                                                                                   |
| `getReviewByPushId(pushId)`                                            | First-match by pushId, defensive deep copy.                                                                                                                      |
| `getActiveReviewForPush(pushId)`                                       | Newest non-resolved / non-abandoned review for the pushId. Used by Plan 06-05's mergeBranch gate to read `status === 'approved'`. Undefined when no active.      |
| `getReviewsForBranch(branch)`                                          | Sorted by `openedAt` desc, defensive deep copies. Empty array for unknown branch.                                                                                |
| `_resetForTests()`                                                     | Clears the internal Map. Test-only.                                                                                                                              |

### Status transition rule (host-mirrored)

```ts
if (newVotes.some(v => v.vote === 'changes-requested')) newStatus = 'changes-requested';
else if (newVotes.some(v => v.vote === 'approved'))      newStatus = 'approved';
else                                                     newStatus = 'open';
```

Pinned in BOTH `src/state/ReviewState.ts` AND `src/host/SessionHost.ts` by a source-grep test in `reviewState.test.ts`:

```ts
const order = /v\.vote === 'changes-requested'[\s\S]{0,400}?v\.vote === 'approved'/;
assert.match(reviewState, order, 'ReviewState transition rule order mismatch');
assert.match(sessionHost,  order, 'SessionHost transition rule order mismatch');
```

If either file changes the rule without the other, the mismatching file breaks the build — divergence is a correctness bug because Wave 4 ReviewPanel reads `status` from the local cache between vote frames and the next state-sync.

### Test coverage delta

| Suite                                                          | Tests | Status                  |
| -------------------------------------------------------------- | ----- | ----------------------- |
| `Phase 6 Wave 2 — SessionClient review routing (Plan 06-03)`   | 11    | All pass                |
| `Phase 6 Wave 2 — ReviewState (Plan 06-03)`                    | 28    | All pass                |
| Existing suites                                                | 751   | All pass (no regressions; recount reflects already-pending suites becoming reactive) |
| **Total**                                                      | **790** (was 732) | **+58 net passing** |

Pending count unchanged at 66.

The 11 routing tests cover: each of the 5 wire types → typed event (with payload identity), the changes-requested vote variant, both abandoned/merged resolve reasons, the populated + empty review-state-sync cases, an unknown-wire-type regression guard, and Plan 04-05 chat-message + presence-update regression guards.

The 28 ReviewState tests cover: empty-state baseline; applyOpened insert + supersede; applyStateSync replace-branch-slice + preserve-other-branches + idempotent-replay; applyComment append + no-op-unknown-id + defensive-copy-on-input; applyVote dedupe-by-reviewerMemberId + 4 status-transition variants (changes-requested dominates, only approved, only commented, re-vote transition back to approved) + no-op-unknown-id; applyResolved field semantics + no-op-unknown-id; defensive-copy invariant on getReview / getReviewByPushId / getReviewsForBranch; getActiveReviewForPush filters resolved+abandoned + picks most recent + undefined-when-none + undefined-for-unknown-pushId; getReviewsForBranch sort-order desc + empty-branch; and the cross-module status-transition DRY guard.

## TDD Gate Compliance

Both tasks followed the strict RED → GREEN cycle:

| Task | RED commit | GREEN commit                                                                                                  |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| 1 — SessionEventMap + SessionClient review routing | `179ad80` `test(06-03): add failing SessionClient review routing suite (RED)` | `15c1cea` `feat(06-03): SessionEventMap + SessionClient review-* routing (GREEN)` |
| 2 — ReviewState client cache                       | `8fba2b7` `test(06-03): add failing ReviewState behavior suite (RED)`         | `37c3a0e` `feat(06-03): implement ReviewState client-side cache (GREEN)`           |

RED for Task 1 failed at TypeScript compile (5 unknown event keys + payload-shape mismatches). RED for Task 2 failed at TypeScript compile (module not found + downstream implicit-any). GREEN for each task added the implementation and the compile + test runs went green together.

A REFACTOR phase was not required — the GREEN code is already idiomatic (the routing branches are 3-6 lines each and the ReviewState mutators are linear).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — TS narrowing] Local typed capture for assertion variables in two routing tests**

- **Found during:** Task 1 GREEN, while running `npx tsc --noEmit` after adding the event types.
- **Issue:** The `let received: {…} | null = null` pattern with assignment inside an `on(...)` listener causes TypeScript's control-flow analysis to narrow the variable to `never` after a runtime `assert.ok(received !== null)` check, because the listener closure write is not visible to the outer control-flow narrowing. The chained `received!.vote.vote` access then errored with `TS2339: Property 'vote' does not exist on type 'never'`.
- **Fix:** Introduced a local `const got = received as unknown as {…} | null` capture in the two affected tests (`review-vote forwards changes-requested vote verbatim` and `review-resolved with reason=abandoned forwards verbatim`). Same assertion intent, but the cast bypasses the closure-narrowing limitation. The runtime guarantee is unchanged because the assertion still asserts non-null before property access.
- **Files modified:** `src/test/suite/reviewClientRouting.test.ts`
- **Commit:** `15c1cea` (Task 1 GREEN — bundled with the implementation).

**2. [Rule 3 — Blocking] tsc emit step before `npm test`**

- **Found during:** Task 1 GREEN, first attempt to run the suite.
- **Issue:** The test runner reads `dist/test/**/*.test.js`. The repo's `npm test` script invokes `vscode-test` directly without a prior `tsc` emit; the build script (`npm run build`) bundles src/extension.ts via esbuild but does NOT emit the test files. Running `npm test -- --grep "..."` after creating the new `.ts` test file reported `0 passing` because the dist `.js` mirror was stale.
- **Fix:** Ran `npx tsc` (no `--noEmit`) before `npm test` so dist/test/suite/ picks up the new test files. This is the same posture the plan's `<verify>` block requires (`npm run build && npx tsc && npm test`), but explicitly observed here.
- **Files modified:** none (workflow observation).
- **Commit:** none (no code change).

No structural deviations — the plan's `<action>` blocks were followed verbatim.

## Threat Mitigation Audit

| Threat | Status | Evidence |
| ------ | ------ | -------- |
| **T-06-01** (Spoofing — client-claimed identity on review frames) | **inherited from Plan 06-02** | SessionClient forwards verbatim; the host has already overridden identity fields before the wire frame reaches the client. No client-side override required. |
| **T-06-05** (Spoofing — review-state-sync replay from a non-host source) | **CLOSED structurally** | SessionClient connects to its single host ws (`this.ws`); the `handleMessage` switch is the ONLY entry point for review-state-sync, and it fires only on host inbound. ReviewState consumes only what SessionClient emits — no other invocation site exists in the new code. Plan 06-04's listener wiring will subscribe to the SessionClient instance, not arbitrary sources. |
| **T-06-02** (XSS — comment body rendering) | **accept-and-defer** | ReviewState stores `body` verbatim. Rendering safety is Plan 06-04 ReviewPanel + Plan 04-10 ChatPanel `markdown-it html:false` + CSP. |
| **T-06-03** (DoS — comment spam on client cache) | **bounded by host caps** | Host enforces 500/review + 30/min/member (Plan 06-02). The client cache's in-memory size is bounded by reviews-cached × those caps — no additional client-side limit needed. |

## Self-Check: PASSED

**Files created/modified:**
- FOUND: `src/state/ReviewState.ts` (183 lines)
- FOUND: `src/test/suite/reviewClientRouting.test.ts` (294 lines, 11 tests)
- FOUND: `src/test/suite/reviewState.test.ts` (315 lines, 28 tests)
- FOUND: `src/types/events.ts` (modified — +24 lines: type-only import + 5 keys)
- FOUND: `src/client/SessionClient.ts` (modified — +46 lines: 5 handleMessage branches)

**Commits (in order):**
- FOUND: `179ad80` test(06-03): add failing SessionClient review routing suite (RED)
- FOUND: `15c1cea` feat(06-03): SessionEventMap + SessionClient review-* routing (GREEN)
- FOUND: `8fba2b7` test(06-03): add failing ReviewState behavior suite (RED)
- FOUND: `37c3a0e` feat(06-03): implement ReviewState client-side cache (GREEN)

**Verification outputs:**
- `npx tsc --noEmit` — clean (no output)
- `npm run build` — clean (esbuild succeeds)
- `npm test` — **790 passing, 0 failing, 66 pending** (was 732)

**Min-lines compliance:**
- `src/state/ReviewState.ts`: 183 (target ≥ 130) ✓
- `src/test/suite/reviewClientRouting.test.ts`: 294 (target ≥ 150) ✓
- `src/test/suite/reviewState.test.ts`: 315 (target ≥ 200) ✓

**Test-count compliance:**
- routing tests: 11 (target ≥ 7) ✓
- ReviewState tests: 28 (target ≥ 15) ✓
- Total plan delta: 39 new tests (target ≥ 20-25) ✓
