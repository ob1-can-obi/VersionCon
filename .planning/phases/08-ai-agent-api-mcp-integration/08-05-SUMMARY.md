---
phase: 08-ai-agent-api-mcp-integration
plan: 05
subsystem: mcp
tags: [phase-8, wave-2, mcp-json, consent, jsonc-parser, first-run-ux, T-08-07, T-08-09]

# Dependency graph
requires:
  - phase: 08-ai-agent-api-mcp-integration/08-01
    provides: "jsonc-parser@3.3.1 + versioncon.mcp.consent / .enabled settings keys + src/mcp/ directory"
provides:
  - "src/mcp/mcpConfig.ts (125 lines) — upsertMcpConfig + removeMcpConfig using jsonc-parser.modify + applyEdits (NEVER JSON.stringify). Preserves user comments + sibling MCP entries (postgres, github, ...) byte-identically. T-08-09 mitigation by construction."
  - "src/mcp/consent.ts (77 lines) — ensureConsent() first-run modal mirroring Phase 7 UriHandler T-07-10. Literal CONSENT_PROMPT from CONTEXT D-5 / RESEARCH §1278. ConfigurationTarget.Global persistence."
  - "13 mcpConfigWriter tests (8 behavior + 5 source-grep) — T-08-09 sibling preservation, T-08-07 no-token-leak, Pitfall 3 self-healing, Pitfall 4 no-JSON.stringify."
  - "12 mcpConsent tests (5 behavior + 7 source-grep) — all 4 ensureConsent branches (already-granted, Allow, Decline, dismiss) + literal prompt copy + Global scope + Allow/Decline button literals."
  - "Test floor: 1110 baseline (plus 08-04's +22 mcpServer tests already on disk) → 1157 passing, 0 failing. Plan 08-05 contributes +25 new tests."
