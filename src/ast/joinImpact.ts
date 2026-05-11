/**
 * Phase 5 Wave 4 (Plan 05-04) — pure-fn symbol/reference join.
 *
 * Consumed by the Wave 4 worker after parsing pre/post symbol indices for
 * every changed file and per-member reference indices for every member's
 * tracked file. Output feeds into the AnalysisResult shipped to the host
 * over IPC and stamped into the system-event ChatRecord (Wave 5).
 *
 * v1 scope decisions (locked here so future plans can't silently drift):
 *
 *   - **T-05-05 cross-file collision mitigation**: a member's reference to
 *     `foo` only counts as a caller of `cart-helpers.ts`'s foo if the
 *     member's reference-file imports `foo` from `cart-helpers`. Strict
 *     import-bridge invariant — no import = no attribution.
 *
 *   - **Symbol "modified" detection**: name + line. v1 SymbolIndex has no
 *     content/value hash, so value-only changes (e.g.
 *     `const x = 0.1` → `const x = 0.2` with same line) are NOT detected.
 *     Phase 5.x can extend SymbolIndex with `hash?: string` to surface
 *     value diffs.
 *
 *   - **Symbol kinds**: derived by which array of SymbolIndex emitted the
 *     entry — functions → 'function', classes → 'class', variables →
 *     'variable', imports → 'import', exports → 'export'.
 *
 *   - **Determinism**: result.affectedSymbols sorted by (changedIn, name);
 *     callers within each AffectedSymbol sorted by displayName then line.
 *
 *   - **Best-effort import-path matching**: `./cart-helpers` matches
 *     `cart-helpers.ts`; `./cart/index` matches `cart.ts`. Extension
 *     stripping covers the common JS/TS/Python file suffixes. False
 *     positives (over-attribution) are acceptable in v1 — user-facing
 *     impact is "you might be affected, check this file"; false negative
 *     (missed attribution) is the dangerous direction.
 *
 * No async — joinImpact is sync (worker calls it directly between extract*
 * passes). No vscode imports — the entire module tree under src/ast is
 * vscode-free by design.
 */
import type {
  SymbolIndex,
  ReferenceIndex,
  AffectedSymbol,
  AnalysisResult,
} from './types.js';

interface ChangedSymbol {
  name: string;
  kind: AffectedSymbol['kind'];
  /** Workspace-relative path of the file the symbol changed in. */
  changedIn: string;
}

/**
 * Pure join: changed symbols × per-member references → AnalysisResult.
 *
 * @param changedSymbolsPerFile  Map of changed-file path → { pre, post } SymbolIndex pair.
 * @param memberReferences       Nested map: memberId → (refFilePath → ReferenceIndex).
 * @param memberDisplayNames     memberId → displayName lookup for caller stamping.
 * @param unsupportedLanguages   Pass-through list of language ids that fell back during this analysis.
 */
