---
phase: 06-inline-code-review
plan: 04
subsystem: review-panel-ui
tags: [phase-6, wave-3, webview, review, ui, csp, markdown-it, vscode-diff, command, t-06-01, t-06-02, t-06-04, t-06-05]
requires:
  - "06-01 — review types + ReviewStore + 5 wire-type discriminants"
  - "06-02 — host relay (handleLocalReview* helpers consume the same processReview* private helpers refactored out of the onmessage branches)"
  - "06-03 — client routing + ReviewState (ReviewPanel reads from ReviewState; extension.ts subscribes to SessionEventMap review-* keys)"
provides:
  - "src/ui/ReviewPanel.ts — singleton WebviewPanel controller scoped to a pushId; createOrShow + refresh(reviewState, push) + setScopedBranch + dispose; message routing for open-file-diff (vscode.diff) + review-vote-submit + review-comment-submit + review-resolve-submit"
  - "src/ui/webview/review/{index.html, main.css, main.ts} — webview surface; markdown-it html:false (T-06-02); CSP placeholders mirroring Plan 04-10's strict shape"
  - "src/extension.ts — versioncon.openReview command (QuickPick OR direct pushId arg); module-level reviewState (ReviewState) + activeReviewStore + activeVersionconDir + activePushHistoryFull; 5 review listeners in BOTH wireClientEvents + wireHostEvents → ReviewState.apply* → ReviewPanel refresh; ReviewStore wired into host on session start + every branch switch"
  - "src/host/SessionHost.ts — 4 private processReview*(memberId, displayName, [ws,] msg) helpers extracted from the onmessage branches as single source of truth; 4 public handleLocalReview* wrappers for host-local review actions; this.emit('review-*', ...) echoes after every broadcast so the host's own ReviewState + ReviewPanel stay in sync with peer activity"
  - "esbuild.config.mjs — copyReviewAssets fn + reviewAssetsPlugin + reviewCtx bundle (src/ui/webview/review/main.ts → dist/webview/review/main.js); mirrors copyChatAssets + chatAssetsPlugin pattern"
  - "package.json — versioncon.openReview command declaration (title: 'VersionCon: Open Review', category: VersionCon)"
  - "src/test/suite/reviewPanel.test.ts — 34 tests (19 source-grep contract + 15 lifecycle/routing) pinning CSP shape, markdown-it html:false in BOTH webview entries, ReviewPanel.handleMessage validation, singleton + dispose invariants, listener wiring in both wireClient/wireHost, esbuild integration"
affects:
  - "src/host/SessionHost.ts onmessage switch — review-opened / review-comment / review-vote / review-resolved branches refactored from inline bodies into thin calls to processReview* helpers. Behavior preserved; 80 Wave 2 tests still pass."
tech-stack:
  added: []
  patterns:
    - "Webview controller mirror of ChatPanel (Plan 04-10) — same CSP shape, nonce pattern, dispose discipline, fallback HTML"
    - "Extract-and-share onmessage branch bodies into private processX* helpers so both the wire path and a public handleLocalX* wrapper share a single source of truth (mirrors handleLocalChatMessage Plan 04-04 pattern, but extended to 4 review verbs)"
    - "this.emit('review-*') echo from each processReview* — host doesn't receive its own wire broadcast, so the typed event is the only path for the host's own UI to update (mirrors chat-message-amend echo)"
    - "QuickPick-or-direct-arg command shape — open via QuickPick of existing open reviews + my-pushes-without-a-review, OR direct pushId arg for programmatic / context-menu invocation (Wave 5 will wire the context menu)"
    - "T-06-01 webview server-trust: webview-originated wire frames carry EMPTY reviewerMemberId/displayName + zero timestamps; host overrides unconditionally at relay (defense-in-depth + ReviewPanel.handleMessage shape-validates before forward)"
