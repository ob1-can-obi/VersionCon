/**
 * Phase 5 Wave 3 (Plan 05-03) — tier-1 Python adapter (SC-3 / CONF-02 / CONF-04
 * / CONF-05 / CONF-06).
 *
 * Walks the tree-sitter-python grammar and emits SymbolIndex + ReferenceIndex
 * shapes. Same contract as JavaScriptAdapter / TypeScriptAdapter (Wave 2):
 * synchronous extract* methods, crash-tolerant try/catch wrapping (T-05-01),
 * no fs / no IO. The async work (parser init + grammar load) happens via
 * {@link PythonAdapter.prepare}; the Wave 4 worker awaits before invocation.
 *
 * Module-scope discipline: only top-level assignments emit
 * {@link SymbolIndex.variables}. Function-local bindings are NOT symbols at
 * the v1 attribution layer — the smallest unit the Wave 4 join can usefully
 * attribute to a member is a top-level binding or a class method, not a
 * function-local. The assignment walker therefore iterates the module's
 * direct named children (and class bodies for methods) but explicitly does
 * NOT recurse into function bodies. Tests pin this invariant
 * (`MODULE-SCOPE DISCIPLINE`) so a future refactor that walks function
 * bodies for assignments breaks the suite loudly.
 *
 * Reference extraction uses a tree cursor for full DFS — `call` and
 * `attribute` nodes can appear at any depth. Dotted attribute chains
 * (`os.path.join`) flatten to the verbatim node text so the Wave 4 join can
 * match against an import's `from` path.
 *
 * Threats mitigated here:
 *   - T-05-01 (DoS via parse crash): every parse + walk is wrapped in
 *     try/catch returning the empty Index. Tested via 4 pathological inputs.
 *   - T-05-02 (slowloris parse): adapter is synchronous; Wave 4 worker
 *     enforces a 5s per-call timeout at the child-process level (the only
 *     viable enforcement point — see types.ts AstAdapter JSDoc).
 *
 * Deferred to a future plan:
 *   - `self.attr = …` class-field detection (would emit on the class, not
 *     module scope — out of v1 scope).
 *   - Subscript-LHS / attribute-LHS assignments (`a[0] = 1`, `o.x = 1`) —
 *     not name bindings.
 *   - `reads` index (bare identifier reads) — v1 emits an empty `reads`
 *     array; Wave 4 join keys on calls + imports, not reads, so this is
 *     compatible with the JS/TS adapter contract.
 */
import type { Node } from 'web-tree-sitter';
import type { AstAdapter, LanguageId, SymbolIndex, ReferenceIndex } from '../types.js';
import { getParserFor } from '../grammars.js';
import { registerAdapter } from '../AstFactory.js';

type Parser = Awaited<ReturnType<typeof getParserFor>>;

/** Build a fresh empty SymbolIndex. */
function emptySymbols(): SymbolIndex {
  return { functions: [], classes: [], variables: [], imports: [], exports: [] };
}

/** Build a fresh empty ReferenceIndex. */
function emptyReferences(): ReferenceIndex {
  return { calls: [], reads: [], imports: [] };
}

export class PythonAdapter implements AstAdapter {
  readonly languageId: LanguageId = 'python';
  private parser: Parser | null = null;

  /**
   * Lazily acquire a parser configured for tree-sitter-python. Called once by
   * the Wave 4 worker before the first extract* invocation. Safe to call
   * repeatedly — `getParserFor` memoizes per-language inside grammars.ts.
   */
  async prepare(): Promise<void> {
    if (!this.parser) {
      this.parser = await getParserFor('python');
    }
  }

  /**
   * Extract module-scope symbols (functions, classes, top-level assignments,
   * imports) from a Python source. NEVER throws — any tree-sitter or walker
   * error returns the empty SymbolIndex (T-05-01 mitigation).
   *
   * @param source — full file contents as a string.
   * @param relativePath — workspace-relative path; treated as an opaque label
   *   only (no fs reads). Required by the AstAdapter contract.
   */
  extractSymbols(source: string, relativePath: string): SymbolIndex {
    void relativePath;
    if (!this.parser) return emptySymbols();
    try {
      const tree = this.parser.parse(source);
      if (!tree) return emptySymbols();
      return this.walkSymbols(tree.rootNode);
    } catch {
      return emptySymbols();
    }
  }

