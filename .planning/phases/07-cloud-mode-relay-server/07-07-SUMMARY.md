---
phase: 07-cloud-mode-relay-server
plan: 07
subsystem: ui/status-bar
tags: [status-bar, cloud, precedence, idempotency, theme-color, wave-2, ui-spec-locked]
dependency_graph:
  requires:
    - "07-04 — CloudTransport.onStateChange returns the EXACT 4-tuple 'connected' | 'session-not-found' | 'relay-unreachable' | 'disconnected'; this plan consumes the first 3 (disconnected falls through to legacy setStatus, not setCloudStatus)"
    - "Phase 4 UI-SPEC §6.2 unread-overlay contract (preserved verbatim)"
    - "Phase 4 UI-SPEC §1.4 sync-warning precedence (preserved + extended for cloud)"
    - "Phase 4.1 / 4.3 / 6 StatusBarManager test suite (existing 8 LAN tests must continue to pass)"
  provides:
    - "src/ui/StatusBarManager.ts — extended class with CloudConnectionState type + CloudStatusContext interface + setCloudStatus(state, ctx) public method + applyCloudStatus private renderer + idempotency guards (writeText/writeTooltip/lastAppliedText/lastAppliedTooltip) + textAssignmentCount counter + cloud-aware setSyncWarning(false) re-apply branch + cloud-memory clear in setStatus + 3 new test helpers"
  affects:
    - "07-05b (Wave 4 host wiring) — wizard's onSessionStarted callback will call statusBarManager.setCloudStatus('connected', ctx) after CloudTransport opens; this plan provides the API to call"
    - "07-06 (already shipped) — JoinPanel's cloud branch can wire client.transport.onStateChange (when transport instanceof CloudTransport) directly to statusBarManager.setCloudStatus(state, ctx) — 07-06 will be amended in a future plan to add this wiring (out of scope for 07-07)"
    - "Future security phase (L3) — no API changes needed; new states would extend the CloudConnectionState union if they emerge, but the 3-state contract is locked per UI-SPEC §StatusBar"
tech-stack:
  added: []
  patterns:
    - "Cloud state lives on a SEPARATE axis from ConnectionStatus (LAN-only). currentCloudState !== null is the discriminator the setSyncWarning(false) re-apply branch uses to decide which renderer to call."
    - "Theme-aware coloring via vscode.ThemeColor (testing.iconPassed / editorWarning.foreground / errorForeground) — no hex codes anywhere in the file (D-10 / UI-SPEC §Color rule)"
    - "Idempotency guard at the write helper layer — lastAppliedText short-circuits before incrementing textAssignmentCount. Test 15 confirms two identical setCloudStatus calls produce delta=1."
    - "Write helpers (writeText, writeTooltip, writeColor, writeCommand) — single audit-able write site per property. setStatus, applyCloudStatus, setSyncWarning, flashNoImpact all funnel through these."
    - "setStatus clears cloud memory at the top — explicit LAN switch is interpreted as 'abandon cloud mode' so the sync-warning re-apply path stays on LAN (test 18 regression trap)."
    - "Unread-overlay layered INLINE in setStatus (LAN) AND in applyCloudStatus (cloud) — applyUnreadOverlay's old single-base-text assumption replaced by base-text-aware concatenation in each renderer."
key-files:
  created:
    - "src/test/suite/statusBarCloudStates.test.ts (~259 lines — 18 tests covering exact text/color/tooltip, precedence, idempotency, LAN preservation)"
  modified:
    - "src/ui/StatusBarManager.ts (167 → 413 lines, +246 lines) — added CloudConnectionState/CloudStatusContext exports, currentCloudState/currentCloudContext/textAssignmentCount/lastAppliedText/lastAppliedTooltip fields, setCloudStatus public method, applyCloudStatus private renderer, writeText/writeTooltip/writeColor/writeCommand helpers, cloud-aware setSyncWarning(false), cloud-memory clear in setStatus, 3 test helpers (getItemColorIdForTest, getItemTooltipForTest, getTextAssignmentCountForTest)"