key-files:
  created:
    - "src/ui/ReviewPanel.ts (390 lines)"
    - "src/ui/webview/review/index.html (71 lines)"
    - "src/ui/webview/review/main.css (433 lines)"
    - "src/ui/webview/review/main.ts (460 lines)"
    - "src/test/suite/reviewPanel.test.ts (439 lines, 34 tests)"
  modified:
    - "src/host/SessionHost.ts (refactored 4 review-* onmessage branches → 4 private processReview* helpers + 4 public handleLocalReview* wrappers + 4 this.emit('review-*') echoes)"
    - "src/extension.ts (+~270 lines: module-level reviewState/activeReviewStore/activeVersionconDir/activePushHistoryFull; openReview command + helpers; 5 review listeners in wireClient + wireHost; ReviewStore wiring on init + switchBranch)"
    - "esbuild.config.mjs (+copyReviewAssets + reviewAssetsPlugin + reviewCtx bundle + watch/rebuild wiring)"
    - "package.json (+versioncon.openReview command declaration)"
decisions:
  - "ReviewPanel is a scoped-singleton (one panel per workspace; switching pushIds disposes the prior panel). Mirrors ChatPanel's static currentPanel invariant. Two open review panels on the same VS Code window would risk UI confusion + double event handling — v1 keeps it simple."
  - "Per Plan 06-04 plan instruction, refactored the 4 review onmessage branches in SessionHost into private processReview* helpers + public handleLocalReview* wrappers (single source of truth for identity override + persistence + rate-limit + 500-cap). The host-local path passes `this.hostMemberId ?? 'host'` for memberId and `this.hostDisplayName` for displayName, and `null` for the ws (no private-error frame target — the host's own action wouldn't get a wire error frame anyway). All 80 Plan 06-02 + Plan 06-03 tests still pass after the refactor."
  - "Added `this.emit('review-*', ...)` after every broadcast in processReview*. Reasoning: the host does NOT receive its own wire broadcast (it IS the broadcaster), so without an internal typed event the host's own ReviewState cache + open ReviewPanel never see events triggered by peer joiners. Mirrors the chat-message-amend echo pattern from Plan 05-05. Rule 2 fix — this was not explicit in the plan's action block but the plan's success criteria require 'both wireClientEvents AND wireHostEvents subscribe to all 5 review events', which is meaningless if the host emit calls don't exist."
  - "Webview markdown-it `html: false` config is DUPLICATED between src/ui/webview/chat/main.ts and src/ui/webview/review/main.ts (no shared module extracted yet — deferred as a future refactor). The duplication is pinned by a source-grep test in reviewPanel.test.ts asserting `html:\\s*false` appears in BOTH files; silent drift between the two webview entries would regress T-06-02 on one panel while leaving the other safe."
  - "versioncon.openReview supports two invocation paths: QuickPick (default) and direct pushId arg (programmatic / Wave-5 context-menu). The QuickPick offers BOTH existing-open reviews AND 'Open a review on push X' entries for the current user's pushes that don't yet have a ReviewRequest. Direct pushId arg without a pre-existing review gates to author-only ('only the push author can open' per 06-SPEC.md locked decision)."
  - "ReviewStore wiring lives inside the workspace IIFE init path AND inside the versioncon.switchBranch handler — mirrors activeChatLog wiring exactly. Each branch switch rebuilds the ReviewStore from disk + re-seeds the in-memory ReviewState cache via applyStateSync, so reviews persist correctly across branch switches and reactivations."
  - "PushRecord lookup for the panel's file list goes through activePushHistoryFull (full PushHistory handle exposed at module scope). The existing activePushHistory remains as the narrow setPushHistory shape; widening it would change the host's setPushHistory contract. Two pointers to the same instance is the cleaner v1 posture."
  - "Comment composer is a simple form (filePath text input + line number input + body textarea) per 06-SPEC.md Wave 4 boundary — per-line vscode.commentController integration is Wave 5's. The webview surface for the comment THREAD VIEW + composer lives here; the gutter UI lives in Plan 06-05."
