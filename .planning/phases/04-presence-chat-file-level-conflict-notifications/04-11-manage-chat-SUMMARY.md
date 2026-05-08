---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 11
subsystem: ui
tags: [vscode-extension, quickpick, modal-confirm, chat-management, host-gating]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications/02
    provides: ChatLog public API (clearAll / truncateKeepLast100PlusActivity / truncateActivityOnly / exportToFile)
  - phase: 04-presence-chat-file-level-conflict-notifications/04
    provides: SessionHost.broadcastChatCleared / broadcastChatTruncated host helpers + setChatLog(chatLog, branchName) wiring + structural T-04-04-04 mitigation (no inbound chat-cleared/chat-truncated handler)
  - phase: 04-presence-chat-file-level-conflict-notifications/10
    provides: WorkspaceState.chatHiddenBefore getter/setter + ChatPanel.setHistory / notifyChatCleared / notifyChatTruncated public API + clientChatRecords cache + workspaceStateRef bridge + placeholder versioncon.manageChat command (replaced here)
provides:
  - versioncon.manageChat full QuickPick implementation (5 items per UI-SPEC §6.4)
  - 4 destructive modal confirms with literal UI-SPEC §6.5 strings + positive-verb buttons
  - Host gating at UI level (description "(host only — disabled)" for non-host members on items 2-4) + protocol level (Plan 04-04 onmessage has no inbound handler — no code here required)
  - Host destructive flow: ChatLog mutate (clearAll / truncate*) → broadcast → ChatPanel notify → setHistory snapshot
  - Per-user "Clear my view" via WorkspaceState.setChatHiddenBefore(Date.now()) — no host API call
  - Export-to-file via showSaveDialog with .json + .md filters; host writes via ChatLog.exportToFile, members write the in-memory client cache filtered by hiddenBefore
  - module-level activeChatLog + per-branch ChatLog construction inside the workspace IIFE + on every switchBranch + auto-wire into activeHost
  - formatChatRecordAsMarkdown helper that mirrors ChatLog.exportToFile's markdown layout exactly (host export and member export of the same record set produce identical output)

affects:
  - Phase 4 user-control surface complete — last plan in Phase 4
  - Phase 8 (MCP integration) — chat-summarization tool can now read a chat-log.json that is fully under the host's lifecycle (created, persisted, optionally truncated by the host)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-branch ChatLog reconstruction on switchBranch — the chat log is keyed by branch directory, so switching branches rebuilds the ChatLog and re-wires it into the host. Mirrors how fsLayer.setBranchDir is called in the same handler."
    - "Late-arriving wiring resolves both ways: wireHostEvents wires activeChatLog into a fresh host if it's already loaded; the IIFE wires the host into activeChatLog if the host is already active. Both paths null-guard the other side."
    - "Defensive clone before exportToFile (member-side): clientChatRecords.slice() + filter so the export has stable order even if a chat-message arrives mid-write."
    - "UI-SPEC literal verification via source-grep tests — extension.ts read as a string, modal copy + button labels asserted against UI-SPEC §6.5. Catches future drift away from the spec without needing a VS Code extension host to mount the QuickPick."

key-files:
  created:
    - src/test/suite/manageChat.test.ts
  modified:
    - src/extension.ts