affects: [08-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "JSONC-edit-in-place pattern: jsonc-parser.modify(text, path, value, opts) + jsonc-parser.applyEdits(text, edits) — the CORRECT alternative to JSON.parse/JSON.stringify when the file contains comments OR siblings managed by other tools. First in-repo use."
    - "Source-grep gate with comment stripping: `text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/.*$/gm, '')` before regex check. Required so JSDoc references to prohibited APIs (used to DOCUMENT the rule) don't trip the gate."
    - "Modal consent persistence at ConfigurationTarget.Global — the once-per-machine grant pattern, mirrors Phase 7 T-07-10 UriHandler consent. Test environment supports Global writes (no fallback to Workspace needed)."
    - "Dismiss-as-decline semantics: undefined response from showInformationMessage is treated identically to 'Decline' — flips enabled=false so activations don't loop-prompt."

key-files:
  created:
    - src/mcp/mcpConfig.ts
    - src/mcp/consent.ts
    - src/test/suite/mcpConfigWriter.test.ts
    - src/test/suite/mcpConsent.test.ts
    - .planning/phases/08-ai-agent-api-mcp-integration/08-05-SUMMARY.md
  modified: []

key-decisions:
  - "Use jsonc-parser.parse (NOT JSON.parse on regex-stripped raw) in Test 2 of mcpConfigWriter. A naive `raw.replace(/\\/\\/.*$/gm, '')` truncates URL values mid-string at `//` inside string literals (e.g. 'http://localhost' becomes 'http:'). jsonc-parser.parse natively handles comments. Bug-fix applied during GREEN phase."
  - "Strip comments before source-grep gates for prohibited APIs (JSON.stringify, headers, Bearer, authorization, ConfigurationTarget.Workspace). JSDoc and inline comments routinely mention prohibited APIs to DOCUMENT the rule — the gate must scan CODE only."
  - "N-08-01 false-positive in mcpReaders.test.ts: the gate regex `\\bimport\\b.*from.*\\bsrc/auth\\b` matched my `// N-08-01: no import from src/auth/.` comment in mcpConfig.ts and consent.ts because the comment contained both 'import' and 'src/auth/' on the same line. Reworded comments to `// N-08-01: this module references no auth-layer symbols (...)`. Semantic content preserved; gate now green. The gate test is correctly doing defense-in-depth — the fix is in the offender side."
  - "ConsentTarget.Global verified in test environment: the test setup/teardown writes consent=false and enabled=true to Global scope and reads back successfully. No fallback to ConfigurationTarget.Workspace was needed (the plan's note allowed a fallback if @vscode/test-electron restricted Global writes — restriction does not apply at the resolved VS Code version 1.121.0)."
  - "Literal CONSENT_PROMPT byte-identical to CONTEXT D-5 / RESEARCH §1278 — concatenated as two adjacent string literals so the source-grep test matches a substring of the literal source representation rather than the concatenated runtime value."

patterns-established:
  - "Pattern: jsonc-parser.modify(text, ['parent', 'child'], value, { formattingOptions }) + applyEdits(text, edits) for atomic in-place JSONC edits. Preserves user comments + sibling entries. NEVER use JSON.parse/JSON.stringify on a file that may contain comments OR be co-managed by another tool — that path destroys both."
  - "Pattern: source-grep gates strip comments before scanning when the prohibited literal is something the code DOCUMENTS in its own JSDoc. Without stripping, the documentation IS the violation. Stripping is `text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/.*$/gm, '')`."
  - "Pattern: ConfigurationTarget.Global modal-consent with dismiss-as-decline semantics — the user grants once per machine; silent dismissal flips a 'enabled' bit so we don't loop-prompt. Mirrors Phase 7 UriHandler T-07-10. CONSENT_PROMPT is a literal constant testable via source-grep."
  - "Pattern: ENOENT-soft remove. removeMcpConfig on a missing file is a no-op (no throw) — the file may have been hand-deleted by the user or never written in the first place. Caller (lifecycle.ts on deactivate) is unaware of the asymmetry."

requirements-completed: [AI-01]

# Metrics
duration: ~45min
completed: 2026-05-21
---

# Phase 8 Plan 05: MCP Config Writer + Consent Modal Summary

**`jsonc-parser`-backed `.vscode/mcp.json` + `.mcp.json` writer (preserves user comments + sibling MCP entries byte-identically — T-08-09 mitigation), plus first-run consent modal mirroring Phase 7 UriHandler T-07-10 with the literal `'VersionCon wants to register an MCP server...'` prompt copy from CONTEXT D-5 / RESEARCH §1278.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2 (Task 1 mcpConfig + tests; Task 2 consent + tests)
- **Files created:** 4 source + 1 summary
- **Files modified:** 0 (all 4 source files are net-new)
- **Tests added:** 25 (13 mcpConfigWriter + 12 mcpConsent)
- **Cumulative tests:** 1110 baseline → 1157 passing (+47; this plan: +25; 08-04 already on disk: +22)
- **Atomic commits:** 4 task commits (RED + GREEN per task)

## Accomplishments

- **`src/mcp/mcpConfig.ts` (125 LOC):** `upsertMcpConfig(workspaceFolder, configRelPath, serverName, url)` + `removeMcpConfig(workspaceFolder, configRelPath, serverName)` using `jsonc-parser.modify` + `applyEdits`. Targets exact path `['servers', serverName]` so siblings under `servers` are byte-untouched. Writes ONLY `{ type: 'http', url }` — zero `headers` / `Bearer` / `authorization` / `token` literals (T-08-07 by construction). Creates `.vscode/` parent dir via `fs.mkdir({ recursive: true })`. ENOENT-soft on remove.
- **`src/mcp/consent.ts` (77 LOC):** `ensureConsent(): Promise<boolean>` async modal. Reads `versioncon.mcp.consent` first → short-circuits to `true` if already granted. Otherwise shows `vscode.window.showInformationMessage(CONSENT_PROMPT, { modal: false }, 'Allow', 'Decline')`. Allow path: persists `consent=true` Global, returns `true`. Decline OR undefined: persists `enabled=false` Global, returns `false`. Literal CONSENT_PROMPT byte-identical to CONTEXT D-5 / RESEARCH §1278.
- **T-08-09 (sibling preservation) test-pinned:** Test 2 of mcpConfigWriter loads a fixture with a `// Local Postgres MCP for dev` comment, a `postgres` stdio entry, and a `github` http entry. After `upsertMcpConfig(...'versioncon'...)`, the comment AND both sibling entries are verified byte-identical via `jsonc-parser.parse`.
- **T-08-07 (no token leak) test-pinned:** Test 7 of mcpConfigWriter asserts the written `.vscode/mcp.json` contains ZERO matches for `\bheaders\b/i`, `\bBearer\b`, `\bauthorization\b/i`, `\btoken\b/i`. Source-grep gate also asserts no occurrences in the mcpConfig.ts CODE itself (comments stripped).
- **All four ensureConsent branches test-verified:** already-granted (no prompt), Allow (consent=true), Decline (enabled=false), dismiss (enabled=false). `ConfigurationTarget.Global` worked in the test environment (no fallback required).
- **N-08-01, N-08-04, N-08-05, N-08-06 preserved:** zero auth imports, zero console.*, zero src/network/ changes, zero relay/ changes.

## Task Commits

1. **Task 1 RED — failing tests for mcpConfig.ts** — `25efa47` (test)
2. **Task 1 GREEN — mcpConfig.ts implementation** — `6c07819` (feat)
3. **Task 2 RED — failing tests for consent.ts** — `28f9ceb` (test)
4. **Task 2 GREEN — consent.ts implementation + N-08-01 comment fix in both files** — `a72cca6` (feat)

**Plan metadata:** (this SUMMARY commit — to follow as `docs(08-05)`)

## Files Created/Modified

- `src/mcp/mcpConfig.ts` — 125 lines; jsonc-parser-backed upsert + remove for `.vscode/mcp.json` and `.mcp.json`
- `src/mcp/consent.ts` — 77 lines; ensureConsent first-run modal
- `src/test/suite/mcpConfigWriter.test.ts` — 319 lines; 8 behavior + 5 source-grep tests
- `src/test/suite/mcpConsent.test.ts` — 247 lines; 5 behavior + 7 source-grep tests
- `.planning/phases/08-ai-agent-api-mcp-integration/08-05-SUMMARY.md` — this file

## Verification Results (per `<output>` requirements)

1. **jsonc-parser preserves the `// Local Postgres MCP for dev` comment** — confirmed. The literal output of mcpConfigWriter Test 2 read-back (from a direct node script):

   ```
   {
     // Local Postgres MCP for dev
     "servers": {
       "postgres": {
         "type": "stdio",
         "command": "postgres-mcp",
         "args": ["--db", "dev"]
       },
       "github": {
         "type": "http",
         "url": "http://localhost:7000/github-mcp"
       },
       "versioncon": {
         "type": "http",
         "url": "http://127.0.0.1:5000/mcp"
       }
     }
   }
   ```

   The leading `// Local Postgres MCP for dev` line survives byte-identically. `postgres` and `github` entries are byte-untouched. `versioncon` is inserted at the end of the `servers` object with the canonical `{ type, url }` shape.

2. **JSON path used in modify calls:** `['servers', 'versioncon']` (passed by lifecycle.ts in 08-09; `versioncon` is the `serverName` arg).

3. **Both config paths handled:**
   - `.vscode/mcp.json` (VS Code Copilot + Cursor read this in-workspace per RESEARCH §B.4)
   - `.mcp.json` at workspace root (Claude Code reads this per RESEARCH §B.4)

   Test 8 of mcpConfigWriter calls `upsertMcpConfig` against BOTH paths and asserts both files materialize with identical shape.

4. **Consent prompt copy committed (verbatim — matches RESEARCH §1278 byte-for-byte):**

   ```
   VersionCon wants to register an MCP server with this workspace so AI agents (Claude Code, Copilot, Cursor) can read your collab state. The server is local-only and read-only. Allow?
   ```

   In source as a 2-literal concatenation:
   ```typescript
   const CONSENT_PROMPT =
     'VersionCon wants to register an MCP server with this workspace so AI agents (Claude Code, ' +
     'Copilot, Cursor) can read your collab state. The server is local-only and read-only. Allow?';
   ```

5. **Consent persistence test ran successfully with `ConfigurationTarget.Global`** — no fallback to `.Workspace` was needed. The `@vscode/test-electron 1.121.0` environment supports Global setting writes for the `versioncon.mcp.consent` and `versioncon.mcp.enabled` keys (these are declared in `package.json` `contributes.configuration.properties` per plan 08-01).

6. **T-08-07 + T-08-09 mitigations test-verified:**
   - T-08-07 (no token leak): Test 7 of mcpConfigWriter + source-grep gate on mcpConfig.ts CODE (comments stripped) — both green. Zero occurrences of `headers` / `Bearer` / `authorization` / `token` in either the written file OR the source.
   - T-08-09 (sibling preservation): Test 2 of mcpConfigWriter — postgres + github + comment all survive byte-identically after the versioncon upsert.

7. **New test count delta + cumulative:**

   | Suite | Tests | Notes |
   |---|---|---|
   | `Phase 8 — mcpConfigWriter` | 8 | T1 empty file; T2 T-08-09 sibling preservation; T3 stale port self-healing; T4 mkdir recursive; T5 remove sibling-safe; T6 remove on missing file no-op; T7 T-08-07 no-token-leak; T8 both config paths |
   | `Phase 8 — mcpConfig.ts source-grep` | 5 | Pitfall 4 (no JSON.stringify in CODE); T-08-07 (no header/Bearer/authorization in CODE); jsonc-parser import + modify + applyEdits; N-08-04 (no console.*); N-08-01 (no src/auth/ import) |
   | `Phase 8 — ensureConsent (first-run modal)` | 5 | already-granted (no prompt); Allow persists consent=true; Decline persists enabled=false; dismiss persists enabled=false; prompt invoked with Allow + Decline literals |
   | `Phase 8 — consent.ts source-grep` | 7 | literal prompt copy (Claude Code + Copilot + Cursor + local-only + read-only); Global (not Workspace); Allow + Decline literals; ensureConsent export; showInformationMessage call; N-08-04; N-08-01 |
   | **Plan 08-05 total** | **25** | All passing, 0 failing |

   Cumulative: 1110 baseline → 1157 passing (+47 = 25 from plan 08-05 + 22 from 08-04's mcpServer.test.ts which was already on disk at dispatch time).

8. **NEITHER file imports from `src/auth/`** — N-08-01 preserved:
   - `grep -E '^import.*from.*src/auth|^import.*from\\s+["'\''][^"'\'']*\\/auth\\/' src/mcp/mcpConfig.ts | wc -l` = 0
   - `grep -E '^import.*from.*src/auth|^import.*from\\s+["'\''][^"'\'']*\\/auth\\/' src/mcp/consent.ts | wc -l` = 0
   - The mcpReaders.test.ts gate test that scans all of src/mcp/ for the regex `\\bimport\\b.*from.*\\bsrc/auth\\b` is GREEN after the comment-rewording fix.

## Decisions Made

See frontmatter `key-decisions` for the full list. Highlights:

1. **Use `jsonc-parser.parse` (not JSON.parse on regex-stripped raw) for test assertion** of T-08-09 sibling preservation. A regex `replace(/\\/\\/.*$/gm, '')` truncates URL string literals at `//` (e.g. `http://localhost` → `http:`). jsonc-parser's own parser understands comments natively.
2. **Strip comments before source-grep gates** when scanning for the literal name of the prohibited API (JSON.stringify, headers, Bearer, ConfigurationTarget.Workspace, etc.). JSDoc routinely mentions these literals to document the prohibition.
3. **N-08-01 comment-rewording**: the mcpReaders.test.ts gate `\\bimport\\b.*from.*\\bsrc/auth\\b` flagged my literal docstring `// N-08-01: no import from src/auth/.`. Reworded to `// N-08-01: this module references no auth-layer symbols (...)` — preserves semantic content without tripping the gate. The gate IS correctly doing defense-in-depth; the fix belongs on the offender side.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test 2 (T-08-09 sibling preservation) — regex strip truncates URLs at `//`**

- **Found during:** Task 1 GREEN, first test run
- **Issue:** The plan's `<action>` sketch for Test 2 used `JSON.parse(raw.replace(/\\/\\/.*$/gm, ''))` to strip line comments before parsing. But the `//` regex matches the `//` in URL string values (e.g. `"url": "http://localhost:7000/github-mcp"`), truncating the URL at `http:` and producing a malformed JSON document. JSON.parse then throws at position 188.
- **Fix:** Replaced the comment-strip approach with `jsonc-parser.parse(raw)` — jsonc-parser is comment-aware and parses JSONC natively. No regex-based comment stripping needed for the JSONC document itself.
- **Files modified:** `src/test/suite/mcpConfigWriter.test.ts` (Test 2 body, +1 import of `parseJsonc`).
- **Verification:** Test 2 now passes; the postgres + github entries are verified byte-identical via `parsed.servers.postgres` / `parsed.servers.github` deep-equality assertions.
- **Committed in:** `6c07819` (Task 1 GREEN commit, alongside the production code).

**2. [Rule 1 - Bug] source-grep gate for JSON.stringify trips on JSDoc reference**

- **Found during:** Task 1 GREEN, source-grep test run
- **Issue:** The plan's `<action>` sketch for the source-grep gate was `assert.doesNotMatch(text, /\\bJSON\\.stringify\\b/, ...)` on the raw file text. The mcpConfig.ts JSDoc header documents the prohibition: `// jsonc-parser instead of JSON.parse/JSON.stringify (Pitfall 4 — ...)`. The gate (correctly identifying the documentation as containing the literal) failed.
- **Fix:** Strip block + line comments BEFORE running the regex check: `text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/.*$/gm, '')`. This pattern was already used elsewhere in the same test file for the headers/Bearer/authorization gate — applied consistently to the JSON.stringify gate. The gate now scans CODE only, not documentation.
- **Files modified:** `src/test/suite/mcpConfigWriter.test.ts` (test name updated to `mcpConfig.ts has no JSON.stringify in CODE`, body adds the comment-strip step).
- **Verification:** The test passes. Manual `sed`-based comment-strip + `grep -c "JSON.stringify"` on mcpConfig.ts returns 0.
- **Committed in:** `6c07819` (Task 1 GREEN commit).

**3. [Rule 1 - Bug] N-08-01 gate (in mcpReaders.test.ts) trips on plain-language comment**

- **Found during:** Task 2 GREEN, full test-suite run
- **Issue:** Plan 08-02's mcpReaders.test.ts (already-landed) has a source-grep gate `/\\bimport\\b.*from.*\\bsrc/auth\\b/` that scans ALL files under `src/mcp/`. My N-08-01 docstring comments in mcpConfig.ts and consent.ts (`// N-08-01: no import from src/auth/.`) contain both `import` and `src/auth` on the same line, so the gate flagged them as offenders.
- **Fix:** Reworded the comments to `// N-08-01: this module references no auth-layer symbols (...)` in both mcpConfig.ts (line 31) and consent.ts (line 25). Semantic content (documenting the rule) is preserved; the literal pattern that trips the gate is gone. The gate test (in 08-02's territory) is left UNTOUCHED — it is correctly doing defense-in-depth source-grep on import statements + comments together; my offender-side fix is the right place.
- **Files modified:** `src/mcp/mcpConfig.ts` (line 31), `src/mcp/consent.ts` (line 25).
- **Verification:** `grep -rE "import.*from.*src/auth" src/mcp/` returns 0 lines for both files. The mcpReaders.test.ts gate test now passes (1 → 0 failing in the cumulative test run).
- **Committed in:** `a72cca6` (Task 2 GREEN commit, batched with consent.ts creation).

---

**Total deviations:** 3 auto-fixed ([Rule 1] x 3 — all source-grep regex pitfalls discovered during GREEN, fixed inline)
**Impact on plan:** All deviations were test-side or comment-side corrections discovered during GREEN. No production-code shape was changed from the planner's sketch. The mcpConfig.ts + consent.ts source files are byte-for-byte the `<interfaces>` block from the plan. No scope creep. No architectural changes.

## Issues Encountered

- **`npm test` requires no other VS Code instance running.** The `@vscode/test-electron` runner errors out with `Running extension tests from the command line is currently only supported if no other instance of Code is running.` if the user has VSCode open. Resolved by closing the editor before each verification run. Existing project quirk — not introduced by this plan. The `until ... done` loop pattern was used to wait for completion.

## User Setup Required

None — no external service configuration needed. Plan 08-05 ships pure file-system + VS Code-settings-API code.

## Next Phase Readiness

**Plan 08-09 (integration / extension.ts wiring) is unblocked.** Specifically:

1. `src/mcp/mcpConfig.ts` exports `upsertMcpConfig(workspaceFolder, configRelPath, serverName, url): Promise<void>` and `removeMcpConfig(workspaceFolder, configRelPath, serverName): Promise<void>` — function signatures match 08-04's `lifecycle.ts` injection-seam types. Lifecycle's `onMcpStart` callback wires `upsertMcpConfig` to BOTH config paths (`.vscode/mcp.json` + `.mcp.json`); `onMcpStop` wires `removeMcpConfig` to both. No further changes to mcpConfig.ts required.
2. `src/mcp/consent.ts` exports `ensureConsent(): Promise<boolean>` — matches 08-04's `lifecycle.ts` `EnsureConsentFn` injection-seam type. Lifecycle's startup path calls `ensureConsent()` before invoking `startMcpServer`; declined consent (`false`) skips the server bootstrap entirely.
3. Both files import only from `vscode` (consent.ts) + `jsonc-parser` + `node:fs/promises` + `node:path` (mcpConfig.ts). Zero coupling to any other 08-XX plan's code surface. Safe to wire from extension.ts in 08-09.

**No blockers, no follow-up tasks.**

---

## Self-Check: PASSED

- [x] `src/mcp/mcpConfig.ts` exists (125 lines, jsonc-parser + modify + applyEdits, no JSON.stringify in CODE, no headers/Bearer/authorization/token in CODE)
- [x] `src/mcp/consent.ts` exists (77 lines, literal CONSENT_PROMPT, ConfigurationTarget.Global, 'Allow' + 'Decline' literal buttons, no console.*)
- [x] `src/test/suite/mcpConfigWriter.test.ts` exists (319 lines, 8 behavior + 5 source-grep tests)
- [x] `src/test/suite/mcpConsent.test.ts` exists (247 lines, 5 behavior + 7 source-grep tests)
- [x] Commit `25efa47` exists in git log (test(08-05): RED — failing tests for mcpConfig.ts upsert/remove)
- [x] Commit `6c07819` exists in git log (feat(08-05): GREEN — mcpConfig.ts upsert/remove with jsonc-parser)
- [x] Commit `28f9ceb` exists in git log (test(08-05): RED — failing tests for consent.ts first-run modal)
- [x] Commit `a72cca6` exists in git log (feat(08-05): GREEN — consent.ts first-run modal + N-08-01 comment fix)
- [x] `npm test` reports 1157 passing, 0 failing
- [x] `npx tsc --noEmit -p .` exits 0 (zero plan-08-05-related errors)
- [x] All N-08-XX gates relevant to this plan pass (N-08-01, N-08-04, N-08-05, N-08-06, T-08-07, T-08-09 — all green)
- [x] `engines.vscode` byte-identical at `^1.85.0` (unchanged from 08-01)

---
*Phase: 08-ai-agent-api-mcp-integration*
*Completed: 2026-05-21*
