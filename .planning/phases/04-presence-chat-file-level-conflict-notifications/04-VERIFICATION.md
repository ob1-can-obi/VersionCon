---
phase: 04-presence-chat-file-level-conflict-notifications
verified: 2026-05-08T07:00:00Z
status: gaps_found
score: 4/5 must-haves verified (SC-1 verified-in-code with new SC-1 regression risk; SC-3 verified-in-code with two new SC-3-affecting blockers)
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  previous_verified: 2026-05-07T00:00:00Z
  gaps_closed:
    - "SC-3: Push/revert/branch events appended to chat-log.json as kind:'system' ChatRecords (closed by Plan 04-12)"
    - "CR-01: Host coerces client-authored chat-message frames to kind:'user', strips subKind/meta (closed by Plan 04-13)"
    - "CR-02: Host validates presence-update.activeFilePath against path traversal, absolute paths, backslashes, 1024-char cap (closed by Plan 04-13)"
    - "CR-03: Host caps chat-message.body at 65536 chars and recordId at 128 chars (closed by Plan 04-13)"
    - "CR-04: Public ChatPanel.onDidChangeViewState setter removed; refs.onPanelActivated bound to panel disposables (closed by Plan 04-14)"
  gaps_remaining: []
  regressions:
    - "SC-1 partial regression: CR-03-NEW path validator over-rejects legitimate filenames containing '..' substring (e.g. src/foo..bar.ts, package..json) — presence-update for those tabs is silently dropped, breaking the live presence panel for any teammate editing such a file"
    - "SC-3 partial regression: CR-01-NEW system event body misattributes actor to host's display name when the underlying PushRecord/BranchInfo carries a different memberDisplayName — host-initiated reverts of other members' pushes are persisted under the wrong name"
    - "SC-3 partial regression: CR-02-NEW host's own ChatPanel desyncs from chat-log.json on every system event — host emits broadcast but does not echo into clientChatRecords; host's chat panel never sees its own push/revert/branch-create activity until reconnect-driven chat-history replay"
