/**
 * Phase 5 — Dependency-aware conflict detection (AST). Wave 1 (Plan 05-01).
 *
 * Canonical type module for Phase 5. Pure types — no runtime imports, no value
 * exports. Every downstream Wave (2-5) imports its contract shapes from here:
 *
 *   - Wave 2 (Plan 05-02): adapters/javascript.ts + adapters/typescript.ts
 *     implement {@link AstAdapter} against {@link SymbolIndex} +
 *     {@link ReferenceIndex}.
 *   - Wave 3 (Plan 05-03): adapters/python.ts + adapters/fallback.ts +
 *     adapters/java.ts + adapters/cpp.ts. Java/C++ stubs DEFER to the fallback
 *     adapter (SC-3) — they register but their getAdapter() entry remains null
 *     in v1 (see AstFactory.ts).
 *   - Wave 4 (Plan 05-04): worker.ts (child_process.fork target) consumes
 *     {@link AnalyzePayload} and emits {@link AnalysisResponse} over IPC;
 *     AstAnalyzer.ts is the parent-side coordinator that builds
 *     {@link AnalysisResult} for the host.
 *   - Wave 5 (Plan 05-05): SessionHost.broadcastPush amends the system-event
 *     ChatRecord with the {@link AffectedSymbol}s returned by the worker.
 *
 * Source of truth for all shapes here: .planning/phases/05-.../05-SPEC.md
 * "Data shapes" section. Any divergence is a SPEC bug — fix the SPEC, then
 * propagate, never the other way around.
 */

/**
 * Phase 5 tier-1 + tier-2 language ids. The factory keys its registry off this
 * discriminated union, and {@link AstAdapter.languageId} is constrained to the
 * same set.
 *
 * Tier 1 (Wave 2, real grammars): javascript, typescript.
 * Tier 1 (Wave 3, real grammar):   python.
 * Tier 2 (Wave 3, fallback only):  java, cpp — registered but route to the
 *   file-level fallback per SC-3 until 5.1 ships real WASM grammars.
 *
 * Source: 05-SPEC.md locked-decisions (frontmatter) + Architecture sketch.
 */
export type LanguageId = 'javascript' | 'typescript' | 'python' | 'java' | 'cpp';

/**
 * Symbol-level index of a single source file. Produced by
 * {@link AstAdapter.extractSymbols} during Wave 4 worker parsing.
 *
 * Source: 05-SPEC.md "Data shapes" — verbatim shape. Wave 4 worker diffs
 * pre/post SymbolIndex pairs per file to compute the changed-symbol set
 * that feeds into the call-graph join.
 */
export interface SymbolIndex {
  functions: Array<{ name: string; line: number; signature?: string }>;
  classes: Array<{ name: string; line: number }>;
  variables: Array<{ name: string; line: number }>;
  imports: Array<{ name: string; from: string; line: number }>;
  exports: Array<{ name: string; line: number }>;
}

/**
 * Reference-level index of a single source file. Produced by
 * {@link AstAdapter.extractReferences} during Wave 4 worker parsing of each
 * member's tracked files.
 *
 * Source: 05-SPEC.md "Data shapes" — verbatim shape. Wave 4 worker joins
 * {@link SymbolIndex} (the changed side) against ReferenceIndex (per-member
 * tracked-paths) to produce per-member {@link AffectedSymbol} lists.
 */
export interface ReferenceIndex {
  calls: Array<{ name: string; line: number }>;
  reads: Array<{ name: string; line: number }>;
  imports: Array<{ name: string; from: string; line: number }>;
}

/**
 * A single change → reference impact pair. One AffectedSymbol per changed
 * symbol per affected member; the {@link AffectedSymbol.callers} array lists
 * every reference site across the team.
 *
 * Source: 05-SPEC.md "Data shapes" — verbatim shape. SC-5 (smart push
 * summary) renders these in the system-event ChatRecord. T-05-05
 * (wrong-attribution) mitigation: Wave 4 join logic MUST match on
 * `name AND callers[].file ==-or-imports changedIn` — the shape itself
 * encodes that file-scoping invariant.
 *
 * Consumed by Wave 5 SessionHost.broadcastPush (stamps into
 * ChatRecord.meta.affectedSymbols) + ChatPanel/ActivityLog renderers.
 */
export interface AffectedSymbol {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'import' | 'export';
  /** Workspace-relative path of the file that changed. */
  changedIn: string;
  callers: Array<{
    memberId: string;
    displayName: string;
    file: string;
    line: number;
  }>;
}

