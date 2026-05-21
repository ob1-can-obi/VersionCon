// src/mcp/adapters/DependencyReaderImpl.ts
// Phase 8 — Reader adapter providing AD-HOC per-call dependency queries.
//
// Per RESEARCH §I.1 + Pitfall 7: Phase 5 has NO standing dep-graph query API
// — the AST analysis runs on push and stamps results onto ChatRecord.meta.
// v1 of this adapter implements forwardDeps/reverseDeps by:
//   1. detectLanguageFromPath(target) -> language id
//   2. getAdapter(lang) -> AstAdapter | null
//   3. fs.readFile(target) -> source string
//   4. adapter.extractReferences(source, target) -> ReferenceIndex
//      ({ calls, reads, imports }).
//   5. Project into { symbols: string[], files: string[] }.
//
// v1 scope:
//   - SINGLE-FILE analysis only (no workspace-wide walk; no standing index).
//     Defer to Phase 8.1 if per-call latency bites (target <100ms p95 per
//     08-07).
//   - 1-hop only (the `hops` param is accepted at the type level but treated
//     as 1 by this implementation).
//   - File-path entry-points only — symbol-entry-point inputs return
//     `{ symbols: [], files: [] }`. Symbol resolution requires a standing
//     index (8.1).
//   - reverseDeps always returns `{ symbols: [], files: [] }` in v1 — reverse
//     walks need the standing index. 08-06/07 tool descriptions document
//     this limitation ("Reverse deps in v1 are best-effort; defer to 8.1").
//
// Defensive returns (no throw):
//   - Unsupported language extension: `{ symbols: [], files: [] }`
//   - Adapter not registered (e.g. java/cpp in v1): `{ symbols: [], files: [] }`
//   - File read failure (missing, permission, etc.): `{ symbols: [], files: [] }`
//   - extractReferences throw (parse error): `{ symbols: [], files: [] }`
//
// Threat mitigations:
//   - T-08-02-aux (path traversal): looksLikeFilePath filters to known source
//     extensions, then path.resolve(workspaceRoot, target) is used and the
//     resolved path is constrained to stay inside the workspace.
//   - Latency: caps the result arrays at 100 entries each so a pathologically
//     large file cannot blow up the JSON response.
//
// N-08-01 (no auth import): only ast/fs/path imports.
// N-08-03 (no writer-shaped methods on the Reader interface): only forwardDeps/
//   reverseDeps declared.
// N-08-04 (no console.*): logger discipline preserved.
import type { DependencyReader } from '../readers.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { detectLanguageFromPath, getAdapter } from '../../ast/AstFactory.js';

/**
 * Construction dependencies for {@link DependencyReaderImpl}. Kept small in
 * v1: only the workspace root is needed because single-file analysis runs
 * on a path resolved against that root.
 */
export interface DependencyReaderDeps {
  /** Absolute path to the workspace root (used to resolve workspace-relative `target` inputs). */
  workspaceRoot: string;
}

/** Maximum number of symbols/files returned per call (latency + token cost cap). */
const MAX_RESULTS = 100;

/**
 * Layer-2 (runtime) implementation of {@link DependencyReader}. Ad-hoc
 * per-call analysis via AstFactory + AstAdapter.extractReferences. See
 * file header for v1 scope decisions and deferred work.
 */
export class DependencyReaderImpl implements DependencyReader {
  constructor(private readonly deps: DependencyReaderDeps) {}

  async forwardDeps(
    target: string,
    _hops: 1 | 2,
  ): Promise<{ symbols: string[]; files: string[] }> {
    // v1: only file-path entry-points are supported. Symbol-entry-point
    // resolution requires the standing index (deferred to 8.1).
    if (!looksLikeFilePath(target)) {
      return { symbols: [], files: [] };
    }

    const lang = detectLanguageFromPath(target);
    if (!lang) return { symbols: [], files: [] };

    const adapter = getAdapter(lang);
    if (!adapter) return { symbols: [], files: [] };

    // Resolve target against the workspace root. Reject path traversal that
    // escapes the workspace (T-08-02-aux mitigation).
    const absPath = path.isAbsolute(target)
      ? target
      : path.resolve(this.deps.workspaceRoot, target);
    const rootResolved = path.resolve(this.deps.workspaceRoot);
    if (!absPath.startsWith(rootResolved + path.sep) && absPath !== rootResolved) {
      return { symbols: [], files: [] };
    }

    let source: string;
    try {
      source = await fs.readFile(absPath, 'utf-8');
    } catch {
      return { symbols: [], files: [] };
    }

    // Adapter may throw on parse error — degrade gracefully.
    let refs;
    try {
      refs = adapter.extractReferences(source, target);
    } catch {
      return { symbols: [], files: [] };
    }

    // ReferenceIndex shape = { calls, reads, imports }. Project into:
    //   symbols = union of imported names + called names + read names
    //   files   = union of `from` module specifiers (deduped)
    const symbolSet = new Set<string>();
    for (const imp of refs.imports) symbolSet.add(imp.name);
    for (const c of refs.calls) symbolSet.add(c.name);
    for (const r of refs.reads) symbolSet.add(r.name);

    const fileSet = new Set<string>();
    for (const imp of refs.imports) fileSet.add(imp.from);

    return {
      symbols: [...symbolSet].slice(0, MAX_RESULTS),
      files: [...fileSet].slice(0, MAX_RESULTS),
    };
  }

  async reverseDeps(
    _target: string,
    _hops: 1 | 2,
  ): Promise<{ symbols: string[]; files: string[] }> {
    // v1: reverse-dep walks require a standing index of "files that import X"
    // (deferred to Phase 8.1). For now, return the empty set unconditionally
    // — the DependencyReader contract is satisfied (no throw, well-typed
    // shape). 08-06/07 tool descriptions document the limitation so AI
    // agents do not silently treat the empty response as "no callers".
    return { symbols: [], files: [] };
  }
}

/**
 * Heuristic: does `s` look like a workspace-relative source file path?
 * Matches paths whose extension is one of the source-language extensions
 * the AstFactory knows about (ts/tsx/js/jsx/mjs/cjs/py/java/cc/cpp/cxx/h/hpp).
 *
 * Used as the gate that distinguishes file-path entry-points (which v1
 * supports) from symbol-entry-points (which v1 defers to 8.1).
 */
function looksLikeFilePath(s: string): boolean {
  if (s.length === 0) return false;
  return /\.(tsx|ts|jsx|js|mjs|cjs|py|java|cpp|cxx|cc|hpp|h)$/i.test(s);
}