metrics:
  duration_minutes: 32
  tasks_completed: 4
  files_created: 5
  files_modified: 4
  tests_added: 34
  tests_total_pre: 790
  tests_total_post: 824
  completed: "2026-05-14"
---

# Phase 6 Plan 04: ReviewPanel UI Summary

One-liner: Wave 3 ships the ReviewPanel webview surface + versioncon.openReview command + side-by-side vscode.diff per file + vote/comment/resolve round-trip through the host — all bundled under the same strict CSP and markdown-it (html:false) shape as Plan 04-10 ChatPanel so the plan introduces zero new dependencies, with 34 new tests pinning the contract.

## What Shipped

### Webview surface (4 new files in src/ui/webview/review/ + 1 controller)

| File | Lines | Purpose |
| ---- | ----- | ------- |
| `src/ui/ReviewPanel.ts` | 390 | Singleton WebviewPanel controller. Same CSP shape as ChatPanel; lifecycle (createOrShow, refresh, setScopedBranch, dispose); 4 inbound webview-message types routed; vscode.diff invocation with pre/post URI construction (push-snapshot vs branch-post, with empty-fallback for newly-added files). |
| `src/ui/webview/review/index.html` | 71 | CSP placeholder + nonce'd script tag; sections for header (title + status badge), files, votes, comments (line-grouped), vote bar, resolve bar, comment composer. |
| `src/ui/webview/review/main.css` | 433 | VS Code theme variable styles only — no hex codes. 5 status-badge visual states (open/approved/changes-requested/resolved/abandoned). File rows act as buttons (cursor:pointer + hover state). Comment groups visually grouped per {filePath}:{line}. |
| `src/ui/webview/review/main.ts` | 460 | Webview JS — state-driven render, markdown-it `html: false` (T-06-02), event-handler attach (no inline onclick — CSP-blocked), postMessage protocol back to extension. |
| `src/test/suite/reviewPanel.test.ts` | 439 (34 tests) | 19 source-grep contract + 15 lifecycle/routing. |

### Webview ↔ extension protocol

| Direction | Message | Payload | Notes |
| --------- | ------- | ------- | ----- |
| webview → ext | `webview-ready` | — | Accepted as no-op; spawning code calls refresh() right after construction. |
| webview → ext | `open-file-diff` | `{filePath}` | Triggers `vscode.commands.executeCommand('vscode.diff', preUri, postUri, title)`. |
| webview → ext | `review-vote-submit` | `{reviewId, vote}` | vote ∈ {approved, changes-requested, commented}. Dropped silently on unknown vote / non-string reviewId. |
| webview → ext | `review-comment-submit` | `{reviewId, filePath, line, body}` | Body ≤ 16 KiB; line ≥ 1; non-empty body. |
| webview → ext | `review-resolve-submit` | `{reviewId, resolvedReason}` | resolvedReason ∈ {merged, abandoned}. |
| ext → webview | `state` | `{review, push, selfMemberId, hostMemberId}` | Full snapshot triggers re-render. |

### vscode.diff URI construction

```
preUri  = file:.versioncon/push-snapshots/{pushId}/{relativePath}
postUri = file:.versioncon/branches/{branchName}/{relativePath}
title   = "Review: {relativePath}"
```

Fallback: when the pre-push snapshot does not exist on disk (newly-added file in this push — PushService skips saveSnapshot when branchExists was false), `preUri = vscode.Uri.parse('untitled:{relativePath}.empty')` so the diff renders "empty vs new file content". Matches the existing edge case in versioncon.previewDiff.

T-06-04 mitigation: both fsPaths are constructed from `this.scopedPushId` (host-stamped at review-opened) + `relativePath` derived from PushRecord.files[].relativePath (host-stamped at push time). No user-supplied path enters URI construction.

### SessionHost refactor (`processReview*` extraction)

The 4 inline review onmessage branches were extracted into private async helpers as a **single source of truth** shared between the wire path AND the public `handleLocalReview*` wrappers:

| Wire branch | Private helper | Public local wrapper |
| ----------- | -------------- | -------------------- |
| `review-opened`   | `processReviewOpened(memberId, displayName, msg)`              | `handleLocalReviewOpen(msg)`     |
| `review-comment`  | `processReviewComment(memberId, displayName, ws, msg)`         | `handleLocalReviewComment(msg)`  |
| `review-vote`     | `processReviewVote(memberId, displayName, msg)`                | `handleLocalReviewVote(msg)`     |
| `review-resolved` | `processReviewResolved(memberId, displayName, ws, msg)`        | `handleLocalReviewResolved(msg)` |

The wire path resolves `memberId` from the ws-bound auth + `displayName` from `this.members.get(memberId).member.displayName`; the local path passes `this.hostMemberId ?? 'host'` for memberId and `this.hostDisplayName` for displayName. The `ws` parameter is for sending private REVIEW_RATE_LIMIT / REVIEW_COMMENT_CAP / REVIEW_PERMISSION_DENIED error frames — host-local actions pass `null` for ws (no wire to send back to themselves).

The host-local actions still go through `enqueueReviewWrite` serialization, T-06-03 rate-limit, 500-cap, and permission gating — "host is just another member" trust model from Plan 04-04 extended to review-* mutations.

After each broadcast, every `processReview*` ALSO fires `this.emit('review-*', ...)` so the host's own ReviewState cache + open ReviewPanel can mirror peer activity — without this, the host's own UI would never reflect events triggered by joiners (the host does not receive its own wire broadcast).

### extension.ts wiring

| Concern | Code added |
| ------- | ---------- |
| Module-level singletons | `reviewState: ReviewState \| null`, `activeReviewStore: ReviewStore \| null`, `activeVersionconDir: string \| null`, `activePushHistoryFull: PushHistory \| null` |
| activate() | `reviewState = new ReviewState()` constructed once at activation |
| Workspace IIFE init | `activeReviewStore = new ReviewStore(versionconDir)`, `await load(activeBranchName)`, `host.setReviewStore(...)` if host present, `reviewState.applyStateSync(branch, store.getAll())` to seed cache |
| Branch switch path | Identical rebuild — new ReviewStore for the new branch + re-wire host + reseed reviewState |
| `versioncon.openReview` command | Two-path implementation: QuickPick (existing open reviews + my-pushes-without-a-review) OR direct pushId arg (author-gated for "open new") |
| Callback bundle | `buildReviewPanelCallbacks()` returns the 5 callbacks (onVoteRequested/onCommentRequested/onResolveRequested/getSelfMemberId/getHostMemberId). Each callback routes through `activeHost.handleLocalReview*` if host, else `activeClient.sendMessage(frame)`, else warning toast. |
| wireClientEvents | 5 new `client.on('review-*', ...)` listeners → `reviewState.apply*` → `refreshReviewPanelIfOpen()` helper |
| wireHostEvents | Identical 5 `host.on('review-*', ...)` listeners — mirrors peer activity into the host's own UI |

### esbuild integration

```javascript
// New: copyReviewAssets() — mirrors copyChatAssets verbatim with chat → review path swaps
// New: reviewAssetsPlugin — sibling to chatAssetsPlugin, onEnd recopy on watch
// New: reviewCtx — bundle src/ui/webview/review/main.ts → dist/webview/review/main.js
//                  (format:'iife', platform:'browser', target:['es2022'])
// Watch + initial-build wiring extended to include reviewCtx + copyReviewAssets
```

No new dependencies — markdown-it was already in package.json from Plan 04-10. Both bundles total ~400 KB.

### Test coverage delta

| Suite | Tests | Status |
| ----- | ----- | ------ |
| `Phase 6 Wave 3 — ReviewPanel source-grep + structure` | 19 | All pass |
| `Phase 6 Wave 3 — ReviewPanel lifecycle behavior` | 15 | All pass |
| Existing suites (Wave 2 + earlier) | 790 | All pass (no regressions) |
| **Total** | **824** (was 790) | **+34 tests** |

