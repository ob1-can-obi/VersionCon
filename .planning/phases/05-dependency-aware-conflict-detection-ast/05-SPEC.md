---
phase: 05-dependency-aware-conflict-detection-ast
spec_locked: 2026-05-11
status: ready-for-planning
ambiguity_score: 3/10
mode: autonomous (user invoked /gsd-autonomous-equivalent for phase 5)
locked_decisions:
  - "Languages tier 1 (this phase): JavaScript, TypeScript, Python — proven web-tree-sitter@0.26 WASM support"
  - "Languages tier 2 (deferred): Java, C++ — flagged in STATE.md Blockers as 'unvalidated'. CONF-09 still requires them; build the architecture so adding them later is a one-WASM-and-one-extractor PR. Acceptable to defer the actual grammars to a 5.1 sub-phase if WASM bring-up turns out hard. SC-3 fallback path covers them in the meantime."
  - "AST process: child_process.fork()'d Node worker, IPC via process.send / process.on('message'). Per SC-2 (extension host must never freeze)."
  - "Trigger: on host-side broadcastPush AFTER push-history append. Host runs analysis once, includes affectedSymbols in the broadcast payload, members render notifications from the broadcast (NOT re-analyze locally — keeps each member's CPU low and analysis consistent across the team)."
  - "Tracked-paths is the membership signal — Plan 03-14 + Plan 04-06 already broadcast which files each member is editing. Phase 5 reads peer tracked-paths from PresenceMap + the per-member tracked file content to build the call-graph index."
  - "Skip patterns + size cap (SC-4): >500KB files, paths containing node_modules / dist / .min. / build / target / out — hard-skip from indexing AND from change-analysis."
  - "Smart push summary: enhance the existing system-event ChatRecord (Plan 04-12 broadcastPush). Add an optional `affectedSymbols: Array<{name, kind, callers: Array<{memberId, displayName, file, line}>}>` field on the system-event meta. ChatPanel + ActivityLog render this when present, fall back to file-count when absent."
  - "WASM grammars vendored under `src/vendor/tree-sitter/` and copied to `dist/` by esbuild — same pattern as Plan 04-10 chat webview assets (markdown-it + highlight.js). No runtime download."
---

# Phase 5 Spec: Dependency-Aware Conflict Detection (AST)

## Background

Phase 4 ships file-level conflict notifications: "Alice pushed file foo.ts that you have open." Useful, but noisy when the change is structural (rename a comment, reformat) and silent when the change is symbol-level inside a file you DON'T have open but DO depend on.

Phase 5 upgrades to **symbol-level** dependency analysis:
- Before broadcasting a push, the host parses the changed files via tree-sitter, extracts the symbols modified (functions, methods, variables, classes, imports, exports)
- For each connected member, the host cross-references those changed symbols against the member's tracked paths' call-graph
- The push system-event ChatRecord carries `affectedSymbols` payload — members see "Alice modified `calculate_total()` — you call this in `cart.ts:34`" instead of "Alice pushed cart-helpers.ts"

This is VersionCon's product differentiator (PROJECT.md: "Teams collaborate on code without merge conflict pain — dependency-aware tracking means you only stop coding when changes genuinely affect what you're working on").

## Locked decisions

See frontmatter. Most ambiguity-prone questions are answered there.

## Success Criteria (testable, from ROADMAP)

1. **Function-level attribution**: after a teammate pushes a change, a user who calls a modified function sees a notification like `calculate_total() was modified by Alice — you call this in line 34` (not "file changed"). Verified via integration test: stage a function rename, simulate a push, assert the broadcast payload's `affectedSymbols` contains the renamed symbol AND the calling member's reference (line + file).
2. **Non-blocking extension host**: AST analysis runs in a separate child process (`child_process.fork`). Push flow returns within UI-spec budget (≤200ms perceived). Verified via timing test: large multi-file push completes the host's `broadcastPush` synchronous path in <50ms; the actual AST work runs async and the chat record is amended (or a follow-up `push-impact` message broadcast) when ready.
3. **Multi-language support**: dependency analysis works for **Python, JavaScript, TypeScript** at minimum (tier 1). Java + C++ register as supported in `AstFactory` but may register the file-level fallback adapter (SC-3 calls out "for all other languages, the system falls back to file-level and line-level detection"). The 4-language interface is in place; tier-2 grammars can land in 5.1 without architectural change.
4. **Size + path skip patterns**: files >500KB are skipped (entry not indexed, change ignored). Paths matching `node_modules/`, `dist/`, `build/`, `.min.`, `target/`, `out/` are skipped. Verified via unit test: feed a 600KB file → indexer returns null, broadcast carries no symbols for that file.
5. **Smart push summary**: the system-event ChatRecord that says "Alice pushed N file(s)" is enhanced — when `affectedSymbols` are present, the message reads `Alice pushed N file(s) — affects 2 of your symbols: calculate_total(), discountRate`. ChatPanel + ActivityLog render the enhanced label when payload present; fall back to existing "N files" text when payload absent (older clients / failed analysis).

