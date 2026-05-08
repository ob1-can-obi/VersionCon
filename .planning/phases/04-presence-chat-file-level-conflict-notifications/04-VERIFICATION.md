---
phase: 04-presence-chat-file-level-conflict-notifications
verified: 2026-05-07T00:00:00Z
status: gaps_found
score: 4/5 must-haves verified
overrides_applied: 0
gaps:
  - truth: "Push events, revert events, and branch events are automatically posted to the chat timeline so the activity history is always visible"
    status: failed
    reason: "Push/revert/branch events are recorded in the ActivityLogProvider (sidebar tree) but NOT written as system-kind ChatRecord entries to chat-log.json, and NOT displayed in the chat panel timeline. The CONTEXT document (line 29) explicitly locks this: 'Push, revert, and branch-create events are ALSO appended to chat-log.json as system events — the activity timeline is the chat timeline.' broadcastPush/broadcastRevert/broadcastBranchCreated in SessionHost do NOT call chatLog.append with kind:'system'. No code path in extension.ts creates a system ChatRecord from a push-received event."
    artifacts:
      - path: "src/host/SessionHost.ts"
        issue: "broadcastPush(), broadcastRevert(), broadcastBranchCreated() do not call chatLog.append() with kind:'system' records"
      - path: "src/extension.ts"
        issue: "push-received handler adds activity tree entry (addPushEntry) but creates no system ChatRecord; push-reverted and branch-created same pattern"
    missing:
      - "In broadcastPush/broadcastRevert/broadcastBranchCreated on SessionHost, after broadcast, call chatLog.append() with a ChatRecord of kind:'system' and the appropriate subKind ('push'/'revert'/'branch-created') and meta fields"
      - "Alternatively wire extension.ts to call activeHost.handleLocalChatMessage({kind:'system', subKind:'push', ...}) on push-received event"
      - "ChatPanel must render system-event rows (renderSystemRow in webview/main.ts already exists and keys off kind==='system') — but system records must first reach chat-log.json"

  - truth: "CR-01: Host accepts client-authored kind:'system' chat-message frames — anyone can forge push/branch-created activity events"
    status: failed
    reason: "In src/host/SessionHost.ts lines 319-331, the chat-message handler spreads msg fields including kind and subKind without coercion. A malicious client can send kind:'system', subKind:'push' and the host persists + broadcasts it as a system event. The REVIEW CR-01 finding is confirmed: the sanitized object at line 319 does not coerce kind to 'user' or strip subKind/meta before persistence."
    artifacts:
      - path: "src/host/SessionHost.ts"
        issue: "Lines 319-331: sanitized = { ...msg, memberId, memberDisplayName, timestamp } — kind and subKind are NOT coerced; ChatRecord at line 330 uses msg.kind verbatim"
    missing:
      - "In the chat-message handler, before building the sanitized record, add: kind: 'user', subKind: undefined, meta: undefined — client-authored messages must always be user-kind regardless of what the client claims"

  - truth: "CR-02: Host does not validate presence-update.activeFilePath for path traversal"
    status: failed
    reason: "src/host/SessionHost.ts lines 349-370: msg.activeFilePath is passed directly to presenceMap.upsert and into the broadcast envelope without any validation. A malicious client can send '../../../../etc/passwd' or '/Users/victim/.ssh/id_rsa' and every connected client will render that string in their presence tree tooltip ('On branch: ...\nFile: ../../../../etc/passwd'). PresenceMap.ts T-04-03-03 documents this as a precondition that callers (Plan 04-06) must enforce — but the host's presence-update handler does not call computeFileOverlap or any normalization."
    artifacts:
      - path: "src/host/SessionHost.ts"
        issue: "Lines 364-366: activeFilePath: msg.activeFilePath — no '..' check, no absolute path rejection, no length cap"
    missing:
      - "In the presence-update handler, validate msg.activeFilePath: reject if contains '..', starts with '/', matches absolute Windows path, contains backslash, or exceeds 1024 chars; set safePath = null for all invalid values"

  - truth: "CR-03: Unbounded chat-message.body — host persists/broadcasts without a host-side length cap"
    status: failed
    reason: "The 64KB body cap exists only in ChatPanel.handleMessage (client-side UI, lines 240-244 in ChatPanel.ts). The host's chat-message handler at SessionHost.ts lines 310-348 has no body length validation. A client bypassing the panel and sending a raw WebSocket message can persist and broadcast arbitrarily large bodies up to maxPayloadBytes (~1MB). The REVIEW CR-03 finding is confirmed."
    artifacts:
      - path: "src/host/SessionHost.ts"
        issue: "chat-message handler has no typeof body !== 'string' check and no body.length > 65536 guard"
    missing:
      - "Before building the sanitized record, add: if (typeof msg.body !== 'string' || msg.body.length === 0 || msg.body.length > 65536) return; if (typeof msg.recordId !== 'string' || msg.recordId.length > 128) return;"

  - truth: "CR-04: openChat onDidChangeViewState handler not pushed to subscriptions — stale state on deactivation"
    status: failed
    reason: "In src/extension.ts lines 303-310, every invocation of versioncon.openChat calls ChatPanel.currentPanel?.onDidChangeViewState(...) using the setter API. The setter overwrites the single stored viewStateHandler (correct for one-at-a-time use) but the closure is NOT pushed to context.subscriptions. During extension deactivation chatPanelIsActive may remain true while the panel is gone. The REVIEW CR-04 finding is confirmed: the unread-clear logic depends on a transient single-handler API that is not lifecycle-managed."
    artifacts:
      - path: "src/extension.ts"
        issue: "Lines 303-310: ChatPanel.currentPanel?.onDidChangeViewState(handler) not pushed to context.subscriptions; handler not disposed on command re-invocation"
    missing:
      - "Move the unread-clear logic into ChatPanel's own onDidChangeViewState Disposable (already pushed to this.disposables at ChatPanel.ts:112-117) via an onPanelActivated callback injected through the refs bundle, OR push the return value of onDidChangeViewState to context.subscriptions"

