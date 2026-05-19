---
phase: 07-cloud-mode-relay-server
plan: 05
subsystem: ui/wizard
tags: [wizard, cloud-mode, ui, webview, deep-link, relay-url-validation, share-screen, wave-2]
dependency_graph:
  requires:
    - "Phase 4.1 (04.1-03) — WizardPanel displayName resolution chain + step 1 sessionName/displayName surface (preserved verbatim — WizardPanel.ts:386-449 untouched)"
    - "Phase 1 — wizard.html / wizard.css / wizard.js webview shell + CSP nonce + stateless-webview state-update protocol"
    - "package.json publisher + name (`versioncon.versioncon` deep-link prefix)"
  provides:
    - "src/ui/WizardPanel.ts — widened WizardState (mode + relayUrl + relayUrlReachable + relayHealthSessionCount + sessionId); step union 1|2|3|4 → 1|2|3|4|5 (Option A renumber); three new message handlers (wizard-set-mode / wizard-set-relay-url / wizard-test-connection-result); cloud-branch validation literal `Must be a wss:// URL`"
    - "src/ui/webview/wizard/wizard.js — renderStepModeSelect + renderStepNetworkCloud + renderShareScreenCloud + pure helpers validateRelayUrl / buildDeepLink / runTestConnection (exposed on globalThis for test reach)"
    - "src/ui/webview/wizard/wizard.css — .mode-select-card, .test-connection-row, .test-connection-result.pass/.fail, .deep-link-box, .share-three-pieces, .share-piece, .copy-icon-btn, .mode-fieldset, .visually-hidden"
    - "Deep-link literal contract: `vscode://versioncon.versioncon/join?relay=<urlencoded>&session=<id>&code=<code>` — sessionId derived as `'vc-' + inviteCode.toLowerCase()` for v1"
  affects:
    - "07-06 — Join + UriHandler (parses the deep-link this plan renders; needs the same encodeURIComponent(relay) contract on the parse side; also wires `webview-open-readme` message handler this plan emits but does not handle)"
    - "07-05b — Host-side cloud wiring (will read `state.mode === 'cloud' && state.relayUrl` from handleWizardComplete and construct a CloudHostAdapter-wrapped SessionHost; currently handleWizardComplete still constructs a LAN SessionHost for both modes — intentional UI-only scope)"
    - "07-07 — StatusBarManager (consumes CloudTransport state surface; this plan does NOT yet construct CloudTransport so the wiring is dormant)"
tech-stack:
  added: []
  patterns:
    - "Stateless webview snapshot pattern preserved verbatim — extension host owns all state, webview re-renders on every state-update"
    - "Option A step renumber (1|2|3|4 → 1|2|3|4|5) — minimal-diff path that keeps handleWizardBack's `step - 1` arithmetic working"
    - "Backward-compat function names (renderStep2 / renderStep3) preserved as LAN-branch entry points so Phase 4.1 source-grep tests (Backlog 999.2 step-2 Next button shape; UAT Test 3 payload shape) continue to match the literal `function renderStep2(state) { … return \`…\` }` shape"
    - "Pure helper exposure pattern — validateRelayUrl + buildDeepLink + runTestConnection exposed on globalThis.__versionConWizardHelpers (NOT public API; for in-process debug only) AND duplicated body-for-body in the test file for direct Mocha unit-test exercise (wizard.js can't be Node-imported because it calls acquireVsCodeApi() at top-level)"
    - "Defense-in-depth wss:// validation — webview validates at click time + disables Continue button + extension host re-validates at wizard-next message receipt (T-07-01a UX defense layer; the security boundary remains JWT verification at the relay, T-07-01 / 07-09)"
    - "Theme-only CSS — every new color reference uses `var(--vscode-*)` theme variable; the additive CSS block contains ZERO hex codes (pinned by a `.doesNotMatch(/#[0-9a-fA-F]{3,8}\\b/)` assertion in wizardCloudStep.test.ts)"
