---
phase: 06-inline-code-review
verified: 2026-05-14T07:55:00Z
status: human_needed
score: 4/4 success criteria code-wired; UAT pending
overrides_applied: 0
re_verification: null
gaps: []
deferred:
  - truth: "T-06-04 (mandatory-review bypass via direct file edit) — filesystem-level integrity"
    addressed_in: "out of scope per 06-SPEC.md frontmatter line 116 (same posture as Phase 3 SyncTracker)"
    evidence: "06-SPEC.md threat model T-06-04 explicitly documents 'out of scope — same posture as Phase 3 SyncTracker'"
  - truth: "Wire propagation of branch.requireReview toggle to peers"
    addressed_in: "future plan (06-05 Decision #9 — 'No wire broadcast on setRequireReview toggle for v1')"
    evidence: "06-05-SUMMARY.md decision: 'A future plan can add branch-require-review-changed wire propagation; out of scope here.'"
  - truth: "Bare-line gutter 'Add comment' affordance (commentingRangeProvider returning real ranges)"
    addressed_in: "Phase 6.x (per 06-05-SUMMARY.md decision)"
    evidence: "06-05-SUMMARY.md decision: 'v1 contract: NO bare-line gutter Add comment affordance. commentingRangeProvider returns [] for all lines. ... Adding a gutter add-comment surface is a Phase 6.x deliverable.'"
human_verification:
  - test: "SC-1: Side-by-side diff opens for each file in a PushRecord from the ReviewPanel"
    expected: "Click a file row in the ReviewPanel; VS Code opens a diff editor titled 'Review: {relativePath}' showing the pre-push snapshot on the left and the current branch content on the right. For newly-added files (no pre-push snapshot), the left side is an empty untitled doc."
    why_human: "Requires a live VS Code Extension Development Host with an open workspace containing .versioncon/push-snapshots; webview button → vscode.diff invocation is a visual flow."
  - test: "SC-2: Approve / request-changes / line comments inside VS Code (no browser)"
    expected: "Open a ReviewPanel for a push; click 'Approve', 'Request Changes', and 'Comment' vote buttons — status badge updates per host transition rule. Submit a per-file comment via the composer; the inline gutter on the underlying file shows a CommentThread with the comment body rendered as escaped Markdown. Reply via VS Code's built-in 'Reply' UI; the reply lands as a sibling comment and round-trips through the host."
    why_human: "Requires live webview rendering + vscode.commentController gutter UI + VS Code's reply submit handler — none of these surfaces are headlessly testable."
  - test: "SC-3: Mandatory review gate blocks merge with non-modal toast + chat system event"
    expected: "Admin runs 'VersionCon: Set Require Review' and toggles ON for target branch 'main'. Then runs 'VersionCon: Merge Branch' from a source branch with an open / unapproved review. Result: non-modal error toast 'VersionCon: ... requires an approving review of push {shortId} ...'; chat panel shows a kind:'system', subKind:'review-resolved' row with body 'Merge blocked: needs review approval — {source} → {target}'. After an approving review lands, the next merge attempt succeeds."
    why_human: "Requires a live session with two members + a push + a review; non-modal vs modal toast appearance is a visual check; chat-panel row rendering is webview-rendered."
  - test: "SC-4: Review events appear in chat thread as system events"
    expected: "Open a review → chat panel shows 'review-opened' row in real time on BOTH host and connected member panels. Comment / vote / resolve each produce a corresponding 'review-comment' / 'review-approved' / 'review-changes-requested' / 'review-resolved' row. Admin override emits TWO rows (the override notice + the resolution)."
    why_human: "Requires multi-window UAT to confirm both connected-member panels AND the host's own panel show the events in real time (Phase 4 CR-02-NEW echo path is the carrier — code-verified, UAT pending). Plus visual confirmation of body text + sub-kind icons."
  - test: "T-06-02 visual: no CSP violation when comment body contains markdown / script tags"
    expected: "Submit a comment with body '<script>alert(1)</script> **bold** `code`'. Webview renders 'bold' bolded, 'code' as inline code, and the script tag escaped as literal text. No VS Code devtools console CSP error."
    why_human: "Webview CSP compliance and markdown-it escape behavior are only observable through the webview devtools console + visual rendering."