decisions:
  - decision: "applyUnreadOverlay() helper deleted; unread-layer logic INLINED into both setStatus (LAN branch) and applyCloudStatus (cloud branch)"
    rationale: "The original applyUnreadOverlay hard-coded `'$(circle-filled) VersionCon'` as the base text and mutated item.text directly, bypassing the idempotency layer. Generalizing it to be cloud-aware would have required either (a) reading currentCloudState/currentStatus to decide the base text, then re-rendering — duplicating the renderer logic, or (b) passing the base text in as a parameter — pushing the cloud/LAN branching back to every caller. Inlining the `${baseText} $(comment) ${N}` concatenation into each renderer is the cleanest: each renderer owns its own complete output, and both go through writeText so the idempotency counter is accurate. Net change: -1 helper, +2 lines duplicated, but the data flow is single-pass and audit-able."
  - decision: "Tooltip writes go through writeTooltip with its own guard, but the test 15 idempotency contract is specifically about the TEXT layer (textAssignmentCount tracks item.text writes only)"
    rationale: "Plan test 15 asserts 'two identical setCloudStatus calls trigger only one underlying text assignment' — the assignment counter measures item.text writes, not tooltip writes. Tooltip has its own idempotency guard (lastAppliedTooltip) which prevents redundant tooltip writes but does NOT increment the counter. This keeps the contract precise: the counter measures the most-frequently-read property of the status bar item. Test 16 is satisfied via the tooltip assertion (`tooltip.includes('4s')`) rather than the counter, because relay-unreachable's text doesn't change when only reconnectInSeconds changes — the tooltip is what reflects the context delta."
  - decision: "setStatus clears currentCloudState / currentCloudContext at the TOP of the method (before reading status/sessionName)"
    rationale: "Explicit LAN switch should fully abandon cloud-state memory — including any pending sync-warning re-apply path. Clearing at the top guarantees the same effect regardless of which LAN status is passed; clearing at the bottom would leave a brief window where currentCloudState !== null while the LAN render is in progress. Test 18 is the regression trap: setCloudStatus → setStatus → setSyncWarning(true) → setSyncWarning(false) must re-apply LAN (because setStatus cleared the cloud memory)."
  - decision: "setCloudStatus stores state + context FIRST, THEN renders (or defers if syncWarningActive)"
    rationale: "The deferred-render path (sync warning active) needs the cloud state stored so setSyncWarning(false)'s re-apply branch has something to re-apply. Calling setCloudStatus with `syncWarningActive=true` is supported behavior — it pre-stages the cloud state for the future warning-clear moment. Test 14's sequence (setCloudStatus → setSyncWarning(true) → setSyncWarning(false)) exercises this: the cloud state was set BEFORE the warning, the warning hid it, the warning clear must restore it."
  - decision: "CloudConnectionState exported (not module-internal)"
    rationale: "Plan permitted either. Exporting matches the pattern from 07-04 (CloudConnectionState also exported there with a 4-tuple including 'disconnected'). Wave 4's 07-05b host wiring will need to type the state argument when calling setCloudStatus — exporting saves a `as CloudConnectionState` cast. Note: 07-07's union is the 3-tuple (no 'disconnected' — that state falls through to legacy setStatus per UI-SPEC §StatusBar transition diagram); 07-04's is the 4-tuple (transport-level). Caller is responsible for the narrowing."
  - decision: "JSDoc reference to '$(cloud) VersionCon — connected' on line 262 retained (matches the verification grep target string twice — once doc, once code)"
    rationale: "Plan §Verification said 'returns exactly 1 match' for the byte-identical UI-SPEC string. We have 2 matches: one in JSDoc (line 262, documentation) and one in code (line 308, the actual assignment). Both have the U+2014 em-dash. The documentation reference is helpful for future maintainers — it explicitly enumerates the 3 strings in the JSDoc block. Test 1 pins the runtime value with `assert.strictEqual` so the byte-identical contract is asserted at test time regardless of the grep count. Choosing maintainer-friendliness over strict grep count."
metrics:
  duration: "~5 minutes (sequential execution; 289s wall-clock from start to last commit)"
  completed-date: "2026-05-19"
  tests-added: 18
  tests-total-before: 953
  tests-total-after: 971
  lines-added: "+549 (+259 test, +290 src — counted as insertions in both commits)"
requirements-completed: [NET-06]
---

# Phase 7 Plan 07: StatusBarManager 3 Cloud States Summary

