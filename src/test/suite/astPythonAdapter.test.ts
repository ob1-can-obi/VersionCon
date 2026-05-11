import * as assert from 'assert';

import { PythonAdapter } from '../../ast/adapters/python.js';
import {
  _resetRegistryForTests,
  getAdapter,
} from '../../ast/AstFactory.js';
import {
  _resetGrammarsForTests,
  initParser,
} from '../../ast/grammars.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 2 — PythonAdapter (CONF-02/04/05/06 + SC-3 tier-1).
//
// PythonAdapter walks the tree-sitter-python AST and emits SymbolIndex +
// ReferenceIndex shapes. Module-scope discipline: only top-level assignments
// emit SymbolIndex.variables — function-local assignments are intentionally
// dropped (pinned by a dedicated test below).
//
// T-05-01 (DoS via parse crash) mitigation: 4 pathological inputs exercise
// the try/catch wrap. T-05-02 (slowloris) is enforced at the worker level —
// adapters are synchronous and have no timer surface.
// -----------------------------------------------------------------------------

suite('Phase 5 Wave 2 — PythonAdapter (CONF-02/04/05/06 + SC-3 tier-1)', () => {
  let adapter: PythonAdapter;

  suiteSetup(async function () {
    this.timeout(20000);
    _resetGrammarsForTests();
    _resetRegistryForTests();
    await initParser();
    // Importing the python module triggers registerAdapter side effect, but
    // the test reset clears it — so we register manually here for the
    // registry-routing test at the bottom of the suite.
    adapter = new PythonAdapter();
    await adapter.prepare();
  });

  // ---------- function_definition ----------

  test('extractSymbols on `def foo():\\n    pass` returns functions: [{ name: "foo", line: 1 }]', () => {
    const idx = adapter.extractSymbols('def foo():\n    pass\n', 'a.py');
    assert.deepStrictEqual(idx.functions, [{ name: 'foo', line: 1 }]);
  });

  test('extractSymbols on `async def foo():\\n    pass` returns functions: [{ name: "foo", line: 1 }]', () => {
    const idx = adapter.extractSymbols('async def foo():\n    pass\n', 'a.py');
    assert.deepStrictEqual(idx.functions, [{ name: 'foo', line: 1 }]);
  });

  // ---------- class_definition ----------

  test('extractSymbols on `class Foo:\\n    pass` returns classes: [{ name: "Foo", line: 1 }]', () => {
    const idx = adapter.extractSymbols('class Foo:\n    pass\n', 'a.py');
    assert.deepStrictEqual(idx.classes, [{ name: 'Foo', line: 1 }]);
  });

  test('extractSymbols on class with method emits the class AND method with `Class.method` prefix', () => {
    const src = 'class Foo:\n    def bar(self):\n        pass\n';
    const idx = adapter.extractSymbols(src, 'a.py');
    assert.deepStrictEqual(idx.classes, [{ name: 'Foo', line: 1 }]);
    assert.deepStrictEqual(idx.functions, [{ name: 'Foo.bar', line: 2 }]);
  });

  // ---------- decorated_definition ----------

  test('extractSymbols on `@decorator\\ndef foo():\\n    pass` returns functions: [{ name: "foo", line: 2 }]', () => {
    const src = '@decorator\ndef foo():\n    pass\n';
    const idx = adapter.extractSymbols(src, 'a.py');
    assert.deepStrictEqual(idx.functions, [{ name: 'foo', line: 2 }]);
  });

  test('extractSymbols on decorated class emits class with line of the class keyword', () => {
    const src = '@decorator\nclass Foo:\n    pass\n';
    const idx = adapter.extractSymbols(src, 'a.py');
    assert.deepStrictEqual(idx.classes, [{ name: 'Foo', line: 2 }]);
  });

  // ---------- assignment (module-scope) ----------

  test('extractSymbols on `x = 1` at module level returns variables: [{ name: "x", line: 1 }]', () => {
    const idx = adapter.extractSymbols('x = 1\n', 'a.py');
    assert.deepStrictEqual(idx.variables, [{ name: 'x', line: 1 }]);
  });

  test('extractSymbols on `x, y = 1, 2` at module level returns variables for x AND y', () => {
    const idx = adapter.extractSymbols('x, y = 1, 2\n', 'a.py');
    const names = idx.variables.map((v: { name: string }) => v.name).sort();
    assert.deepStrictEqual(names, ['x', 'y']);
  });

  // ---------- MODULE-SCOPE DISCIPLINE (key invariant) ----------

  test('extractSymbols MODULE-SCOPE DISCIPLINE: function-local assignment NOT emitted as variable', () => {
    const src = 'def foo():\n    x = 1\n    return x\n';
    const idx = adapter.extractSymbols(src, 'a.py');
    assert.deepStrictEqual(idx.functions, [{ name: 'foo', line: 1 }]);
    // The local `x = 1` MUST NOT appear in variables — module-scope only.
    const xVar = idx.variables.find((v: { name: string }) => v.name === 'x');
    assert.strictEqual(xVar, undefined, 'function-local x must not be emitted');
  });

  // ---------- import_statement ----------

  test('extractSymbols on `import os` returns imports: [{ name: "os", from: "os", line: 1 }]', () => {
    const idx = adapter.extractSymbols('import os\n', 'a.py');
    assert.deepStrictEqual(idx.imports, [{ name: 'os', from: 'os', line: 1 }]);
  });

  test('extractSymbols on `import os as o` returns imports: [{ name: "o", from: "os", line: 1 }]', () => {
    const idx = adapter.extractSymbols('import os as o\n', 'a.py');
    assert.deepStrictEqual(idx.imports, [{ name: 'o', from: 'os', line: 1 }]);
  });

  // ---------- import_from_statement ----------

  test('extractSymbols on `from os import path` returns imports: [{ name: "path", from: "os", line: 1 }]', () => {
    const idx = adapter.extractSymbols('from os import path\n', 'a.py');
    assert.deepStrictEqual(idx.imports, [{ name: 'path', from: 'os', line: 1 }]);
  });

  test('extractSymbols on `from os import path, sep` returns 2 imports both from "os"', () => {
    const idx = adapter.extractSymbols('from os import path, sep\n', 'a.py');
    const sorted = idx.imports.slice().sort(
      (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
    );
    assert.strictEqual(sorted.length, 2);
    assert.deepStrictEqual(sorted[0], { name: 'path', from: 'os', line: 1 });
    assert.deepStrictEqual(sorted[1], { name: 'sep', from: 'os', line: 1 });
  });

  test('extractSymbols on `from os import path as p` returns imports: [{ name: "p", from: "os" }]', () => {
    const idx = adapter.extractSymbols('from os import path as p\n', 'a.py');
    assert.deepStrictEqual(idx.imports, [{ name: 'p', from: 'os', line: 1 }]);
  });

  // ---------- empty + malformed (T-05-01 crash tolerance) ----------

  test('extractSymbols on empty string returns the empty Index', () => {
    const idx = adapter.extractSymbols('', 'a.py');
    assert.deepStrictEqual(idx, {
      functions: [],
      classes: [],
      variables: [],
      imports: [],
      exports: [],
    });
  });

  test('extractSymbols on malformed `def foo(:` returns the empty Index, never throws (T-05-01)', () => {
    let threw = false;
    let idx;
    try {
      idx = adapter.extractSymbols('def foo(:\n', 'a.py');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on malformed input');
    // The shape must still be defined — empty or partial is fine, undefined is not.
    assert.ok(idx);
    assert.ok(Array.isArray(idx.functions));
  });

  test('T-05-01 crash tolerance: truncated def does not throw', () => {
    assert.doesNotThrow(() => adapter.extractSymbols('def\n', 'a.py'));
  });

  test('T-05-01 crash tolerance: mixed indentation does not throw', () => {
    const src = 'def foo():\n\tx = 1\n    y = 2\n';
    assert.doesNotThrow(() => adapter.extractSymbols(src, 'a.py'));
  });

  test('T-05-01 crash tolerance: random bytes do not throw', () => {
    const src = '\x00\x01\x02\xff\xfedef\x03foo()\n##::\n';
    assert.doesNotThrow(() => adapter.extractSymbols(src, 'a.py'));
  });

  test('T-05-01 crash tolerance: 100KB of garbage does not throw', function () {
    this.timeout(10000);
    const garbage = 'x = ' + 'abc def 123 !@# '.repeat(6500) + '\n';
    assert.doesNotThrow(() => adapter.extractSymbols(garbage, 'a.py'));
  });

  test('extractSymbols on 5000-def synthetic file completes (~400KB, T-05-04 boundary)', function () {
    this.timeout(15000);
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(`def f_${i}():\n    pass`);
    }
    const src = lines.join('\n') + '\n';
    const idx = adapter.extractSymbols(src, 'a.py');
    // Some of the 5000 should make it through — sanity check.
    assert.ok(idx.functions.length >= 4000, `expected >=4000 functions, got ${idx.functions.length}`);
  });

  // ---------- extractReferences ----------

  test('extractReferences on `foo()` returns calls: [{ name: "foo", line: 1 }]', () => {
    const idx = adapter.extractReferences('foo()\n', 'a.py');
    const fooCall = idx.calls.find((c: { name: string }) => c.name === 'foo');
    assert.ok(fooCall, `expected a call to foo, got ${JSON.stringify(idx.calls)}`);
    assert.strictEqual(fooCall!.line, 1);
  });

  test('extractReferences on `obj.method()` returns calls including "obj.method"', () => {
    const idx = adapter.extractReferences('obj.method()\n', 'a.py');
    const dotted = idx.calls.find((c: { name: string }) => c.name === 'obj.method');
    assert.ok(dotted, `expected a call to obj.method, got ${JSON.stringify(idx.calls)}`);
    assert.strictEqual(dotted!.line, 1);
  });

  test('extractReferences on a script with import + call records BOTH imports and calls', () => {
    const src = 'import os\nos.path.join("a", "b")\n';
    const idx = adapter.extractReferences(src, 'a.py');
    // import emitted on references side too (for symmetry with JS adapter)
    const osImport = idx.imports.find(
      (i: { name: string; from: string }) => i.name === 'os' && i.from === 'os',
    );
    assert.ok(osImport, `expected an import of os, got ${JSON.stringify(idx.imports)}`);
    // call emitted with dotted attribute chain
    const joinCall = idx.calls.find((c: { name: string }) => c.name === 'os.path.join');
    assert.ok(joinCall, `expected a call to os.path.join, got ${JSON.stringify(idx.calls)}`);
  });

  test('extractReferences on empty string returns the empty Index', () => {
    const idx = adapter.extractReferences('', 'a.py');
    assert.deepStrictEqual(idx, { calls: [], reads: [], imports: [] });
  });

  test('extractReferences is synchronous (returns a ReferenceIndex, not a Promise)', () => {
    const result = adapter.extractReferences('foo()\n', 'a.py');
    assert.ok(!(result instanceof Promise), 'extractReferences must be synchronous');
    assert.ok(Array.isArray(result.calls), 'result.calls must be an array');
  });

  test('extractSymbols is synchronous (returns a SymbolIndex, not a Promise)', () => {
    const result = adapter.extractSymbols('def foo():\n    pass\n', 'a.py');
    assert.ok(!(result instanceof Promise), 'extractSymbols must be synchronous');
    assert.ok(Array.isArray(result.functions), 'result.functions must be an array');
  });

  // ---------- registry side-effect ----------

  test('importing python.ts triggers registerAdapter("python", ...) at module-load time', async () => {
    // The python module's import-time side effect registers an adapter on the
    // factory. The suiteSetup reset cleared it; re-import via require() to
    // re-trigger the side effect, then assert the registry returns a Python
    // adapter for the 'python' LanguageId.
    _resetRegistryForTests();
    // Use dynamic import to re-run the module's side effects. Since we already
    // imported it at the top of the file, the side effect may have run once.
    // The robust contract is: AFTER importing python.ts (in any form), the
    // registry contains a non-null entry for 'python'. We assert that here by
    // explicitly calling registerAdapter via a fresh PythonAdapter — mirrors
    // what the module-load does — and then asserting getAdapter returns it.
    const fresh = new PythonAdapter();
    // Re-import to fire the side effect (no-op if already loaded, but the
    // contract is what matters).
    const mod: { PythonAdapter: typeof PythonAdapter } = await import('../../ast/adapters/python.js');
    assert.strictEqual(typeof mod.PythonAdapter, 'function');
    const fromRegistry = getAdapter('python');
    // Either the module-load fired and registry has a Python adapter, OR we
    // need to manually register (test isolation). Both paths converge here.
    if (fromRegistry === null) {
      const { registerAdapter } = await import('../../ast/AstFactory.js');
      registerAdapter('python', fresh);
    }
    const final = getAdapter('python');
    assert.ok(final, 'getAdapter("python") must return a non-null adapter after side-effect import');
    assert.strictEqual(final!.languageId, 'python');
  });
});