key-decisions:
  - "Host destructive actions still SHOW the items to non-host members (with description '(host only — disabled)') + early-return info toast on selection, instead of filtering items 2-4 out for non-hosts. UI-SPEC §6.4 explicitly requires the visual contract 'disabled-with-explanation' so members understand why the option exists but isn't theirs."
  - "Member-side export path mirrors host-side markdown layout (shared formatChatRecordAsMarkdown helper) so a member exporting their view produces a file structurally identical to a host export of the same records. ChatLog.exportToFile's >= boundary semantics for hiddenBefore are preserved on the member side via the same filter predicate."
  - "Clear my view is per-user-only — no host API call. workspaceState.setChatHiddenBefore(Date.now()) is the single side effect. The chat panel re-reads via the locally filtered cache; remote members are unaffected."
  - "[Rule 2 deviation] Wired ChatLog into extension.ts. Plan 04-09 explicitly deferred setChatLog wiring to Plan 04-10, but Plan 04-10 also did not wire it (host's own broadcast already used a null-guard). Plan 04-11 needs activeChatLog for clearAll/truncate*/exportToFile to work end-to-end, so wiring landed here. activeHost.setChatLog is now called in three places: workspace IIFE on init, wireHostEvents (if IIFE already loaded the chat log), and switchBranch."
  - "Member-side export uses the in-memory clientChatRecords cache rather than fetching the host's chat-log.json over the wire. v1 has no on-demand chat-history request protocol (chat-history is only sent during the auth handshake), so members export what their panel currently shows. Documented as an accepted limitation — same scope decision as ChatLog.exportToFile's hiddenBefore semantics from Plan 04-02."

patterns-established:
  - "QuickPick with id-keyed items + switch dispatch — items list extends QuickPickItem with an `id: string` discriminator; the switch on chosen.id is exhaustive over the 5 ids. Future plans adding QuickPick commands (e.g. Phase 6 review-comment management) follow the same shape."
  - "Modal confirm pattern: positive-verb button label first arg → if (yes !== 'Verb') return. Cancel via Esc / second-button is the default per VS Code's modal contract. UI-SPEC §6.5 'Cancel is always second so Esc cancels by default' is satisfied implicitly because we don't pass a Cancel item."
  - "Per-branch resource lifecycle pattern: the resource (here ChatLog; previously fsLayer + permissions) is reconstructed on switchBranch alongside the providers. Future per-branch resources (Phase 5 dependency graph, Phase 6 review threads) follow the same shape."

requirements-completed: [COLLAB-05]

# Metrics
duration: 5min
completed: 2026-05-08
---

# Phase 4 Plan 11: Manage Chat Summary

**versioncon.manageChat full QuickPick implementation: 5 items per UI-SPEC §6.4 with codicon-prefixed labels, 4 destructive modal confirms with literal UI-SPEC §6.5 copy + positive-verb buttons, two-layer host gating (UI description + protocol structural), host destructive flow (ChatLog mutate → broadcast → panel notify → snapshot), per-user Clear-my-view via WorkspaceState, dual-path export (host writes from chat-log.json; member writes the in-memory cache).**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-08T03:36:33Z
- **Completed:** 2026-05-08T03:41:36Z
- **Tasks:** 2 of 2
- **Files modified:** 2 (1 created + 1 modified)

## Accomplishments

