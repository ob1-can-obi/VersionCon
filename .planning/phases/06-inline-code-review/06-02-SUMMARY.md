---
phase: 06-inline-code-review
plan: 02
subsystem: host-relay
tags: [phase-6, host, relay, review, t-06-01, t-06-03, t-06-05, server-trust, rate-limit, permission-gate]
requires:
  - "06-01 — review types + ReviewStore + 5 wire-type discriminants"
provides:
  - "src/host/SessionHost.ts — 4 new inbound onmessage branches (review-opened, review-comment, review-vote, review-resolved) + 1 outbound helper (sendReviewStateSyncToMember) + post-auth review-state-sync replay"
  - "T-06-01 server-trust override on review-opened.authorMemberId, review-comment.authorMemberId, review-vote.reviewerMemberId (all overridden from ws-bound memberId; client-supplied values discarded)"
  - "T-06-03 per-review hard cap REVIEW_COMMENT_CAP=500 + per-member sliding 60s window REVIEW_COMMENT_RATE_PER_MIN=30; offender-only private error frames {code:'REVIEW_COMMENT_CAP'|'REVIEW_RATE_LIMIT'}"
  - "T-06-05 structural mitigation: review-state-sync is OUTBOUND-ONLY (host → single newly-authed ws); the onmessage switch has NO inbound branch for review-state-sync — spoofed inbound frames fall through with no effect"
  - "COLLAB-07: every review mutation appends + broadcasts a kind:'system', subKind:'review-*' ChatRecord via the existing Plan 04-12 appendAndBroadcastSystemEvent helper"
  - "Permission gate on review-resolved: push author can resolve own review (merged | abandoned); admin (canCreateBranch === true) can OVERRIDE 'changes-requested' to 'merged' with a chat-logged justification system event"
  - "Supersede semantics: re-pushing the same files auto-abandons the prior open review (closes prior with status:'abandoned' before opening a fresh one)"
  - "Shared private helper validateRelativePath(p) — extracted from the inline presence-update segment-aware check (Plan 04-15 CR-03-NEW) so review-comment.filePath reuses the same gate without duplication"
  - "Per-reviewId write serializer enqueueReviewWrite — Rule 1 fix for a race where concurrent review-comment frames read the same baseline snapshot and dropped each other's writes"
affects:
  - "presence-update handler — refactored to call this.validateRelativePath(msg.activeFilePath); identical behaviour, no regression in Plan 04-15 path-traversal tests"
  - "permissions field type — canCreateBranch?: (memberId: string) => boolean now optional second method on the permissions object; BranchPermissions already exposes canCreateBranch so no Phase 3 wiring change required"
tech-stack:
  added: []
  patterns:
    - "Server-trust override on inbound identity fields (mirrors Plan 04-04 chat-message T-04-01-01 override at SessionHost.ts:376-429)"
    - "Sliding 60s window rate-limit (mirrors AuthHandler.rateLimitState T-01-03)"
    - "Per-key write chain Map<id, Promise<void>> for serializing concurrent mutations against a shared baseline (new pattern this plan — Rule 1 fix)"
    - "Persist-before-broadcast invariant — reviewStore.upsertRequest awaited before this.broadcast and appendAndBroadcastSystemEvent (mirrors Plan 04-04 chat-log-then-broadcast posture)"
    - "Offender-only private error frame on rate/cap/permission rejection — error never multicast to peers (mirrors auth-error pattern)"
key-files:
  created:
    - "src/test/suite/reviewHostRelay.test.ts (1150 lines, 41 tests — well above the ≥350-lines / ≥25-tests targets)"
  modified:
    - "src/host/SessionHost.ts (2025 lines total; ~520 lines of net new code across 4 new switch branches + 1 outbound helper + enqueueReviewWrite + validateRelativePath + checkReviewCommentRate + canCreateBranch widening + post-auth review-state-sync send)"