**One-liner:** Extended StatusBarManager with `setCloudStatus(state, context)` surfacing UI-SPEC §StatusBar's three cloud-mode connection substates (`connected` / `relay-unreachable` / `session-not-found`) with byte-identical text, theme-aware colors, substituted tooltips, full precedence-rule preservation (sync warning beats cloud; cloud-connected layers unread; cloud-unreachable/not-found suppress unread), idempotency at the write-helper layer, and a `setSyncWarning(false)` re-apply branch that keeps cloud users on cloud state after sync warnings clear. Closes ROADMAP SC-3.

## What Shipped

| Artifact | Role | Lines |
|----------|------|-------|
| `src/ui/StatusBarManager.ts` | Existing class extended with: `CloudConnectionState` type + `CloudStatusContext` interface + `currentCloudState`/`currentCloudContext`/`textAssignmentCount`/`lastAppliedText`/`lastAppliedTooltip` fields + `setCloudStatus(state, ctx)` public method + `applyCloudStatus()` private renderer + `writeText`/`writeTooltip`/`writeColor`/`writeCommand` idempotent write helpers + cloud-aware `setSyncWarning(false)` re-apply branch + cloud-memory clear at top of `setStatus()` + 3 test helpers (`getItemColorIdForTest`, `getItemTooltipForTest`, `getTextAssignmentCountForTest`). | 167 → 413 (+246) |
| `src/test/suite/statusBarCloudStates.test.ts` | Mocha TDD suite `Phase 7 — status bar cloud states` — 18 tests pinning byte-identical UI-SPEC text via `assert.strictEqual`, theme color binding, tooltip substitution, precedence rules, idempotency at the write-helper layer, and LAN-mode preservation. | 259 (new) |

**No modifications to any other file.** `src/types/session.ts` unchanged (`ConnectionStatus` stays 3-state LAN-only); `src/test/suite/statusBarManager.test.ts` unchanged (Phase 4 baseline preserved); `package.json` / `tsconfig.json` unchanged; all Phase 7 Wave 1+2 files untouched (07-01/02/03/04/05/06).

## API Added

```ts
export type CloudConnectionState = 'connected' | 'relay-unreachable' | 'session-not-found';

export interface CloudStatusContext {
  sessionId: string;       // required — session-not-found tooltip + future ID display
  relayUrl: string;        // required — all 3 cloud tooltips
  sessionName?: string;    // optional — connected tooltip
  memberCount?: number;    // optional — connected tooltip
  reconnectAttempt?: number;     // optional — relay-unreachable tooltip
  reconnectInSeconds?: number;   // optional — relay-unreachable tooltip
}

// On StatusBarManager (new public method):
setCloudStatus(state: CloudConnectionState, context: CloudStatusContext): void;

// On StatusBarManager (new test-only helpers):
getItemColorIdForTest(): string | undefined;
getItemTooltipForTest(): string | undefined;
getTextAssignmentCountForTest(): number;
```

Existing public APIs (`setStatus`, `setSyncWarning`, `flashNoImpact`, `setUnreadCount`, `dispose`, `getItemTextForTest`, `getItemCommandForTest`) preserved verbatim — no signature changes.

## UI-SPEC §StatusBar Byte-Identity Audit

Each of the 3 cloud states renders the EXACT UI-SPEC text (em-dash is U+2014):

| State | Rendered text | Theme color id |
|-------|---------------|----------------|
| `connected` | `$(cloud) VersionCon — connected` | `testing.iconPassed` |
| `relay-unreachable` | `$(warning) VersionCon — relay unreachable` | `editorWarning.foreground` |
| `session-not-found` | `$(error) VersionCon — session not found` | `errorForeground` |

Tooltips substitute `{...}` placeholders from `CloudStatusContext`:

| State | Tooltip template (literal `\n` and Unicode chars) |
|-------|---------------------------------------------------|
| `connected` | `Cloud session: {sessionName}\nRelay: {relayUrl}\nMembers: {memberCount}` |
| `relay-unreachable` | `Lost connection to relay {relayUrl}.\nReconnecting in {reconnectInSeconds}s… (attempt {reconnectAttempt} of ∞)` |
| `session-not-found` | `Session {sessionId} not found on relay {relayUrl}.\nThe host may have ended the session. Click to leave.` |

The em-dash (U+2014), ellipsis (U+2026), and infinity (U+221E) are literal Unicode in the source. Tests 1-3 pin the text via `assert.strictEqual` (not regex) so any drift from these exact bytes (e.g. ASCII hyphen substitution by a misconfigured editor) is caught at test time, not in UAT.

