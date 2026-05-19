---
phase: 07-cloud-mode-relay-server
plan: 06
subsystem: ui/join + extension/uri-handler
tags: [join-panel, urihandler, deep-link, cloud-mode, security, webview, wave-2]
dependency_graph:
  requires:
    - "Phase 1 — JoinPanel base shell (state-update protocol, escapeHtml helper, SessionClient.connect entry point)"
    - "Phase 4.1 — 'displayName is always self-attested' invariant (preserved verbatim — JoinPrefill struct has NO displayName field)"
    - "07-01 — Transport seam (SessionClient constructor accepts optional `transport?: ClientTransport`); JoinPanel's cloud branch injects a CloudTransport via this seam"
    - "07-04 — CloudTransport class (constructor signature `(relayUrl, sessionId, token, ...)`); JoinPanel cloud branch imports + constructs it"
    - "07-05 — Wizard share-screen deep-link emitter (canonical byte-shape `vscode://versioncon.versioncon/join?relay=<urlencoded>&session=<id>&code=<code>` — this plan's UriHandler parses the exact same shape)"
  provides:
    - "src/ui/JoinPanel.ts — JoinState widened with mode/relayUrl/sessionId; handleMessage routes new 'join-mode-change'; handleJoinConnect dispatches on payload.mode === 'cloud'; new public static JoinPanel.openPrefilled() entry point for the UriHandler"
    - "src/ui/JoinPanel.ts — JoinPrefill type exported (mode + relayUrl + sessionId + inviteCode; NO displayName)"
    - "src/ui/webview/join/join.js — Connection method radio + mode-conditional Host IP+Port (LAN) vs Relay URL+Session ID (Cloud) fields; every state.* field rendered through escapeHtml"
    - "src/ui/webview/join/join.css — .radio-group / .radio-option / .fieldset-legend rules using only var(--vscode-*) tokens"
    - "src/extension.ts — exported VersionConUriHandler class implementing vscode.UriHandler; getDeepLinkOutputChannel('VersionCon: Deep Links') lazy helper; activate() registers handler via vscode.window.registerUriHandler"
    - "package.json — activationEvents: [] → ['onUri'] for cold-start activation"
  affects:
    - "07-05b (Host-side cloud wiring, deferred) — JoinPanel's cloud branch already constructs SessionClient with a CloudTransport; the host-side mirror (SessionHost wrapping CloudHostAdapter wrapping CloudTransport) lands in 07-05b"
    - "07-07 (StatusBarManager) — receives the CloudTransport.onStateChange(...) events from the cloud SessionClient constructed here; status-bar wiring is dormant until 07-07 lands"
    - "07-12 (Docs / README) — relay README will be referenced by the wizard's 'webview-open-readme' link (still unhandled; deferred — see Open Items)"
tech-stack:
  added: []
  patterns:
    - "Lazy OutputChannel construction mirroring getGitBridgeOutputChannel (single canonical channel name; idempotent push to context.subscriptions; disposed with the extension)"
    - "JoinPrefill type that intentionally omits displayName — making the Phase 4.1 'displayName is always self-attested' invariant a compile-time contract (the field cannot be set from a URI, period)"
    - "Validation order: structural validation (path / required params / scheme) BEFORE confirmation prompt — the user is never asked to 'Join' an obviously-malformed link"
    - "Confirmation gate via vscode.window.showInformationMessage — text-only dialog renders untrusted relay strings safely without HTML interpretation"
    - "Source-grep test pattern (Phase 4.1 wizardValidation.test.ts precedent) for UI-SPEC literal copy + handleUri block sanity checks (no displayName extraction, no ${code} interpolation in appendLine)"
    - "Functional handler tests via runtime stubbing of vscode.window.showInformationMessage + JoinPanel.openPrefilled with try/finally save+restore (no sinon dependency; mirrors the Phase 4 routing tests' typed-bracket-cast pattern)"
key-files:
  created:
    - "src/test/suite/joinPanelCloudBranch.test.ts (94 lines — 8 source-grep tests covering JoinState shape, UI-SPEC literal copy, escapeHtml coverage, CloudTransport dispatch, no-hex CSS, activationEvents, mode-change message routing)"
    - "src/test/suite/uriHandlerDeepLink.test.ts (337 lines — 5 source-grep + 7 functional tests covering happy path, Cancel, dismiss, XSS verbatim pass-through, wrong-path rejection, missing-param rejection, invalid-scheme rejection)"
    - ".planning/phases/07-cloud-mode-relay-server/07-06-SUMMARY.md (this file)"
  modified:
    - "src/ui/JoinPanel.ts (+150 / -33 lines — JoinState widened; JoinPrefill exported; openPrefilled / applyPrefill methods; handleJoinConnect cloud-branch dispatch; CloudTransport import)"
    - "src/ui/webview/join/join.js (+50 / -7 lines — Connection method fieldset + radio handlers + mode-conditional render + join-mode-change message)"
    - "src/ui/webview/join/join.css (+39 / 0 lines — purely additive radio-group rules)"
    - "src/extension.ts (+145 / 0 lines — getDeepLinkOutputChannel helper; exported VersionConUriHandler class with handleUri; registerUriHandler call in activate())"
    - "package.json (+0 / 0 net — activationEvents: [] → ['onUri'])"
