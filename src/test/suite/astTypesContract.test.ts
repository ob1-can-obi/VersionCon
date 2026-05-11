import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

import type { AstAdapter, LanguageId } from '../../ast/types.js';
import {
  _resetRegistryForTests,
  detectLanguageFromPath,
  getAdapter,
  registerAdapter,
} from '../../ast/AstFactory.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 1 (Plan 05-01) — AstFactory behavior + types/factory/chat
// source-grep contract pins.
//
// Behavior suite exercises getAdapter / registerAdapter / detectLanguageFromPath
// directly. Source-grep suite reads src/ast/types.ts, src/ast/AstFactory.ts and
// src/types/chat.ts as strings and asserts the canonical export names + the
// AstAdapter interface shape + ChatRecord.meta extension survive — mirrors
// Phase 4.3 filesExclude.test.ts source-grep pattern.
// -----------------------------------------------------------------------------

/** Minimal AstAdapter stub for registry behavior tests — does NOT parse anything. */
function makeMockAdapter(languageId: LanguageId): AstAdapter {
  return {
    languageId,
    extractSymbols: () => ({
      functions: [],
      classes: [],
      variables: [],
      imports: [],
      exports: [],
    }),
    extractReferences: () => ({ calls: [], reads: [], imports: [] }),
  };
}

suite('Phase 5 Wave 1 — AstFactory behavior', () => {
  setup(() => {
    // Reset between tests so registration in one test does not leak into the
    // next. The Wave 1 contract is "registry empty until Waves 2/3 populate
    // it" — every test starts from that baseline.
    _resetRegistryForTests();
  });

  // ---------- Wave 1 baseline: every language returns null ----------
  test('getAdapter("javascript") returns null in Wave 1 — no adapter registered yet', () => {
    assert.strictEqual(getAdapter('javascript'), null);
  });

  test('getAdapter("typescript") returns null in Wave 1', () => {
    assert.strictEqual(getAdapter('typescript'), null);
  });

  test('getAdapter("python") returns null in Wave 1', () => {
    assert.strictEqual(getAdapter('python'), null);
  });

  test('getAdapter("java") returns null in Wave 1', () => {
    assert.strictEqual(getAdapter('java'), null);
  });

  test('getAdapter("cpp") returns null in Wave 1', () => {
    assert.strictEqual(getAdapter('cpp'), null);
  });

  // ---------- registerAdapter wires the registry; idempotent on overwrite ----------
  test('after registerAdapter("javascript", mockAdapter), getAdapter returns the mock', () => {
    const mock = makeMockAdapter('javascript');
    registerAdapter('javascript', mock);
    assert.strictEqual(getAdapter('javascript'), mock);
  });

  test('registerAdapter is idempotent on overwrite — last registration wins', () => {
    const first = makeMockAdapter('javascript');
    const second = makeMockAdapter('javascript');
    registerAdapter('javascript', first);
    registerAdapter('javascript', second);
    assert.strictEqual(getAdapter('javascript'), second);
  });

  // ---------- detectLanguageFromPath: javascript variants ----------
  test('detectLanguageFromPath("foo.js") === "javascript"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.js'), 'javascript');
  });

  test('detectLanguageFromPath("foo.jsx") === "javascript"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.jsx'), 'javascript');
  });

  test('detectLanguageFromPath("foo.mjs") === "javascript"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.mjs'), 'javascript');
  });

  test('detectLanguageFromPath("foo.cjs") === "javascript"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.cjs'), 'javascript');
  });

  // ---------- detectLanguageFromPath: typescript ----------
  test('detectLanguageFromPath("foo.ts") === "typescript"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.ts'), 'typescript');
  });

  test('detectLanguageFromPath("foo.tsx") === "typescript"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.tsx'), 'typescript');
  });

  // ---------- detectLanguageFromPath: python ----------
  test('detectLanguageFromPath("foo.py") === "python"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.py'), 'python');
  });

  // ---------- detectLanguageFromPath: java ----------
  test('detectLanguageFromPath("foo.java") === "java"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.java'), 'java');
  });

  // ---------- detectLanguageFromPath: cpp variants (.h tagged cpp per SC-3) ----------
  test('detectLanguageFromPath("foo.cpp") === "cpp"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.cpp'), 'cpp');
  });

  test('detectLanguageFromPath("foo.cc") === "cpp"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.cc'), 'cpp');
  });

  test('detectLanguageFromPath("foo.cxx") === "cpp"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.cxx'), 'cpp');
  });

  test('detectLanguageFromPath("foo.h") === "cpp" — ambiguous with C; tagged cpp per SC-3', () => {
    assert.strictEqual(detectLanguageFromPath('foo.h'), 'cpp');
  });

  test('detectLanguageFromPath("foo.hpp") === "cpp"', () => {
    assert.strictEqual(detectLanguageFromPath('foo.hpp'), 'cpp');
  });

  // ---------- detectLanguageFromPath: negative cases ----------
  test('detectLanguageFromPath("foo.txt") === null — unsupported extension', () => {
    assert.strictEqual(detectLanguageFromPath('foo.txt'), null);
  });

  test('detectLanguageFromPath("foo") === null — no extension', () => {
    assert.strictEqual(detectLanguageFromPath('foo'), null);
  });

  test('detectLanguageFromPath("Foo.PY") === "python" — case-insensitive on extension', () => {
    assert.strictEqual(detectLanguageFromPath('Foo.PY'), 'python');
  });
});

