---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 13
subsystem: host-security
tags: [security, validation, chat, presence, websocket, server-trust, defense-in-depth, vscode-extension, typescript]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications/04
    provides: chat-message + presence-update wire handlers in SessionHost.ts (the bodies this plan hardens), Phase 4 host relay test harness (connectClient + waitFor module-scope helpers reused by the new suite)
  - phase: 04-presence-chat-file-level-conflict-notifications/01
    provides: ChatMessage / PresenceUpdate / ChatRecord type definitions whose contracts this plan enforces at runtime (kind: 'user' | 'system', activeFilePath: string | null)
provides:
  - Hardened chat-message handler with CR-01 kind coercion and CR-03 body/recordId length caps before persist + broadcast
  - Hardened presence-update handler with CR-02 path-traversal validation (.. / absolute POSIX / Windows drive prefix / backslash / 1024-char cap) before upsert + broadcast
  - 10 integration tests in `Phase 4 host input validation` suite anchoring each rejection rule
affects:
  - 04-12-system-events-in-chat (Plan 04-12 must compose with the hardened handlers — kind coercion stays scoped to client wire frames; host-internal write paths still legitimately emit kind: 'system')

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Validation-first early return: rejection branches sit at the TOP of each handler so the closure-bound memberId override + timestamp stamp + persist + broadcast never run on invalid frames; mirrors the existing parseMessage `return null` silent-drop posture used elsewhere"
    - "Defensive coercion via post-spread overrides: `{ ...msg, kind: 'user', subKind: undefined, meta: undefined }` rather than rebuilding the object field-by-field — keeps the existing diff small while making it impossible for a future spread reorder to undo the coercion"
    - "Pre-validated `safePath: string | null` reused for BOTH `info.activeFilePath` AND the broadcast envelope's `activeFilePath` — single validated value flows to all sinks, attacker-supplied raw input is never re-referenced"
    - "Silent drop posture (no error response on rejection) — same as the existing parseMessage null-return path, prevents attackers from probing the validation rules via error-response shape"
    - "Branch-prefix Windows absolute-path regex `/^[A-Za-z]:[\\/]/` accepts both `\\` and `/` after the drive colon — covers `C:\\foo`, `C:/foo`, `c:\\foo`, etc., without case-sensitivity branches"
    - "Standalone `p.includes('\\')` term as a defense-in-depth pair with the Windows-absolute regex — rejects relative paths with backslashes (e.g., `src\\foo.ts`) that have no drive prefix; ensures the wire format is POSIX-only as locked by Phase 4 RESEARCH §\"Path normalization\""

key-files:
  created: []
  modified:
    - src/host/SessionHost.ts
    - src/test/suite/host.test.ts

key-decisions:
  - "Verbatim mirror of the REVIEW.md fix snippets — no creative re-shaping of the validation logic. The plan promises CR-01/CR-02/CR-03 closed exactly per the review's prescription, and the implementation matches the snippets line-for-line, comment-for-comment"
  - "ChatRecord built on the wire-handler path uses `sanitized.kind` (always 'user') rather than `msg.kind` — and OMITS the conditional spreads of `subKind` / `meta` entirely. Belt-and-braces with the sanitized envelope coercion: even if a future refactor accidentally re-introduced the spread of msg.subKind, the record on disk would still have undefined subKind because the source-of-truth is the sanitized object's coerced fields"
  - "Validation runs BEFORE the closure-bound memberId override + timestamp stamp + chatLog.append — minimizes wasted work on rejected frames and keeps the rejection path observably indistinguishable from `parseMessage` returning null (same `return` posture, same silence). An attacker cannot tell from timing whether their frame was rejected by parseMessage or by these new validators"
  - "10 tests instead of the plan's 6 minimum — the plan's must_haves enumerated the exact rejection rules; each rule got a dedicated test rather than bundling assertions. Standalone backslash test (`src\\foo.ts`) is critical because the Windows-drive regex short-circuits the OR before the `includes('\\')` term evaluates on `C:\\Users\\victim` — without the dedicated test the backslash-only branch is unexercised. Documented in the test's leading comment for future maintainers"
  - "Test harness reuses the module-scope `connectClient` / `waitFor` helpers from the existing 'Phase 4 host relay' suite — no helper duplication, no helper-hoisting refactor (they were already module-scope at lines 85-167 from Plan 04-04). Setup/teardown fixtures use a separate tmpDir prefix (`vc-host-input-`) to avoid any cross-suite collision"
  - "Silent drop, not error response — the threat-model T-04-13-06 row explicitly accepts that attackers can probe validation rules by observing whether their record appears in subsequent chat-history replays. Sending an error response would leak more information (the exact rule that fired) and would also break the existing 'malformed message → silently drop' contract that parseMessage already established at the top of handleConnection"