---

# Phase 6: Inline Code Review — Verification Report

**Phase Goal:** Author opens a "mini PR" review on a push; reviewers see side-by-side diffs, approve / request-changes / leave line comments inside VS Code; admin-toggleable mandatory-review gate blocks merges until an approving review lands; every review event posts a system row in chat.
**Verified:** 2026-05-14T07:55:00Z
**Status:** human_needed (all 4 SC have intact code wiring + tests; live multi-window UAT required for the user-visible flows)
**Re-verification:** No — initial verification.

---

## Success Criteria Verdicts

### SC-1: Side-by-side diff per change — PASS (code) / UAT pending

| Concern | Evidence | Verdict |
|---------|----------|---------|
| `vscode.diff` invocation from ReviewPanel | `src/ui/ReviewPanel.ts:269-273` — `vscode.commands.executeCommand('vscode.diff', preUri, postUri, title)` | VERIFIED |
| pre/post URI construction (`push-snapshots/{pushId}/{rel}` ↔ `branches/{branchName}/{rel}`) | `src/ui/ReviewPanel.ts:251-266` | VERIFIED |
| `open-file-diff` webview → ext message routed | `src/ui/ReviewPanel.ts:400-413` (handleMessage open-file-diff case) | VERIFIED |
| Empty-file fallback for newly-added files (no pre-snapshot) | `src/ui/ReviewPanel.ts:259-264` — try `fs.access(preFsPath)`, else `untitled:` URI | VERIFIED |
| Tests | `src/test/suite/reviewPanel.test.ts` 34 tests (19 source-grep + 15 lifecycle) — includes the `vscode.diff invocation pattern` source-grep assertion | VERIFIED |

### SC-2: Approve / request-changes / line comments inside VS Code — PASS (code) / UAT pending

| Concern | Evidence | Verdict |
|---------|----------|---------|
| Vote UI in webview (approve / request-changes / commented) | `src/ui/webview/review/main.ts:38, html:false`; vote buttons → `postMessage({type:'review-vote-submit', vote, reviewId})` | VERIFIED |
| Vote routing through host (identity overridden) | `src/host/SessionHost.ts:1268-1342` (`processReviewVote`) — `reviewerMemberId: memberId` line 1291 (T-06-01 override) | VERIFIED |
| Status transition rule (changes-requested dominates → approved → open) | `src/host/SessionHost.ts:1294-1305` + `src/state/ReviewState.ts:116-118` — pinned cross-module by source-grep test `reviewState.test.ts` | VERIFIED |
| Inline comments via `vscode.comments.createCommentController` | `src/extension.ts:615` (controller construction) + `src/ui/inlineReviewComments.ts:62-110` (`registerInlineCommentsForReview`) | VERIFIED |
| Comment body rendered via `vscode.MarkdownString` (T-06-02) | `src/ui/inlineReviewComments.ts:98` — `body: new vscode.MarkdownString(c.body)` (isTrusted defaults false) | VERIFIED |
| Reply routing via `versioncon.review.replyToComment` | `src/extension.ts:889-940` — handler registers + routes through `buildReviewPanelCallbacks().onCommentRequested` | VERIFIED |
| Tests | `src/test/suite/reviewInlineComments.test.ts` 18 tests (10 behavior + 8 source-grep); `src/test/suite/reviewHostRelay.test.ts` 41 tests (vote/comment branches) | VERIFIED |

### SC-3: Mandatory review gate — PASS (code) / UAT pending

