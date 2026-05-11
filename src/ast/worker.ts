/**
 * Phase 5 Wave 4 (Plan 05-04) — forked AST worker.
 *
 * Runs in a child_process.fork()'d Node process. MUST NOT import vscode —
 * verified by source-grep at the bottom + by build-time inspection of the
 * bundled dist/ast-worker.js (zero `require('vscode')` occurrences).
 *
 * Lifecycle:
 *
 *   1. Boot:
 *        - Parser.init() once via grammars.ts.
 *        - side-effect imports of all 5 adapters (./adapters/javascript.js
 *          etc.) — each module's import-time registerAdapter call populates
 *          the AstFactory registry before any message arrives.
 *
 *   2. Per AnalyzePayload message:
 *        - For each changedFiles[i]:
 *            * gate via skipPolicy.shouldSkip (defense-in-depth — host also
 *              checks, but the worker re-checks because IPC could mutate
 *              the payload in theory).
 *            * detect language, get adapter, await prepare(relativePath).
 *            * extractSymbols(preContent || '') + extractSymbols(postContent || '').
 *            * Wrap each extract* in try/catch — one bad file MUST NOT poison
 *              the whole pass.
 *        - For each memberTrackedFiles[memberId][i]: same gate + adapter +
 *          extractReferences in try/catch.
 *        - joinImpact(changedSymbolsPerFile, memberReferences, displayNames,
 *          unsupportedLanguages) → AnalysisResult.
 *        - process.send({ requestId, ok: true, result }) back to parent.
 *        - On ANY catch-all error: process.send({ requestId, ok: false, error }).
 *
 *   3. Crash tolerance:
 *        - process.on('uncaughtException', ...) — best-effort respond + exit(1).
 *          Parent re-forks lazily on next analyzeChange call.
 *        - process.on('disconnect', () => process.exit(0)) — clean shutdown
 *          when parent calls worker.disconnect().
 *
 * Threat mitigations:
 *   - T-05-01 (worker crash): per-file try/catch + uncaughtException handler.
 *   - T-05-02 (slowloris parse): parent enforces 5s timeout via Promise.race;
 *     worker has no internal timer (sync extract* keeps it tractable).
 *   - T-05-03 (path escape): parent validates paths BEFORE IPC; worker re-
 *     applies shouldSkip as defense-in-depth.
 *   - T-05-04 (memory bloat): shouldSkip drops 500KB+ files per spec.
 *
 * Bundled to dist/ast-worker.js by esbuild (third context in
 * esbuild.config.mjs). CJS / platform:node / target:node18 / external:['vscode'].
 *
 * @module worker
 */

import { initParser } from './grammars.js';
import { getAdapter, detectLanguageFromPath } from './AstFactory.js';
import { shouldSkip } from './skipPolicy.js';
import { joinImpact } from './joinImpact.js';
import type {
  AnalyzePayload,
  AnalysisResponse,
  SymbolIndex,
  ReferenceIndex,
  LanguageId,
  AstAdapter,
} from './types.js';

// Side-effect imports — each adapter module calls registerAdapter at module
// scope so getAdapter() returns the right instance once these imports resolve.
// Order doesn't matter (distinct language ids); kept in alphabetical order.
import './adapters/cpp.js';
import './adapters/java.js';
import './adapters/javascript.js';
import './adapters/python.js';
import './adapters/typescript.js';

/**
 * Parser.init() is a one-shot per process — memoized via {@link initParser}.
 * The worker awaits it on the first message; subsequent messages reuse the
 * cached init promise without paying the ~10s Wasm cold-start cost.
 */
let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await initParser();
  initialized = true;
}

/**
 * Resolve and (if necessary) await the adapter's optional prepare() hook.
 * The AstAdapter interface intentionally omits prepare — it's adapter-private
 * (JS/TS/Python load tree-sitter Parsers there) and the host MUST NOT see it
 * (SC-2 — host thread cannot await Wasm boot). Workers cast through unknown
 * to access it.
 *
 * @returns the adapter on success, or null when prepare failed (the worker
 *          treats that as "this file's language is unusable" and falls
 *          back to file-level via the unsupportedLanguages signal).
 */
async function getPreparedAdapter(
  languageId: LanguageId | null,
  relativePath: string,
): Promise<AstAdapter | null> {
  if (!languageId) return null;
  const adapter = getAdapter(languageId);
  if (!adapter) return null;
  const maybePrep = (adapter as unknown as {
    prepare?: (rel?: string) => Promise<void>;
  }).prepare;
  if (typeof maybePrep === 'function') {
    try {
      await maybePrep.call(adapter, relativePath);
    } catch (err) {
      console.error('[ast-worker] adapter.prepare failed for', relativePath, err);
      return null;
    }
  }
  return adapter;
}