human_verification:
  - test: "SC-1: Live presence panel shows correct data across two VS Code windows"
    expected: "Panel shows all connected members, their active file, and their branch in real time; selfMemberId row shows '(you)' suffix; divergence indicator appears for members on different branches"
    why_human: "Requires two Extension Development Host windows running simultaneously; single-machine UAT blocked by backlog 999.1 (Bonjour service-name collision); multi-machine UAT feasible but not automated"

  - test: "SC-2: In-app chat send and syntax-highlighted code snippets"
    expected: "Text messages appear in chat panel; fenced code blocks (```ts) render with highlight.js syntax highlighting; no CSP violation in webview console"
    why_human: "Requires live WebviewPanel rendering in VS Code; cannot test webview behavior headlessly"

  - test: "SC-4: Soft non-blocking toast on file overlap across two Extension Development Host windows"
    expected: "When member A pushes src/foo.ts and member B has foo.ts open, member B sees a non-modal information notification matching 'Alice pushed 1 file — affects: foo.ts: \"msg\"'; modal:true is NOT set"
    why_human: "Requires two Extension Development Host windows; cross-process WebSocket; visual verification of notification appearance (non-modal)"

  - test: "SC-5: Green status bar flash when push does not affect open files"
    expected: "Status bar shows '$(check) VersionCon — no impact (N file(s) unaffected)' for ~5 seconds then reverts; no toast appears"
    why_human: "Requires two Extension Development Host windows and visual observation of 5-second flash timing"
---

# Phase 4: Presence, Chat + File-Level Conflict Notifications — Verification Report