| Concern | Evidence | Verdict |
|---------|----------|---------|
| Pure-function gate `checkRequireReviewGate(source, target, deps)` | `src/state/requireReviewGate.ts:1-87` | VERIFIED |
| Gate inserted at `versioncon.mergeBranch` | `src/extension.ts:2539` | VERIFIED |
| Gate inserted at `versioncon.quickMergeFiles` | `src/extension.ts:2683` | VERIFIED |
| Gate inserted at `versioncon.structuredMergeBranch` | `src/extension.ts:2787` | VERIFIED |
| `BranchManager.setRequireReview` + `getRequireReview` | `src/filesystem/BranchManager.ts:172-186` | VERIFIED |
| Admin command `versioncon.setBranchRequireReview` gated by `canCreateBranch` | `src/extension.ts:2596-…`; `package.json:240` declares the command | VERIFIED |
| Non-modal error toast on block | `src/extension.ts` shows `vscode.window.showErrorMessage(...)` at 3 block paths — no `modal:true` flag | VERIFIED |
| Chat system event on block ("Merge blocked: needs review approval — {source} → {target}") | `src/extension.ts:2548, 2692, 2796` — `appendAndBroadcastSystemEvent('review-resolved', ...)` | VERIFIED |
| Tests | `src/test/suite/mandatoryReviewGate.test.ts` 25 tests (10 BranchManager toggle + 9 gate behavior + 6 insertion source-grep) | VERIFIED |

### SC-4: Review comments in chat thread — PASS (code) / UAT pending

| Concern | Evidence | Verdict |
|---------|----------|---------|
| `SystemEventSubKind` extended with 5 review sub-kinds | `src/types/chat.ts` — review-opened / review-comment / review-approved / review-changes-requested / review-resolved | VERIFIED |
| `processReviewOpened` appends + broadcasts system event | `src/host/SessionHost.ts:1163-1171` (`appendAndBroadcastSystemEvent('review-opened', ...)`) | VERIFIED |
| `processReviewComment` system event | `src/host/SessionHost.ts:1257-1265` | VERIFIED |
| `processReviewVote` system event (sub-kind from vote: approved/changes-requested/comment) | `src/host/SessionHost.ts:1326-1342` (`subKind` mapping per `sanitizedVote.vote`) | VERIFIED |
| `processReviewResolved` system event (+ admin-override double event) | `src/host/SessionHost.ts:1408-1424` | VERIFIED |
| Host echoes `this.emit('review-*', ...)` so the host's own UI updates | `src/host/SessionHost.ts:1161, 1255, 1323, 1402` (4 emit calls) | VERIFIED |
| Tests | `src/test/suite/reviewHostRelay.test.ts` 41 tests (system event coverage across all 4 verbs) | VERIFIED |

---

## STRIDE Threat Mitigation Verdicts

