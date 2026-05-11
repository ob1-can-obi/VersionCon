---
phase: 06-inline-code-review
spec_locked: 2026-05-11
status: ready-for-planning
ambiguity_score: 3/10
mode: autonomous (user invoked "continue to phase 6" after Phase 5)
locked_decisions:
  - "Review unit = ReviewRequest tied to a SPECIFIC PushRecord (one review per push). Author opens it; reviewers vote (approve / request-changes / commented-only). Re-pushing the same files supersedes the prior request — review re-opens automatically on the new push."
  - "Storage: .versioncon/reviews/{pushId}.json per-review file, indexed by pushId. Same persistence shape as PushHistory + ChatLog (load all on activate, write whole-file on mutation). Reviews live per-branch under .versioncon/branches/{branch}/reviews/."
  - "Wire transport: new ProtocolMessage discriminants `review-opened`, `review-comment`, `review-vote`, `review-resolved`, plus `review-state-sync` on auth. Each carries a serverTrustedMemberId stamped by SessionHost (same pattern as Plan 04-04 chat-message)."
  - "Side-by-side diff: implemented via vscode.diff against (pre-push snapshot ↔ post-push file content). Pre-push snapshot already exists in push-snapshots/ (PushService) — Phase 6 doesn't introduce a new snapshotting layer."
  - "Inline comments use vscode.commentController API — registers per-review, lifecycle managed by ReviewPanel. Comments persist via the wire + .versioncon/reviews/{pushId}.json."
  - "Mandatory-review gate: BranchPermissions gets a new optional 'requireReview' boolean per-branch. mergeBranch (existing command) checks: if target branch requires review AND the source-branch's most-recent push has no approving ReviewRequest in 'approved' state, block with a non-modal error toast + chat system event 'Merge blocked: needs review approval'."
  - "Chat integration: every review event (open, comment, vote, resolve) appends a system-event ChatRecord into chat-log.json so the team sees review activity in chat. SystemEventSubKind union extends to include 'review-opened' | 'review-comment' | 'review-approved' | 'review-changes-requested' | 'review-resolved'."
  - "Permission model: anyone in the session can leave comments + vote. Only the push author can RESOLVE their own review (close it as 'merged'/'abandoned'). Only admins can OVERRIDE a 'changes-requested' vote to merge anyway (with a chat-logged justification, mirrors host-override patterns from Phase 3)."
  - "Scope boundary: this phase does NOT add a GitHub/GitLab PR import (that's a Phase 7-cloud or future bridge concern). Reviews are LAN/session-scoped only — when a session ends, the review history persists on disk and replays on the next session via review-state-sync."
---

# Phase 6 Spec: Inline Code Review

## Background

PROJECT.md: "Users can request a formal review of their changes before they merge." Phase 4 chat + Phase 5 dependency-detection give context for WHY a change matters; Phase 6 lets teams gate merges on explicit human approval.

The model is "mini PR inside VS Code" — the author of a push can open a review, reviewers see a side-by-side diff with line comments, vote approve/request-changes, and the admin can configure target branches to require an approving review before merge lands.

This is REQ REVIEW-01..04 in REQUIREMENTS.md.

## Locked decisions

See frontmatter. Most ambiguity-prone questions are answered there.

## Success Criteria (testable, from ROADMAP)

1. **Side-by-side diff per change**: a user can open a review panel for any staged change and see a side-by-side diff of exactly what changed in each file. Verified via `vscode.diff` command opening pre/post pairs for each file in the PushRecord.
2. **Approve / request-changes / line comments inside VS Code**: a reviewer can approve, request changes, or leave line-level comments — all from inside VS Code (no browser). Verified by `vscode.commentController` registration + per-line thread persistence + protocol round-trip tests for review-vote and review-comment.
3. **Mandatory review gate**: when an admin configures a branch to require review, the merge action is blocked until at least one reviewer approves. Verified by `mergeBranch` command failing with a clear error toast when `requireReview` is true AND no approving review exists for the latest push; chat system event "Merge blocked: needs review approval" appears.
4. **Review comments in chat thread**: review events (open, vote, comment, resolve) appear in the in-app chat thread as system events so the team can follow the conversation without switching panels. Verified by chat-log.json gaining `{kind: 'system', subKind: 'review-*'}` records on each event.

## Data shapes

```ts
// New, added to src/types/review.ts
export type ReviewVote = 'approved' | 'changes-requested' | 'commented';
export type ReviewStatus = 'open' | 'approved' | 'changes-requested' | 'resolved' | 'abandoned';

export interface ReviewComment {
  id: string;                    // uuid
  reviewId: string;
  authorMemberId: string;
  authorDisplayName: string;     // host-stamped at relay
  filePath: string;              // relative to workspace
  line: number;                  // 1-based, anchor on post-push file
  body: string;                  // markdown
  createdAt: number;             // unix ms
}

export interface ReviewVoteRecord {
  reviewerMemberId: string;
  reviewerDisplayName: string;
  vote: ReviewVote;
  votedAt: number;
}

export interface ReviewRequest {
  id: string;                    // uuid
  pushId: string;                // ties to PushRecord.id
  branch: string;
  authorMemberId: string;
  authorDisplayName: string;
  openedAt: number;
  status: ReviewStatus;
  votes: ReviewVoteRecord[];     // one per reviewer; latest vote wins on re-vote
  comments: ReviewComment[];
  resolvedAt?: number;
  resolvedBy?: string;
  resolvedReason?: 'merged' | 'abandoned';
}
```

```ts
// Extend src/types/chat.ts SystemEventSubKind
export type SystemEventSubKind =
  | 'push'                       // existing
  | 'revert'                     // existing
  | 'branch-created'             // existing
  | 'review-opened'              // new
  | 'review-comment'             // new
  | 'review-approved'            // new
  | 'review-changes-requested'   // new
  | 'review-resolved';           // new
```