gaps:
  - truth: "SC-3: Push/revert/branch system event body correctly identifies the actor (the member whose action is being recorded), not the host's display name when the actor is a different member"
    status: failed
    reason: "broadcastPush (SessionHost.ts:676), broadcastRevert (SessionHost.ts:704), and broadcastBranchCreated (SessionHost.ts:727) all interpolate `this.hostDisplayName` into the system event body string regardless of whether the underlying PushRecord/BranchInfo carries a different memberDisplayName. Plan 04-12 introduced this defect: the helper accepts a body string already-baked, and the call sites bake hostDisplayName instead of record.memberDisplayName. The contract in `extension.ts:1440` (revertPushFiles) explicitly relays a non-host member's push record into broadcastRevert; under that path the persisted ChatRecord and the chat-message envelope both display the host's name as the actor of an action the host did not perform. Latent for v1 host-only pushes but observable on revert and on any future relay path."
    artifacts:
      - path: "src/host/SessionHost.ts"
        issue: "Lines 676, 704, 727: body = `${this.hostDisplayName} pushed/reverted/created branch ...`. Should use record.memberDisplayName (push/revert) or branch.createdBy mapped through member registry (branch-created)"
    missing:
      - "broadcastPush body must interpolate `record.memberDisplayName` not `this.hostDisplayName`"
      - "broadcastRevert body must interpolate `record.memberDisplayName` not `this.hostDisplayName`"
      - "broadcastBranchCreated body should resolve `branch.createdBy` (a memberId) to a displayName via this.members lookup, falling back to hostDisplayName when the actor is the host"
      - "Widen appendAndBroadcastSystemEvent signature to accept actorMemberId and actorDisplayName (defaulting to host) so the helper can stamp the correct identity on the persisted ChatRecord and chat-message envelope"
      - "Add a regression test that calls broadcastPush with a PushRecord whose memberDisplayName differs from the host name, asserting persisted body and envelope body both interpolate the record's displayName"

  - truth: "SC-3: Host's own ChatPanel renders system events in real time on the same timeline that connected members see"
    status: failed
    reason: "appendAndBroadcastSystemEvent at SessionHost.ts:754-800 broadcasts a chat-message envelope but does not echo the new ChatRecord into the host process's clientChatRecords cache (the in-memory list ChatPanel.getRecords reads from). Plan 04-04 already established this echo pattern for host-emitted user messages via dispatchChatReceivedLocally (extension.ts:285), but the four broadcastPush/Revert/BranchCreated call sites in extension.ts (lines 1333, 1397, 1440, 1476) do not call dispatchChatReceivedLocally on the system record. Result: a host pushing or reverting sees the activity tree update (because addPushEntry is called separately) but the chat panel timeline does NOT show the system-event row until the host reconnects and chat-history replay arrives — direct violation of CONTEXT.md line 29 'the activity timeline is the chat timeline' from the host's own perspective. New plan 04-12 tests pass because they only verify connected-client receipt and chatLog.getRecords, not the host process's chat panel."
    artifacts:
      - path: "src/host/SessionHost.ts"
        issue: "Lines 754-800: appendAndBroadcastSystemEvent does not expose the persisted record to the caller, so extension.ts cannot echo it into clientChatRecords"
      - path: "src/extension.ts"
        issue: "Lines 1333, 1397, 1440, 1476: activeHost.broadcastPush/Revert/BranchCreated invoked without any echo into clientChatRecords"
    missing:
      - "Refactor appendAndBroadcastSystemEvent to either (a) return the persisted record so callers can dispatchChatReceivedLocally, OR (b) accept an `onLocalEcho?: (r: ChatRecord) => void` callback, OR (c) emit a SessionHost event ('system-event-emitted') that extension.ts subscribes to"
      - "In extension.ts at the four broadcast call sites, on host-initiated push/revert/branch-create, push the resulting system ChatRecord into clientChatRecords and call ChatPanel.currentPanel?.postChatMessage(record) — same pattern as dispatchChatReceivedLocally for user messages"
      - "Add an integration test that constructs a ChatPanel for the host process and asserts that a host broadcastBranchCreated produces a record visible to the host's panel (via getRecords) without requiring reconnect"

  - truth: "SC-1: Presence broadcast accepts legitimate workspace-relative paths including filenames containing two consecutive periods (e.g. src/foo..bar.ts, package..json, my..folder/index.ts)"
    status: failed
    reason: "Plan 04-13's CR-02 fix at SessionHost.ts:378 uses `p.includes('..')` to reject path traversal. This substring check fires on any path containing two consecutive periods, not just on the directory-traversal segment `../`. Legitimate filenames like `src/foo..bar.ts`, `package..json`, `my..folder/foo.ts`, or `__tests__/foo.test..js` are all silently dropped at the host. The teammate editing such a file broadcasts a presence-update that the host silently discards; their 'now editing X' presence row never updates for anyone else. Verified empirically: `node -e \"console.log('src/foo..bar.ts'.includes('..'))\"` → true. The 04-13 test suite only exercises the true-positive case (`'../../../../etc/passwd'` is rejected), so the over-rejection is unexercised. SC-1 is observable-broken for any teammate whose tab basename matches this pattern."
    artifacts:
      - path: "src/host/SessionHost.ts"
        issue: "Line 378: p.includes('..') is too coarse — should target the path segment '..' with separator boundaries"
    missing:
      - "Replace `p.includes('..')` with segment-aware traversal detection: `const segments = p.split('/'); if (segments.includes('..')) return;` — rejects only the `..` directory segment, not arbitrary substrings"
      - "Add a positive test in `Phase 4 host input validation` that sends activeFilePath `'src/foo..bar.ts'` and asserts the broadcast DOES reach Bob and the PresenceMap contains the path verbatim"
      - "Optional: add a positive test for `'package..json'` and `'my..folder/index.ts'` as additional regression coverage"

