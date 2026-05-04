# Stack Research

**Domain:** Collaborative VS Code Extension with LAN/Cloud Version Control
**Researched:** 2026-05-04
**Confidence:** HIGH (core VS Code/networking stack), MEDIUM (AST parsing for extension host), LOW (C++ tree-sitter WASM compat)

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | 5.x (5.7+) | Extension host + webview development language | VS Code itself is TypeScript; full IntelliSense against `@types/vscode`; strict mode eliminates entire classes of runtime bugs across the message-passing boundary |
| `@types/vscode` | `^1.109.0` | VS Code Extension API type definitions | Track latest stable VS Code (currently 1.109). Set `engines.vscode` in package.json to your minimum; types version must match. Pin to `^1.100.0` for broad compatibility while keeping modern APIs |
| esbuild | `^0.25.x` | Bundle extension host (Node.js target) and webview (browser target) separately | Officially recommended by VS Code docs; produces minimal bundles; run `tsc --noEmit` alongside it for type checking. Two entry points: `src/extension.ts` (Node, CJS) and `webview/index.tsx` (browser, ESM/Vite) |
| React | `^18.3.x` | Webview UI framework | Best documented webview pattern in 2025/2026 VS Code ecosystem; strong state management story with hooks; widely used by GitHub Copilot Chat and similar complex extensions; better than Vue/Svelte for webview DX because the VS Code community has consolidated on it |
| Vite | `^6.x` | Webview build and HMR in development | Pair with React for webview-only builds; provides Fast Refresh in dev mode; esbuild handles extension host while Vite handles webview — avoids configuring two separate webpack pipelines |
| Tailwind CSS | `^4.x` | Webview styling | Map VS Code CSS variables to Tailwind tokens so panels feel native across themes; v4's CSS-first config works well in Vite. Do NOT use for extension host code (Node.js side). |
| `ws` | `^8.18.x` | WebSocket server (LAN + Cloud transport layer) | Raw, battle-tested, zero dependencies beyond Node.js buffers; runs fine in the extension host process; supports both TCP server (LAN) and encrypted TLS upgrade (cloud); 50k+ connections ceiling means it won't be the bottleneck. Prefer `ws` over Socket.IO because VersionCon's push model is explicit, not continuous — no need for Socket.IO's auto-reconnect magic or room abstractions that come with its 300 KB overhead |
| `bonjour-service` | `^1.x` | mDNS/Zeroconf LAN service discovery | Modern TypeScript rewrite of the deprecated `bonjour` package; pure JS, no native dependencies (unlike `node-mdns` which requires `libavahi` on Linux); allows host to advertise `_versioncon._tcp.local` and joiners to discover it without typing an IP. Actively maintained with recent releases |
| `web-tree-sitter` | `^0.25.x` (pin to 0.25.x) | AST parsing for dependency analysis in extension host | WASM-based; runs in Node.js extension host without native module ABI issues that break across VS Code Electron upgrades. Critical note: pin to `^0.25.x` — 0.26.x WASM files are incompatible with 0.20.x-era grammar `.wasm` files, and not all language grammars have been rebuilt yet |
| Zod | `^4.x` | Message protocol validation between extension host and webview, and over WebSocket | TypeScript-first; validates incoming JSON messages at runtime and infers types statically — eliminates a whole class of "wrong message shape" bugs across the WebSocket and postMessage boundaries. v4 added tree-shakeable mini build ideal for extension bundles |