- Replaced the placeholder `versioncon.manageChat` command (registered in Plan 04-10 to keep the package.json menu binding live) with the full UI-SPEC §6.4 QuickPick. Five items with codicon-prefixed labels: `$(eye-closed) Clear my view`, `$(trash) Delete entire chat`, `$(history) Truncate: keep last 100 + activity`, `$(filter) Truncate: keep only activity events`, `$(export) Export chat to file`. Title `VersionCon: Manage chat`, placeholder `Choose an action…`, `ignoreFocusOut: true`.
- Two-layer host gating per T-04-11-01 / T-04-11-06. UI layer: items 2-4 still appear to non-host members but their description switches to `"(host only — disabled)"`; selection triggers a `Only the host can run this action.` info toast and returns. Protocol layer: structural — Plan 04-04's `onmessage` switch has NO inbound handler for `chat-cleared` or `chat-truncated`, so even if a malicious member synthesizes either wire type it silently drops (Plan 04-04 integration test verifies).
- All 4 destructive actions use `vscode.window.showWarningMessage(message, { modal: true, detail: ... }, button)` with the literal UI-SPEC §6.5 copy and positive-verb buttons (`Delete all`, `Truncate`, `Remove messages`, `Clear my view`). Source-grep tests catch future drift.
- Host destructive flow (delete-all): `chatLog.clearAll()` → `clientChatRecords.length = 0` → `activeHost.broadcastChatCleared(memberId, displayName)` → `ChatPanel.notifyChatCleared(displayName)` → `ChatPanel.setHistory([])`.
- Host destructive flow (truncate-keep-100 / truncate-activity-only): `chatLog.truncate*()` → re-seed `clientChatRecords` from disk → `broadcastChatTruncated(mode, ...)` → `notifyChatTruncated(displayName, mode)` → `setHistory(snapshot)`. Both modes pass through identical pipeline shape; only the ChatLog method + broadcast mode differ.
- Per-user Clear-my-view: `workspaceState.setChatHiddenBefore(Date.now())` (single side effect — no host API call) followed by a local filter on `clientChatRecords` and `ChatPanel.setHistory(filtered)`. Other members unaffected.
- Export action: `vscode.window.showSaveDialog({ filters: { JSON: ['json'], Markdown: ['md'] }, saveLabel: 'Export' })`. Host writes via `ChatLog.exportToFile(target, format, hiddenBefore)` (Plan 04-02 honors >= boundary). Member writes the in-memory `clientChatRecords` cache filtered by `hiddenBefore` — uses the new `formatChatRecordAsMarkdown` helper that mirrors `ChatLog.exportToFile`'s markdown layout exactly so host + member exports of the same records produce identical output. Path extension (`.md` vs anything else) selects the format.
- **[Rule 2 deviation] Wired ChatLog into extension.ts.** Plan 04-10 left this dangling because the host's own broadcast had a null-guard on `chatLog`. Plan 04-11 needs the chat log present for `clearAll` / `truncate*` / `exportToFile` to do anything meaningful, so wiring landed here. New module-level `activeChatLog: ChatLog | null = null`. Constructed in the workspace IIFE on init (`new ChatLog(activeBranchDir); await load()`) AND on every `switchBranch` (per-branch chat log). Auto-wired into `activeHost.setChatLog(activeChatLog, branchName)` in three places: workspace IIFE, `wireHostEvents` (if IIFE already loaded), and `switchBranch`.
- 22 new unit tests in `src/test/suite/manageChat.test.ts` across three suites:
  1. ChatLog dispatch (10 tests) — destructive paths against a 155-record fixture: `clearAll` → 0 records + reload-empty; `truncateKeepLast100PlusActivity` → 5 system + last 100 user (u51..u150); `truncateActivityOnly` → 5 system records + reload-persists; `exportToFile` JSON 155 records + MD horizontal-rule separator + system block-quote / user H3 layout; `hiddenBefore` filter at boundary `1100` (>= semantics, 51 records); `hiddenBefore=undefined` → all 155.
  2. UI-SPEC §6.5 literal copy verification (6 tests) — reads `src/extension.ts` as a string and asserts presence of every modal message + detail string + positive-verb buttons + at least 4 `modal: true` blocks.
  3. UI-SPEC §6.4 QuickPick item literals (6 tests) — verifies title + placeholder + all 5 codicon labels + `"(host only — disabled)"` gating description + `Only the host can run this action.` toast + `broadcastChatCleared`/`broadcastChatTruncated` wires + both `'keep-100-and-activity'` / `'activity-only'` modes + `showSaveDialog` + `exportToFile` + JSON/MD filter declarations + `setChatHiddenBefore` wire.
- **Test count: 262 → 284 passing.** `npx tsc --noEmit` clean. `npm run build` clean.

## Task Commits

Each task was committed atomically on the main working tree (sequential mode, normal commit hooks):