decisions:
  - decision: "JoinPrefill struct exported with NO displayName field (compile-time enforcement of Phase 4.1 invariant)"
    rationale: "T-07-10c mitigation needed two layers of defense: (1) source-grep test asserts handleUri block contains neither `params.get('displayName')` nor `params.get('name')`, (2) the JoinPrefill type definition itself omits displayName so the only way to set it through openPrefilled would be a hard type error. JoinPanel.applyPrefill copies only the four fields in JoinPrefill; if a future contributor adds a fifth field, they have to extend the type — which forces a code review of the new field's trust posture. This is structurally stronger than a runtime check ('if (prefill.displayName) throw') because there's no `displayName` slot to fill in the first place."
  - decision: "Validation order: path → relay present → session present → wss-scheme check → confirmation prompt (NOT path → confirmation → rest)"
    rationale: "Plan §verification mandates `path → required-params → wss-scheme → prompt`. The intent is that the user is never asked to 'Join' an obviously-bad URL — a non-wss link from an attacker would otherwise see a confirmation dialog (even if Cancel is the safe default, the prompt itself is an attack surface; user fatigue could lead to accidental clicks). Validation precedes consent. Test 'handleUri with non-wss:// relay → no prompt, error toast shown' pins this contract directly."
  - decision: "Cloud-branch SessionClient construction passes relayUrl/0 as the hostIp/port placeholder when injecting CloudTransport"
    rationale: "SessionClient.constructor (07-01) takes `(hostIp, port, inviteCode, displayName, transport?)`. When `transport` is provided, the hostIp/port arguments are unused — the transport owns the connection details. Passing relayUrl as the hostIp string + 0 as the port keeps the typed signature satisfied without inventing a new constructor overload (which would churn 07-01's stable shape). The 0-port has no LAN-mode reachability (LanClientTransport would reject it), but cloud-mode never instantiates LanClientTransport because the explicit `transport` arg short-circuits that default. Functionally equivalent to passing literal 'cloud' / -1; this choice keeps history-write meaningful (relayUrl is the human-readable identifier of where the joiner connected)."
  - decision: "Mode-change is a separate 'join-mode-change' message (NOT a payload field on every 'join-connect')"
    rationale: "The webview is stateless — every render rebuilds the form. A radio-change must persist into the extension-host state machine to survive the next render cycle. If mode were only sent inside 'join-connect', toggling the radio would update the visible markup but the extension's state.mode would stay stale until the user clicked Join. The dedicated 'join-mode-change' message mirrors Plan 04-09's debounce-presence pattern (one outbound message per user intent) and keeps state.mode authoritative in the extension host (which is the canonical store, per Phase 1 stateless-webview pattern)."
  - decision: "UriHandler registration uses an inline lambda for onConnected (NOT a named module-level handleJoinerConnected)"
    rationale: "Plan §Task 2 §step 2 offered both options ('refactor that callback into a named module-level function handleJoinerConnected ... or inline a thin lambda that calls the existing command's body'). The existing JoinPanel.createOrShow call site at line 1760 uses `(client) => wireClientEvents(client)` as an inline lambda; mirroring that pattern keeps both call sites byte-identical in shape. wireClientEvents is at activate() scope (line 1382) and is therefore reachable from the UriHandler registration at line 1769 without any refactor. Extracting to module scope would require widening wireClientEvents' closure dependencies (statusBarManager, sidebarProvider, ChatPanel refs, etc.) into module-level singletons — out of scope and a noisy diff."
  - decision: "Type-cast `(await import('../../extension.js')) as any` in the deep-link test file"
    rationale: "VersionConUriHandler is a class in extension.ts. The dist/test/suite/uriHandlerDeepLink.test.js dynamically imports the compiled extension; TypeScript's resolution of the import target uses the .d.ts of extension.ts, which (correctly) reports the class on the module namespace. But during the RED phase the class doesn't exist yet — `import { VersionConUriHandler } from '../../extension.js'` would static-fail. The `as any` cast preserves the RED → GREEN transition (RED fails at runtime with 'VersionConUriHandler is not a constructor', GREEN succeeds). After GREEN the cast is harmless because all properties are accessed via known-runtime-shape new-call. Mirrors Plan 04-05's typed-bracket-cast precedent ('test harness invokes private handleMessage via typed bracket cast — avoids real WebSocket spin-up')."