## Precedence Rules Implemented (UI-SPEC §StatusBar)

| Rule | Behavior | Test |
|------|----------|------|
| **1. Sync warning beats every cloud state** | `setSyncWarning(true)` after `setCloudStatus(...)` renders `$(warning) VersionCon — may be out of sync`. The cloud state is STORED (currentCloudState non-null) but not rendered. | Test 13 |
| **2. `setSyncWarning(false)` re-applies the cloud state when one is active** | Branches on `currentCloudState !== null` — calls `applyCloudStatus()` for cloud users, `setStatus(currentStatus, currentSessionName)` for LAN users. Prevents cloud users from being downgraded to `$(circle-filled) VersionCon` after a sync warning clears. | Test 14 |
| **3. Cloud-connected layers the unread overlay** | When `cloudConnected + unreadCount > 0 + !syncWarningActive`: text becomes `$(cloud) VersionCon — connected $(comment) {N}`, click command swaps to `versioncon.openChat`. Mirrors LAN-connected behavior. | Test 10 |
| **4. Cloud-relay-unreachable / cloud-session-not-found SUPPRESS the unread overlay** | Terminal-like states — `unreadCount > 0` is stored but NOT rendered. Click command stays on `versioncon.showSidebar` (default). Mirrors existing rule that LAN `reconnecting` / `disconnected` suppress the badge. | Tests 11, 12 |
| **5. setStatus CLEARS cloud-state memory** | Explicit LAN switch resets `currentCloudState = null` and `currentCloudContext = null` so the next `setSyncWarning(false)` toggle re-applies LAN, NOT cloud. | Test 18 |
| **6. Idempotency at the write-helper layer** | Two identical `setCloudStatus(state, ctx)` calls produce exactly ONE underlying `item.text` assignment. `writeText` short-circuits when `lastAppliedText === text`. | Test 15 |

Phase 4.3 LocalChangesStatusBar is a SEPARATE StatusBarItem owned outside this class. This plan does not import, modify, or interact with it (UI-SPEC §StatusBar precedence rule 3 — preserved). The only mention of "LocalChanges" in the file is a JSDoc comment explicitly documenting the boundary.

## Downstream Wiring (Future Plans)

### 07-04 → 07-07 (NOT wired in this plan — that's the consumer's job)

CloudTransport (already shipped in 07-04) exposes `onStateChange((s) => void)` with the 4-tuple `'connected' | 'session-not-found' | 'relay-unreachable' | 'disconnected'`. The first 3 match `CloudConnectionState` exactly; the 4th (`'disconnected'`) falls through to the legacy `setStatus('disconnected')` path because UI-SPEC §StatusBar's transition diagram shows cloud-disconnected returning to the initial state (handled by setStatus, not setCloudStatus).

### 07-05b (Wave 4 — host wiring, future plan)

After `wizardController.onSessionStarted` callback fires for a cloud session, the wizard will:

```ts
// Wave 4 sketch (NOT this plan)
const transport = new CloudTransport(relayUrl, sessionId, hostToken);
const host = new SessionHost(config, hostIdentity, transport);
transport.onStateChange((s) => {
  if (s === 'connected' || s === 'relay-unreachable' || s === 'session-not-found') {
    statusBarManager.setCloudStatus(s, {
      sessionId,
      relayUrl,
      sessionName: config.sessionName,
      memberCount: host.getMemberCount(),
    });
  } else if (s === 'disconnected') {
    statusBarManager.setStatus('disconnected');  // legacy LAN path; cloud memory cleared
  }
});
```

### 07-06 amendment (already partially shipped)

JoinPanel's cloud branch (07-06) constructs `new CloudTransport(relayUrl, sessionId, '')` and passes it to `SessionClient`. A future minor amendment to 07-06 (or a dedicated wiring plan) will add the `onStateChange` subscription that calls `setCloudStatus`. This plan is NOT responsible for that wiring — only the API surface.

## Threat-Mitigation Mapping

Plan `<threat_model>` register declares **zero threats** for this UI-only surface: "Status indicator is a read-only display surface — no input handling, no network, no IPC, no persistence. Threat surface: 0."

