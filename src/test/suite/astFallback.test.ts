import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

import {
  FallbackAdapter,
  createFallbackAdapter,
} from '../../ast/adapters/fallback.js';
import {
  _resetRegistryForTests,
  getAdapter,
} from '../../ast/AstFactory.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 2 — FallbackAdapter + Java/C++ stubs (SC-3 / CONF-10).
//
// FallbackAdapter is the SC-3 line-level safety net for files we can't (or
// won't, in v1) parse with a real grammar. v1 routes Java + C++ here; the
// stub modules (java.ts / cpp.ts) call registerAdapter('java' | 'cpp',
// createFallbackAdapter(...)) at module-load time so getAdapter is non-null
// for every LanguageId — Wave 4 worker stays branch-free.
//
// Contract pinned by this suite:
//   - extractSymbols emits one variable per non-blank non-comment line, with
//     first-token-of-line as the name and 1-based line number.
//   - extractReferences always returns the empty ReferenceIndex — line-level
//     fallback CANNOT derive references (CONF-10 explicit).
//   - BOM + CRLF + comment-stripping handled correctly.
//
// Source-grep tests at the bottom pin the java.ts / cpp.ts register-but-
// fallback shape so a future refactor can't quietly drop them.
// -----------------------------------------------------------------------------

suite('Phase 5 Wave 2 — FallbackAdapter + Java/C++ stubs (SC-3 / CONF-10)', () => {
  // ---------- construction ----------

  test('createFallbackAdapter("java").languageId === "java"', () => {
    const a = createFallbackAdapter('java');
    assert.strictEqual(a.languageId, 'java');
  });

  test('createFallbackAdapter("cpp").languageId === "cpp"', () => {
    const a = createFallbackAdapter('cpp');
    assert.strictEqual(a.languageId, 'cpp');
  });

  test('FallbackAdapter is a class with a public constructor taking a LanguageId', () => {
    const a = new FallbackAdapter('python');
    assert.strictEqual(a.languageId, 'python');
  });

  // ---------- extractSymbols on empty + simple ----------

  test('extractSymbols on empty string returns the empty Index', () => {
    const a = createFallbackAdapter('java');
    const idx = a.extractSymbols('', 'Foo.java');
    assert.deepStrictEqual(idx, {
      functions: [],
      classes: [],
      variables: [],
      imports: [],
      exports: [],
    });
  });

  test('extractSymbols on `class Foo {\\n  void bar() {}\\n}` emits first-token-per-line for 3 lines', () => {
    const a = createFallbackAdapter('java');
    const src = 'class Foo {\n  void bar() {}\n}\n';
    const idx = a.extractSymbols(src, 'Foo.java');
    assert.strictEqual(idx.variables.length, 3);
    assert.deepStrictEqual(idx.variables[0], { name: 'class', line: 1 });
    assert.deepStrictEqual(idx.variables[1], { name: 'void', line: 2 });
    assert.deepStrictEqual(idx.variables[2], { name: '}', line: 3 });
    // Only variables are populated — functions/classes/imports/exports stay empty.
    assert.deepStrictEqual(idx.functions, []);
    assert.deepStrictEqual(idx.classes, []);
    assert.deepStrictEqual(idx.imports, []);
    assert.deepStrictEqual(idx.exports, []);
  });

  // ---------- comment + blank line handling ----------

  test('extractSymbols on a comment-only file returns the empty Index', () => {
    const a = createFallbackAdapter('cpp');
    const src = '// alpha\n// beta\n/* gamma */\n# python-style\n';
    const idx = a.extractSymbols(src, 'a.cpp');
    assert.deepStrictEqual(idx.variables, []);
  });

  test('extractSymbols preserves ORIGINAL line numbers across blank lines', () => {
    const a = createFallbackAdapter('java');
    const src = '\n\nint x;\n\nint y;\n';
    const idx = a.extractSymbols(src, 'a.java');
    assert.strictEqual(idx.variables.length, 2);
    assert.deepStrictEqual(idx.variables[0], { name: 'int', line: 3 });
    assert.deepStrictEqual(idx.variables[1], { name: 'int', line: 5 });
  });

  // ---------- encoding edge cases ----------

  test('extractSymbols strips a leading U+FEFF (BOM) before tokenization', () => {
    const a = createFallbackAdapter('java');
    const src = '﻿hello world\n';
    const idx = a.extractSymbols(src, 'a.java');
    assert.strictEqual(idx.variables.length, 1);
    // The token is the 5-char 'hello' with NO leading BOM character.
    assert.strictEqual(idx.variables[0].name, 'hello');
    assert.strictEqual(idx.variables[0].name.length, 5);
    assert.strictEqual(idx.variables[0].line, 1);
  });

  test('extractSymbols on CRLF input strips the trailing \\r from each line', () => {
    const a = createFallbackAdapter('cpp');
    const src = 'a\r\nb\r\nc\r\n';
    const idx = a.extractSymbols(src, 'a.cpp');
    assert.strictEqual(idx.variables.length, 3);
    assert.deepStrictEqual(idx.variables[0], { name: 'a', line: 1 });
    assert.deepStrictEqual(idx.variables[1], { name: 'b', line: 2 });
    assert.deepStrictEqual(idx.variables[2], { name: 'c', line: 3 });
  });

  test('extractSymbols on tab-indented input still tokenizes the first non-whitespace word', () => {
    const a = createFallbackAdapter('java');
    const src = '\t\tprivate int counter;\n';
    const idx = a.extractSymbols(src, 'a.java');
    assert.strictEqual(idx.variables.length, 1);
    assert.deepStrictEqual(idx.variables[0], { name: 'private', line: 1 });
  });

  // ---------- extractReferences contract ----------

  test('extractReferences ALWAYS returns the empty ReferenceIndex (CONF-10)', () => {
    const a = createFallbackAdapter('java');
    const idx = a.extractReferences('class Foo { void bar() { baz(); } }\n', 'Foo.java');
    assert.deepStrictEqual(idx, { calls: [], reads: [], imports: [] });
  });

  test('extractReferences on empty string returns the empty ReferenceIndex', () => {
    const a = createFallbackAdapter('cpp');
    const idx = a.extractReferences('', 'a.cpp');
    assert.deepStrictEqual(idx, { calls: [], reads: [], imports: [] });
  });

  // ---------- synchronous contract (matches AstAdapter interface) ----------

  test('extractSymbols is synchronous (returns SymbolIndex, not a Promise)', () => {
    const a = createFallbackAdapter('java');
    const result = a.extractSymbols('int x;\n', 'a.java');
    assert.ok(!(result instanceof Promise));
    assert.ok(Array.isArray(result.variables));
  });

  test('extractReferences is synchronous (returns ReferenceIndex, not a Promise)', () => {
    const a = createFallbackAdapter('cpp');
    const result = a.extractReferences('class Foo {};\n', 'a.cpp');
    assert.ok(!(result instanceof Promise));
    assert.ok(Array.isArray(result.calls));
  });
});