function emptySymbols(): SymbolIndex {
  return { functions: [], classes: [], variables: [], imports: [], exports: [] };
}

/**
 * Handle a single AnalyzePayload message.
 *
 * Crash-tolerant: every extract* call wrapped in try/catch. A single bad file
 * (e.g. binary garbage with a .js extension) contributes to
 * unsupportedLanguages but does NOT abort the rest of the pass.
 */
async function handle(payload: AnalyzePayload): Promise<AnalysisResponse> {
  try {
    await ensureInit();

    // Per-file pre/post SymbolIndex pairs for joinImpact.
    const changedSymbolsPerFile = new Map<
      string,
      { pre: SymbolIndex; post: SymbolIndex }
    >();
    const unsupported = new Set<string>();

    for (const file of payload.changedFiles) {
      if (typeof file.relativePath !== 'string') continue;
      if (shouldSkip(file.relativePath)) continue;

      const lang = file.languageId ?? detectLanguageFromPath(file.relativePath);
      const adapter = await getPreparedAdapter(lang, file.relativePath);
      if (!adapter) {
        unsupported.add(lang ?? 'unknown');
        continue;
      }

      try {
        const pre =
          typeof file.preContent === 'string'
            ? adapter.extractSymbols(file.preContent, file.relativePath)
            : emptySymbols();
        const post =
          typeof file.postContent === 'string'
            ? adapter.extractSymbols(file.postContent, file.relativePath)
            : emptySymbols();
        changedSymbolsPerFile.set(file.relativePath, { pre, post });
      } catch (err) {
        console.error(
          '[ast-worker] extractSymbols failed for',
          file.relativePath,
          err,
        );
        unsupported.add(lang ?? 'unknown');
      }
    }

    // Per-member per-file ReferenceIndex.
    const memberRefs = new Map<string, Map<string, ReferenceIndex>>();
    for (const [memberId, files] of Object.entries(payload.memberTrackedFiles)) {
      const fileMap = new Map<string, ReferenceIndex>();
      for (const f of files) {
        if (typeof f.relativePath !== 'string') continue;
        if (shouldSkip(f.relativePath)) continue;

        const lang = f.languageId ?? detectLanguageFromPath(f.relativePath);
        const adapter = await getPreparedAdapter(lang, f.relativePath);
        if (!adapter) {
          // Tracked-file language unsupported: tracked in `unsupported` set
          // so the host sees the SC-3 signal.
          unsupported.add(lang ?? 'unknown');
          continue;
        }

        try {
          const refs = adapter.extractReferences(f.content, f.relativePath);
          fileMap.set(f.relativePath, refs);
        } catch (err) {
          console.error(
            '[ast-worker] extractReferences failed for',
            f.relativePath,
            err,
          );
        }
      }
      if (fileMap.size > 0) memberRefs.set(memberId, fileMap);
    }

    const result = joinImpact(
      changedSymbolsPerFile,
      memberRefs,
      new Map(Object.entries(payload.memberDisplayNames)),
      [...unsupported].sort(),
    );
    return { requestId: payload.requestId, ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { requestId: payload.requestId, ok: false, error: message };
  }
}

process.on('message', (msg: AnalyzePayload) => {
  handle(msg)
    .then((resp) => {
      if (process.send) process.send(resp);
    })
    .catch((err) => {
      if (process.send) {
        const errResp: AnalysisResponse = {
          requestId: msg?.requestId ?? '',
          ok: false,
          error: String(err),
        };
        process.send(errResp);
      }
    });
});

// Last-resort: any escaped throw (e.g. an unhandled rejection that the
// promise wrapper above missed) — notify parent best-effort then exit. The
// parent's exit handler re-forks lazily on the next analyzeChange call.
process.on('uncaughtException', (err) => {
  console.error('[ast-worker] uncaughtException', err);
  try {
    if (process.send) {
      const errResp: AnalysisResponse = {
        requestId: '',
        ok: false,
        error: 'uncaughtException',
      };
      process.send(errResp);
    }
  } catch {
    // ignore — process is already on its way out
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ast-worker] unhandledRejection', reason);
  // No exit — the per-message try/catch should already have responded.
});

// Parent disconnect → clean shutdown (no error).
process.on('disconnect', () => process.exit(0));