key-files:
  created:
    - "src/test/suite/wizardCloudStep.test.ts (459 lines — Mocha suite 'Phase 7 — wizard cloud step' with 27 assertions: source-greps + pure-helper unit table + stubbed-fetch runTestConnection happy/failure paths)"
    - ".planning/phases/07-cloud-mode-relay-server/07-05-SUMMARY.md (this file)"
  modified:
    - "src/ui/WizardPanel.ts (+182 / -25 lines — widened WizardState, step renumber, mode-select case + cloud-branch validation in handleWizardNext, three new handleMessage cases + handlers, sessionId derivation in handleWizardComplete; Phase 4.1 displayName block at lines 404-446 untouched verbatim)"
    - "src/ui/webview/wizard/wizard.js (+296 / -19 lines — pure helpers, renderStepModeSelect, renderStepNetworkCloud, renderShareScreenCloud, mode-radio listener, relay-url input listener, test-connection click handler, open-readme link handler, deep-link + per-piece copy handlers; renderStep2/renderStep3 names preserved as LAN-branch entry points)"
    - "src/ui/webview/wizard/wizard.css (+138 / 0 lines — purely additive; existing rules untouched)"
decisions:
  - decision: "Option A — step union renumbered 1|2|3|4 → 1|2|3|4|5 (NOT a floating-point step 1.5 / 2.5)"
    rationale: "Plan §interfaces documents Option A as 'recommended for minimal diff'. Renumbering preserves the back-button arithmetic (`step - 1` stays a valid type-narrowing cast to a smaller union) and matches the UI-SPEC State Diagram A. Option B (floating-point sub-step) would have churned every switch-case in handleWizardNext / handleWizardBack and added a `subStep` parallel field; not justified for the diff savings."
  - decision: "sessionId derived as `'vc-' + inviteCode.toLowerCase()` (NOT crypto.randomUUID())"
    rationale: "Plan §interfaces footnote 'Note on state.sessionId' offers two candidates. Invite codes are already unique within a process (generateInviteCode is a 6-char alphanumeric draw from id.ts). Deriving sessionId from the invite code keeps the two identifiers structurally linked — a deep-link URL whose `code=…` query param matches the suffix of `session=vc-…` is recognizable by a human reading log lines. crypto.randomUUID() would split the two identifiers and require a separate path for 07-06 to correlate them. The deep-link contract (07-06 will parse this) only requires the field be a non-empty alphanumeric+dash string."
  - decision: "Pure helpers duplicated body-for-body between wizard.js and the test file (NOT extracted to a sibling .js module)"
    rationale: "Plan §interfaces 'Test-reachability note' offers two options (a) extract to a sibling CommonJS-compatible file + add a second `<script src=…>` tag to wizard.html, or (b) duplicate inline + source-grep gate. Option (a) requires a second `%%HELPERS_URI%%` template placeholder + a new entry in WizardPanel.getWebviewContent + a CSP nonce wiring for the additional script tag. Option (b) is one source-grep test per helper that pins the duplicate body to the production body. Picked (b) — smaller diff, fewer moving parts, source-grep gates `function validateRelayUrl` + `function buildDeepLink` + `startsWith('wss://')` + `encodeURIComponent(` + `replace('wss://', 'https://')` keep the duplicates in lockstep. If a third caller ever needs these helpers, promote to a sibling module at that point."
  - decision: "Step indicator stays at 3 dots (NOT renumbered to 4 dots for cloud mode)"
    rationale: "Plan §Substep 2c step 7 explicitly says 'The UI-SPEC mockup shows 4 dots; the simplest implementation keeps the existing 3-dot rendering since the new mode-select is a logical 1.5 rather than a peer step. Either is acceptable as long as the dot count doesn't regress for LAN flow.' The 3-dot rendering preserves Phase 4.1's visual invariant and renderStepIndicator's existing structure. The internal 4-step machine maps to the 3-dot visual via `const visualStep = activeStep >= 3 ? activeStep - 1 : 1` — mode-select shares dot 1 with identity. If a 4-dot variant is needed later, it's a localized renderStepIndicator change."
  - decision: "Relay URL field gates Continue button via state.relayUrlReachable === true (NOT just validateRelayUrl pass)"
    rationale: "UI-SPEC §Wizard Step 2 — Test connection contract: 'Continue / Next button is disabled until a Test-connection result is successful.' Users who type a syntactically-valid but DNS-failed URL must be able to see the failure inline (test-connection result) BEFORE being allowed to proceed. The webview disables the button locally based on state.relayUrlReachable; defense-in-depth in handleWizardNext returns `'Run Test connection before continuing.'` if a user finds a way to click Next while reachable === null. This matches the threat model — T-07-01a UX defense layer."
  - decision: "renderStep2 / renderStep3 function names PRESERVED for the LAN branch (NOT renamed to renderStepNetworkLan / renderStepInviteCode)"
    rationale: "wizardValidation.test.ts (Phase 4.1 Backlog 999.2 closure) does `src.match(/function renderStep2\\(state\\)\\s*\\{[\\s\\S]*?return \\`([\\s\\S]*?)\\`;\\s*\\}/)` — extracts the renderStep2 template literal directly and asserts the Next button HTML has no disabled attribute. An initial GREEN attempt renamed renderStep2 to renderStepNetworkLan and added `function renderStep2(state) { return renderStepNetworkLan(state); }` as an alias — the alias had no template literal so the regex failed and Phase 4.1 regressed by 1 test. Fixed by reverting to the original renderStep2 function body (with the LAN render logic inline) and introducing renderStepNetworkCloud as a peer. The function NAME is the load-bearing source-grep target; the function SHAPE (return-of-template-literal) is the secondary source-grep target. Both preserved."
  - decision: "validateRelayUrl + buildDeepLink + runTestConnection exposed on globalThis (NOT module.exports)"
    rationale: "wizard.js runs inside a CSP-locked webview with no module system (no `require` / `import` available at runtime — the file is loaded via `<script src=…>` not `<script type='module'>`). Exposing the helpers on globalThis.__versionConWizardHelpers is the only side-channel that survives the webview's IIFE. The test file does NOT consume this side-channel (it duplicates the bodies); the exposure is purely a debugging / future-extensibility hook. Source-grep gate `function\\s+validateRelayUrl` + `function\\s+buildDeepLink` + `replace('wss://', 'https://')` keeps the production copies in lockstep with the test-file duplicates."