export function joinImpact(
  changedSymbolsPerFile: Map<string, { pre: SymbolIndex; post: SymbolIndex }>,
  memberReferences: Map<string, Map<string, ReferenceIndex>>,
  memberDisplayNames: Map<string, string>,
  unsupportedLanguages: string[] = [],
): AnalysisResult {
  // 1. Compute the union of changed symbols across all files.
  const changes: ChangedSymbol[] = [];
  for (const [file, { pre, post }] of changedSymbolsPerFile) {
    diffArray(pre.functions, post.functions, 'function', file, changes);
    diffArray(pre.classes, post.classes, 'class', file, changes);
    diffArray(pre.variables, post.variables, 'variable', file, changes);
    diffArray(pre.imports, post.imports, 'import', file, changes);
    diffArray(pre.exports, post.exports, 'export', file, changes);
  }

  // 2. For each change, find callers across all members.
  const affected: AffectedSymbol[] = [];
  for (const change of changes) {
    const callers: AffectedSymbol['callers'] = [];
    // For class methods (e.g. "A.bar"), the consumer typically imports the
    // class "A" — not the method symbol itself. Match the import-bridge against
    // either the full changed name OR the root segment (everything before
    // the first dot). Single-token names (no dot) use only the full name.
    const rootName = (() => {
      const dot = change.name.indexOf('.');
      return dot < 0 ? change.name : change.name.slice(0, dot);
    })();

    for (const [memberId, fileMap] of memberReferences) {
      for (const [refFile, refs] of fileMap) {
        // Find the import-bridge: an import of the changed symbol's name
        // (or its root class name for dotted methods) FROM the changed file.
        // T-05-05 file-scoped gate.
        const bridge = refs.imports.find(
          imp =>
            (imp.name === change.name || imp.name === rootName) &&
            pathMatches(imp.from, change.changedIn),
        );
        if (!bridge) continue;

        const displayName = memberDisplayNames.get(memberId) ?? 'Unknown';

        // Add the import line itself as a "caller" site (Wave 5 renders it).
        callers.push({
          memberId,
          displayName,
          file: refFile,
          line: bridge.line,
        });

        // Add each call site in the same file matching the changed name.
        // Match against (a) the full call name (e.g. `A.bar` matches `A.bar`),
        // or (b) the base name (e.g. `obj.foo` matches `foo` for top-level
        // function changes — file-scoped via import-bridge above).
        for (const c of refs.calls) {
          if (c.name === change.name || extractBaseName(c.name) === change.name) {
            callers.push({ memberId, displayName, file: refFile, line: c.line });
          }
        }

        // Add each read site in the same file matching the changed name.
        for (const r of refs.reads) {
          if (r.name === change.name || extractBaseName(r.name) === change.name) {
            callers.push({ memberId, displayName, file: refFile, line: r.line });
          }
        }
      }
    }
    if (callers.length > 0) {
      callers.sort(
        (a, b) =>
          a.displayName.localeCompare(b.displayName) || a.line - b.line || a.file.localeCompare(b.file),
      );
      affected.push({
        name: change.name,
        kind: change.kind,
        changedIn: change.changedIn,
        callers,
      });
    }
  }

  // 3. Determinism: sort affectedSymbols.
  affected.sort(
    (a, b) =>
      a.changedIn.localeCompare(b.changedIn) || a.name.localeCompare(b.name),
  );

  // 4. perMember regroup. Members with zero affected symbols are absent.
  const perMember: Record<string, AffectedSymbol[]> = {};
  for (const sym of affected) {
    const seen = new Set<string>();
    for (const c of sym.callers) {
      const key = `${c.memberId}::${sym.name}::${sym.changedIn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!perMember[c.memberId]) perMember[c.memberId] = [];
      // Avoid double-adding the same symbol-entry for the same member.
      if (!perMember[c.memberId].some(s => s.name === sym.name && s.changedIn === sym.changedIn)) {
        perMember[c.memberId].push(sym);
      }
    }
  }

  return { affectedSymbols: affected, perMember, unsupportedLanguages };
}

/**
 * Detect added / removed / modified entries between pre and post arrays of
 * the same SymbolIndex sub-field. Modified iff name appears in both but the
 * line differs.
 */
function diffArray(
  pre: Array<{ name: string; line: number }>,
  post: Array<{ name: string; line: number }>,
  kind: AffectedSymbol['kind'],
  file: string,
  out: ChangedSymbol[],
): void {
  const preMap = new Map(pre.map(p => [p.name, p.line]));
  const postMap = new Map(post.map(p => [p.name, p.line]));
  const allNames = new Set<string>([...preMap.keys(), ...postMap.keys()]);
  for (const name of allNames) {
    const preLine = preMap.get(name);
    const postLine = postMap.get(name);
    const added = preLine === undefined && postLine !== undefined;
    const removed = preLine !== undefined && postLine === undefined;
    const modified =
      preLine !== undefined && postLine !== undefined && preLine !== postLine;
    if (added || removed || modified) {
      out.push({ name, kind, changedIn: file });
    }
  }
}

/**
 * Best-effort import-path matching. Strips leading './', any common source
 * extension (ts/tsx/js/jsx/mjs/cjs/py/java/cpp/cc/cxx/h/hpp), and a trailing
 * `/index` segment so `./cart/index` resolves to `cart`.
 *
 * Examples:
 *   './cart-helpers' ⇄ 'cart-helpers.ts'   → match
 *   './cart/index'   ⇄ 'cart.ts'           → match
 *   './a'            ⇄ 'a.ts'              → match
 *   './b'            ⇄ 'a.ts'              → no match
 */
function pathMatches(importFrom: string, changedIn: string): boolean {
  const normalize = (p: string): string =>
    p
      .replace(/^\.\//, '')
      .replace(/\.(tsx|ts|jsx|js|mjs|cjs|py|java|cpp|cxx|cc|hpp|h)$/i, '')
      .replace(/\/index$/, '');
  return normalize(importFrom) === normalize(changedIn);
}

/**
 * Extract the last segment of a dotted call name.
 *   'foo'        → 'foo'
 *   'obj.foo'    → 'foo'
 *   'A.b.c.foo'  → 'foo'
 *
 * File-scoped matching (T-05-05) makes this safe: even if two unrelated
 * files both have a `foo` member, the import-bridge gate ensures we only
 * attribute when the consumer imports from the changed file.
 */
function extractBaseName(callName: string): string {
  const idx = callName.lastIndexOf('.');
  return idx < 0 ? callName : callName.slice(idx + 1);
}