Pending count unchanged at 66.

The 19 source-grep tests cover: markdown-it html:false in both review/main.ts AND chat/main.ts (T-06-02 cross-webview regression), CSP placeholder + nonce'd script tag in index.html, strict CSP shape mirrored from ChatPanel, retainContextWhenHidden + enableScripts, localResourceRoots = dist/webview/review/, vscode.diff invocation with push-snapshots/branches references, versioncon.openReview registered + declared, reviewState constructed via new ReviewState(), 5 review listeners in BOTH wireClientEvents + wireHostEvents (the "in both" assertion is via two separate tests), SessionHost.handleLocalReview* quartet, SessionHost this.emit('review-*') echoes, esbuild copyReviewAssets + bundle entry + output path, and ReviewPanel.handleMessage's 4 inbound message types.

The 15 lifecycle tests cover: createOrShow singleton invariant (same pushId → same instance, different pushId → disposes prior), dispose clears static currentPanel, handleMessage routes review-vote-submit / review-comment-submit / review-resolve-submit to the right callbacks, handleMessage rejects on every defense-in-depth gate (unknown vote, non-string reviewId, empty body, body > 16 KiB, line < 1, unknown resolvedReason, unknown type, null/non-object frames), and webview-ready accepted as no-op.

## TDD Gate Compliance

Tasks 1-3 are `type="auto"` (no `tdd="true"`), so RED → GREEN cycle does not apply. Task 4 is `tdd="true"` but per the plan's posture (mirror of Plan 06-01 Task 4 source-grep exception) and Plan 06-01's documented carve-out: "the contract test exists to break the build if Waves drift the shapes" — source-grep tests are pin-current-behavior and the lifecycle tests pin existing implementation from Tasks 1-3. RED would have to be artificial. The single `test(06-04): add ReviewPanel source-grep + lifecycle suite (Task 4)` commit lands the entire suite, all 34 tests passing on first run.

| Task | Commit | Pattern |
| ---- | ------ | ------- |
| 1 — Webview scaffold + esbuild + command declaration | `85d771c` `feat(06-04): review webview scaffold + esbuild bundle + openReview command (Task 1)` | type=auto |
| 2 + 3 — ReviewPanel controller + extension.ts wiring + host local helpers | `186c83c` `feat(06-04): ReviewPanel controller + extension wiring + host local helpers (Tasks 2 & 3)` | type=auto (combined; tasks share extension.ts edits) |
| 4 — Test suite | `2580eb3` `test(06-04): add ReviewPanel source-grep + lifecycle suite (Task 4)` | Pin-current-behavior posture per Plan 06-01 carve-out |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical functionality] Added `this.emit('review-*', ...)` echoes in SessionHost processReview* helpers**

- **Found during:** Task 3, after extracting the wire branches and wiring the 5 review listeners in wireHostEvents.
- **Issue:** The plan's action block instructed adding 5 `host.on('review-*', ...)` listeners in wireHostEvents that apply to ReviewState + refresh the host's panel. But existing SessionHost had NO `this.emit('review-*', ...)` calls — the wire branches only broadcasted via `this.broadcast(...)`. So the listeners in wireHostEvents would never fire, meaning the host's own UI would never reflect peer-originated review events (the host doesn't receive its own wire broadcast). This is exactly the missing-piece pattern that Plan 04-15 / chat-message-amend solved for chat amends.
- **Fix:** Added `this.emit('review-opened', { review: sanitized })` after the `review-opened` broadcast, `this.emit('review-comment', { reviewId, comment })` after the `review-comment` broadcast, `this.emit('review-vote', { reviewId, vote })` after the `review-vote` broadcast, and `this.emit('review-resolved', { reviewId, resolvedBy, resolvedReason })` after the `review-resolved` broadcast.
- **Files modified:** `src/host/SessionHost.ts` (4 emit calls added inside the processReview* helpers).
- **Commit:** `186c83c` (Tasks 2 & 3 GREEN — included with the extraction).