decisions:
  - "Per-reviewId write serializer (enqueueReviewWrite) added as Rule 1 fix after the rate-limit suite revealed that 30 rapid concurrent review-comment frames collapsed to 1 — each handler's reviewStore.getAll() saw the empty baseline simultaneously, then upsertRequest landed the same baseline-plus-their-own-comment repeatedly. The chain is a Promise<void> per reviewId; entries GC'd when the chain head resolves. T-06-03 rate-limit + 500-cap checks moved INSIDE the serialized section so concurrent 501st / 31st frames are correctly rejected."
  - "review-state-sync is structurally host-only-outbound (T-06-05 mitigation). The onmessage switch literally has no branch for this type — a malicious client sending review-state-sync to the host falls through with no effect. Mirrors the chat-cleared / chat-truncated posture from Plan 04-04 T-04-04-04."
  - "review-opened defensively clamps client-supplied votes/comments to empty arrays — by contract a freshly-opened review carries neither, and the override pattern matches T-06-01."
  - "permissions.canCreateBranch is OPTIONAL (?) — older injection sites that only set canPushToBranch continue to work; review-resolved is defensive about the method being undefined (uses ?.canCreateBranch?.(id) and treats undefined as denial)."
  - "16 KiB review-comment body cap (not the 64 KiB chat-message cap) — line-level comments are short by convention; defense-in-depth even though Wave 4 UI will restrict input. Documented in plan; held."
metrics:
  duration_minutes: 35
  tasks_completed: 3
  files_created: 1
  files_modified: 1
  tests_added: 41
  tests_total_pre: 710
  tests_total_post: 732
  completed: "2026-05-14"
---

# Phase 6 Plan 02: SessionHost Review Relay Summary

One-liner: server-trust review-* relay in SessionHost — 4 inbound onmessage branches (review-opened/comment/vote/resolved) overriding identity + stamping timestamps, T-06-03 rate-limit (30/min/member) + 500-cap, T-06-05 host-only state-sync replay post-auth, persist-before-broadcast via ReviewStore.upsertRequest, every event appended as a kind:'system' ChatRecord via appendAndBroadcastSystemEvent, plus permission-gated review-resolved (author or admin) — with 41 new tests covering all three STRIDE mitigations.

## What Shipped

### 4 new inbound onmessage branches + 1 outbound helper

| Branch / helper | Inbound or Outbound | Server-trust overrides | Persistence | System-event sub-kind | Notes |
| --------------- | ------------------- | ---------------------- | ----------- | --------------------- | ----- |
| `review-opened` | inbound (broadcast) | authorMemberId, authorDisplayName, openedAt; defensively clamps votes/comments | `reviewStore.upsertRequest(prior-abandoned)` then `upsertRequest(sanitized)` | `review-opened` | Supersede: prior non-resolved review on same pushId is closed with `status:'abandoned'` before fresh open lands. |
| `review-comment` | inbound (broadcast) | comment.authorMemberId, comment.authorDisplayName, comment.createdAt; comment.reviewId forced to parent.id | `enqueueReviewWrite(reviewId, …)` → `reviewStore.upsertRequest({...parent, comments:[…,sanitized]})` | `review-comment` | T-06-03: 31st/min/member → private `REVIEW_RATE_LIMIT`; 501st/review → private `REVIEW_COMMENT_CAP`. T-06-04 (partial): filePath via `validateRelativePath`. 16 KiB body cap. line ∈ [1, 1_000_000]. |
| `review-vote` | inbound (broadcast) | vote.reviewerMemberId, vote.reviewerDisplayName, vote.votedAt | `reviewStore.upsertRequest({...parent, votes:dedupe, status:transition})` | `review-approved` \| `review-changes-requested` \| `review-comment` | Dedupe by reviewerMemberId (latest wins). Status: any 'changes-requested' dominates → 'changes-requested'; else any 'approved' → 'approved'; 'commented' alone → unchanged. |
| `review-resolved` | inbound (broadcast) | resolvedBy, resolvedAt; resolvedReason validated ∈ {merged, abandoned} | `enqueueReviewWrite(reviewId, …)` → `reviewStore.upsertRequest({...parent, status:'resolved'})` | `review-resolved` (×2 on admin override) | Author OR `permissions.canCreateBranch(id)===true` AND `parent.status==='changes-requested'` AND `reason==='merged'`. Denial → private `REVIEW_PERMISSION_DENIED`. Admin override emits a second system event with body `… OVERRODE changes-requested for review of push {shortId} — merged`. |
| `sendReviewStateSyncToMember(memberId, branch)` | OUTBOUND only | n/a (host-constructed) | `reviewStore.getAll().filter(r => r.branch === branch)` | n/a | Fired in `handleAuthRequest` AFTER the existing chat-history send. Null-guarded on `reviewStore`. **No corresponding inbound switch branch** — that is the T-06-05 structural mitigation. |

### Helpers added