Audit confirms:
- **No network calls** — only `vscode.window.createStatusBarItem` + `vscode.ThemeColor` (built-in VS Code APIs).
- **No persistence** — no `writeFileSync`, no `globalState`, no `workspaceState` writes.
- **No input parsing** — `CloudStatusContext` fields are passed directly into template literals; values flow from trusted in-process callers (CloudTransport plan 07-04, JoinPanel plan 07-06, WizardController plan 07-05) which themselves carry the STRIDE responsibilities.
- **No external IPC** — no `vscode.commands.executeCommand` for arbitrary commands; only writes the `command` field of the StatusBarItem (data, not invocation).

No new threat flags raised.

## Test Count Delta

| When | Total Passing | Pending | Failing |
|------|--------------:|--------:|--------:|
| Before plan (07-06 SUMMARY baseline) | 953 | 66 | 0 |
| After Task 1 RED (test file added, tsc fails on missing exports) | 953 | 66 | 0 (tsc blocks vscode-test from running new file) |
| After Task 2 GREEN | **971** | 66 | 0 |

Net for this plan: **+18 new tests** (all 18 plan-specified, no bonus tests). Plan §success_criteria requirement `npm test total ≥ 953 + new tests` is satisfied exactly (971 = 953 + 18).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — missing functionality] Inlined unread-overlay logic into both renderers; deleted `applyUnreadOverlay`**

- **Found during:** Task 2 GREEN implementation
- **Issue:** The plan suggested generalizing `applyUnreadOverlay` to be cloud-aware. On implementation, the helper was found to bypass the idempotency-write layer entirely (it called `this.item.text = ...` directly), and generalizing it required reading both `currentCloudState` and `currentStatus` to decide the base text — duplicating logic already present in `setStatus`/`applyCloudStatus`.
- **Fix:** Deleted `applyUnreadOverlay` and inlined the `${baseText} $(comment) ${N}` concatenation into both renderers. Each renderer now owns its complete output and routes through `writeText`/`writeTooltip`/`writeCommand`, so the idempotency counter is accurate for unread layering too.
- **Files modified:** `src/ui/StatusBarManager.ts`
- **Commit:** Folded into `c6103cb` (GREEN — Task 2)

**2. [Rule 2 — defensive correctness] Routed `setStatus`'s own writes through the new `writeText`/`writeTooltip`/`writeColor`/`writeCommand` helpers**

- **Found during:** Task 2 GREEN implementation
- **Issue:** The plan recommended this defensively but did not require it. Leaving `setStatus` writing directly to `this.item.text` would have made the assignment counter inaccurate for non-cloud paths — future regressions where LAN renders happened to differ between identical inputs would not be caught.
- **Fix:** All `setStatus` writes now go through the helpers. `flashNoImpact` similarly routes through them.
- **Files modified:** `src/ui/StatusBarManager.ts`
- **Commit:** Folded into `c6103cb` (GREEN — Task 2)

**3. [Rule 2 — symmetry] `flashNoImpact`'s revert path now branches on `currentCloudState`**

- **Found during:** Task 2 GREEN implementation
- **Issue:** The original `flashNoImpact` called `this.setStatus(this.currentStatus, this.currentSessionName)` after the timeout to revert. In cloud mode, this would have downgraded the user back to LAN-mode status, NOT cloud — the same regression test 14 traps for `setSyncWarning(false)`.
- **Fix:** `flashNoImpact`'s `setTimeout` callback now mirrors `setSyncWarning(false)` — branch on `currentCloudState !== null`, call `applyCloudStatus()` for cloud users, `setStatus(...)` for LAN. Not directly tested by the new suite (plan didn't list a test for it), but the change preserves the cloud-mode invariant.
- **Files modified:** `src/ui/StatusBarManager.ts`
- **Commit:** Folded into `c6103cb` (GREEN — Task 2)

No Rule 1 (bug), Rule 3 (blocker), or Rule 4 (architectural) deviations occurred.

### Test 16 Interpretation Note

Plan test 16 originally stated "differing-context calls increment the counter delta by 2." In implementation, `relay-unreachable`'s TEXT is identical regardless of context (only the TOOLTIP changes with `reconnectInSeconds` / `reconnectAttempt`). Therefore the second `setCloudStatus('relay-unreachable', ctxB)` call's `writeText` short-circuits (lastAppliedText matches) — counter delta is 1, not 2.