**2. [Rule 1 — TS narrowing] Widened activePushHistory module scope to a full PushHistory handle**

- **Found during:** Task 3, when writing the openReview command's QuickPick body that needs `pushHistory.getRecord(pushId)` + `pushHistory.getRecords()`.
- **Issue:** The existing `activePushHistory: { getLatestRecord: () => { id: string } | undefined } | null` is a narrow setPushHistory contract — it only exposes `getLatestRecord` so the openReview command can't reach `getRecord` / `getRecords`.
- **Fix:** Added a parallel `activePushHistoryFull: PushHistory | null` module-level handle initialized inside the workspace IIFE alongside the existing narrow handle. The narrow handle remains for `host.setPushHistory(...)` to preserve the host's setPushHistory contract.
- **Files modified:** `src/extension.ts`
- **Commit:** `186c83c` (Tasks 2 & 3 GREEN).

**3. [Rule 1 — TS narrowing] Local typed-capture pattern for nullable activeVersionconDir + reviewState through the openReview command implementation**

- **Found during:** Task 3 GREEN, type-check phase.
- **Issue:** After awaiting QuickPick inside the openReview command, TypeScript's control-flow analysis loses the `activeVersionconDir !== null` narrowing (string | null) across the await boundary, and a `targetPushId: string | null` declared as `let` is not narrowed after the `if (!targetPushId)` block ends (because it may have been reassigned inside the branch).
- **Fix:** Captured `reviewState` into a local `const rs = reviewState` and `activeVersionconDir` into a local `const versionconDir = activeVersionconDir` right after the null-guards, then used the locals through the rest of the function. Added an explicit `if (!targetPushId) return;` before the panel construction so the closing `ReviewPanel.createOrShow(...targetPushId,...)` sees a non-null string.
- **Files modified:** `src/extension.ts` (openReviewCommandImpl body).
- **Commit:** `186c83c`.

### Plan-prescribed work (not auto-fixes, but worth noting)

- The plan instructed extracting the 4 review onmessage branch bodies in SessionHost into private helpers so the public handleLocalReview* wrappers could reuse them. Done — 4 processReview* helpers each shared between the wire path and the local path. 80 Wave 2 tests still pass with the refactor (the test suite is the regression net for the extraction).
- The plan instructed routing the openReview QuickPick to filter `reviewState.getReviewsForBranch(activeBranch).filter(r => r.status !== 'resolved' && r.status !== 'abandoned')`. Done — and the QuickPick ALSO offers "Open a review on push X" entries for the current user's pushes that don't yet have a ReviewRequest, so v1 supports the "open a new review" UX from the same command.
- The plan instructed handleMessage to defensively validate vote-string membership, line bounds, body length BEFORE forwarding to the extension callback. Done — and the test suite asserts each defense-in-depth gate (8 lifecycle tests cover the rejection branches).

## Threat Mitigation Audit