deferred: []
human_verification:
  - test: "SC-1: Live presence panel shows correct data across two VS Code windows"
    expected: "Panel shows all connected members, their active file, and their branch in real time; selfMemberId row shows '(you)' suffix; divergence indicator appears for members on different branches"
    why_human: "Requires two Extension Development Host windows running simultaneously; single-machine UAT blocked by backlog 999.1 (Bonjour service-name collision); multi-machine UAT feasible but not automated"

  - test: "SC-2: In-app chat send and syntax-highlighted code snippets"
    expected: "Text messages appear in chat panel; fenced code blocks (```ts) render with highlight.js syntax highlighting; no CSP violation in webview console"
    why_human: "Requires live WebviewPanel rendering in VS Code; cannot test webview behavior headlessly"

  - test: "SC-3: System events visible in chat panel timeline (host AND connected members)"
    expected: "When host pushes, host's own chat panel shows '{HostName} pushed N file(s)' system row. When host reverts a member's push, the system row shows the original member's name (not host). When a connected member is online, their chat panel shows the same system row in real time."
    why_human: "Requires multi-window UAT to verify host-process chat panel echo (CR-02-NEW) and actor attribution (CR-01-NEW). Code-level evidence already shows both gaps exist; UAT confirms the user-visible impact."

  - test: "SC-4: Soft non-blocking toast on file overlap across two Extension Development Host windows"
    expected: "When member A pushes src/foo.ts and member B has foo.ts open, member B sees a non-modal information notification matching 'Alice pushed 1 file — affects: foo.ts: \"msg\"'; modal:true is NOT set"
    why_human: "Requires two Extension Development Host windows; cross-process WebSocket; visual verification of notification appearance (non-modal)"

  - test: "SC-5: Green status bar flash when push does not affect open files"
    expected: "Status bar shows '$(check) VersionCon — no impact (N file(s) unaffected)' for ~5 seconds then reverts; no toast appears"
    why_human: "Requires two Extension Development Host windows and visual observation of 5-second flash timing"
---

# Phase 4: Presence, Chat + File-Level Conflict Notifications — Verification Report

**Phase Goal:** Team members can see who is online and what they are working on, communicate via in-app chat, and receive soft non-blocking alerts when a teammate's push touches files they have open
**Verified:** 2026-05-08T07:00:00Z
**Status:** GAPS_FOUND (re-verification — supersedes prior gaps_found of 2026-05-07)
**Re-verification:** Yes — after gap closure plans 04-12, 04-13, 04-14 landed (commits cb85245..637e4d2)

This report supersedes the prior 04-VERIFICATION.md (gaps_found, 4/5 SC verified, 5 code gaps + 4 human UAT items). All five originally-identified gaps are CLOSED. However, a supplementary code review (04-REVIEW-GAPS.md) on the gap-closure work surfaced three NEW blockers introduced by Plans 04-12 and 04-13 that affect the same Success Criteria the gap closures were meant to satisfy. Phase 4 cannot ship as currently composed — net status remains gaps_found.

---

## Re-verification Summary

| Original Gap | Plan | Status | Evidence |
|--------------|------|--------|----------|
| SC-3: Push/revert/branch events appended to chat-log.json as system records | 04-12 | CLOSED | SessionHost.ts:663-731 invokes appendAndBroadcastSystemEvent on each broadcast helper; 13 new tests in `Phase 4 system events in chat` suite pass |
| CR-01: Host coerces client kind to 'user' | 04-13 | CLOSED | SessionHost.ts:333-341 force-coerces sanitized.kind/subKind/meta; new test 'kind:system from client is coerced to user' in `Phase 4 host input validation` passes |
| CR-02: Host validates presence-update.activeFilePath | 04-13 | CLOSED (with regression — see CR-03-NEW below) | SessionHost.ts:373-382 implements path-traversal/absolute/backslash/1024-cap rejection |
| CR-03: Host caps chat-message body and recordId | 04-13 | CLOSED | SessionHost.ts:316-317 enforces 65536/128 char limits before persistence |
| CR-04: ChatPanel onDidChangeViewState lifecycle | 04-14 | CLOSED | Public setter removed; ChatPanel.ts:128 invokes refs.onPanelActivated through panel disposables; 4 new lifecycle tests pass |