## Architecture sketch (planner refines)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Extension Host (main process — must stay responsive)                       │
│                                                                              │
│  SessionHost.broadcastPush(record)                                          │
│    1. existing path: append PushHistory, write snapshot, broadcast wire     │
│    2. NEW: async fork AstWorker, send {changedFiles, memberTrackedFiles}    │
│    3. on worker response → broadcast push-impact-update (amend payload)     │
│                                                                              │
│  AstAnalyzer (host process — thin coordinator)                              │
│    ├─ workerPool: 1 long-lived child_process.fork('./ast-worker.js')        │
│    ├─ analyzeChange(pushRecord, memberTrackedFiles) → impact summary        │
│    └─ skipPolicy: size/path patterns gate before sending to worker          │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │ IPC (process.send)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  AstWorker (forked Node process — heavy work, isolated)                     │
│                                                                              │
│  per-language adapters:                                                      │
│    src/ast/adapters/javascript.ts   (tree-sitter-javascript.wasm)           │
│    src/ast/adapters/typescript.ts   (tree-sitter-typescript.wasm)           │
│    src/ast/adapters/python.ts       (tree-sitter-python.wasm)               │
│    src/ast/adapters/fallback.ts     (line-level diff, no AST — SC-3 fb)     │
│    src/ast/adapters/java.ts         (registered but defers to fallback v1)  │
│    src/ast/adapters/cpp.ts          (registered but defers to fallback v1)  │
│                                                                              │
│  Each adapter implements:                                                    │
│    extractSymbols(source: string) → SymbolIndex                             │
│    extractReferences(source: string) → ReferenceIndex                       │
│                                                                              │
│  Worker pipeline:                                                            │
│    1. parse pre/post for each changed file → diff symbol sets               │
│    2. parse member tracked files → reference index                          │
│    3. join changed-symbols ⨯ references → impact list                       │
│    4. return { affectedSymbols, perMember: {[memberId]: AffectedSymbol[]} } │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data shapes (planner refines)

```ts
// New, added to src/types/conflict.ts (or src/ast/types.ts)
export interface SymbolIndex {
  functions: Array<{ name: string; line: number; signature?: string }>;
  classes: Array<{ name: string; line: number }>;
  variables: Array<{ name: string; line: number }>;
  imports: Array<{ name: string; from: string; line: number }>;
  exports: Array<{ name: string; line: number }>;
}

export interface ReferenceIndex {
  // For each symbol referenced, where is it referenced
  calls: Array<{ name: string; line: number }>;
  reads: Array<{ name: string; line: number }>;
  imports: Array<{ name: string; from: string; line: number }>;
}

export interface AffectedSymbol {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'import' | 'export';
  changedIn: string;       // file path that changed
  callers: Array<{
    memberId: string;
    displayName: string;
    file: string;
    line: number;
  }>;
}

// Append to ChatRecord.meta (in src/types/chat.ts):
export interface ChatRecordMeta {
  // existing fields ...
  affectedSymbols?: AffectedSymbol[];
  unsupportedLanguages?: string[]; // SC-3 fallback signal
}
```

## Threat model