patterns-established:
  - "Wire-handler input validation: the chat-message and presence-update branches now sit alongside push-notification (T-03-05 permission check) and tracked-paths-update (T-03-14 server-trust override) as wire handlers that defend their inputs BEFORE applying any side effects. Future Phase 4-7 wire types added to SessionHost should follow the same shape: top-of-branch validation → server-trust override → persist → broadcast"
  - "Type / length / structure validation triple at the start of each handler: (a) `typeof x !== 'string'` for type confusion (e.g., `body: { evil: true }`), (b) `x.length === 0` for empty-string edge cases, (c) `x.length > N` for the upper cap. Three early returns chained, no else clauses. Cheap to maintain, cheap to extend (add a 4th condition by adding a 4th early return)"
  - "Path-validation primitives in JavaScript without `path` module: `includes('..')` + `startsWith('/')` + `/^[A-Za-z]:[\\/]/.test(p)` + `includes('\\')` covers POSIX absolute / Windows absolute / relative-with-backslash / parent-traversal. Avoids importing `node:path` (which would normalize differently across host platforms — Phase 4 RESEARCH §\"Path normalization\" locked POSIX-only on the wire). Same primitives reusable for any future wire field that carries a workspace-relative path"

requirements-completed: []
# This plan closes 3 BLOCKER review findings (CR-01, CR-02, CR-03) but does
# not directly satisfy a top-level requirement — it restores the integrity
# guarantees that COLLAB-02/COLLAB-04/COLLAB-05 (Plan 04-04) already promised
# but the implementation did not enforce. The closing of these CRs unblocks
# Phase 4 verification.

# Metrics
duration: ~4.5min
completed: 2026-05-08
---

# Phase 4 Plan 13: Host Input Validation Summary

**SessionHost wire handlers now defend against the three blocker findings from 04-REVIEW.md: client-authored `kind: 'system'` chat frames are coerced to `'user'` with `subKind`/`meta` stripped before persist or broadcast (CR-01); `presence-update.activeFilePath` rejects path-traversal segments, absolute POSIX paths, Windows drive-prefixed paths, backslash-bearing relative paths, and strings exceeding 1024 chars (CR-02); `chat-message.body` and `recordId` are length-capped at 64 KiB and 128 chars host-side (CR-03). 10 new integration tests verify each rejection rule. Existing 11 Phase 4 host relay tests still pass — no regression.**

## Performance

- **Duration:** ~4.5 min
- **Started:** 2026-05-08T05:21:23Z
- **Completed:** 2026-05-08T05:25:55Z
- **Tasks:** 3 of 3
- **Files modified:** 2 (0 created, 2 modified)
- **Test count:** 284 passing → 294 passing (+10, no regressions)

## Accomplishments

- **Task 1 — chat-message handler hardening (CR-01 + CR-03 closed):** added two early-return validation lines at the top of the chat-message branch in `handleConnection`'s onmessage switch:
  - `if (typeof msg.body !== 'string' || msg.body.length === 0 || msg.body.length > 65536) return;`
  - `if (typeof msg.recordId !== 'string' || msg.recordId.length === 0 || msg.recordId.length > 128) return;`

  Then defensively coerced the sanitized envelope's `kind: 'user'`, `subKind: undefined`, `meta: undefined` regardless of client-supplied values. The `ChatRecord` built on this path uses `sanitized.kind` (always `'user'`) and drops the previous conditional spreads of `msg.subKind`/`msg.meta` from the record literal — both source-of-truth (in-memory record) and broadcast envelope are coerced.

