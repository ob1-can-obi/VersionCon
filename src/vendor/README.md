# Vendored binaries

## tree-sitter grammars (Phase 5 Wave 2 — Plan 05-02)

Three language-grammar WebAssembly modules live under `tree-sitter/`. The Wave 4
AST worker (forked Node child process) loads them at runtime via
`Language.load()` from web-tree-sitter@0.26.8.

We vendor the binaries (rather than depending on the grammar npm packages at
runtime) so that:

- CI installs are reproducible — no rebuild against system tree-sitter CLI
- Install size stays small — only the WASM bytes, no native build artifacts
- The host process never imports tree-sitter (SC-2: AST runs in worker only)

### Provenance

| File             | Source npm package                  | Version | ABI | SHA256                                                              |
|------------------|-------------------------------------|---------|-----|----------------------------------------------------------------------|
| `javascript.wasm` | `tree-sitter-javascript`           | 0.23.1  | 14  | `4a378293fe7853cbee2836023be072dafa0e53b3b5edb245920838ca834ed121` |
| `typescript.wasm` | `tree-sitter-typescript` (TS)      | 0.23.2  | 14  | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tsx.wasm`        | `tree-sitter-typescript` (TSX)     | 0.23.2  | 14  | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |

The web-tree-sitter runtime engine WASM (`web-tree-sitter.wasm`, ~196KB) is NOT
vendored — it ships with the runtime npm package and esbuild copies it from
`node_modules/web-tree-sitter/` into `dist/vendor/tree-sitter/` at build time.

### Re-vendoring procedure

```bash
npm install --no-save tree-sitter-javascript@<version> tree-sitter-typescript@<version>
cp node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm src/vendor/tree-sitter/javascript.wasm
cp node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm src/vendor/tree-sitter/typescript.wasm
cp node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm        src/vendor/tree-sitter/tsx.wasm
npm uninstall tree-sitter-javascript tree-sitter-typescript
shasum -a 256 src/vendor/tree-sitter/*.wasm  # update this README
```

Verify each file's first 4 bytes are the Wasm magic (`0061736d`) before
committing — a text-not-binary file (e.g. an HTML 404) breaks the worker
opaquely:

```bash
for f in src/vendor/tree-sitter/*.wasm; do
  head -c 4 "$f" | xxd -p | grep -q "0061736d" || echo "BAD: $f"
done
```

ABI mismatch surfaces as a `Language.load()` rejection — web-tree-sitter@0.26.x
supports tree-sitter ABI versions 13-14 (see
`node_modules/web-tree-sitter/web-tree-sitter.d.ts` `LANGUAGE_VERSION` /
`MIN_COMPATIBLE_VERSION` constants). If you re-vendor against a grammar built
with a newer CLI than the runtime supports, bump web-tree-sitter as well.