| Threat | Status | Evidence |
| ------ | ------ | -------- |
| **T-06-01** (Spoofing — webview-originated reviewer identity) | **CLOSED structurally** | The webview's onVoteRequested / onCommentRequested / onResolveRequested callbacks construct wire frames with EMPTY `reviewerMemberId` / `authorMemberId` / `resolvedBy` and `0` timestamps. The host's processReview* helpers (Plan 06-02 OWNER, extended by this plan into the shared helpers) override identity unconditionally at relay. Test `Phase 6 Wave 3 — handleMessage rejects review-vote-submit with non-string reviewId` covers the defense-in-depth shape gate; the host-side override is covered by Plan 06-02's 41 tests. |
| **T-06-02** (XSS — markdown-it in webview) | **CLOSED** | `html: false` in `src/ui/webview/review/main.ts`. Source-grep test pins the literal config in BOTH `src/ui/webview/chat/main.ts` AND `src/ui/webview/review/main.ts` — drift between them would regress the gate on one panel while keeping the other safe. CSP `script-src 'nonce-X'` blocks inline scripts; CSP `default-src 'none'` + no remote sources keep the bundle airtight. |
| **T-06-04** (Path tampering on vscode.diff URIs) | **CLOSED for this surface** | `preFsPath` and `postFsPath` in ReviewPanel.openFileDiff are constructed from `this.scopedPushId` (host-stamped at review-opened) + `relativePath` flowing from PushRecord.files (host-stamped at push time). `path.join` is the only path concatenation. The user-typable surface in the webview's comment composer's filePath input goes through the host's `validateRelativePath` (Plan 06-02 extracted helper) at the wire layer; the webview does NOT consume the filePath input for any local file access. |
| **T-06-05** (State replay) | **CLOSED structurally** | ReviewPanel.refresh reads from ReviewState; ReviewState is fed by SessionClient.handleMessage (single host ws) + SessionHost.this.emit('review-*') (host's own loop). No peer-to-peer path; no other entry point exists. The 5 `client.on('review-*', ...)` and `host.on('review-*', ...)` listeners in extension.ts are the only ingress paths. |
| **T-06-03** (DoS — comment spam) | **bounded by host** | Plan 06-02 OWNER enforces 30/min + 500-cap inside the processReview* helpers (which this plan now also exposes through handleLocalReview*); ReviewPanel.handleMessage clamps body length at 16 KiB before forwarding to defense-in-depth the host's wire-layer check. |

## Threat Flags

No new security-relevant surface introduced beyond the plan's `<threat_model>`. The webview ↔ extension boundary is bounded by the documented postMessage protocol; vscode.diff path arguments are derived from host-trusted PushRecord state.

## Self-Check: PASSED

**Files created:**
- FOUND: `src/ui/ReviewPanel.ts` (390 lines)
- FOUND: `src/ui/webview/review/index.html` (71 lines)
- FOUND: `src/ui/webview/review/main.css` (433 lines)
- FOUND: `src/ui/webview/review/main.ts` (460 lines)
- FOUND: `src/test/suite/reviewPanel.test.ts` (439 lines, 34 tests)

**Files modified:**
- FOUND: `src/host/SessionHost.ts` (processReview* extraction + handleLocalReview* + this.emit echoes)
- FOUND: `src/extension.ts` (reviewState + openReview command + 10 listeners + ReviewStore wiring)
- FOUND: `esbuild.config.mjs` (copyReviewAssets + reviewAssetsPlugin + reviewCtx)
- FOUND: `package.json` (versioncon.openReview command declaration)

**Commits (in order):**
- FOUND: `85d771c` feat(06-04): review webview scaffold + esbuild bundle + openReview command (Task 1)
- FOUND: `186c83c` feat(06-04): ReviewPanel controller + extension wiring + host local helpers (Tasks 2 & 3)
- FOUND: `2580eb3` test(06-04): add ReviewPanel source-grep + lifecycle suite (Task 4)

**Verification outputs:**
- `npx tsc --noEmit` — clean (no output)
- `npm run build` — clean (esbuild succeeds; dist/webview/review/{main.js,index.html,main.css,codicon/codicon.css,codicon/codicon.ttf} all present)
- `npm test` — **824 passing, 0 failing, 66 pending** (was 790 after Plan 06-03)
- `npm test -- --grep "Phase 6 Wave 3"` — **34 passing** (19 source-grep + 15 lifecycle)
- `grep -c 'html:\s*false' src/ui/webview/chat/main.ts src/ui/webview/review/main.ts` — both files match (T-06-02 cross-webview regression guard armed)

**Min-lines compliance vs plan's must_haves.artifacts targets:**
- ReviewPanel.ts: 390 (target ≥ 250) ✓
- index.html: 71 (target ≥ 30) ✓
- main.css: 433 (target ≥ 100) ✓
- main.ts: 460 (target ≥ 200) ✓
- reviewPanel.test.ts: 439 (target ≥ 200) ✓