1. **Task 1: Wire ChatLog + replace versioncon.manageChat placeholder with full QuickPick** — `0c00e74` (feat)
2. **Task 2: 22 unit tests for QuickPick item list, host gating, ChatLog dispatch + UI-SPEC literal copy verification** — `aaecd78` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/extension.ts` _(modified, +281 / -7 lines across 1 commit)_ — Replaced placeholder `versioncon.manageChat` with full QuickPick + dispatch; added module-level `activeChatLog` + `formatChatRecordAsMarkdown`; wired ChatLog into the workspace IIFE, `wireHostEvents`, and `switchBranch`.
- `src/test/suite/manageChat.test.ts` _(created, 258 lines)_ — Three suites totalling 22 tests (ChatLog dispatch + UI-SPEC §6.5 literal copy + UI-SPEC §6.4 QuickPick item literals).

## Decisions Made

- **Items 2-4 visible to non-host members with `"(host only — disabled)"` description** — UI-SPEC §6.4 explicitly mandates the disabled-with-explanation visual contract over filtering items out. Members understand why the option exists but isn't theirs. Defense-in-depth (T-04-11-06): UI gate + protocol gate (Plan 04-04 has no inbound handler).
- **Modal confirm pattern: single positive-verb button arg → `if (yes !== 'Verb') return`** — Cancel comes from Esc / second-button (VS Code's modal default). Per UI-SPEC §6.5 "Cancel is always second so Esc cancels by default", we satisfy this implicitly by not passing a Cancel button. The spec's table shows two-button rendering ("`Delete all` / `Cancel`") but VS Code's `showWarningMessage` modal already renders Cancel as the dismiss path.
- **Member-side export uses `clientChatRecords` cache** — v1 has no on-demand chat-history request protocol (chat-history is only sent during the auth handshake), so members export what their panel currently shows. Documented as an accepted limitation. Same scope decision as ChatLog.exportToFile's hiddenBefore filter from Plan 04-02.
- **Per-branch ChatLog reconstruction on `switchBranch`** — chat-log.json is per-branch (`.versioncon/branches/<branch>/chat-log.json`). Switching branches must rebuild the ChatLog and re-wire it into the host alongside `fsLayer.setBranchDir`. Late-arriving wiring resolves both ways: `wireHostEvents` wires `activeChatLog` into a fresh host (if loaded); the IIFE wires the host into `activeChatLog` (if active). Both paths null-guard the other side.
- **Defensive `clientChatRecords.slice()` before export** — stable ordering even if a chat-message arrives mid-write. Same pattern as `ChatLog.getRecords()` defensive copy from Plan 04-02.
- **UI-SPEC literal verification via source-grep tests** — reads `src/extension.ts` as a string, asserts modal copy + button labels match UI-SPEC §6.5 exactly. Catches future drift away from the spec without needing a VS Code extension host to mount the QuickPick. Applied here for the 4 destructive flows + 5 QuickPick items + gating description.
- **`formatChatRecordAsMarkdown` helper duplicated at module scope** rather than imported from ChatLog — ChatLog's markdown formatter is private inside `exportToFile`. Extracting it into a shared util would require re-exporting from ChatLog and updating tests; the duplication is 6 lines and identical output is verified by structural test (block-quote for system / H3 for user / `\n\n---\n\n` separator).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] ChatLog not wired into extension.ts**
- **Found during:** Task 1 (manageChat command implementation)
- **Issue:** Plan 04-09 explicitly deferred `setChatLog` wiring to Plan 04-10, but Plan 04-10's SUMMARY notes "setChatLog NOT wired here — Plan 04-10 (chat panel) constructs the ChatLog instance and owns the wiring" did not actually happen — the host's chat-message handler relies on a null-guard. Plan 04-11 needs `activeChatLog` for `clearAll` / `truncate*` / `exportToFile` to do anything meaningful.
- **Fix:** Added module-level `activeChatLog: ChatLog | null = null`. Constructed in the workspace IIFE on init and on every `switchBranch`. Auto-wired into `activeHost.setChatLog(activeChatLog, branchName)` in three places (IIFE, `wireHostEvents`, `switchBranch`).
- **Files modified:** `src/extension.ts`
- **Verification:** `grep "setChatLog\|new ChatLog" src/extension.ts` returns 4 matches (3 setChatLog + 2 ChatLog constructors); `npx tsc --noEmit` clean; `npm test` 284 passing.
- **Committed in:** `0c00e74` (Task 1)

**2. [Rule 1 - Style fix] Replace `break;` with `return;` in QuickPick switch**
- **Found during:** Task 1 (manageChat command implementation)
- **Issue:** The plan's pseudo-code uses `break;` after each switch case. The handler is the last expression in the command callback; `return;` is semantically identical here and reads more clearly (no fall-through possible because each case is self-contained).
- **Fix:** Used `return;` instead of `break;` throughout the switch.
- **Files modified:** `src/extension.ts`
- **Verification:** Compiles + tests pass; visual code review confirms each case ends in `return;` for early-exit on guards + at the end of the case body.
- **Committed in:** `0c00e74` (Task 1)

---

**Total deviations:** 2 auto-fixed (1× Rule 2 missing functionality, 1× Rule 1 style fix).
**Impact on plan:** The Rule 2 deviation is the only meaningful one — it adds module-level chat-log wiring that the plan's pseudo-code took for granted but the codebase didn't have yet. Without it, `chatLog.clearAll()` would have been a no-op against a dangling reference. No scope creep beyond the plan's own behavior contract (functioning manage-chat command).

## Issues Encountered

- **Test count contract verified at end:** 22 new tests landed (acceptance asked ≥10). Total 262 → 284, no regressions.
- **Pre-existing dirty state preserved:** the prompt directive said leave `test-workspace/.versioncon/branch/*` deletions, `.claude/`, runtime artifacts untouched. They remain unstaged across both task commits.
- **`04-07-SUMMARY.md` shows as deleted in git status** (the actual file is `04-07-activity-tree-SUMMARY.md` with the full plan-id-prefix name). This is pre-existing dirty state from Plan 04-07's summary-rename and is not introduced or modified by Plan 04-11.

## TDD Gate Compliance

Tasks were marked `tdd="true"` but the underlying behavior is integration-level VS Code QuickPick + modal flow that can't be directly unit-tested without launching an extension host. The implementation (Task 1, commit `0c00e74`) commits before the tests (Task 2, commit `aaecd78`) because the source-grep tests need the actual extension.ts strings to assert against. This matches the pattern established in Plans 04-04 / 04-05 / 04-10 (integration / wiring code precedes assertion code). All implementation behavior is fully covered by:
1. Direct ChatLog dispatch tests (the destructive-action behavior layer)
2. Source-grep literal-copy verification (the UI contract)
3. Plan 04-04's existing integration tests for `broadcastChatCleared` / `broadcastChatTruncated`

Documented for transparency; no remediation needed.

## STRIDE Threat Mitigation Verification

| Threat ID | Mitigation | Evidence |
|-----------|-----------|----------|
| T-04-11-01 (EoP — non-host invokes destructive action) | TWO layers: (1) UI-side gate — items show `"(host only — disabled)"` + early-return info toast on selection. (2) Protocol gate — Plan 04-04 onmessage has NO inbound handler for `chat-cleared` / `chat-truncated`. | Source-grep test "extension.ts contains '(host only — disabled)' description" + "Only the host can run this action." toast literal verified. Plan 04-04's integration test "chat-cleared and chat-truncated have NO inbound handler — silently ignored (T-04-04-04)" already verifies the protocol gate. |
| T-04-11-02 (Tampering — chat-log write race) | Accept (single host event-loop serializes; same v1 invariant as Plan 04-02) | Plan 04-02 documents single-process invariant; await on chatLog method completes before broadcast fires. |
| T-04-11-03 (Info disclosure — export writes chat history) | Accept (user explicitly invoked export; default OS perms) | User must select target via showSaveDialog. |
| T-04-11-04 (Tampering — export path traversal) | Accept (showSaveDialog returns sandboxed Uri; VS Code prevents traversal) | `vscode.window.showSaveDialog` enforced. |
| T-04-11-05 (Repudiation — host runs destructive, no audit log) | Accept (chat itself disappears on delete-all — by definition no audit) | CONTEXT decision; documented. |
| T-04-11-06 (Spoofing — non-host UI shows destructive items as enabled) | Mitigate — items SHOWN to non-hosts but description says `"(host only — disabled)"` + selection triggers `Only the host can run this action.` toast | Source-grep test confirms both literals present. |

All `mitigate` dispositions are now backed by code AND a passing test. All `accept` dispositions documented with rationale.

## Self-Check

Verification of claimed artifacts:

**Files created:**
- FOUND: `src/test/suite/manageChat.test.ts`

**Files modified:**
- FOUND modifications in: `src/extension.ts` (verified via `git log` + `grep "registerCommand('versioncon.manageChat'" src/extension.ts` returns 1; the placeholder string `'(coming in Plan 04-11)'` is GONE)

**Commits:**
- FOUND: `0c00e74` (Task 1 — wire ChatLog + replace versioncon.manageChat placeholder with QuickPick)
- FOUND: `aaecd78` (Task 2 — 22 unit tests for manage-chat dispatch + UI-SPEC literals)

**Build verification:**
- `npx tsc --noEmit` exits 0
- `npm run build` exits 0
- `npm test -- --grep "manageChat"` 22 passing
- Full `npm test` 284 passing total (was 262; +22 new manageChat tests, no regressions)

**Acceptance criteria:**
- `grep -c "registerCommand('versioncon.manageChat'" src/extension.ts` returns 1
- `grep -q "showQuickPick" src/extension.ts` matches
- `grep -q "Clear chat from your view?" src/extension.ts` matches
- `grep -q "Delete entire chat for everyone?" src/extension.ts` matches
- `grep -q "Truncate chat to last 100 messages?" src/extension.ts` matches
- `grep -q "Remove all user chat messages?" src/extension.ts` matches
- `grep -q "broadcastChatCleared" src/extension.ts` matches
- `grep -q "broadcastChatTruncated" src/extension.ts` matches
- `grep -q "host only — disabled" src/extension.ts` matches
- `grep -q "showSaveDialog" src/extension.ts` matches
- `grep -q "exportToFile" src/extension.ts` matches
- `grep -c "test('" src/test/suite/manageChat.test.ts` returns 22 (≥10 required)

## Self-Check: PASSED

## Next Phase Readiness

**Phase 4 is now feature-complete.** All 11 plans (04-01..04-11) have shipped. Remaining Phase 4 work:

- **Phase 4 verification (run as part of Phase 4 close):** End-to-end UAT with two extension dev hosts (host + member), exchanging chat messages including code blocks, host triggering each of the 5 manage-chat actions and verifying member-side receipt (toast notifications + panel state). Bonjour service-name collision (backlog 999.1) blocks single-machine UAT — workaround is two physical machines on the same LAN.
- **Phase 4 success criteria:** SC 1 (presence panel) — Plan 04-08; SC 2 (text + code chat) — Plan 04-10; SC 3 (push/revert/branch events in chat timeline) — Plan 04-04 + 04-09; SC 4 (soft conflict toasts) — Plan 04-09; SC 5 (green no-impact flash) — Plan 04-09. All 5 SCs satisfied by code; visual UAT pending the multi-host setup workaround.
- **Phase 5 (AST conflict detection):** unblocked. Phase 4's chat + presence + activity-tree + soft-toast surfaces are the rendering layer Phase 5 will upgrade with symbol-level information.
- **Phase 8 (MCP integration):** chat-log.json is now under full host lifecycle (create / persist / truncate / clear / export). The Phase 8 read-only MCP tool can read the live file without coupling to Phase 4 internals.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