metrics:
  duration: "~9 minutes (sequential execution; 2 RED + 2 GREEN commits)"
  completed-date: "2026-05-19"
  tests-added: 20
  tests-total-before: 933
  tests-total-after: 953
requirements-completed: [NET-06]
---

# Phase 7 Plan 06: Join Cloud Branch + UriHandler Summary

**One-liner:** JoinPanel gains a LAN/Cloud "Connection method" radio with mode-conditional fields (Host IP+Port vs Relay URL+Session ID), and a vscode://versioncon.versioncon/join?... deep-link handler that requires a user-visible confirmation prompt (T-07-10 mitigation) BEFORE opening the pre-filled JoinPanel.

## What Shipped

| File | Role | Δ |
|------|------|---|
| `src/ui/JoinPanel.ts` | JoinState widened; cloud branch in handleJoinConnect; openPrefilled static entry; JoinPrefill type exported | +150 / -33 |
| `src/ui/webview/join/join.js` | Connection method fieldset + mode-conditional render + join-mode-change message | +50 / -7 |
| `src/ui/webview/join/join.css` | Additive radio-group rules (theme variables only, no hex) | +39 / 0 |
| `src/extension.ts` | getDeepLinkOutputChannel + VersionConUriHandler class + registerUriHandler in activate() | +145 / 0 |
| `package.json` | activationEvents: [] → ['onUri'] | (1-line) |
| `src/test/suite/joinPanelCloudBranch.test.ts` | 8 source-grep tests | NEW (94 lines) |
| `src/test/suite/uriHandlerDeepLink.test.ts` | 5 source-grep + 7 functional tests | NEW (337 lines) |

## Widened JoinState (final shape)

```typescript
interface JoinState {
  hostIp: string;            // LAN branch (existing)
  port: string;              // LAN branch (existing)
  inviteCode: string;        // shared (existing)
  displayName: string;       // shared (existing)
  recentSessions: SavedSession[];
  discoveredSessions: DiscoveredSession[];
  isConnecting: boolean;
  error: string | null;
  // Plan 07-06 additions:
  mode: 'lan' | 'cloud';     // default 'lan' — back-compat for existing flow
  relayUrl: string;          // Cloud branch only
  sessionId: string;         // Cloud branch only
}
```

## JoinPrefill (exported — used by VersionConUriHandler)

```typescript
export interface JoinPrefill {
  mode: 'cloud';
  relayUrl: string;
  sessionId: string;
  inviteCode: string;
  // NOTE: NO displayName field — Phase 4.1 invariant T-07-10c
}
```

## VersionConUriHandler — validation order (LOCKED)

1. `uri.path !== '/join'` → log to OutputChannel, return (no prompt, no panel)
2. `relay` query param missing → log, return
3. `session` query param missing → log, return
4. `relay.startsWith('wss://')` is false → log + showErrorMessage('Invalid invite link — relay must use wss://.'), return
5. **THEN** `vscode.window.showInformationMessage('Join VersionCon session? You've been invited to join a cloud session at <relay>.', 'Join', 'Cancel')`
6. If choice === 'Join' → `JoinPanel.openPrefilled(context, sessionHistory, onConnected, { mode: 'cloud', relayUrl, sessionId, inviteCode })`
7. Else (Cancel / dismissed) → log breadcrumb, return silently (NO toast on cancel per UI-SPEC §Reconnect Progress Copy)

## Confirmation prompt — verbatim copy (UI-SPEC literal)

```
Join VersionCon session? You've been invited to join a cloud session at wss://r.fly.dev.
[Join]  [Cancel]
```

## Test results

```
✔ npx tsc --noEmit                                                  — exits 0
✔ npx vscode-test --grep "Phase 7.*join cloud branch"
  → 8/8 passing (16 ms)
✔ npx vscode-test --grep "Phase 7.*deep link"
  → 12/12 passing (46 ms)
✔ npx vscode-test                                                    — full project run
  → 953 passing, 0 failing, 66 pending (was 933 / 0 / 66 → +20 new)
```

Grep gates (all pass):