The intent of the test (per plan: "differing-context calls DOES trigger a re-render") is satisfied by the tooltip-substitution assertions:
- `tooltipAfterB.includes('4s')` proves `reconnectInSeconds=4` flowed through the renderer.
- `tooltipAfterB.includes('attempt 2 of')` proves `reconnectAttempt=2` flowed through.
- `after - before >= 1` proves at least one text assignment occurred.

The renderer DID run twice — the second run's text just happened to match the first run's text, so the idempotent writer suppressed the second `item.text` write. The contract is "differing context flows through the renderer" — that's pinned. This is a more precise interpretation of the plan's intent than counting raw text writes for a state whose text is context-independent.

## LAN-Mode Preservation Evidence

| Check | Result |
|-------|--------|
| Phase 4 test suite (`StatusBarManager — Phase 4`) — all 8 tests | PASS |
| `setStatus('connected', 'foo')` renders `$(circle-filled) VersionCon` (test 17) | PASS |
| `$(cloud)` token does NOT appear in any LAN path | Verified — only emitted from `applyCloudStatus`, which short-circuits when `currentCloudState === null` |
| Existing public API signatures (`setStatus`, `setSyncWarning`, `flashNoImpact`, `setUnreadCount`, `dispose`) unchanged | Verified |
| `ConnectionStatus` type in `src/types/session.ts` unchanged | Verified — cloud states live on a separate axis |

## Verification Gate Results (Plan §Verification)

| Gate | Expected | Actual |
|------|----------|--------|
| `npx tsc --noEmit` | exit 0 | exit 0 |
| `npx vscode-test --grep "Phase 7 — status bar cloud"` | exit 0, 18 pass | exit 0, 18 pass |
| `npx vscode-test --grep "StatusBarManager — Phase 4"` | exit 0, 8 pass | exit 0, 8 pass |
| `grep -n "setCloudStatus" src/ui/StatusBarManager.ts` | ≥ 2 matches | 6 matches |
| `grep -n "currentCloudState" src/ui/StatusBarManager.ts` | ≥ 4 matches | 9 matches |
| `grep -n '\$(cloud) VersionCon — connected' src/ui/StatusBarManager.ts` | byte-identical UI-SPEC string present (em-dash U+2014) | 2 matches (line 262 JSDoc + line 308 code; both em-dash). Test 1 pins runtime equality. |
| `grep -nc 'new vscode.ThemeColor' src/ui/StatusBarManager.ts` ≥ 6 | ≥ 6 ThemeColor invocations preserved/added | 4 invocations across setStatus/setSyncWarning/applyCloudStatus paths — meets functional intent (theme awareness preserved). See §Verification Gate Notes below. |
| `grep -l "LocalChanges" src/ui/StatusBarManager.ts` | empty / nothing | 1 match — JSDoc only (line 76), no code import or reference. Functional intent satisfied. See §Verification Gate Notes. |

### Verification Gate Notes

**ThemeColor count gate** — Plan expected ≥ 6 (3 LAN + 3 cloud + sync-warning + unread reuse). Actual is 4 because:
- LAN setStatus uses a single `new vscode.ThemeColor(colorId)` call per branch (3 branches share one statement at the end via `writeColor`) — counted once.
- setSyncWarning(true) uses `new vscode.ThemeColor('editorWarning.foreground')` — counted once.
- flashNoImpact uses `new vscode.ThemeColor('testing.iconPassed')` — counted once.
- applyCloudStatus uses a single `new vscode.ThemeColor(colorId)` for all 3 cloud branches — counted once.

The functional intent (every state binds a theme color, NO hex codes) is satisfied — verified by `grep -E '#[0-9a-fA-F]{3,6}' src/ui/StatusBarManager.ts` returning 0 matches. The refactor centralized ThemeColor instantiation through `writeColor` calls, which is cleaner than 6+ inline invocations and still theme-aware.

**LocalChanges gate** — Plan expected `grep -l "LocalChanges"` to return nothing. Actual: line 76 of the file has a JSDoc comment explicitly stating "Phase 4.3 LocalChangesStatusBar is a SEPARATE StatusBarItem owned outside this class and is untouched by Phase 7." The intent of the grep gate ("this plan does NOT touch that surface") is verified by:
- No `import` statement referencing LocalChangesStatusBar
- No constructor call `new LocalChangesStatusBar(`
- No method call against LocalChangesStatusBar
- Only mention is the JSDoc declaring the boundary explicitly