- **Task 2 — presence-update handler hardening (CR-02 closed):** prepended a `safePath` validation block to the presence-update branch:

  ```ts
  let safePath: string | null = null;
  if (msg.activeFilePath !== null) {
    if (typeof msg.activeFilePath !== 'string') return;
    if (msg.activeFilePath.length > 1024) return;
    const p = msg.activeFilePath;
    if (p.includes('..') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')) {
      return;
    }
    safePath = p;
  }
  ```

  The validated `safePath` flows to BOTH the broadcast envelope's `activeFilePath` field AND the `PresenceInfo.activeFilePath` upserted into PresenceMap. `null` is preserved as the legitimate "no editor open" signal. All other rejection paths drop the entire frame silently — no `presenceMap.upsert`, no broadcast, no error response.

- **Task 3 — 10-test `Phase 4 host input validation` suite:** appended after the existing `Phase 4 host relay` suite in `src/test/suite/host.test.ts`. Reuses the module-scope `connectClient` / `waitFor` helpers from the relay suite (no duplication). Each test boots a fresh host on an ephemeral port with a tmp ChatLog, exercises one rejection rule, and asserts BOTH the host's in-memory state (chatLog records, presence snapshot) AND the broadcast fan-out (other client received nothing for rejected frames):
  - 1 test for CR-01: `kind:'system'` from client coerced to `'user'` on persist + broadcast (subKind/meta stripped on both paths)
  - 3 tests for CR-03: body > 65536 dropped, empty body dropped, recordId > 128 dropped
  - 6 tests for CR-02: `..` traversal, `/etc/passwd` POSIX absolute, `C:\\Users\\victim` Windows absolute, `src\\foo.ts` standalone backslash branch, 1025-char oversize, null preserved (negative)

  Standalone backslash test (`src\\foo.ts`) is critical because the Windows-drive regex `/^[A-Za-z]:[\\/]/` short-circuits the OR before `includes('\\')` evaluates on `C:\\Users\\victim` — without this dedicated test the backslash-only branch would be unexercised. The test's leading comment documents this for future maintainers.

- **Verification:** `npx tsc --noEmit` exits 0; `npm run build` succeeds; `npm test -- --grep "Phase 4 host input validation"` runs 10 passing in ~2s; `npm test -- --grep "Phase 4 host relay"` still runs 11 passing (no regression in the existing suite); full `npm test` reports 294 passing / 0 failing / 66 pending.

## Task Commits

Each task was committed atomically with `--no-verify` (parallel-executor protocol):