---

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tree-sitter-javascript` | `^0.25.0` | JS/JSX AST grammar for web-tree-sitter | Used by dependency analysis engine for JavaScript files |
| `tree-sitter-typescript` | `^0.25.x` | TypeScript + TSX grammar for web-tree-sitter | TypeScript files; note this package provides both `typescript` and `tsx` grammar variants |
| `tree-sitter-python` | `^0.25.0` | Python AST grammar for web-tree-sitter | Python dependency tracking (function calls, imports) |
| `tree-sitter-java` | `^0.23.5` | Java AST grammar for web-tree-sitter | Java dependency analysis; last published Dec 2024 — verify WASM compat against your pinned web-tree-sitter version |
| `tree-sitter-cpp` | `^0.23.4` | C/C++ grammar for web-tree-sitter | C/C++ analysis; covers both C and C++ syntaxes |
| `@sanity/diff-match-patch` | `^3.2.x` | Character-level diff and patch for push summaries | Maintained fork of Google's diff-match-patch; used to compute line-by-line diffs shown in the "smart push summary" before a push is confirmed. The original `diff-match-patch` is 6 years stale; use this fork |
| `vscode-languageclient` / `vscode-languageserver` | `^9.x` | LSP infrastructure (optional, for future language server extension) | Only if dependency analysis grows complex enough to warrant a dedicated language server process. Not needed for v1 — do analysis inline in extension host |
| `@vscode/test-electron` | `^2.x` | Integration testing inside VS Code process | Required for tests that need full VS Code Extension API access; pairs with Mocha |
| `mocha` | `^10.x` | Unit + integration test runner | VS Code's built-in test tooling uses Mocha under the hood via `@vscode/test-cli`; use it directly for consistency |
| `@types/ws` | `^8.x` | TypeScript types for ws | Dev dependency; needed because `ws` ships CommonJS without bundled types |
| `uuid` | `^11.x` | Generate unique IDs for branches, pushes, users | Pure JS, tiny; used for push IDs, session tokens, branch GUIDs |

---

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `@vscode/vsce` | Package and publish to VS Code Marketplace | The official CLI for `.vsix` packaging; run `vsce package` and `vsce publish` |
| ESLint + `typescript-eslint` | Lint TypeScript source | Use `@typescript-eslint/recommended-type-checked` ruleset; catches async/await misuse in extension activation |
| `prettier` | Code formatting | Configure to match VS Code's own style; pair with eslint-config-prettier to avoid conflicts |
| VS Code Launch configs (`.vscode/launch.json`) | Debug extension in Extension Development Host | Set up two launch configs: one that runs the extension + one for webview HMR server |
| `@vscode/test-cli` | Modern CLI for running extension tests | Wraps `@vscode/test-electron` with a simpler config; recommended in 2025 docs |

---

## Installation

```bash
# Extension host dependencies
npm install ws bonjour-service web-tree-sitter tree-sitter-javascript tree-sitter-typescript tree-sitter-python tree-sitter-java tree-sitter-cpp @sanity/diff-match-patch zod uuid

# Webview dependencies (install in webview-ui/ sub-package or configure as separate build target)
npm install react react-dom tailwindcss