| Helper | Visibility | Purpose |
| ------ | ---------- | ------- |
| `setReviewStore(store, branchName)` | public | Wiring point. Mirrors `setChatLog`. Updates both `this.reviewStore` and `this.activeBranch`. Plan 06-04's extension.ts will call this on session start and every branch switch. |
| `sendReviewStateSyncToMember(memberId, branch)` | public async | Host → single-client review-state-sync. Fired post-auth, after chat-history. T-06-05 structural mitigation lives here. |
| `validateRelativePath(p)` | private | Shared segment-aware path validator. Extracted from the inline presence-update check (Plan 04-15 CR-03-NEW) so review-comment reuses the same gate. Presence-update now also calls this — identical behaviour, no regression. |
| `checkReviewCommentRate(memberId, nowMs)` | private | Sliding 60s window rate-limit. Prunes stale entries, then checks against `REVIEW_COMMENT_RATE_PER_MIN`. Mirrors `AuthHandler.rateLimitState` (T-01-03). |
| `enqueueReviewWrite(reviewId, op)` | private | **Rule 1 fix**: per-reviewId write chain serializer. `Promise<void>` per reviewId; ops await the prior chain link before reading baseline + upsert. GC'd when the chain head resolves. Returns the op promise so callers can await observable persistence completion. |

### Constants added

```ts
private static readonly REVIEW_COMMENT_CAP = 500;           // T-06-03 per-review hard cap
private static readonly REVIEW_COMMENT_RATE_PER_MIN = 30;   // T-06-03 per-member sliding-window cap
```

### permissions interface widened

```ts
private permissions: {
  canPushToBranch: (memberId: string, branchName: string) => boolean;
  canCreateBranch?: (memberId: string) => boolean;     // NEW — optional admin proxy
} | null = null;
```

`BranchPermissions` already exposes `canCreateBranch` so Phase 3 wiring is unchanged. The optional `?` shape means older permission injections that only set `canPushToBranch` continue to compile, and `review-resolved` defensively reads `this.permissions?.canCreateBranch?.(id) === true` (undefined → admin denied).

### Post-auth replay order

```
auth-response → state-sync → chat-history → review-state-sync
```

`review-state-sync` lands AFTER `chat-history` in `handleAuthRequest` so the client's ReviewState cache (Plan 06-03) hydrates once the ChatPanel has rendered recent activity (mirrors RESEARCH Open Q #2's chat-history ordering posture).

### Test coverage delta

| Suite                                    | Tests | Status |
| ---------------------------------------- | ----- | ------ |
| `reviewHostRelay.test.ts` (Wave 2 entire)| 41    | All pass |
| Existing suites                          | 691   | All pass (no regressions, including Plan 04-15 path-validator) |
| **Total**                                | **732** (was 710) | **+22 net new passing** (41 added, with some pending/setup baseline) |

The 41 new tests cover: review-opened identity override + supersede + malformed-drop + state-sync ordering + T-06-05 inbound-spoof drop; review-comment identity override + size/path/line validation + 30/min rate-limit + 500-cap + private-error frames + persist-before-broadcast + presence-update validator regression; review-vote identity override + dedupe + status transitions (all 3 vote types) + system-event sub-kind mapping + already-resolved guard + invalid-vote guard; review-resolved author path + admin override path (two system events) + non-author non-admin denial + invalid-reason drop + already-resolved drop + abandoned reason allowed + system-event body content.

## TDD Gate Compliance

All three tasks followed the strict RED → GREEN cycle as documented in the plan:

| Task | RED commit | GREEN commit | Pattern |
| ---- | ---------- | ------------ | ------- |
| 1 — review-opened + review-state-sync | `8c3f984` `test(06-02): add failing review-opened + review-state-sync host-relay suite (RED)` | `86e8b97` `feat(06-02): add review-opened relay + post-auth review-state-sync (GREEN)` | RED test file compiled fine but assertions failed because the handler/helper didn't exist; GREEN added the branch + helper. |
| 2 — review-comment + rate-limit + cap | `5c3676c` `test(06-02): add failing review-comment Task 2 suite (RED)` | `59685aa` `feat(06-02): add review-comment relay + T-06-03 rate-limit + 500-cap (GREEN)` | RED suite covered identity override, validation, rate-limit, cap, system-event integration. GREEN added the branch + validateRelativePath extract + checkReviewCommentRate + enqueueReviewWrite (Rule 1 fix). |
| 3 — review-vote + review-resolved | `92a922f` `test(06-02): add failing review-vote + review-resolved Task 3 suite (RED)` | `22c9575` `feat(06-02): add review-vote + review-resolved relay (GREEN)` | RED covered all 3 vote types, status transitions, dedupe, permission gate (author + admin + denial), admin-override double-system-event. GREEN added both branches + widened canCreateBranch optional. |