| Threat | Mitigation in Code | File:Line | Verdict |
|--------|---------------------|-----------|---------|
| **T-06-01** (Spoofed vote / authorship) | Host overrides `authorMemberId` (review-opened, review-comment) and `reviewerMemberId` (review-vote) and `resolvedBy` (review-resolved) from ws-bound `memberId` — client-supplied values discarded | `src/host/SessionHost.ts:1131, 1143, 1232, 1291, 1385` | CLOSED |
| **T-06-02** (Comment XSS) | Webview: `markdown-it({ html: false })` in BOTH `src/ui/webview/review/main.ts:38` AND `src/ui/webview/chat/main.ts:52` (cross-webview source-grep test pins both). Inline comments: `new vscode.MarkdownString(c.body)` (isTrusted defaults false) at `src/ui/inlineReviewComments.ts:98`. CSP `default-src 'none'; script-src 'nonce-X'` at `src/ui/ReviewPanel.ts:342-346` | CLOSED |
| **T-06-03** (Comment DoS — spam) | Per-review hard cap `REVIEW_COMMENT_CAP=500` + per-member sliding 60s window `REVIEW_COMMENT_RATE_PER_MIN=30` enforced INSIDE per-reviewId write serializer. Offender-only private error frames `{code:'REVIEW_COMMENT_CAP'\|'REVIEW_RATE_LIMIT'}` | `src/host/SessionHost.ts:149-151, 1205-1224, 1079-1095` | CLOSED |
| **T-06-04** (Mandatory-review bypass via OS-level file edit) | Documented out of scope per 06-SPEC.md frontmatter line 116 — same posture as Phase 3 SyncTracker. Wire-frame path-traversal on `comment.filePath` IS guarded by `validateRelativePath` (`src/host/SessionHost.ts:1033`, called at `1185`) | ACCEPTED (per spec) |
| **T-06-05** (State-sync replay from non-host) | `review-state-sync` is structurally host→client only. The SessionHost onmessage switch has **no** branch for `msg.type === 'review-state-sync'` (verified — `grep -nE "msg\.type === 'review-state-sync'" src/host/SessionHost.ts` returns zero matches). Outbound only via `sendReviewStateSyncToMember` (`src/host/SessionHost.ts:1597-1614`) fired inside `handleAuthRequest` (line 732) | CLOSED structurally |

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/types/review.ts` | 5 type exports (ReviewVote, ReviewStatus, ReviewComment, ReviewVoteRecord, ReviewRequest) | VERIFIED | 68 lines; all 5 exports present |
| `src/network/protocol.ts` | 5 new wire types + VALID_TYPES set updated | VERIFIED | Lines 40-44 (MessageType), 347-405 (interfaces), 453 (VALID_TYPES) |
| `src/types/branch.ts` | `BranchInfo.requireReview?` | VERIFIED | Line 14 |
| `src/types/chat.ts` | `SystemEventSubKind` extended with 5 review sub-kinds | VERIFIED | 8 members |
| `src/filesystem/ReviewStore.ts` | per-review JSON persistence at `.versioncon/branches/{branch}/reviews/{pushId}.json` | VERIFIED | 125 lines; load + upsertRequest + getReview + getAll + getOpenForBranch |
| `src/host/SessionHost.ts` | 4 wire branches + 4 processReview* + 4 handleLocalReview* + state-sync sender + appendAndBroadcastSystemEvent public + REVIEW_COMMENT_CAP/RATE constants + validateRelativePath shared | VERIFIED | All sites confirmed (lines 540-568, 732, 1033, 1112-1424, 1495, 1580, 1597) |
| `src/client/SessionClient.ts` | 5 handleMessage case branches → typed events | VERIFIED | Lines 405-431 |
| `src/types/events.ts` | 5 new SessionEventMap keys | VERIFIED (per 06-03-SUMMARY) | type-only import + 5 keys |
| `src/state/ReviewState.ts` | apply* mutators + get* getters; status transition matches host | VERIFIED | 183 lines; transition rule pinned cross-module |
| `src/state/requireReviewGate.ts` | pure-function `checkRequireReviewGate` | VERIFIED | 87 lines |
| `src/ui/ReviewPanel.ts` | singleton panel + vscode.diff + addOwnedDisposable | VERIFIED | 402 lines |
| `src/ui/webview/review/{index.html, main.css, main.ts}` | CSP + nonce + markdown-it html:false | VERIFIED | 71 + 433 + 460 lines |
| `src/ui/inlineReviewComments.ts` | registerInlineCommentsForReview helper | VERIFIED | 112 lines |
| `src/extension.ts` | reviewState init + ReviewStore wiring + openReview + setBranchRequireReview + replyToComment + 3 gate insertions + 5 listeners in BOTH wireClient + wireHost | VERIFIED | All sites confirmed (lines 691, 1298-1340, 1705-1745, 1901, 2456, 2539, 2596, 2683, 2787, 889) |
| `package.json` | `versioncon.openReview` + `versioncon.setBranchRequireReview` declared | VERIFIED | Lines 235, 240 |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| Webview vote button click | `processReviewVote` (host) | postMessage `review-vote-submit` → ReviewPanel.handleMessage → callbacks.onVoteRequested → activeHost.handleLocalReviewVote OR activeClient.sendMessage | WIRED | ReviewPanel.handleMessage:416-422; extension callback bundle wires to host/client |
| Webview comment composer | `processReviewComment` | postMessage `review-comment-submit` → handleMessage → onCommentRequested → wire | WIRED | ReviewPanel.handleMessage; callbacks |
| `processReview*` (host) | ReviewState (client + host self) | broadcast → SessionClient.handleMessage → emit OR this.emit('review-*') | WIRED | Both paths confirmed; host self-echo at SessionHost.ts:1161/1255/1323/1402 |
| ReviewState | ReviewPanel render | `refreshReviewPanelIfOpen()` after each apply* | WIRED | extension.ts wireClient + wireHost listeners |
| Merge command | requireReview gate | `checkRequireReviewGate(source, target, {branchManager, pushHistory, reviewState})` | WIRED | 3 insertion sites |
| Gate block | chat system event | `activeHost.appendAndBroadcastSystemEvent('review-resolved', 'Merge blocked: ...')` | WIRED | extension.ts:2548, 2692, 2796 |
| Inline comment reply | `processReviewComment` | `versioncon.review.replyToComment` → `buildReviewPanelCallbacks().onCommentRequested` | WIRED | extension.ts:889-940 |
| Admin command | `BranchManager.setRequireReview` | `versioncon.setBranchRequireReview` QuickPick → setRequireReview | WIRED | extension.ts:2596 |
| Auth post-replay | client ReviewState seed | `sendReviewStateSyncToMember` after chat-history in handleAuthRequest | WIRED | SessionHost.ts:732 |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compile | `npx tsc --noEmit` | exit 0, no output | PASS |
| Full test suite | `npm test` | **867 passing, 0 failing, 66 pending** | PASS |
| T-06-05 inbound-state-sync handler absent | `grep -nE "msg\.type === 'review-state-sync'" src/host/SessionHost.ts` | zero matches | PASS (structural mitigation confirmed) |
| markdown-it html:false in BOTH webviews | `grep -nE "html:\s*false" src/ui/webview/chat/main.ts src/ui/webview/review/main.ts` | both match | PASS |
| 3 gate insertions | `grep -c "checkRequireReviewGate" src/extension.ts` | 4 (1 import + 3 call sites) | PASS |
| 5 listeners in wireClient + wireHost | `grep -nE "client\.on\('review-\|host\.on\('review-" src/extension.ts` | 10 matches (5 + 5) | PASS |
| Identity overrides in 4 processReview* | `grep -nE "authorMemberId: memberId\|reviewerMemberId: memberId\|resolvedBy: memberId" src/host/SessionHost.ts` | 7 matches across 4 helpers | PASS |
| commentController constructed | `grep -nE "vscode\.comments\.createCommentController" src/extension.ts` | 1 match at line 615 | PASS |
| MarkdownString wraps comment body | `grep -nE "new vscode\.MarkdownString" src/ui/inlineReviewComments.ts` | 1 match at line 98 | PASS |
| `appendAndBroadcastSystemEvent` public | `grep -nE "public appendAndBroadcastSystemEvent" src/host/SessionHost.ts` | 1 match | PASS |

---

## Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|---|---|---|---|
| **REVIEW-01** (Inline diff + approve flow — mini PR inside VS Code) | 06-04, 06-05 | end-to-end ReviewPanel + vote + comment + diff | SATISFIED (code) — UAT for webview/diff/comment-controller surfaces | ReviewPanel.ts + reviewPanel.test.ts + inlineReviewComments.ts |
| **REVIEW-02** (Side-by-side diff showing what changed) | 06-04 | `vscode.diff` against push-snapshots ↔ branches | SATISFIED (code) — UAT for visual diff | ReviewPanel.ts:251-273 |
| **REVIEW-03** (Reviewers can approve / request-changes / line comments) | 06-02, 06-03, 06-04, 06-05 | wire round-trip + ReviewState + CommentController + reply | SATISFIED (code) — UAT for gutter + reply flow | processReviewVote + processReviewComment + registerInlineCommentsForReview |
| **REVIEW-04** (Mandatory review gate) | 06-01 (flag), 06-05 (gate) | requireReview + checkRequireReviewGate at 3 entry points | SATISFIED (code) — UAT for block toast + chat row | requireReviewGate.ts + 3 extension.ts insertions |

No orphaned Phase 6 requirements in REQUIREMENTS.md.

> **REQUIREMENTS.md status table at lines 185-188** still reads `Pending` for REVIEW-01..04. This is a documentation drift — the implementation has landed; the status table was not updated by any of the 5 SUMMARY commits. Not phase-blocking but should be updated.

---

## Anti-Patterns Found

| File | Concern | Severity | Impact |
|------|---------|----------|--------|
| `.planning/REQUIREMENTS.md:185-188` | REVIEW-01..04 still marked `Pending` despite all 5 plans landing GREEN | INFO | Doc drift only; verification report supersedes |
| `package.json` `commands` array | `versioncon.review.replyToComment` is `registerCommand`-only (not declared in package.json contributions) | INFO | Working as-designed — the comments-API reply UI invokes by command id; package.json declaration would only add Command Palette discoverability (which is undesirable for a reply-thread internal command). Documented in 06-05-SUMMARY decision #7. |
| `src/ui/inlineReviewComments.ts:62` (`registerInlineCommentsForReview`) duplicates `branchDir` URI construction in extension.ts | None — bounded helper | INFO | The helper accepts `branchDir` as a param; the inflation lives in extension.ts (line 397 `path.join(activeVersionconDir, 'branches', activeBranchName)`). Clear separation. |

No BLOCKER or WARNING anti-patterns surfaced.

---

## Test Counts (Phase 6 contribution)

| Wave | Plan | Tests added |
|------|------|-------------|
| 1 | 06-01 (types + ReviewStore) | 26 (14 CRUD + 12 source-grep) |
| 2 | 06-02 (host relay) | 41 |
| 3 | 06-03 (client routing + ReviewState) | 39 (11 + 28) |
| 4 | 06-04 (ReviewPanel UI) | 34 (19 source-grep + 15 lifecycle) |
| 5 | 06-05 (gate + inline comments) | 43 (25 + 18) |
| **Total** | | **183 new tests**; suite went 684 → 867 |

---

## Documentation Gaps

- **REQUIREMENTS.md status table not refreshed** — REVIEW-01..04 still show `Pending`. Not phase-blocking; suggest a follow-up doc commit marking them `Implemented (Phase 6, pending UAT)` once the human verification checklist below is run.
- **No phase-level 06-SUMMARY.md** — each wave has a SUMMARY (06-01..06-05) but there is no aggregating phase-roll-up. Pattern across phases varies; not flagged as a gap.
- **No UAT plan checked into `.planning/phases/06-inline-code-review/`** — the human-verification section of this report serves that role; no separate UAT.md exists. Consistent with Phase 4 posture.

---

## Gaps Summary

**No code gaps.** All 4 Success Criteria from `06-SPEC.md` have intact code wiring with test coverage; all 5 STRIDE threats from the spec are mitigated (4 closed, 1 explicitly accepted out of scope per the spec); TypeScript compiles clean, build succeeds, and the 867-passing test suite is stable.

Phase 6 is **feature-complete at the code level**. Status is `human_needed` rather than `passed` because five distinct user-visible flows (vscode.diff visual, vote/comment/reply gutter UI, mandatory-review gate block toast, chat-thread system rows in real time across two windows, and CSP/XSS empirical check) require a live VS Code Extension Development Host to confirm.

Recommended path: run the 5-item human-verification checklist on a 2-machine session (or 2 Extension Development Host windows on the same machine with the mDNS workaround documented in backlog 999.1) and refresh the REQUIREMENTS.md status table afterward.

---

_Verified: 2026-05-14T07:55:00Z_
_Verifier: Claude (gsd-verifier — Opus 4.7 1M context)_