# Dev dependencies
npm install -D @types/vscode @types/ws typescript esbuild vite @vitejs/plugin-react @vscode/vsce @vscode/test-electron @vscode/test-cli mocha @types/mocha eslint typescript-eslint prettier
```

**Project structure:**

```
versioncon/
├── src/                    # Extension host (Node.js, esbuild target)
│   ├── extension.ts        # Activation entry point
│   ├── server/             # WebSocket server (ws)
│   ├── discovery/          # mDNS (bonjour-service)
│   ├── analysis/           # AST parsing (web-tree-sitter)
│   ├── sync/               # Diff + push logic
│   └── protocol/           # Zod schemas for all messages
├── webview-ui/             # React webview app (Vite target)
│   ├── src/
│   │   ├── panels/         # SplitPane, BranchView, WorkspaceView
│   │   ├── components/
│   │   └── protocol/       # Shared Zod schemas (import from ../src/protocol)
│   └── vite.config.ts
├── esbuild.js              # Extension host bundler
├── package.json            # engines.vscode: "^1.100.0"
└── tsconfig.json
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `ws` (raw WebSocket) | Socket.IO | If you needed HTTP long-polling fallback for corporate firewalls, or built-in room abstractions — but VersionCon runs inside VS Code (Node.js), not a browser, so HTTP fallback is irrelevant and rooms can be a 20-line Map implementation |
| `bonjour-service` | `node-mdns` | `node-mdns` is more battle-tested for embedded Linux but requires native dependencies (`libavahi-compat-libdnssd-dev`); impossible to distribute as a VS Code extension without native rebuild on install. `bonjour-service` is pure JS and ships in `.vsix` cleanly |
| `web-tree-sitter` (WASM) | `tree-sitter` (native Node bindings) | Native `tree-sitter` is faster but uses native `.node` modules that break on every Electron ABI version bump. WASM runs identically across all VS Code versions. The performance difference is ~2-3x but dependency analysis runs per-push (not per-keystroke) so it's acceptable |
| React + Vite | Svelte + Vite | Svelte produces smaller bundles and has excellent TS support; choose it if bundle size becomes a concern after v1. React has stronger community patterns for complex drag-drop UIs specifically |
| `@sanity/diff-match-patch` | `fast-diff` | `fast-diff` is lighter (only computes diffs, no patch/apply) and fine if you only need display diffs. Use `fast-diff` for the visual push summary; use `@sanity/diff-match-patch` if you ever need to apply patches for revert operations |
| Zod | `ajv` | `ajv` is faster for JSON Schema validation but is JSON-Schema-centric and requires separate type generation. Zod infers TypeScript types automatically, which matters across the WebSocket message boundary where type safety is critical |
| esbuild (extension host) | webpack | webpack offers more plugins but is 10-20x slower. VS Code's own docs list esbuild first. Only switch to webpack if you need a plugin that esbuild doesn't support |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@vscode/webview-ui-toolkit` | Officially deprecated as of January 1, 2025. Microsoft has stopped maintaining it. | React + Tailwind CSS with VS Code CSS variable mappings. The VS Code-native look comes from CSS variables (`--vscode-button-background`, etc.), not the component library |
| `vscode` npm package (legacy) | Deprecated in favor of `@types/vscode`; confusingly, there is still an npm package named `vscode` — it is unmaintained since 2019 | `@types/vscode` for types + `@vscode/test-electron` for testing |
| `node-mdns` | Requires system-level native dependencies (`libavahi` on Linux, Bonjour on Windows) that cannot be bundled in a `.vsix`. Extension installs would break on clean machines | `bonjour-service` (pure JavaScript TypeScript rewrite) |
| `tree-sitter` (native Node binding) | Native `.node` modules must be compiled against the exact Electron ABI version. VS Code updates Electron every few months, breaking native modules silently. Extensions cannot distribute prebuilt binaries for every Electron version | `web-tree-sitter` (WASM build) — runs in any Node.js/Electron without recompilation |
| Google CRDTs / `yjs` / `automerge` | PROJECT.md explicitly rules out real-time character-by-character sync. CRDTs add significant complexity (convergence logic, vector clocks) for a push-based model where the server is the single source of truth | Simple push-based delta model: diff on push, apply on pull, server holds canonical state |
| `chokidar` for file watching | Inside VS Code extensions, `vscode.workspace.createFileSystemWatcher()` is the correct API — it respects the user's `files.watcherExclude` settings, integrates with VS Code's own watcher, and doesn't add an external dependency | `vscode.workspace.createFileSystemWatcher()` |
| Real-time co-editing (Yjs, ShareDB) | VersionCon's architecture is explicitly "push when ready, not character-by-character." Adding OT or CRDT sync would contradict the core design decision in PROJECT.md and massively increase complexity | WebSocket broadcast of push events with diff payloads |
| `electron` as a separate dependency | VS Code already runs in Electron; importing it again in the extension host creates version conflicts | Use Node.js built-ins (`http`, `net`, `crypto`) available through VS Code's Electron runtime |

---

## Stack Patterns by Variant

**If running as LAN host (server mode):**
- Spin up a `ws.WebSocketServer` on a configurable port (default 7379)
- Advertise via `bonjour-service` as `_versioncon._tcp.local` with metadata (host name, port, repo name)
- Store branch state in a plain JSON + file tree structure on the host's local disk
- All clients connect via WebSocket; host is the single source of truth

**If running as LAN client (joiner mode):**
- Use `bonjour-service` to browse for `_versioncon._tcp` services
- Show discovered hosts in the setup wizard webview
- Connect via `ws.WebSocket` client to the host's IP:port
- No local server process needed

**If running in Cloud mode:**
- Same WebSocket protocol, different transport: connect to a hosted relay server (TLS WebSocket `wss://`)
- The hosted relay is the same Node.js `ws` server, deployed as a standalone service (not the VS Code extension)
- Extension's `server/` module should be transport-agnostic: `LanTransport` vs `CloudTransport`, both implementing the same interface

**For dependency analysis performance:**
- Initialize all `web-tree-sitter` parsers eagerly on extension activation (not lazy), because WASM load time is ~200ms per language — pre-warming avoids blocking the first push analysis
- Cache parsed trees by file URI + content hash; invalidate on file change events
- Run analysis in a `setImmediate`/async loop to avoid blocking the extension host event loop