// -----------------------------------------------------------------------------
// Source-grep + registry-routing tests for the java.ts + cpp.ts stub modules.
// The stub-file existence is the contract per the plan; these tests pin the
// register-but-fallback shape so a refactor cannot silently drop the routing.
// -----------------------------------------------------------------------------

suite('Phase 5 Wave 2 — Java + C++ stub adapters (SC-3 register-but-fallback)', () => {
  const javaStubPath = path.resolve(process.cwd(), 'src/ast/adapters/java.ts');
  const cppStubPath = path.resolve(process.cwd(), 'src/ast/adapters/cpp.ts');

  test('src/ast/adapters/java.ts contains registerAdapter("java", ...)', () => {
    const src = fsSync.readFileSync(javaStubPath, 'utf-8');
    assert.match(
      src,
      /registerAdapter\(['"]java['"]/,
      'java.ts must call registerAdapter for the java LanguageId',
    );
  });

  test('src/ast/adapters/java.ts references Phase 5.1 (upgrade roadmap)', () => {
    const src = fsSync.readFileSync(javaStubPath, 'utf-8');
    assert.match(
      src,
      /Phase 5\.1/,
      'java.ts JSDoc must reference Phase 5.1 as the upgrade target',
    );
  });

  test('src/ast/adapters/cpp.ts contains registerAdapter("cpp", ...)', () => {
    const src = fsSync.readFileSync(cppStubPath, 'utf-8');
    assert.match(
      src,
      /registerAdapter\(['"]cpp['"]/,
      'cpp.ts must call registerAdapter for the cpp LanguageId',
    );
  });

  test('src/ast/adapters/cpp.ts references Phase 5.1 (upgrade roadmap)', () => {
    const src = fsSync.readFileSync(cppStubPath, 'utf-8');
    assert.match(
      src,
      /Phase 5\.1/,
      'cpp.ts JSDoc must reference Phase 5.1 as the upgrade target',
    );
  });

  test('java.ts uses createFallbackAdapter — NOT a real grammar import', () => {
    const src = fsSync.readFileSync(javaStubPath, 'utf-8');
    assert.match(
      src,
      /createFallbackAdapter/,
      'java.ts must route through createFallbackAdapter (no real grammar in v1)',
    );
    // Negative: no tree-sitter import sneaking in.
    assert.doesNotMatch(
      src,
      /from ['"]web-tree-sitter['"]/,
      'java.ts MUST NOT import web-tree-sitter directly (v1 fallback only)',
    );
  });

  test('cpp.ts uses createFallbackAdapter — NOT a real grammar import', () => {
    const src = fsSync.readFileSync(cppStubPath, 'utf-8');
    assert.match(
      src,
      /createFallbackAdapter/,
      'cpp.ts must route through createFallbackAdapter (no real grammar in v1)',
    );
    assert.doesNotMatch(
      src,
      /from ['"]web-tree-sitter['"]/,
      'cpp.ts MUST NOT import web-tree-sitter directly (v1 fallback only)',
    );
  });

  test('after importing java.ts, getAdapter("java") returns a non-null adapter with languageId "java"', async () => {
    _resetRegistryForTests();
    // Importing the module fires the registerAdapter side effect.
    await import('../../ast/adapters/java.js');
    const a = getAdapter('java');
    assert.ok(a, 'getAdapter("java") must be non-null after side-effect import');
    assert.strictEqual(a!.languageId, 'java');
  });

  test('after importing cpp.ts, getAdapter("cpp") returns a non-null adapter with languageId "cpp"', async () => {
    _resetRegistryForTests();
    await import('../../ast/adapters/cpp.js');
    const a = getAdapter('cpp');
    assert.ok(a, 'getAdapter("cpp") must be non-null after side-effect import');
    assert.strictEqual(a!.languageId, 'cpp');
  });

  test('after importing fallback-stub modules, line-level extraction works through getAdapter', async () => {
    // Re-register manually because Node module cache means the dynamic import
    // does NOT re-run the side effect after _resetRegistryForTests cleared
    // the registry. The contract this test pins is: getAdapter('java')
    // returns a FallbackAdapter that extracts line-level variables — we
    // construct that registration the same way java.ts does at module load.
    const { createFallbackAdapter } = await import('../../ast/adapters/fallback.js');
    const { registerAdapter } = await import('../../ast/AstFactory.js');
    _resetRegistryForTests();
    registerAdapter('java', createFallbackAdapter('java'));
    const a = getAdapter('java');
    assert.ok(a, 'getAdapter("java") must be non-null after registration');
    const idx = a!.extractSymbols('public class Foo {}\n', 'Foo.java');
    assert.strictEqual(idx.variables.length, 1);
    assert.strictEqual(idx.variables[0].name, 'public');
    assert.strictEqual(idx.variables[0].line, 1);
  });
});