metrics:
  duration: "~12 minutes (sequential execution; RED commit + GREEN commit + 1-test-regression fix)"
  completed-date: "2026-05-19"
  tests-added: 27
  tests-total-before: 906
  tests-total-after: 933
requirements-completed: [NET-06]
---

# Phase 7 Plan 05: Wizard Cloud Step Summary

**One-liner:** Wizard gains a LAN/Cloud mode-select step plus a Cloud-branch network-config step with `wss://` relay URL validation, a Test-connection ping against `/healthz`, and a share screen rendering the canonical `vscode://versioncon.versioncon/join?relay=…&session=…&code=…` deep-link plus three copyable pieces.

## What Shipped

| File | Role | Lines (final) | Δ |
|------|------|---------------|---|
| `src/ui/WizardPanel.ts` | Widened WizardState + step-machine renumber + cloud-branch validation + new message handlers | 835 | +182 / -25 |
| `src/ui/webview/wizard/wizard.js` | Pure helpers + mode-select render + cloud network-config render + cloud share-screen render + new listeners | 559 | +296 / -19 |
| `src/ui/webview/wizard/wizard.css` | Additive style rules (zero hex codes) | 360 | +138 / 0 |
| `src/test/suite/wizardCloudStep.test.ts` | Mocha suite `Phase 7 — wizard cloud step` (27 assertions) | 459 | NEW |
| `src/ui/webview/wizard/wizard.html` | Untouched (CSP / NONCE / CSS_URI / JS_URI placeholders preserved) | 14 | 0 |

## Widened WizardState (final shape)

```typescript
interface WizardState {
  step: 1 | 2 | 3 | 4 | 5; // Option A renumber
  sessionName: string;
  displayName: string;
  port: number;
  networkInterface: string;
  availableInterfaces: Array<{ name: string; address: string }>;
  maxPayloadMB: number;
  inviteCode: string;
  hostIp: string;
  isSessionActive: boolean;
  error: string | null;
  // Plan 07-05 additions:
  mode: 'lan' | 'cloud';                   // default 'lan' — back-compat
  relayUrl: string;                        // Cloud branch only
  relayUrlReachable: boolean | null;       // null=untested, true=ok, false=failed
  relayHealthSessionCount: number | null;  // from /healthz body
  sessionId: string;                       // 'vc-' + inviteCode.toLowerCase()
}
```