/**
 * Per-language adapter contract. Implementations are Wave 2 (JS/TS via
 * tree-sitter), Wave 3 (Python via tree-sitter; Java/C++ stub adapters that
 * defer to fallback by NOT registering in {@link AstFactory.registerAdapter}).
 *
 * Both methods are **synchronous** by design:
 *   - T-05-01 (worker crash): wrapping tree-sitter parse in a Promise would
 *     leak timers on crash; sync surface keeps the worker tractable.
 *   - T-05-02 (slowloris parse): Wave 4 enforces a 5s per-file timeout at the
 *     CHILD-process level, not via Promise.race in the host. Adapters cannot
 *     and MUST NOT enforce their own timeout.
 *
 * The interface intentionally exposes only the SymbolIndex / ReferenceIndex
 * shapes — no tree-sitter types leak through the public surface (T-05-01
 * mitigation: prevents the host process from importing tree-sitter even by
 * accident, which would defeat the worker isolation).
 */
export interface AstAdapter {
  readonly languageId: LanguageId;
  extractSymbols(source: string, relativePath: string): SymbolIndex;
  extractReferences(source: string, relativePath: string): ReferenceIndex;
}

/**
 * The aggregated result of one push-analysis pass. Produced by
 * {@link AnalysisResponse} (worker → parent IPC) and consumed by Wave 5
 * SessionHost.broadcastPush.
 *
 * - `affectedSymbols`: flat union over all members. Wave 5 stamps this onto
 *   the host-side ChatRecord.meta.affectedSymbols verbatim.
 * - `perMember`: per-recipient projection so a client can render
 *   "you call this in X" without re-filtering the union. Key is memberId;
 *   value is the subset of affectedSymbols whose callers reference that
 *   member.
 * - `unsupportedLanguages`: language ids that fell through to file-level
 *   fallback during this push (SC-3 signal). Wave 5 forwards via
 *   ChatRecord.meta.unsupportedLanguages.
 */
export interface AnalysisResult {
  affectedSymbols: AffectedSymbol[];
  perMember: Record<string, AffectedSymbol[]>;
  unsupportedLanguages: string[];
}

/**
 * Wave 4 IPC frame — parent → worker analyze request.
 *
 * Source: 05-SPEC.md Architecture sketch + Wave 4 plan. Locked here so Wave 4
 * has a stable wire shape from day one.
 *
 * - `requestId`: correlates response. Worker echoes verbatim in
 *   {@link AnalysisResponse.requestId}.
 * - `changedFiles`: one entry per file touched by the push. preContent null
 *   means "newly added file"; postContent null means "deleted file". Wave 4
 *   worker diffs the two SymbolIndex'es.
 * - `memberTrackedFiles`: per-member tracked-paths content. Key is memberId,
 *   value is the list of files that member has open (from PresenceMap +
 *   tracked-paths broadcast in Plan 03-14 / Plan 04-06).
 * - `memberDisplayNames`: memberId → displayName lookup so the worker can
 *   stamp human-readable names into {@link AffectedSymbol.callers} without a
 *   second IPC round-trip.
 *
 * T-05-03 (path escape) mitigation: every {@link AnalyzePayload}'s
 * relativePath fields are workspace-relative — Wave 4 worker MUST reject any
 * value whose segments include '..' (same gate as Plan 04-15 CR-03-NEW).
 * Absolute paths NEVER cross IPC.
 *
 * T-05-04 (memory bloat) mitigation: the host gates each file with
 * {@link import('./skipPolicy.js').shouldSkip}(relativePath, sizeBytes) before
 * adding it to changedFiles or memberTrackedFiles — files over 500KB or
 * matching the skip-path patterns are excluded BEFORE the payload is built.
 */
export interface AnalyzePayload {
  requestId: string;
  changedFiles: Array<{
    relativePath: string;
    preContent: string | null;
    postContent: string | null;
    languageId: LanguageId | null;
  }>;
  memberTrackedFiles: Record<
    string,
    Array<{ relativePath: string; content: string; languageId: LanguageId | null }>
  >;
  memberDisplayNames: Record<string, string>;
}

/**
 * Wave 4 IPC frame — worker → parent analyze response. Discriminated union on
 * `ok`. On error, the parent logs and proceeds with the existing file-level
 * broadcast (SC-2 + SC-3 fallback path) — the push is NEVER blocked.
 */
export type AnalysisResponse =
  | { requestId: string; ok: true; result: AnalysisResult }
  | { requestId: string; ok: false; error: string };