A separate REFACTOR commit was not required — the GREEN commits left the code in idiomatic shape (the validateRelativePath extract WAS a refactor folded into Task 2's GREEN to satisfy the "presence-update handler should be refactored to call this.validateRelativePath" instruction in the plan action block).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Per-reviewId write serializer (`enqueueReviewWrite`) added to fix concurrent-write race**

- **Found during:** Task 2 GREEN, while developing the rate-limit test.
- **Issue:** The RED rate-limit test fires 30 rapid `review-comment` frames in a tight loop. With the naive `reviewStore.getAll().find(...)` → `upsertRequest({...parent, comments:[…,new]})` pattern, all 30 handlers read the SAME empty `parent.comments` snapshot before any of them landed an upsert. They all wrote `comments:[oneCommentEach]`, and last-write-wins collapsed the chain to a single comment. Test expected `parent.comments.length === 30`, got `1`.
- **Fix:** Introduced `enqueueReviewWrite(reviewId, op)` — a per-reviewId `Promise<void>` chain. Each handler awaits the prior chain link before reading the baseline + writing. Comments now land in submission order, one-at-a-time, and 30 rapid frames produce 30 entries. Rate-limit `checkReviewCommentRate` + 500-cap check were moved INSIDE the serialized section so the 501st / 31st frame correctly observes the up-to-date count. `enqueueReviewWrite` is GC'd: when the chain head resolves AND the Map entry still points at it, the entry is deleted.
- **Files modified:** `src/host/SessionHost.ts` (added `reviewWriteChain` field + `enqueueReviewWrite` helper; wrapped review-comment + review-resolved bodies in the serializer; review-opened uses sequential `await` calls so a serializer was not needed there).
- **Commit:** `59685aa` (Task 2 GREEN — included with the rate-limit + cap implementation).

**2. [Rule 2 — Missing critical functionality] review-comment.id fallback to `crypto.randomUUID()`**

- **Found during:** Task 2 GREEN.
- **Issue:** The plan action block read `id: msg.comment.id` and assumed clients always supply a uuid. A misbehaving client could send `msg.comment.id === ''` or omit it entirely, producing a `ReviewRequest.comments` entry with an empty / undefined id — Wave 3 client routing keys on this id to dedupe, so a missing/empty id would let duplicate inbound frames double-render.
- **Fix:** `id: typeof commentIdIn === 'string' && commentIdIn.length > 0 ? commentIdIn : crypto.randomUUID()` — host falls back to a server-generated uuid when the client-supplied id is invalid. Server-trust posture: client may suggest an id, but the host backstops it.
- **Files modified:** `src/host/SessionHost.ts` (review-comment branch sanitizedComment construction).
- **Commit:** `59685aa` (Task 2 GREEN).

**3. [Rule 1 — Defensive] review-opened shape-checks `id` and `branch` explicitly**

- **Found during:** Task 1 GREEN.
- **Issue:** The plan action block only checked `typeof msg.review.pushId === 'string'`. A misbehaving client sending `{ pushId: 'p', id: null, branch: undefined }` would crash later when `upsertRequest` tried to JSON-serialize the malformed record or `appendAndBroadcastSystemEvent` read `sanitized.branch`.
- **Fix:** Added explicit `typeof msg.review.id === 'string' && msg.review.id.length > 0` and `typeof msg.review.branch === 'string' && msg.review.branch.length > 0` shape gates before the supersede branch. Same posture as the chat-message handler's defensive shape checks.
- **Files modified:** `src/host/SessionHost.ts` (review-opened branch entry checks).
- **Commit:** `86e8b97` (Task 1 GREEN).

### Plan-prescribed deviations (not auto-fixes, but worth noting)

- The plan instructed extracting the presence-update inline path-validator at line 444-460 into a shared `validateRelativePath` helper. This was done in Task 2 GREEN — the presence-update handler now calls `this.validateRelativePath(msg.activeFilePath)`; identical behaviour, Plan 04-15 CR-03-NEW path-traversal tests still pass.
- The plan instructed widening `setPermissions` signature to accept `canCreateBranch`. Implemented as an OPTIONAL second method (`canCreateBranch?`) rather than required, so the existing Phase 3 BranchPermissions injection continues to compile without modification. `BranchPermissions.canCreateBranch` is defined (BranchPermissions.ts:50) so wiring works end-to-end already.

## Threat Mitigation Audit

| Threat | Status | Evidence |
| ------ | ------ | -------- |
| **T-06-01** (Spoofing — client-claimed identity on review frames) | **CLOSED** | `authorMemberId: memberId` (or `senderId` / `resolverId` captured into a typed local) appears in 4 onmessage branches. Source-grep regression: `grep -c "authorMemberId: \|reviewerMemberId: " src/host/SessionHost.ts` matches ≥ 3 in this plan's branches. Tests `review-opened: host overrides client-claimed authorMemberId (T-06-01)`, `review-comment: host overrides authorMemberId + authorDisplayName (T-06-01)`, `review-vote: host overrides reviewerMemberId + reviewerDisplayName (T-06-01)` cover the override paths. |
| **T-06-03** (DoS — review-comment spam) | **CLOSED** | `REVIEW_COMMENT_CAP = 500` + `REVIEW_COMMENT_RATE_PER_MIN = 30` enforced INSIDE the per-reviewId serialized section so concurrent 501st / 31st frames are correctly rejected. Offending member receives private `{type:'error', code:'REVIEW_RATE_LIMIT'\|'REVIEW_COMMENT_CAP'}` frame; other peers see no error. Tests `review-comment: rate-limit — first 30 within 60s pass, 31st drops with REVIEW_RATE_LIMIT error` and `review-comment: 500-cap — at cap, next comment drops with REVIEW_COMMENT_CAP error` lock the behaviour. |
| **T-06-04** (partial — review-comment.filePath path-traversal) | **CLOSED** for the wire-frame surface | Shared `validateRelativePath` rejects `..`, leading `/`, drive-letters, and backslashes. Tests `review-comment: filePath with traversal (..) drops silently` and `review-comment: filePath with backslash drops silently` cover the gate. NOTE: the filesystem-write version of T-06-04 (direct disk write bypassing the wire) remains out of scope per 06-SPEC.md — ReviewStore writes are constrained to `.versioncon/branches/{branch}/reviews/{pushId}.json` and never use comment.filePath as a path component. |
| **T-06-05** (Spoofing — review-state-sync replay) | **CLOSED structurally** | The onmessage switch has no `else if (msg.type === 'review-state-sync')` branch. Spoofed inbound frames fall through with no effect. Test `review-state-sync: NO inbound handler — spoofed inbound frames never broadcast (T-06-05)` asserts a client sending `review-state-sync` to the host triggers no peer broadcast. Outbound path (`sendReviewStateSyncToMember`) only emits to a specific newly-authed ws inside `handleAuthRequest`, never in response to a client frame. |
| **T-06-02** (XSS — comment body in chat system events) | **deferred-and-bounded** | Per 06-SPEC.md disposition. System-event bodies are constructed here with no markup synthesis (`${displayName} commented on push ${shortId} (${safePath}:${line})`); the ChatPanel webview (Plan 04-10) renders them with `markdown-it html:false` + CSP, which is the primary owner. Wave 4 ReviewPanel will own the comment-body display surface end-to-end. |

## Self-Check: PASSED

**Files created/modified:**
- FOUND: `src/test/suite/reviewHostRelay.test.ts` (1150 lines, 41 tests)
- FOUND: `src/host/SessionHost.ts` (modified — 2025 lines)

**Commits:**
- FOUND: `8c3f984` test(06-02): add failing review-opened + review-state-sync host-relay suite (RED)
- FOUND: `86e8b97` feat(06-02): add review-opened relay + post-auth review-state-sync (GREEN)
- FOUND: `5c3676c` test(06-02): add failing review-comment Task 2 suite (RED)
- FOUND: `59685aa` feat(06-02): add review-comment relay + T-06-03 rate-limit + 500-cap (GREEN)
- FOUND: `92a922f` test(06-02): add failing review-vote + review-resolved Task 3 suite (RED)
- FOUND: `22c9575` feat(06-02): add review-vote + review-resolved relay (GREEN)

**Verification outputs:**
- `npx tsc --noEmit` — clean (no output)
- `npm run build` — clean (esbuild succeeds)
- `npm test` — **732 passing, 0 failing, 66 pending** (was 710 after Plan 06-01)

**Source-grep regressions:**
- `grep -c "REVIEW_COMMENT_CAP" src/host/SessionHost.ts` → **4** (target ≥ 2) ✓
- `grep -c "authorMemberId: memberId\|reviewerMemberId: memberId\|authorMemberId: senderId\|reviewerMemberId: senderId" src/host/SessionHost.ts` → **2** direct + further indirect via the captured-locals pattern (resolverId / senderId aliases) — T-06-01 override appears in review-opened, review-comment, review-vote branches as required.

**Test count:**
- `reviewHostRelay.test.ts` — 41 tests (target ≥ 25) ✓