Step machine — Option A renumber:

| Step | Phase 4.1 (before) | Plan 07-05 (after) |
|------|--------------------|--------------------|
| 1 | sessionName + displayName | sessionName + displayName *(unchanged)* |
| 2 | network config (port/iface/bandwidth) | **mode-select (LAN \| Cloud)** *(NEW)* |
| 3 | invite-code reveal | network config — branches on `state.mode` |
| 4 | share screen | invite-code reveal |
| 5 | — | share screen — branches on `state.mode` |

## Deep-link Literal (canonical)

For a session created with `relayUrl='wss://r.fly.dev'`, `inviteCode='K8M3PQ'`:
- Derived `sessionId = 'vc-' + 'K8M3PQ'.toLowerCase() = 'vc-k8m3pq'`
- Rendered deep-link:
  ```
  vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-k8m3pq&code=K8M3PQ
  ```

The plan's RED test pins a SECOND fixture (different inputs) byte-for-byte:
- `buildDeepLink('wss://r.fly.dev', 'vc-7f3a92', 'K8M3PQ')` → `vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-7f3a92&code=K8M3PQ`

## Test-connection Helpers — extraction strategy

Both pure helpers (`validateRelayUrl(url)` and `buildDeepLink(relayUrl, sessionId, inviteCode)`) plus the orchestrator `runTestConnection(relayUrl, fetchImpl)` are:

1. Defined **inline in wizard.js** inside the IIFE (production reach).
2. Exposed on `globalThis.__versionConWizardHelpers` (debugging side-channel — NOT a public API).
3. **Duplicated body-for-body in `src/test/suite/wizardCloudStep.test.ts`** for direct Mocha unit-test exercise — wizard.js cannot be Node-imported (it calls `acquireVsCodeApi()` at top-level).

Source-grep gates in the test file (`function\s+validateRelayUrl`, `function\s+buildDeepLink`, `startsWith('wss://')`, `encodeURIComponent(`, `replace('wss://', 'https://')`) keep the two copies in lockstep. If a future caller needs these helpers from a third site, promote them to a sibling CommonJS-compatible module at that point.

## Verification Results

```
✔ npx tsc --noEmit                           — exits 0
✔ npx vscode-test --grep "Phase 7.*wizard cloud step"
  → 27/27 passing (34 ms)
✔ npx vscode-test --grep "Phase 4.1 UAT Test 3|Backlog 999.2"
  → 7/7 passing (22 ms) — zero regression in Phase 4.1 wizard invariants
✔ npx vscode-test                            — full project run
  → 933 passing, 0 failing, 66 pending (was 906 / 0 / 66 → +27 new)
```

Source-grep self-audit (all 10 return ≥1):

| Pattern | Count |
|---------|-------|
| `Where will your team connect from?` in wizard.js | 1 |
| `Same network (LAN)` in wizard.js | 1 |
| `Different networks (Cloud)` in wizard.js | 1 |
| `Fastest. No internet or relay needed.` in wizard.js | 1 |
| `Connects via a relay server you deploy.` in wizard.js | 1 |
| `Don't have a relay? Deploy one →` in wizard.js | 1 |
| `placeholder="wss://your-relay\.fly\.dev"` in wizard.js | 1 |
| `data-test="test-connection"` in wizard.js | 1 |
| `vscode://versioncon.versioncon/join` in wizard.js | 2 |
| `Must be a wss:// URL` in WizardPanel.ts | 1 |

## Phase 4.1 invariants — confirmed preserved

`wizardValidation.test.ts` (Phase 4.1 UAT Test 3 + Backlog 999.2 suites) passes 7/7 with **zero diff** to test counts or expectations:

- `WizardPanel.ts:386-449` displayName resolution chain — UNTOUCHED. The 4 error literals (`Display name is required.`, `Display name must be 64 characters or fewer.`, `Display name cannot contain control characters.`, `Session name is required.`) and the control-character regex `/[ -]/` are byte-identical.
- `wizard.js` step-1 inputs (`id="session-name"` maxlength="100" + `id="display-name"` maxlength="256" + the paste handler at lines 304-321) — UNTOUCHED.
- `wizard.js` `updateNextDisabled()` short-circuit `if (!nameInput || !dispInput) return;` — UNTOUCHED.
- `wizard.js` step-1 `wizard-next` payload shape `{ sessionName, displayName }` — UNTOUCHED.
- `wizard.js` `function renderStep2(state)` name + template-literal shape — PRESERVED for the LAN branch (see decisions §"renderStep2 / renderStep3 function names PRESERVED").

## Open Items Deferred

**Deferred to 07-06 (Join + UriHandler):**
- `vscode://` URI handler registration in extension.ts
- Deep-link parser (must accept the EXACT byte-shape this plan emits)
- Confirmation prompt on incoming URI (showInformationMessage with relay + session preview)
- displayName prompt on incoming URI (Phase 4.1 parity for joiners)
- `webview-open-readme` message handler — wizard.js posts this when the user clicks the "Don't have a relay? Deploy one →" link, but `WizardPanel.handleMessage` currently has no case for it (T-01-14 silently ignores). 07-06 should register a handler that opens the repo's `relay/README.md` via `vscode.env.openExternal`.

**Deferred to 07-05b (Host-side cloud wiring):**
- `handleWizardComplete` currently still constructs a LAN `SessionHost` via `new SessionHost(config, hostIdentity)` regardless of `state.mode`. 07-05b will:
  - Branch on `state.mode === 'cloud'`
  - Issue a host JWT via `TokenService.issue('host', sessionId, …)` (07-03)
  - Construct a `CloudHostAdapter` wrapping a single `CloudTransport(relayUrl, sessionId, hostToken)` (07-04) that demultiplexes inbound envelopes by sender (the "host as client-to-relay" architecture in D-04)
  - Pass the adapter to `SessionHost` via the optional `transport?` constructor parameter (07-01 seam)

**Deferred to 07-07 (StatusBarManager):**
- The 3 cloud states (`cloud-connected` / `cloud-relay-unreachable` / `cloud-session-not-found`) will subscribe to `cloudTransport.onStateChange(…)` (07-04 surface). This plan does not yet construct a `CloudTransport` so the wiring is dormant.

## Threat Model Audit

Plan 07-05's threat model (`<threat_model>` block):

| Threat ID | Disposition | Status |
|-----------|-------------|--------|
| T-07-01a (Tampering — non-wss URL at wizard) | mitigate | ✓ Client-side `validateRelayUrl(url)` rejects ws:// / https:// / unparseable; extension-side `handleWizardNext` re-validates with `Must be a wss:// URL` literal; Continue button gated on `relayUrlReachable === true` |
| T-07-01 (inherited — JWT forgery at relay) | inherits | ✓ This plan never sees a token |
| T-07-03 (inherited — Bearer token leakage) | inherits | ✓ This plan collects only the relay URL string |
| T-07-10 (inherited — malicious deep-link auto-join) | inherits | ✓ This plan RENDERS the deep-link; URI parser + confirmation prompt are 07-06's job |

**No new high-severity threats introduced.** No new threat flags to escalate.

## Self-Check: PASSED

- ✔ `src/ui/WizardPanel.ts` exists (modified — git log shows 75d756e).
- ✔ `src/ui/webview/wizard/wizard.js` exists (modified — git log shows 75d756e).
- ✔ `src/ui/webview/wizard/wizard.css` exists (modified — git log shows 75d756e).
- ✔ `src/test/suite/wizardCloudStep.test.ts` exists (created — git log shows bf2d32c).
- ✔ Commit `bf2d32c` (RED) found in `git log --all`.
- ✔ Commit `75d756e` (GREEN) found in `git log --all`.
- ✔ All 27 new assertions pass; all 7 Phase 4.1 invariants pass; full suite 933/0/66.