// -----------------------------------------------------------------------------
// Source-grep suite: pin the exported names + interface shapes so Wave 2-5
// type imports stay valid through any future refactor. Mirrors the Phase 4.3
// filesExclude.test.ts source-grep pattern (which itself mirrors Phase 4
// host.test.ts UAT regression suite).
// -----------------------------------------------------------------------------

suite('Phase 5 Wave 1 — types + factory + chat contract (source-grep)', () => {
  const typesPath = path.resolve(process.cwd(), 'src/ast/types.ts');
  const factoryPath = path.resolve(process.cwd(), 'src/ast/AstFactory.ts');
  const chatPath = path.resolve(process.cwd(), 'src/types/chat.ts');

  test('src/ast/types.ts exports LanguageId', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(src, /export type LanguageId/, 'LanguageId union export must be present');
  });

  test('src/ast/types.ts exports SymbolIndex', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(src, /export interface SymbolIndex/, 'SymbolIndex interface export must be present');
  });

  test('src/ast/types.ts exports ReferenceIndex', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(
      src,
      /export interface ReferenceIndex/,
      'ReferenceIndex interface export must be present',
    );
  });

  test('src/ast/types.ts exports AffectedSymbol', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(
      src,
      /export interface AffectedSymbol/,
      'AffectedSymbol interface export must be present',
    );
  });

  test('src/ast/types.ts exports AstAdapter interface', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(src, /export interface AstAdapter/, 'AstAdapter interface export must be present');
  });

  test('AstAdapter declares extractSymbols(source: string, relativePath: string): SymbolIndex', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(
      src,
      /extractSymbols\(source: string, relativePath: string\): SymbolIndex/,
      'extractSymbols method signature must match the Wave 1 contract',
    );
  });

  test('AstAdapter declares extractReferences(source: string, relativePath: string): ReferenceIndex', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(
      src,
      /extractReferences\(source: string, relativePath: string\): ReferenceIndex/,
      'extractReferences method signature must match the Wave 1 contract',
    );
  });

  test('src/ast/types.ts exports AnalysisResult', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(
      src,
      /export interface AnalysisResult/,
      'AnalysisResult interface export must be present',
    );
  });

  test('src/ast/types.ts exports AnalyzePayload', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(
      src,
      /export interface AnalyzePayload/,
      'AnalyzePayload IPC frame export must be present',
    );
  });

  test('src/ast/types.ts exports AnalysisResponse as discriminated union', () => {
    const src = fsSync.readFileSync(typesPath, 'utf-8');
    assert.match(
      src,
      /export type AnalysisResponse/,
      'AnalysisResponse discriminated union export must be present',
    );
  });

  test('src/types/chat.ts ChatRecord.meta declares affectedSymbols?: AffectedSymbol[]', () => {
    const src = fsSync.readFileSync(chatPath, 'utf-8');
    assert.match(
      src,
      /affectedSymbols\?: AffectedSymbol\[\]/,
      'ChatRecord.meta.affectedSymbols (SC-5 payload) field must be present',
    );
  });

  test('src/types/chat.ts ChatRecord.meta declares unsupportedLanguages?: string[]', () => {
    const src = fsSync.readFileSync(chatPath, 'utf-8');
    assert.match(
      src,
      /unsupportedLanguages\?: string\[\]/,
      'ChatRecord.meta.unsupportedLanguages (SC-3 fallback signal) field must be present',
    );
  });

  test('src/types/chat.ts imports AffectedSymbol via type-only import from ../ast/types.js', () => {
    const src = fsSync.readFileSync(chatPath, 'utf-8');
    assert.match(
      src,
      /import type \{ AffectedSymbol \} from '\.\.\/ast\/types\.js'/,
      'AffectedSymbol must be imported via type-only import so no runtime cycle is introduced',
    );
  });

  test('src/ast/AstFactory.ts exports getAdapter, registerAdapter, detectLanguageFromPath', () => {
    const src = fsSync.readFileSync(factoryPath, 'utf-8');
    assert.match(src, /export function getAdapter/, 'getAdapter export must be present');
    assert.match(src, /export function registerAdapter/, 'registerAdapter export must be present');
    assert.match(
      src,
      /export function detectLanguageFromPath/,
      'detectLanguageFromPath export must be present',
    );
  });
});