- **T-05-01** (worker crash): AST worker process can crash on malformed source. Mitigation: parent supervises with re-fork-on-exit, falls back to file-level analysis on repeated crashes. Source-grep test pins the `worker.on('exit')` handler.
- **T-05-02** (slowloris parse): malicious nested template-literal or grammar-pathological input could hang the worker. Mitigation: worker has a 5s per-file timeout; on timeout, the file is reported as unanalyzable and falls through to file-level. Test feeds a tree-sitter pathological case + asserts timeout.
- **T-05-03** (path escape in worker IPC): worker reads file paths sent over IPC. Mitigation: parent validates paths against the workspace root + branch dir before sending. Same segment-aware traversal check as Plan 04-15 CR-03-NEW.
- **T-05-04** (memory bloat from large repos): per-member tracked file content shipped over IPC. Mitigation: stream file paths + read inside the worker; cap individual file at 500KB (SC-4); cap total per-analysis payload at 10MB.
- **T-05-05** (wrong-attribution): symbol name collision (`User` in two unrelated files). Mitigation: scope to file-level for v1 — affectedSymbols only fires when name AND containing-file-path match between change and reference. Cross-file scope-aware matching deferred to 5.x.

## Wave breakdown (planner consumes this — refine but preserve intent)

- **Wave 1** — Types + protocol + skip policy + factory scaffold
  Files: `src/ast/types.ts` (new), `src/ast/AstFactory.ts` (new, returns null for unsupported), `src/ast/skipPolicy.ts` (new, 500KB + path patterns), `src/test/suite/astSkipPolicy.test.ts`, `src/types/chat.ts` (extend ChatRecordMeta).

- **Wave 2** — JavaScript + TypeScript adapter
  Files: `src/ast/adapters/javascript.ts` (new — extracts functions/classes/exports/imports/calls), `src/ast/adapters/typescript.ts` (new — extends JS w/ types), `src/vendor/tree-sitter/javascript.wasm` (vendored), `src/vendor/tree-sitter/typescript.wasm`, `esbuild.config.mjs` (copy WASMs to dist/), `src/test/suite/astJavaScriptAdapter.test.ts`, `src/test/suite/astTypeScriptAdapter.test.ts`.

- **Wave 3** — Python adapter + Java/C++ register-but-fallback stubs
  Files: `src/ast/adapters/python.ts` (new), `src/ast/adapters/java.ts` (new, falls back), `src/ast/adapters/cpp.ts` (new, falls back), `src/vendor/tree-sitter/python.wasm`, `src/ast/adapters/fallback.ts` (new — line-level diff, SC-3), `src/test/suite/astPythonAdapter.test.ts`, `src/test/suite/astFallback.test.ts`.

- **Wave 4** — AST worker process + IPC + parent coordinator
  Files: `src/ast/worker.ts` (new — runs in child_process.fork; parses, joins, returns impact), `src/ast/AstAnalyzer.ts` (new — parent-side coordinator, worker lifecycle, timeout, crash recovery), `esbuild.config.mjs` (bundle worker.ts), `src/test/suite/astAnalyzer.test.ts` (parent integration), `src/test/suite/astWorker.integration.test.ts` (round-trip through worker).

- **Wave 5** — Wire into SessionHost.broadcastPush + smart push summary rendering
  Files: `src/host/SessionHost.ts` (broadcastPush → AstAnalyzer.analyzeChange → amend system event), `src/filesystem/PushService.ts` (capture pre/post snapshots so the analyzer has both), `src/ui/ChatPanel.ts` + chat webview render (display "affects 2 of your symbols" line + per-symbol drill-down), `src/ui/ActivityLogProvider.ts` (label upgrade), `src/test/suite/pushSmartSummary.test.ts` (end-to-end push → broadcast → render).

## Scope guardrails

- Do NOT spike Java/C++ adapters in this phase — register the language IDs but route to fallback. Defer real grammars to Phase 5.1 if needed.
- Do NOT replace the existing CONF-07/08 file-level + green-status flow — Phase 5 ENHANCES, doesn't REPLACE. When `affectedSymbols` is absent (no impact, analysis failed, unsupported language), the existing file-level message still renders.
- Do NOT make analysis blocking on the broadcast — push must broadcast immediately with file-level info; symbol info arrives as an amend. SC-2 is the hard line.
- Do NOT add new wire types if they can be carried as a meta field on the existing push system-event ChatRecord. Plan 04-15 actor-identity contract must be preserved.
- Do NOT increase the chat history size beyond the existing Plan 04-02 truncation rules (keep-last-100). Affected-symbol payload is part of the record's meta, subject to the same truncation.
- All adapters tier 1 must include malformed-input + size-edge tests so worker crashes are caught at unit level.

## Open questions for planner

(none — locked-decisions frontmatter answers the gray areas)