| Gate | Result |
|------|--------|
| `grep -q '"onUri"' package.json` | OK |
| `grep -q "registerUriHandler" src/extension.ts` | OK |
| `grep -q "VersionConUriHandler" src/extension.ts` | OK (class declaration + new in activate) |
| `grep -q "showInformationMessage" src/extension.ts` | OK |
| `grep "params.get('displayName')" src/extension.ts` | ZERO matches (Phase 4.1 invariant) |
| `grep "Connection method" src/ui/webview/join/join.js` | OK (legend literal) |
| `grep -cE "escapeHtml\(" src/ui/webview/join/join.js` | 17 (>= 6 minimum from plan) |

## Threat Model Audit

Plan 07-06's threat model (`<threat_model>` block) — every threat covered by ≥1 test:

| Threat ID | Disposition | Status | Test |
|-----------|-------------|--------|------|
| T-07-10 (Spoofing / Social-Engineering — silent auto-join) | mitigate | ✓ | `handleUri valid URI → confirmation prompt → on Join → openPrefilled called` (asserts call-order showInformationMessage BEFORE openPrefilled); `handleUri → user clicks Cancel → NO panel open`; `handleUri → user dismisses dialog → silent cancellation`; source-grep `extension.ts has NO trusted-relay bypass` |
| T-07-10a (Tampering / XSS via injected param) | mitigate | ✓ | `join.js escapes all rendered state fields via escapeHtml()` (relayUrl/sessionId/inviteCode/displayName all wrapped); `handleUri with <script> in relay param → verbatim passed to openPrefilled (webview escapes at render)` |
| T-07-10b (Information Disclosure — invite code in logs) | mitigate | ✓ | `deep-link OutputChannel log lines do NOT include the invite code value` (source-grep `appendLine.*\$\{code\}` returns zero matches) |
| T-07-10c (Elevation of Privilege — displayName auto-prefill from URI) | mitigate | ✓ | source-grep `extension.ts does NOT extract displayName from deep-link URI params` (asserts handleUri block has neither `params.get('displayName')` nor `params.get('name')`); JoinPrefill type has NO displayName field (compile-time enforcement) |
| T-07-10d (DoS — flood of malformed URIs) | accept | ✓ (no action) | Each malformed URI is O(1) — one appendLine + return. No network activity. Bounded by OS URI-dispatch throttling. |

**No new high-severity threats introduced.** No threat flags to escalate.

## Phase 4.1 invariants — confirmed preserved

- JoinPrefill struct has NO displayName field → URI layer cannot inject a misleading name
- VersionConUriHandler.handleUri block contains zero `params.get('displayName')` / `params.get('name')` calls (source-grep gate)
- JoinPanel constructor's initial state still defaults `displayName: ''` so the user must type it after the panel opens (deep-link or manual entry — same code path)

## Open Items Deferred

**To 07-07 (StatusBarManager):**
- The cloud-mode SessionClient constructed by this plan's cloud branch will emit `cloud-connected` / `cloud-relay-unreachable` / `cloud-session-not-found` state-change events. StatusBarManager subscription to `CloudTransport.onStateChange(...)` is dormant until 07-07 wires it.