**Test suite delta:** 284 passing (prior verification) → 311 passing (current). +27 tests across the three gap-closure plans. 0 regressions, tsc clean, build clean.

---

## New Gaps Introduced by Gap-Closure Plans

The supplementary code review (04-REVIEW-GAPS.md) found three new blockers:

### CR-01-NEW (BLOCKER): System-event body misattributes actor

**File:** `src/host/SessionHost.ts:676, :704, :727`
**Plan that introduced:** 04-12

`broadcastPush`, `broadcastRevert`, and `broadcastBranchCreated` interpolate `this.hostDisplayName` into the body string instead of `record.memberDisplayName` (or `branch.createdBy` resolved). The PushRecord type carries the actual actor's display name and Phase 3 reverts can be host-initiated for non-host members' pushes (`extension.ts:1440`). Under that path the system event lies about who performed the action.

```ts
// SessionHost.ts:676 (broadcastPush)
const body = `${this.hostDisplayName} pushed ${fileCount} file(s)`;
//             ^^^^^^^^^^^^^^^^^^^^^ should be `record.memberDisplayName`
```

**Impact on SC-3:** The activity timeline reflects the wrong actor for any push or revert where the actor is not the host. SC-3's "automatically posted to the chat timeline" is satisfied in shape but not in correctness.

### CR-02-NEW (BLOCKER): Host's own ChatPanel does not see its own system events

**File:** `src/host/SessionHost.ts:754-800` + `src/extension.ts:1333, :1397, :1440, :1476`
**Plan that introduced:** 04-12

`appendAndBroadcastSystemEvent` calls `this.broadcast(...)` to fan out the chat-message envelope to all connected clients, but the host process itself is the broadcaster — it does not receive its own broadcast. `dispatchChatReceivedLocally` (extension.ts:285) is the established echo path for user-authored messages but is not invoked from the four broadcastPush/Revert/BranchCreated call sites. The `clientChatRecords` cache that ChatPanel.getRecords reads from (extension.ts:255) is therefore missing all host-emitted system events.

**Impact on SC-3:** The host's own chat panel timeline is empty of push/revert/branch activity until a reconnect triggers chat-history replay — directly contradicting CONTEXT.md line 29 ("the activity timeline IS the chat timeline") from the host's perspective. Connected members see the events live; the host that emitted them does not.

### CR-03-NEW (BLOCKER): Path validator over-rejects legitimate filenames

**File:** `src/host/SessionHost.ts:378`
**Plan that introduced:** 04-13

```ts
if (p.includes('..') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')) {
//   ^^^^^^^^^^^^^^ matches any substring '..', not just the path segment
  return; // path traversal / absolute path / backslash — drop silently
}
```

`p.includes('..')` fires on legitimate filenames containing two consecutive periods: `src/foo..bar.ts`, `package..json`, `my..folder/foo.ts`, `__tests__/foo.test..js`. These paths are silently dropped by the host's presence-update handler. Verified: `node -e "console.log('src/foo..bar.ts'.includes('..'))"` returns `true`. The 04-13 test suite only exercises the true-positive case (`'../../../../etc/passwd'`).

**Impact on SC-1:** Any teammate editing a file whose workspace-relative path contains `..` substring becomes silently invisible in the presence panel — their "now editing X" row never updates for anyone else. SC-1 is observable-broken for that class of filename.

---