**For the split-pane webview:**
- Use `vscode.window.createWebviewPanel()` with `ViewColumn.One` for workspace view and `ViewColumn.Two` for branch view — these map naturally to VS Code's editor column system
- Implement drag-and-drop using the HTML Drag and Drop API inside the webview; communicate file paths back to extension host via `postMessage`
- Note: VS Code 1.90+ requires a shift-click confirmation for cross-webview drops from different origins; architect both panes as a single webview panel to avoid this security prompt

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `web-tree-sitter@^0.25.x` | Grammar WASM files built with `tree-sitter-cli@0.25.x` | Do NOT upgrade to 0.26.x until all language grammars have rebuilt WASM files; 0.26.x breaks 0.20.x-era grammar WASMs |
| `tree-sitter-javascript@^0.25.0` | `web-tree-sitter@^0.25.x` | Match major.minor versions |
| `tree-sitter-typescript@^0.25.x` | `web-tree-sitter@^0.25.x` | Same alignment requirement |
| `tree-sitter-python@^0.25.0` | `web-tree-sitter@^0.25.x` | Same |
| `tree-sitter-java@^0.23.5` | `web-tree-sitter@^0.25.x` | Java grammar lags behind; test WASM compatibility explicitly before v1 ship |
| `tree-sitter-cpp@^0.23.4` | `web-tree-sitter@^0.25.x` | Same caveat as Java; verify WASM build version |
| `@types/vscode@^1.109.0` | VS Code engine `^1.100.0` | Set `"engines": { "vscode": "^1.100.0" }` in package.json; users on older VS Code won't be offered the extension |
| React 18 + Vite 6 | Node.js `>=18.x` | Vite 6 requires Node 18+; VS Code's bundled Node.js is currently 20.x — no conflict |
| `ws@^8.x` | Node.js `>=14.x` | VS Code's Electron ships Node 20+; no compatibility concern |

---

## Sources

- Official VS Code Extension API — Webview Guide: https://code.visualstudio.com/api/extension-guides/webview
- Official VS Code Bundling Extensions: https://code.visualstudio.com/api/working-with-extensions/bundling-extension
- Official VS Code UX Guidelines: https://code.visualstudio.com/api/ux-guidelines/overview
- Official VS Code Tree View API: https://code.visualstudio.com/api/extension-guides/tree-view
- VS Code 2026 Extension Guide (third-party, MEDIUM confidence): https://abdulkadersafi.com/blog/building-vs-code-extensions-in-2026-the-complete-modern-guide
- Context7 `/websockets/ws` — broadcast and server creation patterns (HIGH confidence)
- Context7 `/tree-sitter/tree-sitter` — incremental parsing, web-tree-sitter initialization (HIGH confidence)
- Context7 `/websites/socket_io` — rooms/namespaces reference (HIGH confidence, used to confirm ws is sufficient)
- Context7 `/colinhacks/zod` — schema validation API (HIGH confidence)
- npm: `web-tree-sitter@0.26.8` — version confirmed, 0.26.x compat issue noted (MEDIUM confidence): https://www.npmjs.com/package/web-tree-sitter
- npm: `bonjour-service` TypeScript rewrite of bonjour (MEDIUM confidence): https://www.npmjs.com/package/bonjour-service
- GitHub issue: web-tree-sitter 0.26.x incompatibility with old grammar WASMs (HIGH confidence): https://github.com/tree-sitter/tree-sitter/issues/5171
- VS Code Webview UI Toolkit deprecation (HIGH confidence): https://github.com/microsoft/vscode-webview-ui-toolkit
- `@types/vscode` version 1.109.0 current as of 2026-05-04 (HIGH confidence): https://www.npmjs.com/package/@types/vscode
- `@sanity/diff-match-patch` maintained fork (MEDIUM confidence): https://www.npmjs.com/package/@sanity/diff-match-patch
- VS Code extension SecretStorage API (HIGH confidence): https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
- Cross-webview drag-drop shift-confirm issue in VS Code 1.90+ (MEDIUM confidence): https://github.com/microsoft/vscode/issues/256444

---

*Stack research for: Collaborative VS Code Extension (VersionCon)*
*Researched: 2026-05-04*