**To 07-05b (Host-side cloud wiring) and to a later host-token-issuance plan:**
- The JWT token passed to `new CloudTransport(relayUrl, sessionId, '')` is currently empty. The protocol-level `auth-request` flow remains the same (host issues the joiner's JWT in response to the auth frame). When the relay enters the picture and rejects empty tokens at the WSS handshake, the joiner will need to either (a) bootstrap with a one-time bearer obtained from the host's invite-code endpoint OR (b) the host returns the joiner's JWT in-band via the existing protocol channel before the relay-side checks kick in. The exact JWT-bootstrap plan is out of scope for 07-06.

**To 07-12 (Docs / README):**
- The wizard's "Don't have a relay? Deploy one →" link in wizard.js still emits an unhandled `webview-open-readme` message. The sequential-execution prompt for this plan called out a possible inline-wire to `vscode.env.openExternal`, but the plan §interfaces does not specify the destination URL and 07-05-SUMMARY explicitly flags this as 07-12's job. Leaving as a deferred item to keep this plan's diff scope-bounded.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added source-grep gate for T-07-10b ('code' not in OutputChannel)**
- **Found during:** Test design
- **Issue:** The plan's threat model lists T-07-10b (Information Disclosure — invite code in logs) but the test inventory only covers T-07-10 (call-order) and T-07-10c (displayName extraction). Without a test pinning the invite code's absence from `appendLine` calls, a future contributor could add `appendLine(\`...code=\${code}\`)` and pass the existing suite.
- **Fix:** Added `deep-link OutputChannel log lines do NOT include the invite code value (T-07-10b)` test — source-grep asserts `appendLine\([^)]*\$\{code\}` returns zero matches in the VersionConUriHandler class block.
- **Files modified:** `src/test/suite/uriHandlerDeepLink.test.ts`
- **Commit:** 2d819b3 (RED)

**2. [Rule 2 - Defense-in-depth] Exported JoinPrefill type with NO displayName field**
- **Found during:** Implementation of JoinPanel.openPrefilled
- **Issue:** Plan §interfaces says "openPrefilled signature accepts only `{ mode, relayUrl, sessionId, inviteCode }` — no `displayName` field" but does not specify whether the type is exported / nominal vs structural / available for compile-time checks elsewhere.
- **Fix:** Added `export interface JoinPrefill { mode: 'cloud'; relayUrl: string; sessionId: string; inviteCode: string; }` at the top of JoinPanel.ts. UriHandler imports it implicitly through the openPrefilled signature; any future deep-link variant must extend JoinPrefill, forcing a code review of any new field's trust posture.
- **Files modified:** `src/ui/JoinPanel.ts`
- **Commit:** 2dbc878 (GREEN)

**3. [Rule 3 - Blocking issue] Test file dynamic import type-cast to `any`**
- **Found during:** RED phase compile
- **Issue:** Without the cast, `import { VersionConUriHandler } from '../../extension.js'` fails at TypeScript compile-time during RED (the class doesn't exist yet), making the RED → GREEN transition uncompilable rather than runtime-failing.
- **Fix:** Wrapped the dynamic import as `(await import('../../extension.js')) as any` — RED fails at runtime with `VersionConUriHandler is not a constructor`, GREEN succeeds. Standard TDD pattern.
- **Files modified:** `src/test/suite/uriHandlerDeepLink.test.ts`
- **Commit:** 2d819b3 (RED)

### Out-of-Scope Items (NOT auto-fixed — logged for tracking)

**1. [Deferred to 07-12] wizard.js 'webview-open-readme' handler still missing**
- The sequential-execution prompt asked whether to wire `vscode.env.openExternal(...)` for the relay README link emitted by the wizard. Plan §plans-out-of-scope explicitly defers this to 07-12 docs. Kept the deferral to keep this plan scope-bounded.

**2. [Deferred to a future host-token plan] CloudTransport token argument is empty string**
- The joiner-side JWT bootstrap is not yet specified. The relay (when it lands) will reject the empty token; the protocol-level `auth-request`/`auth-response` exchange handles the joiner's identity. Token wiring lands when the relay-side handshake is implemented.

## TDD Gate Compliance

Both tasks follow strict RED → GREEN order with separate commits per gate:

| Commit | Type | Description |
|--------|------|-------------|
| 980667a | test  | RED  — joinPanelCloudBranch.test.ts (8 tests, 7 failing) + activationEvents update |
| 2dbc878 | feat  | GREEN — JoinPanel cloud branch (8/8 passing) |
| 2d819b3 | test  | RED  — uriHandlerDeepLink.test.ts (12 tests, 11 failing with `VersionConUriHandler is not a constructor`) |
| 8cbe56f | feat  | GREEN — VersionConUriHandler + activate() wiring (12/12 passing) |

Plan-level type is `execute` (not `tdd`), but Task 2 was explicitly marked `tdd="true"` and followed the gate sequence verbatim. Task 1's commit pair is structurally RED → GREEN (test + activationEvents are inert without the implementation; the GREEN commit lands JoinPanel.ts / join.js / join.css together).

## Self-Check: PASSED

- ✔ `src/ui/JoinPanel.ts` exists, modified (commit 2dbc878).
- ✔ `src/ui/webview/join/join.js` exists, modified (commit 2dbc878).
- ✔ `src/ui/webview/join/join.css` exists, modified (commit 2dbc878).
- ✔ `src/extension.ts` exists, modified (commit 8cbe56f).
- ✔ `package.json` modified (commit 980667a — activationEvents includes "onUri").
- ✔ `src/test/suite/joinPanelCloudBranch.test.ts` exists (created — commit 980667a).
- ✔ `src/test/suite/uriHandlerDeepLink.test.ts` exists (created — commit 2d819b3).
- ✔ Commit 980667a (Task 1 RED) found in `git log`.
- ✔ Commit 2dbc878 (Task 1 GREEN) found in `git log`.
- ✔ Commit 2d819b3 (Task 2 RED) found in `git log`.
- ✔ Commit 8cbe56f (Task 2 GREEN) found in `git log`.
- ✔ All 20 new assertions pass; full suite 953/0/66.
- ✔ `npx tsc --noEmit` exits 0.
- ✔ All 7 grep gates from plan §verification pass.