## Goal Achievement (Re-evaluated)

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Any team member can see a live presence panel showing who is online, which file each person has open, and which branch they are on | UNCERTAIN (human needed) — code wired, **NEW regression risk for `..` filenames** | PresenceTreeProvider exists and compiles; `(you)` suffix and `$(git-compare)` divergence indicator in code; 13 unit tests pass. CR-03-NEW will cause silent presence-update drops for any tab whose path contains `..`. Multi-window UAT required. |
| 2 | Team members can send text messages and paste syntax-highlighted code snippets in the in-app chat | UNCERTAIN (human needed) | ChatPanel.ts intact; markdown-it + highlight.js bundled; CSP nonce; 64KB client-side cap; 04-13 added 65536-char host-side cap; no code regression. Live webview UAT required. |
| 3 | Push events, revert events, and branch events are automatically posted to the chat timeline so the activity history is always visible | FAILED (with new defects) | 04-12 added the persistence path correctly. But CR-01-NEW means the persisted body misattributes the actor when the actor is not the host (revert path). CR-02-NEW means the host's own ChatPanel does not show events the host emits. Connected-member view works; host view and attribution correctness do not. |
| 4 | User receives a soft non-blocking notification when a teammate pushes a file they have open | UNCERTAIN (human needed) | computeFileOverlap wired; formatPushToast literals correct; showInformationMessage called without modal:true; no code regression. Multi-window UAT required. |
| 5 | When a push does not affect the user's workspace, the user sees a green "no impact" status | UNCERTAIN (human needed) | StatusBarManager.flashNoImpact intact; 8 unit tests pass; no code regression. Multi-window UAT required. |

**Score: 4/5 SC have intact code wiring; SC-3 fails due to two new SC-3-impacting blockers.** SC-1 has a new regression risk from CR-03-NEW (over-rejection of legitimate `..` filenames); listed under regressions but counted as code-wired-pending-UAT pending fix because the failure mode is filename-conditional, not categorical.

---

### Required Artifacts (delta since prior verification)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/host/SessionHost.ts` (chat-message handler) | CR-01 + CR-03 input validation | VERIFIED | Lines 316-317, 333-341 — kind coercion, body/recordId caps in place. 04-13 closed. |
| `src/host/SessionHost.ts` (presence-update handler) | CR-02 path validation | VERIFIED-WITH-REGRESSION | Lines 373-382 — validation present but `p.includes('..')` over-rejects (CR-03-NEW). 04-13 closed CR-02 but introduced false-positive on legitimate `..` filenames. |
| `src/host/SessionHost.ts` (broadcastPush/Revert/BranchCreated) | System event persistence + broadcast | VERIFIED-WITH-DEFECTS | Lines 663-731 — append+broadcast path wired. But body uses hostDisplayName (CR-01-NEW). 04-12 closed SC-3 shape but introduced actor misattribution. |
| `src/host/SessionHost.ts` (appendAndBroadcastSystemEvent) | Host-internal system event helper | VERIFIED-WITH-DEFECT | Lines 754-800 — helper exists, persists, broadcasts. Does not echo to host's own clientChatRecords (CR-02-NEW). |
| `src/ui/ChatPanel.ts` | onPanelActivated through refs | VERIFIED | Lines 34, 121-130 — interface field + invocation; viewStateHandler field and public setter removed. 04-14 closed CR-04. |
| `src/extension.ts` (versioncon.openChat) | Refs bundle includes onPanelActivated | VERIFIED | Lines 305-313 — onPanelActivated callback wired; standalone setter call removed. 04-14 closed CR-04. |
| `src/extension.ts` (push/revert/branch-create call sites) | Echo system events to host's own panel | NOT WIRED (CR-02-NEW) | Lines 1333, 1397, 1440, 1476 invoke broadcast helpers but never echo the system record into clientChatRecords. |

---