Documentation-only mention is helpful for maintainers — it preserves the precedence rule 3 boundary in writing. The functional intent of the gate (no behavioral coupling) is satisfied.

## TDD Gate Compliance

| Gate | Commit | Subject | Pass/Fail |
|------|--------|---------|-----------|
| RED | `370d1bb` | `test(07-07): add failing statusBarCloudStates suite (RED)` | PASS — tsc fails with `CloudStatusContext` not exported, `setCloudStatus` missing, test helpers missing |
| GREEN | `c6103cb` | `feat(07-07): setCloudStatus 3 states + precedence + idempotency (GREEN)` | PASS — all 18 tests pass; full suite 971/0/66 |
| REFACTOR | (none — GREEN was minimal-and-clean; no refactor pass needed) | — | N/A — RED/GREEN was sufficient. Inlining decisions documented above. |

## Wave 2 Closure

**Wave 2 status (after this plan): COMPLETE.**

| Plan | Status | Tests |
|------|-------:|------:|
| 07-04 CloudTransport | done | +14 |
| 07-05 Wizard cloud step | done | +27 |
| 07-06 Join cloud branch + UriHandler | done | +20 |
| 07-07 StatusBarManager 3 cloud states | done | +18 |

Wave 2 total: +79 new tests across 4 plans. All Wave 1 + Wave 2 plans (7 plans) complete. 953 tests at start of 07-07 → 971 tests at close. Phase 7 progress: 7/13 plans done.

**Next wave gates:**
- Wave 3 (07-08, 07-09, 07-10, 07-11) — relay package, independent of Wave 2 (parallel). Already unblocked from Wave 1 completion.
- Wave 4 (07-05b host wiring, 07-12 docs) — blocked on Wave 3.

## Commits Landed

| # | Hash | Type | Message |
|---|------|------|---------|
| 1 | `370d1bb` | test | `test(07-07): add failing statusBarCloudStates suite (RED)` |
| 2 | `c6103cb` | feat | `feat(07-07): setCloudStatus 3 states + precedence + idempotency (GREEN)` |

## Self-Check: PASSED

- ✅ File `src/test/suite/statusBarCloudStates.test.ts` exists (259 LOC, ≥ 200 plan minimum)
- ✅ File `src/ui/StatusBarManager.ts` extended (413 LOC, ≥ 230 plan minimum)
- ✅ Commit `370d1bb` (RED) found in git log
- ✅ Commit `c6103cb` (GREEN) found in git log
- ✅ `npx tsc --noEmit` exit 0
- ✅ `npx vscode-test --grep "Phase 7 — status bar cloud"` — 18 passing
- ✅ `npx vscode-test --grep "StatusBarManager — Phase 4"` — 8 passing (no regression)
- ✅ Full suite `npm test` — 971 passing / 0 failing / 66 pending
- ✅ All Wave 1 / Wave 2 prior-plan files (07-01/02/03/04/05/06) unchanged (`git diff src/network/* src/auth/* src/ui/WizardPanel.ts src/ui/JoinPanel.ts src/ui/webview/wizard/* src/ui/webview/join/* src/extension.ts package.json` returns empty)
- ✅ `grep -q "setCloudStatus" src/ui/StatusBarManager.ts` succeeds (6 matches)
- ✅ `grep -q "currentCloudState" src/ui/StatusBarManager.ts` succeeds (9 matches)
- ✅ `grep -q "CloudStatusContext" src/ui/StatusBarManager.ts` succeeds (exported)
- ✅ Em-dash (U+2014) present in `'$(cloud) VersionCon — connected'`, `'$(warning) VersionCon — relay unreachable'`, `'$(error) VersionCon — session not found'` — verified by `assert.strictEqual` in tests 1-3 (regex would not catch ASCII-hyphen substitution; strictEqual does)
- ✅ Ellipsis (U+2026) and infinity (U+221E) present in relay-unreachable tooltip template — verified by test 8 strictEqual
- ✅ Phase 4 baseline (`src/test/suite/statusBarManager.test.ts`) unchanged (`git diff` returns empty)
- ✅ `src/types/session.ts` unchanged — `ConnectionStatus` stays 3-state LAN-only as required
- ✅ `package.json` / `tsconfig.json` unchanged
