---
phase: 1
slug: extension-foundation-lan-networking
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-04
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | mocha 11.x + @vscode/test-cli |
| **Config file** | .vscode-test.mjs — Plan 01 creates, Wave 0 (Plan 00) creates test stubs |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --grep "<relevant-module>"`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| T00-1 | 00 | 0 | ALL | — | N/A | setup | `npm test` | Plan 00 creates | pending |
| T01-2 | 01 | 1 | SAFE-01 | T-01-02 | .vscodeignore excludes src/ | unit | `npm test -- --grep "Protocol"` | src/test/suite/protocol.test.ts | pending |
| T02-1 | 02 | 2 | NET-01, NET-08 | T-01-03,04,05 | timingSafeEqual, maxPayload | integration | `npm test -- --grep "SessionHost\|AuthHandler\|BandwidthMonitor"` | src/test/suite/host.test.ts | pending |
| T02-2 | 02 | 2 | NET-03, NET-05, SAFE-02 | — | no workspace lockout | unit | `npm test -- --grep "SessionClient\|ConnectionState"` | src/test/suite/client.test.ts | pending |
| T03-1 | 03 | 2 | NET-04 | T-01-12 | SecretStorage for codes | unit | `npm test -- --grep "SessionHistory\|SecretStore\|generateInviteCode"` | src/test/suite/storage.test.ts | pending |
| T03-2 | 03 | 2 | NET-07 | T-01-09 | graceful mDNS failure | integration | `npm test -- --grep "DiscoveryManager\|Network Utils"` | src/test/suite/discovery.test.ts | pending |
| T04-1 | 04 | 3 | NET-01, NET-02 | T-01-13,14 | nonce CSP | unit | `npm test -- --grep "WizardState"` | — | pending |
| T05-1 | 05 | 3 | NET-03, NET-04 | T-01-16,18 | input validation, CSP | unit | `npm run lint && npm run build` | — | pending |
| T05b-1 | 05b | 3 | NET-05 | T-01-17 | role check on kick | unit | `npm run lint && npm run build` | — | pending |
| T06-1 | 06 | 4 | ALL | T-01-20,21 | resource disposal | integration | `npm test` | — | pending |

*Status: pending · green · red · flaky*

---

## Wave 0 Requirements

- [x] `mocha` + `@types/mocha` + `@vscode/test-cli` + `@vscode/test-electron` — installed by Plan 01 Task 1
- [x] `.vscode-test.mjs` — created by Plan 01 Task 1
- [x] `src/test/` — test directory structure created by Plan 00
- [x] Stub test files for NET-01 through NET-08, SAFE-01, SAFE-02 — created by Plan 00

*Wave 0 is covered by Plan 00 (test stubs) + Plan 01 Task 1 (framework install + config).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Setup wizard completes in <60s | NET-02 | UX timing requires human evaluation | Launch extension, start wizard, time to session active |
| Join flow completes in seconds | NET-04 | UX timing requires human evaluation | Open second VS Code, join session, time to connected |
| Status bar indicator visibility | NET-05 | Visual verification needed | Check status bar shows correct icon and text in all 3 states |
| Status bar colors per D-10 | D-10 | Visual color verification | Green=connected, Yellow=reconnecting, Red=disconnected |
| Reconnect after sleep/wake | NET-05 | Requires physical sleep/wake cycle | Put machine to sleep, wake, verify auto-reconnect |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (Plan 00 creates stubs)
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending execution
