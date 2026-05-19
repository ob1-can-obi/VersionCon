---
phase: 07-cloud-mode-relay-server
plan: 02
subsystem: cloud-wire-protocol
tags: [phase-7, wave-1, cloud-envelope, wire-shape, v1, forward-compat, l3-seam, net-06, t-07-04, byte-shape-snapshot]
requires:
  - "06-04 — ProtocolMessage union (envelope wraps the same wire messages)"
provides:
  - "src/network/CloudEnvelope.ts — CloudEnvelope { v:1, sessionId, encrypted:false, payload } interface; wrap/unwrap/serialize/deserialize; EnvelopeShapeError + EnvelopeEncryptedNotSupportedError typed throws"
  - "src/test/suite/cloudEnvelope.test.ts — byte-shape snapshot (literal JSON equality) + 6 unwrap-rejection paths + L3 forward-compat assertion"
affects:
  - "07-04 — CloudTransport (consumes wrap/unwrap on send/receive)"
  - "07-05b — adds optional target?: string field for unicast routing"
  - "07-08 — relay router reads envelope.sessionId only (this is the byte-pass-through contract)"
tech-stack:
  added: []
  patterns:
    - "Literal types as forward-compat discriminator: v:1 and encrypted:false are LITERAL types (not number/boolean) so a future EncryptedCloudEnvelope variant produces a discriminated union narrowable via `if (env.encrypted)` — version bump avoided when L3 ships"
    - "Byte-stable serialize via insertion-order field construction: wrap() always builds fields in canonical order (v, sessionId, encrypted, payload) so JSON.stringify produces a snapshot-stable wire string. No replacer, no whitespace arg — those would break determinism"
    - "Loud forward-compat failure (EnvelopeEncryptedNotSupportedError) instead of silent drop: when a v1 client encounters encrypted:true from an L3-upgraded peer, it throws a typed subclass of EnvelopeShapeError so version skew is debuggable at the catch site"
    - "Layered framing vs protocol: envelope's job is framing (v/sessionId/encrypted/payload); payload's protocol discriminator (type) is parseMessage's job downstream. unwrap() does NOT deep-validate payload.type — that's protocol.ts's responsibility"
key-files:
  created:
    - "src/network/CloudEnvelope.ts (172 lines)"
    - "src/test/suite/cloudEnvelope.test.ts (220 lines)"
  modified: []
key-decisions:
  - "encrypted:false is set as a LITERAL type (not boolean) so the type system can discriminate v1 vs future L3 envelopes via `if (env.encrypted) {…ciphertext branch…} else {…ProtocolMessage branch…}` — no version bump required when L3 ships"
  - "EnvelopeEncryptedNotSupportedError extends EnvelopeShapeError (single hierarchy) so callers catching the base class still catch the forward-compat case; the subclass is a refinement for diagnostics, not a separate hierarchy"
  - "unwrap() validates shape only — payload's type-discriminator validation is left to protocol.ts/parseMessage downstream. Two responsibilities, two layers, two catch points"
  - "serialize uses JSON.stringify with NO replacer and NO whitespace arg — both would break byte-shape determinism that the snapshot test pins"
  - "deserialize wraps JSON.parse failures in EnvelopeShapeError so callers see exactly ONE typed-error surface across both 'bad JSON' and 'wrong shape' cases — single catch suffices"
patterns-established:
  - "Wire-shape forward-compat: literal discriminator + typed subclass-error for unknown discriminator value — future L3 can swap encrypted:true without v-bump"
  - "Byte-shape snapshot tests for wire protocols: literal JSON-string equality against a fixed example to pin field ordering"
  - "Layered envelope/payload validation: framing layer validates frame shape; protocol layer validates payload shape — two catch points, two error types"
requirements-completed: [NET-06]

duration: ~5min
started: "2026-05-18T23:37:00.000Z"
completed: "2026-05-18T23:40:00.000Z"
---

# Plan 07-02: CloudEnvelope Wire Protocol Summary

**Cloud-mode envelope module — v1 wire shape ({v:1, sessionId, encrypted:false, payload}) with typed forward-compat errors and a byte-shape snapshot test that pins the relay's byte-pass-through contract.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-18T23:37Z
- **Completed:** 2026-05-18T23:40Z
- **Tasks:** 3 (RED test commit → GREEN implementation commit → SUMMARY)
- **Files created:** 2 (`src/network/CloudEnvelope.ts`, `src/test/suite/cloudEnvelope.test.ts`)

## Accomplishments

- Shipped the v1 cloud-mode envelope module that wraps every ProtocolMessage flowing through a CloudTransport (host ↔ relay ↔ client).
- Pinned the byte-shape contract that lets the relay (07-08 router.ts) stay a dumb byte-forwarder reading only `envelope.sessionId` — payload bytes are never inspected, which keeps the relay free of VersionCon protocol semantics and unlocks the future L3 E2E seam.
- Added 11 passing tests across two Mocha suites (`Phase 7 — envelope shape` happy paths + `Phase 7 — envelope reject` rejection paths):
  - Byte-shape snapshot: literal JSON equality against `{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"ping"}}`
  - 6 unwrap rejection paths: non-object input, wrong v, missing sessionId, missing payload, encrypted:non-boolean, encrypted:true (forward-compat L3-skew assertion)
  - serialize/deserialize round-trip with byte identity
  - EnvelopeEncryptedNotSupportedError instanceof check (loud forward-compat failure)

## TDD Gate Sequence

| Phase | Commit | Subject |
|-------|--------|---------|
| RED | `973d071` | `test(07-02): add failing CloudEnvelope envelope-shape suite (RED)` |
| GREEN | `6f8ac80` | `feat(07-02): implement CloudEnvelope wire-shape module (GREEN)` |
| REFACTOR | — | none required — implementation already at target shape |

## Verification

- `npx tsc` — clean (no type errors)
- `npx vscode-test` — **878 passing, 66 pending** (full suite, including the new 11 Phase 7 envelope tests)
- Source-grep contracts:
  - `import type { ProtocolMessage } from './protocol.js'` present in CloudEnvelope.ts
  - No replacer/whitespace arg in JSON.stringify (byte-shape determinism preserved)
  - encrypted:false literal type pinned by `interface CloudEnvelope { …; encrypted: false; … }`

## Orchestrator note

The executor agent for this plan was running under `isolation="worktree"` during the parent wave dispatch, but commits landed on `main` directly (not on the worktree branch). The agent was killed shortly after the GREEN commit, before it could write this SUMMARY.md — so this file was written by the orchestrator after verifying the commits and re-running the test suite. The remaining Wave 1 plans (07-01, 07-03) will be re-dispatched in sequential mode (no `isolation="worktree"`) to avoid the race.