**Phase Goal:** Team members can see who is online and what they are working on, communicate via in-app chat, and receive soft non-blocking alerts when a teammate's push touches files they have open
**Verified:** 2026-05-07T00:00:00Z
**Status:** GAPS_FOUND
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Any team member can see a live presence panel showing who is online, which file each person has open, and which branch they are on | ? UNCERTAIN (human needed) | `PresenceTreeProvider` exists and compiles; `upsert/removeMember/setSelfMemberId/setCurrentBranch` wired; `(you)` suffix and `$(git-compare)` divergence indicator in code; 13 unit tests pass. Requires two-window UAT to verify end-to-end. |
| 2 | Team members can send text messages and paste syntax-highlighted code snippets in the in-app chat | ? UNCERTAIN (human needed) | `ChatPanel.ts` exists with markdown-it + highlight.js, CSP nonce, `send-chat` postMessage handler, 64KB client-side cap. `versioncon.openChat` registered. Requires live webview to verify rendering. |
| 3 | Push events, revert events, and branch events are automatically posted to the chat timeline | ✗ FAILED | `broadcastPush/Revert/BranchCreated` in SessionHost do NOT call `chatLog.append()` with system records. Push events go only to ActivityLogProvider (sidebar tree). Chat panel receives only user messages. CONTEXT.md line 29 explicitly locks: "Push, revert, and branch-create events are ALSO appended to chat-log.json as system events." |
| 4 | User receives a soft non-blocking notification when a teammate pushes a file they have open | ? UNCERTAIN (human needed) | `computeFileOverlap` wired in extension.ts push-received handler; `formatPushToast` produces UI-SPEC §6.1 literals; `showInformationMessage` called without `modal:true`; StatusBarManager tests pass. Requires two-window UAT. |
| 5 | When a push does not affect the user's workspace, the user sees a green "no impact" status | ? UNCERTAIN (human needed) | `StatusBarManager.flashNoImpact` implemented with correct text and 5s timer; 8 unit tests pass including revert-after-duration test. Requires two-window UAT for visual confirmation. |

**Score: 4/5 truths verifiable (1 FAILED, 4 UNCERTAIN/human-needed)**

---

## Code Review Findings (CR-01 through CR-04)

Per the code review (04-REVIEW.md), four critical security/integrity findings must be fixed before the phase ships:

| Finding | Component | Status | Evidence |
|---------|-----------|--------|----------|
| CR-01: Host doesn't validate `kind`/`subKind`/`meta` — clients can forge system events | `src/host/SessionHost.ts` lines 319-331 | ✗ FAILED | Confirmed: `sanitized = { ...msg, ... }` spreads `kind` and `subKind` unmodified; ChatRecord at line 330 uses `msg.kind` verbatim; no coercion to `'user'` |
| CR-02: `presence-update.activeFilePath` has no path-traversal guard on the wire | `src/host/SessionHost.ts` lines 362-366 | ✗ FAILED | Confirmed: `activeFilePath: msg.activeFilePath` passed directly to `presenceMap.upsert` and broadcast envelope; no `'..'` check, no absolute path rejection |
| CR-03: `chat-message.body` has no host-side length cap | `src/host/SessionHost.ts` lines 310-348 | ✗ FAILED | Confirmed: no `typeof msg.body !== 'string'` check and no `body.length > 65536` guard in the handler |
| CR-04: `openChat` `onDidChangeViewState` handler not pushed to subscriptions | `src/extension.ts` lines 303-310 | ✗ FAILED | Confirmed: setter called without pushing return value to subscriptions; unread-clear logic not lifecycle-managed |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/types/chat.ts` | ChatRecord, PresenceInfo, ChatRecordKind, SystemEventSubKind | ✓ VERIFIED | 4 exports confirmed; compiles cleanly |
| `src/network/protocol.ts` | 5 new ProtocolMessage interfaces + VALID_TYPES | ✓ VERIFIED | 5 new type discriminators confirmed |
| `src/types/events.ts` | 5 new client event keys | ✓ VERIFIED | 5 event keys confirmed |
| `src/filesystem/ChatLog.ts` | ChatLog class with 6 async methods + 3 truncation modes | ✓ VERIFIED | 6 async methods confirmed |
| `src/filesystem/PresenceMap.ts` | PresenceMap class with 5 methods | ✓ VERIFIED | 5 methods confirmed; no fs imports |
| `src/host/SessionHost.ts` | chat-message + presence-update handlers, 7 public methods, member-left cleanup | ✓ VERIFIED (with gaps) | Handlers exist; 7 public methods exist; member-left cleanup confirmed. CR-01/CR-02/CR-03 are unresolved security gaps. |
| `src/client/SessionClient.ts` | 5 new switch cases routing to typed events | ✓ VERIFIED | 5 cases confirmed |
| `src/utils/fileOverlap.ts` | computeFileOverlap (pure) + getOpenTabPaths | ✓ VERIFIED | Both functions confirmed; case-sensitivity logic and workspace boundary check present |
| `src/ui/ActivityLogProvider.ts` | TreeDataProvider, ring buffer 200, sticky unread, UI-SPEC labels | ✓ VERIFIED | All features confirmed; 27 tests |
| `src/ui/PresenceTreeProvider.ts` | TreeDataProvider, sort order, (you) suffix, divergence indicator | ✓ VERIFIED | All features confirmed; 13 tests |
| `src/ui/StatusBarManager.ts` | flashNoImpact + setUnreadCount + syncWarning precedence | ✓ VERIFIED | All features confirmed; 8 tests |
| `src/ui/ChatPanel.ts` | WebviewPanel with markdown-it, highlight.js, CSP nonce, send-chat handler | ✓ VERIFIED | Confirmed substantive; CSP nonce; 64KB client-side cap |
| `src/extension.ts` | Provider wiring, push-received overlap calc, presence broadcast | ✓ VERIFIED (with gaps) | All key imports and wiring confirmed; system events to chat not wired (SC-3 gap) |
| `package.json` | versioncon.activityLog + versioncon.presence views + commands | ✓ VERIFIED | Both views and all commands confirmed |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/host/SessionHost.ts` | `src/filesystem/ChatLog.ts` | `chatLog.append(record)` | ✓ WIRED | chat-message handler appends to chatLog |
| `src/host/SessionHost.ts` | `src/filesystem/PresenceMap.ts` | `presenceMap.upsert(info)` | ✓ WIRED | presence-update handler upserts |
| `src/client/SessionClient.ts` | `src/types/events.ts` | `emit('chat-received', ...)` 5 events | ✓ WIRED | 5 emit calls confirmed |
| `src/extension.ts` | `src/utils/fileOverlap.ts` | `computeFileOverlap(...)` in push-received | ✓ WIRED | Import and call site confirmed |
| `src/extension.ts` | `src/ui/ActivityLogProvider.ts` | `activityLogProvider.addPushEntry(...)` | ✓ WIRED | Call sites confirmed |
| `src/extension.ts` | `src/ui/PresenceTreeProvider.ts` | `presenceTreeProvider.upsert(info)` | ✓ WIRED | Call site confirmed |
| `src/extension.ts` | `src/ui/StatusBarManager.ts` | `statusBarManager.flashNoImpact(...)` | ✓ WIRED | Call site confirmed |
| `src/host/SessionHost.ts` | chat-log.json | system event records for push/revert/branch | ✗ NOT WIRED | broadcastPush/Revert/BranchCreated do NOT call chatLog.append with system records — SC-3 root cause |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `ActivityLogProvider` | `entries[]` | `addPushEntry/addRevertEntry/addBranchCreateEntry` in extension.ts push-received/reverted/branch-created handlers | Yes — real push data from server-trusted broadcast | ✓ FLOWING |
| `PresenceTreeProvider` | `map` (PresenceMap) | `presenceTreeProvider.upsert(info)` on presence-update events | Yes — host-stamped PresenceInfo | ✓ FLOWING |
| `ChatPanel` webview | `records[]` + `clientChatRecords` | chat-received events from SessionClient | Yes — real ChatRecord payloads | ✓ FLOWING for user messages |
| Chat panel system-event rows | `record.kind === 'system'` records | NOT FLOWING — no code path creates system ChatRecords from push events | No | ✗ DISCONNECTED — SC-3 gap |
| `StatusBarManager` flash | `flashNoImpact(data.files.length)` | push-received overlap calc result | Yes | ✓ FLOWING |

---

### Behavioral Spot-Checks

Step 7b: SKIPPED for cross-process behaviors requiring two VS Code Extension Development Host windows. Code-level checks performed instead:

| Behavior | Check | Result | Status |
|----------|-------|--------|--------|
| Protocol round-trip | `grep "suite('Phase 4 protocol'" src/test/suite/protocol.test.ts` | Found | ✓ PASS |
| ChatLog persistence methods | `grep -c "async append\|async load\|async clearAll" src/filesystem/ChatLog.ts` returns 6 | 6 | ✓ PASS |
| Host identity override | `grep "T-04-04-01" src/host/SessionHost.ts` — documented | Found | ✓ PASS |
| Host-side body cap | `grep "body.length > 65536" src/host/SessionHost.ts` | NOT FOUND | ✗ FAIL (CR-03) |
| Kind coercion in host | `grep "kind: 'user'" src/host/SessionHost.ts` in sanitized block | NOT FOUND | ✗ FAIL (CR-01) |
| Path traversal guard | `grep "includes('\.\.')" src/host/SessionHost.ts` in presence-update handler | NOT FOUND | ✗ FAIL (CR-02) |
| System events to chat | `grep "kind.*system.*append\|chatLog.*system" src/host/SessionHost.ts` near broadcastPush | NOT FOUND | ✗ FAIL (SC-3) |

---

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|---------------|-------------|--------|----------|
| COLLAB-01 | 04-03, 04-08, 04-09 | Real-time presence — who's online, file, branch | ✓ SATISFIED (code) / ? UAT pending | PresenceTreeProvider fully wired; presence-update broadcast on activeTextEditor change |
| COLLAB-02 | 04-01, 04-04, 04-05, 04-10 | In-app text chat | ✓ SATISFIED (code) / ? UAT pending | ChatPanel, send-chat handler, handleLocalChatMessage all wired |
| COLLAB-03 | 04-10 | Code snippet support with syntax highlighting | ✓ SATISFIED (code) / ? UAT pending | markdown-it + highlight.js bundled; fenced code blocks rendered |
| COLLAB-04 | 04-01, 04-02, 04-04, 04-05, 04-07, 04-09 | Push events automatically logged in chat | ✗ BLOCKED | Push events reach ActivityLogProvider but NOT chat-log.json as system records. Chat panel timeline is empty of push/revert/branch events. |
| COLLAB-05 | 04-11 | Chat shows who's working + who's affected | ? PARTIAL | manageChat QuickPick registered with all 5 actions; host-gating present. But the system-event chat messages that would show "pushed X files" are not created (COLLAB-04 gap cascades here). |
| COLLAB-06 | 04-07, 04-09 | Soft notifications in activity tree for affected code | ✓ SATISFIED | `affectsLocal` flag drives "— affects you" label in ActivityLogProvider; wired from computeFileOverlap result |
| CONF-01 | 04-06, 04-09 | File-level conflict notification | ✓ SATISFIED (code) / ? UAT pending | computeFileOverlap correctly detects overlap; extension.ts fires toast on overlap > 0 |
| CONF-07 | 04-09 | Soft non-blocking notifications (not modal) | ✓ SATISFIED (code) / ? UAT pending | showInformationMessage called without modal:true; UI-SPEC §6.1 literals verified |
| CONF-08 | 04-09 | Green status when unaffected | ✓ SATISFIED (code) / ? UAT pending | flashNoImpact with correct text, 5s timer, sync-warning precedence |

---

### Anti-Patterns Found

| File | Issue | Severity | Impact |
|------|-------|----------|--------|
| `src/host/SessionHost.ts:319-331` | CR-01: `kind` and `subKind` not coerced in chat-message handler — client can send `kind:'system'` and it persists/broadcasts as a system event | BLOCKER | Any authenticated member can forge push/branch activity events in the chat timeline |
| `src/host/SessionHost.ts:362-366` | CR-02: `activeFilePath` passed to presenceMap.upsert without validation — path traversal possible | BLOCKER | Malicious client can inject `../../../../etc/passwd` as another member's active file; displayed in every connected member's presence panel tooltip |
| `src/host/SessionHost.ts:310-348` | CR-03: No host-side body length cap — client bypassing the panel can send unbounded body strings | WARNING | Denial of service; chat-log.json bloat; webview hang on multi-MB markdown render |
| `src/extension.ts:303-310` | CR-04: `onDidChangeViewState` handler not pushed to subscriptions; unread state may persist incorrectly after deactivation | WARNING | Stale `chatPanelIsActive` state between sessions; unread badge may not clear correctly |
| `src/host/SessionHost.ts` (broadcastPush/Revert/BranchCreated) | System events not appended to chat-log.json — SC-3 gap | BLOCKER | Chat timeline never shows push/revert/branch activity; COLLAB-04 requirement not met; CONTEXT.md locked decision violated |