  /**
   * Extract references (calls + imports) from a Python source. Bare-identifier
   * `reads` are intentionally empty in v1 — Wave 4 join keys on calls and
   * imports, not reads. NEVER throws (T-05-01 mitigation).
   */
  extractReferences(source: string, relativePath: string): ReferenceIndex {
    void relativePath;
    if (!this.parser) return emptyReferences();
    try {
      const tree = this.parser.parse(source);
      if (!tree) return emptyReferences();
      return this.walkReferences(tree.rootNode);
    } catch {
      return emptyReferences();
    }
  }

  /**
   * Module-scope walker. Iterates the module's direct named children. Recurses
   * INTO class_definition bodies (so methods are emitted with the class
   * prefix) but does NOT recurse into function_definition bodies — local
   * assignments are not symbols.
   */
  private walkSymbols(root: Node): SymbolIndex {
    const out = emptySymbols();
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (child) this.visitTopLevel(child, null, out);
    }
    return out;
  }

  /**
   * Visit a top-level node (or a child of a class body — in which case
   * classCtx is the class name so methods emit as `Class.method`).
   */
  private visitTopLevel(n: Node, classCtx: string | null, out: SymbolIndex): void {
    switch (n.type) {
      case 'function_definition': {
        const ident = n.childForFieldName('name');
        if (ident) {
          const name = classCtx ? `${classCtx}.${ident.text}` : ident.text;
          out.functions.push({ name, line: ident.startPosition.row + 1 });
        }
        // Do NOT recurse into function bodies — local vars are not symbols.
        return;
      }
      case 'class_definition': {
        const ident = n.childForFieldName('name');
        if (ident) {
          out.classes.push({ name: ident.text, line: ident.startPosition.row + 1 });
        }
        // Recurse into the class body so methods are emitted with the class
        // prefix. The body field is a `block` node; its named children are
        // statements (including nested function_definitions / decorated
        // definitions for the methods).
        const body = n.childForFieldName('body');
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const c = body.namedChild(i);
            if (c) this.visitTopLevel(c, ident?.text ?? null, out);
          }
        }
        return;
      }
      case 'decorated_definition': {
        // The 'definition' field holds the wrapped function/class node — its
        // own startPosition (`def foo` / `class Foo`) is what we emit as the
        // line, NOT the decorator's line.
        const inner = n.childForFieldName('definition');
        if (inner) this.visitTopLevel(inner, classCtx, out);
        return;
      }
      case 'expression_statement': {
        // Module-scope assignments wrap in an expression_statement. Walk one
        // level in to find the assignment node (Python grammar).
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c && c.type === 'assignment') {
            this.emitAssignment(c, out);
          }
        }
        return;
      }
      case 'assignment': {
        // In some grammar versions, assignment can appear directly at module
        // scope without an expression_statement wrapper. Handle both shapes.
        this.emitAssignment(n, out);
        return;
      }
      case 'import_statement': {
        this.emitImportStatement(n, out.imports);
        return;
      }
      case 'import_from_statement': {
        this.emitImportFromStatement(n, out.imports);
        return;
      }
      default:
        // No-op for everything else (if_statement, try_statement, etc. — we
        // do NOT walk control-flow blocks for assignments at v1).
        return;
    }
  }

  /** Pull names from an assignment node's `left` field. */
  private emitAssignment(n: Node, out: SymbolIndex): void {
    const lhs = n.childForFieldName('left');
    if (lhs) this.emitAssignmentNames(lhs, out);
  }

  /**
   * Emit SymbolIndex.variables names from a Python assignment LHS. Handles
   * identifier (`x`), pattern_list (`x, y`), expression_list, and
   * tuple_pattern. Attribute LHS (`self.x = …`) and subscript LHS (`a[0] = …`)
   * are intentionally skipped — they are not name bindings.
   */
  private emitAssignmentNames(lhs: Node, out: SymbolIndex): void {
    if (lhs.type === 'identifier') {
      out.variables.push({ name: lhs.text, line: lhs.startPosition.row + 1 });
      return;
    }
    if (
      lhs.type === 'pattern_list' ||
      lhs.type === 'expression_list' ||
      lhs.type === 'tuple_pattern'
    ) {
      for (let i = 0; i < lhs.namedChildCount; i++) {
        const c = lhs.namedChild(i);
        if (c) this.emitAssignmentNames(c, out);
      }
      return;
    }
    // attribute / subscript / starred — deferred to v2.
  }

  /**
   * Emit imports from an `import_statement` node. Children are
   * `dotted_name` (`import os`) or `aliased_import` (`import os as o`).
   * Multi-import (`import os, sys`) emits one entry per child.
   */
  private emitImportStatement(
    n: Node,
    out: Array<{ name: string; from: string; line: number }>,
  ): void {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (!c) continue;
      if (c.type === 'aliased_import') {
        const orig = c.childForFieldName('name');
        const alias = c.childForFieldName('alias');
        if (orig && alias) {
          out.push({ name: alias.text, from: orig.text, line: alias.startPosition.row + 1 });
        } else if (orig) {
          out.push({ name: orig.text, from: orig.text, line: orig.startPosition.row + 1 });
        }
      } else if (c.type === 'dotted_name') {
        out.push({ name: c.text, from: c.text, line: c.startPosition.row + 1 });
      }
    }
  }

  /**
   * Emit imports from an `import_from_statement` node:
   *
   *   from os import path        → { name: 'path', from: 'os' }
   *   from os import path, sep   → 2 entries, both from: 'os'
   *   from os import path as p   → { name: 'p',    from: 'os' }
   *
   * The `module_name` field carries the FROM path (dotted_name or
   * relative_import). All OTHER named children of the statement are the
   * imported names (identifier / aliased_import / dotted_name for nested
   * imports such as `from x import y.z` though that is rare).
   */
  private emitImportFromStatement(
    n: Node,
    out: Array<{ name: string; from: string; line: number }>,
  ): void {
    const moduleField = n.childForFieldName('module_name');
    const fromPath = moduleField?.text ?? '';
    const moduleId = moduleField?.id;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (!c) continue;
      if (moduleId !== undefined && c.id === moduleId) continue; // skip the module_name itself
      if (c.type === 'aliased_import') {
        const orig = c.childForFieldName('name');
        const alias = c.childForFieldName('alias');
        if (orig && alias) {
          out.push({ name: alias.text, from: fromPath, line: alias.startPosition.row + 1 });
        } else if (orig) {
          out.push({ name: orig.text, from: fromPath, line: orig.startPosition.row + 1 });
        }
      } else if (c.type === 'dotted_name' || c.type === 'identifier') {
        out.push({ name: c.text, from: fromPath, line: c.startPosition.row + 1 });
      }
    }
  }

  /**
   * Reference walker — DFS the entire tree (call / attribute / import nodes
   * can appear at any depth) and emit calls + imports. Bare-identifier reads
   * are intentionally NOT emitted (v1 scope; see file header).
   */
  private walkReferences(root: Node): ReferenceIndex {
    const out = emptyReferences();
    const cursor = root.walk();
    const dfs = (): void => {
      const node = cursor.currentNode;
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (fn) {
          out.calls.push({ name: fn.text, line: fn.startPosition.row + 1 });
        }
      } else if (node.type === 'import_statement') {
        this.emitImportStatement(node, out.imports);
      } else if (node.type === 'import_from_statement') {
        this.emitImportFromStatement(node, out.imports);
      }
      if (cursor.gotoFirstChild()) {
        do {
          dfs();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    dfs();
    return out;
  }
}

// Module-load side effect: register the Python adapter on first import. The
// Wave 4 worker imports this file at boot, which fires this side effect, and
// `getAdapter('python')` returns a non-null adapter for the worker's uniform
// code path. _resetRegistryForTests can clear it for test isolation.
registerAdapter('python', new PythonAdapter());