### Key Link Verification (delta since prior verification)

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/host/SessionHost.ts (broadcastPush/Revert/BranchCreated)` | `src/filesystem/ChatLog.ts (chatLog.append)` | system ChatRecord with kind:'system' | WIRED | appendAndBroadcastSystemEvent at SessionHost.ts:767-784 — Plan 04-12 |
| `src/host/SessionHost.ts (appendAndBroadcastSystemEvent)` | broadcast(chat-message envelope) | this.broadcast no-exclude | WIRED | SessionHost.ts:789-799 |
| `src/host/SessionHost.ts (appendAndBroadcastSystemEvent)` | `src/extension.ts (clientChatRecords)` | host-process echo of system event | NOT WIRED (CR-02-NEW) | No callback or event from helper to extension.ts; host's own panel desyncs |
| `src/host/SessionHost.ts (broadcastRevert)` | actor identity in body | `record.memberDisplayName` | NOT WIRED (CR-01-NEW) | Body interpolates `this.hostDisplayName` instead — line 704 |
| `src/ui/ChatPanel.ts (constructor)` | `refs.onPanelActivated` | inner panel.onDidChangeViewState Disposable in this.disposables | WIRED | ChatPanel.ts:126-130 — Plan 04-14 |
| `src/extension.ts (versioncon.openChat refs)` | unread-clear logic | `onPanelActivated` callback in refs literal | WIRED | extension.ts:305-313 — Plan 04-14 |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `ActivityLogProvider` | `entries[]` | `addPushEntry/addRevertEntry/addBranchCreateEntry` | Yes | FLOWING (unchanged) |
| `PresenceTreeProvider` | `map` (PresenceMap) | presence-update events | Yes (when path passes validator) | FLOWING-WITH-REGRESSION (CR-03-NEW silently drops `..` filenames) |
| `ChatPanel` webview (connected members) | `records[]` for system events | chat-received via SessionClient | Yes | FLOWING (Plan 04-12 closed) |
| `ChatPanel` webview (host's own panel) | `records[]` for system events | clientChatRecords (extension.ts) | NO — never populated for system events | DISCONNECTED (CR-02-NEW) |
| `ChatPanel` webview body field | actor name in system event body | hostDisplayName (incorrect when actor is non-host member) | Misleading data | HOLLOW (CR-01-NEW) |
| `StatusBarManager` flash | flashNoImpact arg | push-received overlap calc result | Yes | FLOWING (unchanged) |

---

### Behavioral Spot-Checks

| Behavior | Check | Result | Status |
|----------|-------|--------|--------|
| TypeScript compile | `npx tsc --noEmit` | exit 0 | PASS |
| Unit test suite | `npm test` | 311 passing / 0 failing / 66 pending | PASS |
| Phase 4 system events tests | `npm test -- --grep 'Phase 4 system events in chat'` | 13 passing | PASS |
| Phase 4 input validation tests | `npm test -- --grep 'Phase 4 host input validation'` | 10 passing | PASS |
| Phase 4 chat panel lifecycle tests | `npm test -- --grep 'Phase 4 chat panel lifecycle'` | 4 passing | PASS |
| Phase 4 host relay tests | `npm test -- --grep 'Phase 4 host relay'` | 11 passing (no regression) | PASS |
| CR-01-NEW evidence: host name in revert body | `grep "hostDisplayName} reverted" src/host/SessionHost.ts` | match at line 704 | FAIL (defect present) |
| CR-02-NEW evidence: no echo at broadcast call sites | `grep -A 5 "broadcastPush\|broadcastRevert\|broadcastBranchCreated" src/extension.ts | grep dispatchChatReceivedLocally` | no match | FAIL (defect present) |
| CR-03-NEW evidence: includes('..') over-rejection | `node -e "console.log('src/foo..bar.ts'.includes('..'))"` | true | FAIL (defect present) |
| CR-01 closure (kind coercion) | `grep "kind: 'user'" src/host/SessionHost.ts` | line 335 | PASS |
| CR-02 closure (path validation, ignoring CR-03-NEW) | `grep "p.includes('..')" src/host/SessionHost.ts` | line 378 | PASS-WITH-CAVEAT |
| CR-03 closure (body cap) | `grep "msg.body.length > 65536" src/host/SessionHost.ts` | line 316 | PASS |
| CR-04 closure (no public setter) | `grep "viewStateHandler" src/ui/ChatPanel.ts` | no match | PASS |
| CR-04 closure (refs callback wired) | `grep "onPanelActivated" src/extension.ts` | line 305 | PASS |

---

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|---------------|-------------|--------|----------|
| COLLAB-01 | 04-03, 04-05, 04-08 | Real-time presence — who's online, file, branch | PARTIAL — code wired, CR-03-NEW regression for `..` filenames | PresenceTreeProvider fully wired; CR-03-NEW silently drops `..`-bearing paths |
| COLLAB-02 | 04-01, 04-04, 04-05, 04-10 | In-app text chat | SATISFIED (code) / UAT pending | ChatPanel + send-chat handler + handleLocalChatMessage all wired |
| COLLAB-03 | 04-10 | Code snippet support with syntax highlighting | SATISFIED (code) / UAT pending | markdown-it + highlight.js bundled |
| COLLAB-04 | 04-01, 04-02, 04-04, 04-05, 04-07, 04-12 | Push events automatically logged in chat | PARTIAL — chat-log persisted but actor mislabeled and host's own panel desynced | CR-01-NEW + CR-02-NEW both impact this requirement directly |
| COLLAB-05 | 04-02, 04-04, 04-11 | Chat shows who's working + who's affected | PARTIAL — manageChat QuickPick wired; system-event display impaired by CR-01-NEW + CR-02-NEW | manageChat present; but the system messages it depends on for "who pushed what" carry wrong actor and don't render in host's panel |
| COLLAB-06 | 04-07 | Soft notifications in activity tree for affected code | SATISFIED | `affectsLocal` flag drives "— affects you" label in ActivityLogProvider |
| CONF-01 | 04-06, 04-09 | File-level conflict notification | SATISFIED (code) / UAT pending | computeFileOverlap correct; toast on overlap > 0 |
| CONF-07 | 04-06, 04-07, 04-09 | Soft non-blocking notifications (not modal) | SATISFIED (code) / UAT pending | showInformationMessage without modal:true; UI-SPEC §6.1 literals verified |
| CONF-08 | 04-06, 04-09 | Green status when unaffected | SATISFIED (code) / UAT pending | flashNoImpact correct text + 5s timer |

COLLAB-07 (review comments) is mapped to Phase 6 in REQUIREMENTS.md and is not a Phase 4 commitment, despite Plan 04-10 frontmatter listing it. Not counted against Phase 4.

---

### Anti-Patterns Found (delta since prior verification)

| File | Issue | Severity | Impact |
|------|-------|----------|--------|
| `src/host/SessionHost.ts:676, :704, :727` | CR-01-NEW: hostDisplayName interpolated into system event body where record.memberDisplayName should be used | BLOCKER | Activity timeline misattributes the actor on host-initiated reverts of non-host members' pushes; persisted record AND wire envelope both lie |
| `src/host/SessionHost.ts:754-800` + `src/extension.ts:1333, :1397, :1440, :1476` | CR-02-NEW: Host's own ChatPanel desyncs from chat-log.json on every system event — no echo into clientChatRecords | BLOCKER | Host process never sees its own push/revert/branch activity in its chat panel until reconnect; CONTEXT.md line 29 violated from host's perspective |
| `src/host/SessionHost.ts:378` | CR-03-NEW: `p.includes('..')` over-rejects legitimate `..`-bearing filenames | BLOCKER | Presence-update silently dropped for any teammate editing files like `src/foo..bar.ts`, `package..json`, etc.; SC-1 broken for that class of filename |

The remaining 7 warnings + 4 info items from 04-REVIEW-GAPS.md (whitespace-only body bypass, UTF-16 vs byte length cap, empty-string activeFilePath, persist-vs-broadcast contract asymmetry, openChat no-workspace edge, ChatLog.append id dedupe, test name copy-paste, etc.) are NOT phase-blocking but should be tracked as backlog items.

---

### Human Verification Required

#### 1. Live Presence Panel (SC-1)

**Test:** Open two VS Code Extension Development Host windows on separate machines (or same machine with mDNS workaround per backlog 999.1). Host a session on machine A, join from machine B. Open different files on each machine. Check the presence panel on both windows.
**Expected:** Each window shows both members with correct display name, active file basename, and branch. The self-member row shows "(you)" suffix. If branches differ, the $(git-compare) icon appears.
**Why human:** Requires two active VS Code Extension Development Host windows; single-machine UAT blocked by Bonjour service-name collision (backlog 999.1); cross-process WebSocket verification.

#### 2. Chat Panel Send + Code Snippets (SC-2)

**Test:** In a live session, open the chat panel via `versioncon.openChat`. Send a plain text message. Send a message with a fenced code block.
**Expected:** Plain text appears immediately in both members' chat panels. Code block renders with TypeScript syntax highlighting (colored keywords). No CSP violation in the VS Code devtools console.
**Why human:** Requires live WebviewPanel rendering; syntax highlight rendering is visual; CSP errors only visible in webview devtools console.

#### 3. System Events in Chat — Actor + Host-Self Echo (SC-3)

**Test (post-fix):** Connect machines A (host) and B (member). On A, push a file as host — observe both A's and B's chat panels. Then have B push a file (or simulate via revertPushFiles on A targeting B's earlier push) — observe the actor name in both chat panels.
**Expected:** A's chat panel shows the system row in real time, not just B's. The actor name in the body matches the member who performed the action (B for B's push; B again for A reverting B's push). No `{HostName}` substitution where another member's name belongs.
**Why human:** Confirms CR-01-NEW and CR-02-NEW are fixed at runtime — code-level evidence already shows both gaps exist.

#### 4. Soft Toast on File Overlap (SC-4)

**Test:** Machine A has `src/foo.ts` open. Machine B (host) pushes changes to `src/foo.ts` with message "test push". Observe machine A.
**Expected:** A non-modal information notification appears on machine A reading approximately "B pushed 1 file — affects: foo.ts: 'test push'". The notification has no buttons and auto-dismisses. The activity tree gains a new row with the "— affects you" suffix.
**Why human:** Requires two windows; notification appearance is visual; "non-modal" verification requires seeing the VS Code notification area.

#### 5. Green Flash When No Overlap (SC-5)

**Test:** Machine A does NOT have `src/bar.ts` open. Machine B (host) pushes changes to `src/bar.ts`. Observe machine A's status bar.
**Expected:** Status bar changes to "$(check) VersionCon — no impact (1 file unaffected)" for approximately 5 seconds, then reverts. No toast appears.
**Why human:** Requires two windows; 5-second timing must be visually confirmed; status bar text verification is visual.

---

## Gaps Summary

The five originally-identified gaps from the 2026-05-07 verification are CLOSED. Three NEW blockers were introduced by the gap-closure work and are confirmed by direct code inspection:

1. **CR-01-NEW (BLOCKER):** broadcastPush/Revert/BranchCreated body strings interpolate `this.hostDisplayName` instead of `record.memberDisplayName`. Latent for v1 host-only pushes but observable on revert (`extension.ts:1440` reverts non-host pushes through the host) and on any future relay path. Persisted ChatRecord and the chat-message envelope both misattribute the actor.

2. **CR-02-NEW (BLOCKER):** `appendAndBroadcastSystemEvent` does not echo the persisted record into the host process's `clientChatRecords` cache. The four broadcastPush/Revert/BranchCreated call sites in extension.ts do not call `dispatchChatReceivedLocally` for system events (only user messages have this echo). Host's own chat panel never sees its own push/revert/branch activity until a reconnect-driven chat-history replay arrives. Direct contradiction of CONTEXT.md line 29 from the host's perspective.

3. **CR-03-NEW (BLOCKER):** `p.includes('..')` at SessionHost.ts:378 fires on any substring `..`, not just the path-segment directory traversal. Legitimate filenames containing two consecutive periods (`src/foo..bar.ts`, `package..json`, `my..folder/foo.ts`) are silently dropped at the host. Presence panel never updates for any teammate editing such a file. False-positive security check that degrades user-visible behavior.

**Net status:** gaps_found. Phase 4 should not ship until these three blockers are closed. The fix scope is small (each is a 1-5 line code change plus a regression test) and should be addressable in a single follow-up plan (suggested: 04-15 — gap-closure-v2). The rest of the phase (SC-1/2/4/5 code wiring, COLLAB/CONF requirements other than COLLAB-04/COLLAB-05) remains intact and ready for multi-window UAT once these blockers are closed.

---

_Verified: 2026-05-08T07:00:00Z_
_Verifier: Claude (gsd-verifier)_
_Supersedes: 04-VERIFICATION.md @ 2026-05-07T00:00:00Z (gaps_found, 4/5 SC, 5 code gaps + 4 human UAT items)_