---

### Human Verification Required

#### 1. Live Presence Panel (SC-1)

**Test:** Open two VS Code Extension Development Host windows on separate machines (or same machine with mDNS workaround per backlog 999.1). Host a session on machine A, join from machine B. Open different files on each machine. Check the presence panel on both windows.
**Expected:** Each window shows both members with correct display name, active file basename, and branch. The self-member row shows "(you)" suffix. If branches differ, the $(git-compare) icon appears.
**Why human:** Requires two active VS Code Extension Development Host windows; single-machine UAT blocked by Bonjour service-name collision (backlog 999.1); cross-process WebSocket verification.

#### 2. Chat Panel Send + Code Snippets (SC-2)

**Test:** In a live session, open the chat panel via `versioncon.openChat`. Send a plain text message. Send a message with a fenced code block (` ```ts\nconst x = 1;\n``` `).
**Expected:** Plain text appears immediately in both members' chat panels. Code block renders with TypeScript syntax highlighting (colored keywords). No CSP violation in the VS Code devtools console.
**Why human:** Requires live WebviewPanel rendering; syntax highlight rendering is visual; CSP errors only visible in webview devtools console.

#### 3. Soft Toast on File Overlap (SC-4)

**Test:** Machine A has `src/foo.ts` open. Machine B (host) pushes changes to `src/foo.ts` with message "test push". Observe machine A.
**Expected:** A non-modal information notification appears on machine A reading approximately "B pushed 1 file — affects: foo.ts: 'test push'". The notification has no buttons and auto-dismisses. The activity tree gains a new row with the "— affects you" suffix.
**Why human:** Requires two windows; notification appearance is visual; "non-modal" verification requires seeing the VS Code notification area (not a blocking dialog).

#### 4. Green Flash When No Overlap (SC-5)

**Test:** Machine A does NOT have `src/bar.ts` open. Machine B (host) pushes changes to `src/bar.ts`. Observe machine A's status bar.
**Expected:** Status bar changes to "$(check) VersionCon — no impact (1 file unaffected)" for approximately 5 seconds, then reverts to the normal connected status. No toast appears.
**Why human:** Requires two windows; 5-second timing must be visually confirmed; status bar text verification is visual.

---

## Gaps Summary

**5 blockers identified:**

1. **SC-3 FAILED (BLOCKER):** Push/revert/branch events are never written to chat-log.json as system-kind ChatRecord entries. The CONTEXT.md explicitly locks "the activity timeline IS the chat timeline" and "push, revert, and branch-create events are ALSO appended to chat-log.json as system events." The ActivityLogProvider in the sidebar shows these events correctly, but the chat panel timeline is empty of them. COLLAB-04 is not fully met.

2. **CR-01 (BLOCKER):** Host does not coerce `kind` to `'user'` in the chat-message handler. Any authenticated client can forge `kind:'system'`, `subKind:'push'` records that persist to chat-log.json and replay to all future joiners. Integrity of the chat system event log is compromised.

3. **CR-02 (BLOCKER):** Host does not validate `activeFilePath` in the presence-update handler. Path traversal strings (`../../../../etc/passwd`) will be stored in PresenceMap and displayed in every connected member's presence panel tooltip. This is both a spoofing and information-disclosure vector.

4. **CR-03 (WARNING):** Host-side body length cap is missing from the chat-message handler. Only the client UI enforces 64KB. A malicious or modified client can send arbitrarily large bodies that bloat chat-log.json and potentially hang the webview renderer on replay.

5. **CR-04 (WARNING):** The `onDidChangeViewState` handler set via `ChatPanel.currentPanel?.onDidChangeViewState(...)` in extension.ts is not pushed to `context.subscriptions`. The unread-count clearing logic is not lifecycle-managed and may leave stale state between sessions.

**SC-1, SC-2, SC-4, SC-5** have full code-level wiring in place and require multi-window UAT for confirmation. Per the verifier note, these should be classified as `human_needed` items rather than `gaps_found` if the code-level wiring is verifiably in place — and it is. The gaps above are the genuinely unimplemented or insecure items.

---

_Verified: 2026-05-07T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