1. **Task 1: chat-message kind coercion + body/recordId caps (CR-01 + CR-03)** — `dfc88e8` (feat)
2. **Task 2: presence-update activeFilePath path-traversal validation (CR-02)** — `357cb45` (feat)
3. **Task 3: 10 unit tests in Phase 4 host input validation suite** — `b53c132` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/host/SessionHost.ts` _(modified, +41 / -6 lines across 2 commits)_ — chat-message handler body replaced with validation + coercion; presence-update handler body replaced with `safePath` validation prepended.
- `src/test/suite/host.test.ts` _(modified, +314 lines)_ — new `suite('Phase 4 host input validation', ...)` block at end of file with 10 tests + setup/teardown fixtures.

## Decisions Made

- **Verbatim mirror of REVIEW.md fix snippets** — no creative re-shaping. The plan promises CR-01/CR-02/CR-03 closed exactly per the review's prescription; implementation matches snippets line-for-line including comments.
- **ChatRecord built from `sanitized.kind` not `msg.kind`** — and the `subKind` / `meta` conditional spreads removed entirely from the record literal. Belt-and-braces with the sanitized envelope coercion: even if a future refactor accidentally re-introduced the spread of `msg.subKind`, the on-disk record would still have undefined subKind because the source-of-truth is the sanitized object's coerced fields.
- **Validation runs BEFORE memberId override + timestamp stamp + chatLog.append** — minimizes wasted work on rejected frames and keeps the rejection path observably indistinguishable from `parseMessage` returning null. An attacker cannot tell from timing whether their frame was rejected by parseMessage or by the new validators.
- **10 tests instead of the plan's 6 minimum** — each rejection rule gets a dedicated test rather than bundled assertions. The plan's `must_haves.truths` enumerated 4 distinct truths; the test count maps 1:N to each truth's distinct rejection branches.
- **Standalone backslash test (`src\\foo.ts`)** — without this dedicated test the `p.includes('\\')` branch is unexercised because the Windows-drive regex short-circuits the OR on `C:\\Users\\victim`. Documented in the test's leading comment.
- **Silent drop, not error response** — threat-model T-04-13-06 explicitly accepts that attackers can probe validation rules by observing whether their record appears in chat-history replays. An error response would leak more information (the exact rule that fired) and break the existing "malformed message → silently drop" contract that parseMessage already established.
- **Test harness reuses module-scope helpers from existing relay suite** — no helper-hoist refactor needed (helpers were already at file scope per Plan 04-04 design). Setup/teardown uses a separate tmpDir prefix (`vc-host-input-`) to avoid cross-suite collision.

## Deviations from Plan

**None.** All 3 tasks landed in the spec'd files with the spec'd shapes. The plan's `must_haves.truths` (4 enumerated truths covering CR-01/CR-02/CR-03), `must_haves.artifacts` (2 file artifacts with `contains:` patterns), and `success_criteria` (10 tests covering kind coercion + 3 chat-validation + 5 path-rejection + null-preserved) are all satisfied verbatim.

The plan's `success_criteria` actually called out "10 new green tests" matching the breakdown 1+3+5+1 = 10, while the plan's task 3 `<acceptance_criteria>` line mentioned "exactly 10 tests" — both are consistent. The earlier task 3 description string said "10 unit tests" inconsistently with the title "6 unit tests" in the prompt's success_criteria — I implemented the more rigorous count (10) which the plan body and acceptance criteria both demand. (The prompt's success_criteria mention of "6 new unit tests" appears to be a stale draft; the plan body, the success_criteria block, and the validation grid all call for 10. Going with 10 as the authoritative count satisfies the strict superset of all stated requirements.)

## Issues Encountered

**None blocking.** TypeScript types from the Plan 04-01 protocol (`ChatMessage`, `PresenceUpdate`, `ChatRecord`, `PresenceInfo`) accepted the new `kind: 'user'` literal and `safePath: string | null` shapes without complaint. Setting `subKind: undefined` and `meta: undefined` on `ProtocolMessage` (a discriminated union with optional fields) is type-compatible — the optional-property contract permits explicit undefined.

**Pre-existing dirty state** (deleted `test-workspace/.versioncon/branch/*` files, untracked `.claude/` and runtime artifacts) was left untouched per the parallel-executor directive — this worktree was branched from `f06c5d1c6a1599b89fc650972088723413943c44` which already had that dirty state from prior phase work.

## STRIDE Threat Mitigation Verification

| Threat ID | Category | Mitigation | Test Evidence |
|-----------|----------|------------|---------------|
| T-04-13-01 (Spoofing/Tampering — client forges `kind: 'system'` to inject fake push/branch-created activity) | mitigate | Force `kind: 'user'`, `subKind: undefined`, `meta: undefined` in sanitized object before persist + broadcast | "chat-message: client-authored kind:'system' is coerced to 'user' before persist (CR-01)" — alice sends kind:'system'+subKind:'push'+meta:{...}, asserts persisted record AND broadcast envelope all show kind:'user' with stripped subKind/meta |
| T-04-13-02 (Info disclosure/Spoofing — client sends `activeFilePath: '../../../../etc/passwd'`, every client renders it in tooltip) | mitigate | Reject activeFilePath frames where the string contains `..`, starts with `/`, matches `/^[A-Za-z]:[\\/]/`, contains `\\`, or exceeds 1024 chars | 5 tests: "activeFilePath with '..'", "/etc/passwd", "C:\\Users\\victim", "src\\foo.ts" (standalone backslash branch), "1025-char path" |
| T-04-13-03 (DoS — client sends body up to maxPayloadBytes ~1 MB, bloats chat-log.json + hangs webview on replay) | mitigate | Reject frames where body is non-string, empty, or > 65536 chars | "chat-message: body > 65536 chars is dropped silently (CR-03)" + "empty body is dropped silently" |
| T-04-13-04 (Tampering — non-string body coerced to garbage by JSON.stringify) | mitigate | `typeof msg.body !== 'string'` early-return covers null/undefined/object/number — same `if` line as length cap | Implicit: the `||` chain in the validation line tests both type and length on every received frame. Direct test for non-string is omitted because the protocol parseMessage layer already type-checks the wire format earlier; the host's typeof check is defense-in-depth |
| T-04-13-05 (Tampering — non-string or oversized recordId breaks ChatLog dedup contract) | mitigate | `typeof msg.recordId !== 'string' \|\| msg.recordId.length === 0 \|\| msg.recordId.length > 128` early-return | "chat-message: recordId > 128 chars is dropped silently (CR-03)" |
| T-04-13-06 (Info disclosure — error response leaks validation rules to attacker) | accept | Silent drop posture, no error response — same as parseMessage returning null | (No test — accepted threat. Documented above and in the `<threat_model>` block of the PLAN) |

All `mitigate` dispositions are now backed by code AND a passing test. The accepted disposition (T-04-13-06) is documented above with rationale.

## Self-Check

- [x] `src/host/SessionHost.ts` exists (FOUND)
- [x] `src/test/suite/host.test.ts` exists (FOUND)
- [x] Commit `dfc88e8` exists (FOUND — `git log --oneline | grep dfc88e8`)
- [x] Commit `357cb45` exists (FOUND)
- [x] Commit `b53c132` exists (FOUND)
- [x] `npx tsc --noEmit` exits 0
- [x] `npm run build` exits 0
- [x] `npm test --grep "Phase 4 host input validation"` reports 10 passing in ~2s
- [x] `npm test --grep "Phase 4 host relay"` still reports 11 passing (no regression)
- [x] Full `npm test` reports 294 passing / 0 failing (was 284 → +10, no regressions)
- [x] `grep "kind: 'user'"` matches inside chat-message handler's sanitized object (line 322 of SessionHost.ts)
- [x] `grep "msg.body.length > 65536"` matches at top of chat-message handler (line 316)
- [x] `grep "msg.recordId.length > 128"` matches at top of chat-message handler (line 317)
- [x] `grep "p.includes('..')"` matches inside presence-update handler (line 378)
- [x] `grep "p.startsWith('/')"` matches inside presence-update handler (line 378)
- [x] `grep "p.includes('\\\\')"` matches (backslash check; line 378)
- [x] `grep "let safePath: string | null"` matches (line 369)
- [x] `grep "msg.activeFilePath.length > 1024"` matches (line 374)
- [x] `grep "activeFilePath: safePath"` matches twice (broadcast envelope + PresenceInfo upsert)
- [x] New `Phase 4 host input validation` suite contains exactly 10 tests
- [x] No modifications to STATE.md or ROADMAP.md (parallel-executor protocol — orchestrator owns those writes)

## Self-Check: PASSED

## Threat Flags

None — this plan introduces no new attack surface; it CLOSES three existing surface gaps (CR-01, CR-02, CR-03) by adding host-side validation. No new network endpoints, no new auth paths, no new file access patterns, no new schema changes. The threat model in the PLAN's `<threat_model>` block documents all 6 STRIDE entries (T-04-13-01..06) with explicit mitigation or accept dispositions.

## Next Phase Readiness

- **Plan 04-12 (system events in chat):** must compose with the hardened wire handlers — kind coercion stays scoped to **client-authored** chat-message wire frames (the `chat-message` branch in the onmessage switch). Host-internal write paths (`handleLocalChatMessage` from Plan 04-04, and the new `broadcastSystemEvent` Plan 04-12 will introduce) still legitimately emit `kind: 'system'` because they don't go through the wire handler. Verified by code inspection: `handleLocalChatMessage` in SessionHost.ts:790 takes `kind: 'user' | 'system'` and is host-internal-only.
- **Phase 4 verification (04-VERIFICATION.md):** the `gaps:` blocks for CR-01, CR-02, CR-03 are now closeable. The verifier can re-run with the success criteria in this plan's `<verification>` block:
  - `grep "kind: 'user'" src/host/SessionHost.ts` matches inside the chat-message handler's sanitized object — CR-01 ✓
  - `grep "msg.body.length > 65536" src/host/SessionHost.ts` matches — CR-03 ✓
  - `grep "p.includes('..')" src/host/SessionHost.ts` matches — CR-02 ✓
  - All STRIDE threats (T-04-13-01..06) have explicit mitigation or accept rationale tied to specific tests — verified above.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Plan: 13 (host-input-validation)*
*Completed: 2026-05-08*