```ts
// Extend src/network/protocol.ts ProtocolMessage union
| { type: 'review-opened'; review: ReviewRequest; timestamp: number; }
| { type: 'review-comment'; reviewId: string; comment: ReviewComment; timestamp: number; }
| { type: 'review-vote'; reviewId: string; vote: ReviewVoteRecord; timestamp: number; }
| { type: 'review-resolved'; reviewId: string; resolvedBy: string; resolvedReason: 'merged' | 'abandoned'; timestamp: number; }
| { type: 'review-state-sync'; reviews: ReviewRequest[]; timestamp: number; }  // sent post-auth alongside existing state-sync
```

```ts
// Extend BranchInfo (BranchManager) with optional requireReview flag
export interface BranchInfo {
  // existing fields ...
  requireReview?: boolean;        // admin-toggleable per-branch gate (REVIEW-04)
}
```

## Threat model

- **T-06-01** (spoofed vote): client could send `review-vote` with a forged reviewerMemberId. Mitigation: SessionHost overrides reviewerMemberId/displayName with server-trusted values from the ws.member (same pattern as Plan 04-04 chat-message). Source-grep test pins the override.
- **T-06-02** (comment XSS in webview): markdown rendering of comment bodies could allow script injection. Mitigation: reuse Plan 04-10's CSP + markdown-it config (markdown only, no raw HTML, no inline scripts).
- **T-06-03** (review-DOS via spam comments): malicious member could spam thousands of comments. Mitigation: per-review cap of 500 comments + per-minute rate-limit of 30 comments/member (host-enforced). After cap, host drops the comment with a chat warning to the offending member only.
- **T-06-04** (mandatory-review bypass via direct file edit): admin sets requireReview=true, malicious user edits `.versioncon/branches/main/foo.ts` directly via OS file manager. Mitigation: out of scope — same posture as Phase 3 SyncTracker (file-system-level integrity isn't VersionCon's threat model). Document explicitly.
- **T-06-05** (review state-sync replay): on reconnect, the host sends review-state-sync. A malicious peer could craft a fake state to inject reviews. Mitigation: state-sync is HOST → CLIENT only; clients ignore inbound review-state-sync from anywhere but the host's ws (same wire-trust posture as state-sync today).

## Wave breakdown (planner consumes)

- **Wave 1** — Types + wire protocol + ReviewStore (persistence)
  Plan: 06-01
  New files: `src/types/review.ts`, `src/filesystem/ReviewStore.ts`, `src/test/suite/reviewStore.test.ts`
  Modified: `src/types/chat.ts` (extend SystemEventSubKind), `src/network/protocol.ts` (5 new wire types), `src/filesystem/BranchManager.ts` (BranchInfo.requireReview optional field)
  Persistence: `.versioncon/branches/{branch}/reviews/{pushId}.json` per-review

- **Wave 2** — Host-side relay + chat system events + member-leave cleanup
  Plan: 06-02
  Modified: `src/host/SessionHost.ts` (handle review-opened / review-comment / review-vote / review-resolved with server-trusted memberId override; rate-limit + 500-comment cap; emit appendAndBroadcastSystemEvent on each)
  New tests: `src/test/suite/reviewHostRelay.test.ts`

- **Wave 3** — Client-side routing + ReviewState manager
  Plan: 06-03
  Modified: `src/client/SessionClient.ts` (route 5 new wire types → typed events)
  New files: `src/state/ReviewState.ts` (client-side cache + active-review getter), `src/test/suite/reviewClientRouting.test.ts`, `src/test/suite/reviewState.test.ts`
  Extends: `src/types/events.ts` (5 new client events)

- **Wave 4** — ReviewPanel UI (webview) + side-by-side diff via vscode.diff
  Plan: 06-04
  New files: `src/ui/ReviewPanel.ts` (webview controller), `src/ui/webview/review/` (HTML + CSS + JS for the review panel — file list + vote buttons + comment input)
  New command: `versioncon.openReview` (Command Palette + push-history context menu)
  Tests: `src/test/suite/reviewPanel.test.ts` (source-grep + lifecycle)

- **Wave 5** — Inline comments via vscode.commentController + Mandatory-review gate on mergeBranch + chat-thread integration
  Plan: 06-05
  Modified: `src/extension.ts` (registers commentController per-review, wires open/close to ReviewPanel lifecycle; updates `versioncon.mergeBranch` to check requireReview + latest push approval)
  New command: `versioncon.setBranchRequireReview` (admin-only QuickPick toggle)
  Tests: `src/test/suite/mandatoryReviewGate.test.ts`, `src/test/suite/reviewInlineComments.test.ts`

## Scope guardrails

- Do NOT add GitHub/GitLab PR import. Reviews are LAN/session-scoped.
- Do NOT change existing PushHistory/PushRecord shape. ReviewRequest references PushRecord by id; review storage is separate.
- Do NOT remove or alter the existing `mergeBranch` flow (Phase 3 quickMergeFiles + structuredMergeBranch) — Phase 6 adds a GATE before merge runs, doesn't refactor the merge logic itself.
- Do NOT introduce a new chat record type. Review events ride as system-events with new SubKinds, same wire shape as Plan 04-12 push/revert/branch-created system events.
- Markdown rendering for comment bodies must reuse Plan 04-10's CSP + markdown-it bundle — no new dependencies.
- All adapters must handle disconnect mid-review gracefully — peer leaves with an open review: their comments persist (already on host disk via ReviewStore), their votes remain valid until they reconnect and explicitly retract.

## Open questions for planner

(none — frontmatter locks the gray areas)
