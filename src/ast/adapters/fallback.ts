/**
 * Phase 5 Wave 3 (Plan 05-03) — line-level fallback adapter (SC-3 / CONF-10).
 *
 * Used when:
 *   - The language has no real grammar (java / cpp v1 — Phase 5.1 promotes
 *     to real tree-sitter adapters).
 *   - The grammar fails to parse the source (Wave 4 worker try/catch
 *     fallthrough).
 *   - The file is over 500KB (skipPolicy excludes BEFORE this adapter sees
 *     it — but the adapter itself is safe at any size).
 *
 * Contract:
 *   - SymbolIndex.variables emits ONE entry per non-blank, non-comment line.
 *     name = first whitespace-delimited token of the trimmed line.
 *     line = 1-based row in the ORIGINAL source (blanks preserve numbering).
 *   - SymbolIndex.functions / .classes / .imports / .exports are always empty.
 *   - ReferenceIndex is ALWAYS entirely empty — line-level fallback cannot
 *     derive references (CONF-10 explicit "fallback to file-level and
 *     line-level detection"). The Wave 4 join layer treats absence of
 *     references as "file-level only, no symbol match attempted."
 *
 * The "first-token-per-line" emission is NOT a meaningful symbol name — its
 * job is to give the Wave 4 join SOMETHING per line to fingerprint. With this
 * per-line signature a fallback file can still surface file-level impact
 * (T-05-05 mitigation: Wave 4 join MUST NOT cross-attribute fallback variables
 * to real-grammar symbols — keys on languageId-equality at the file level).
 *
 * Threats mitigated:
 *   - T-05-01 (parse crash): no parse call here, no tree-sitter, no regex with
 *     pathological backtracking — only String.split + trim + a tiny
 *     comment-prefix regex. Cannot crash on input.
 *   - T-05-04 (memory bloat): O(n) in line count; the skipPolicy 500KB cap
 *     gates upstream, but even unbounded input is safe to traverse.
 *
 * Deferred (out of v1 scope):
 *   - Block-comment closure detection (`/* ... *​/` spanning multiple lines).
 *     The line-level scanner treats every line independently; a multi-line
 *     comment with code-looking middle lines emits spurious tokens. Acceptable
 *     trade-off in v1 — the tokens are never cross-attributed to real symbols
 *     (T-05-05 mitigation) so the noise is bounded.
 *   - Heuristic language-specific stripping (e.g. C++ preprocessor lines).
 *     Phase 5.1 promotes Java + C++ to real grammars where this isn't needed.
 */
import type {
  AstAdapter,
  LanguageId,
  ReferenceIndex,
  SymbolIndex,
} from '../types.js';

/** Comment-line prefixes recognized by the line-level scanner. */
const COMMENT_PREFIX = /^(\/\/|#|\/\*|\*)/;

export class FallbackAdapter implements AstAdapter {
  constructor(public readonly languageId: LanguageId) {}

  /**
   * Emit one variable per non-blank, non-comment line. Synchronous,
   * crash-tolerant: any unexpected input shape (non-string, etc.) returns
   * the empty SymbolIndex.
   *
   * @param source — file contents.
   * @param relativePath — workspace-relative path; treated as an opaque
   *   label only.
   */
  extractSymbols(source: string, relativePath: string): SymbolIndex {
    void relativePath;
    const out: SymbolIndex = {
      functions: [],
      classes: [],
      variables: [],
      imports: [],
      exports: [],
    };
    if (typeof source !== 'string' || source.length === 0) return out;
    // Strip a leading BOM so the first-line token doesn't include U+FEFF.
    const cleaned = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    const lines = cleaned.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Strip trailing \r (CRLF input) so the token doesn't carry the CR.
      const raw = lines[i].replace(/\r$/, '');
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue; // blank
      if (COMMENT_PREFIX.test(trimmed)) continue; // comment (best-effort)
      // First whitespace-delimited token. split with limit=1 yields the first
      // element; if the line has no whitespace, the whole line IS the token.
      const firstToken = trimmed.split(/\s+/, 1)[0];
      if (!firstToken) continue;
      out.variables.push({ name: firstToken, line: i + 1 });
    }
    return out;
  }

  /**
   * Line-level fallback CANNOT derive references — always returns the empty
   * ReferenceIndex (CONF-10 explicit contract; T-05-05 mitigation).
   */
  extractReferences(source: string, relativePath: string): ReferenceIndex {
    void source;
    void relativePath;
    return { calls: [], reads: [], imports: [] };
  }
}

/**
 * Factory helper so the Java + C++ stub modules can construct a fallback
 * adapter inline without leaking the FallbackAdapter constructor into the
 * stub-file contract (the stubs only need this single call).
 */
export function createFallbackAdapter(languageId: LanguageId): FallbackAdapter {
  return new FallbackAdapter(languageId);
}
