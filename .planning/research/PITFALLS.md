# Pitfalls Research

**Domain:** Collaborative VS Code extension with LAN/cloud version control, AST dependency analysis, and split-pane UI
**Researched:** 2026-05-04
**Confidence:** HIGH (VS Code API pitfalls), HIGH (networking), MEDIUM (AST multi-language), HIGH (sync/UX)

---

## Critical Pitfalls

### Pitfall 1: tree-sitter NODE_MODULE_VERSION Mismatch Breaks Extension on Install

**What goes wrong:**
The native `node-tree-sitter` module compiles against the OS Node.js version, not the Electron/Node.js version embedded in VS Code. The result is a `NODE_MODULE_VERSION` error at runtime: "The module was compiled against a different Node.js version." The extension loads fine in the Development Host but crashes on install in real VS Code.

**Why it happens:**
VS Code runs its own bundled Electron version of Node.js (often newer or older than the system Node). Native `.node` binaries target a specific NODE_MODULE_VERSION. When the user's system Node.js differs from VS Code's embedded Electron Node, the prebuilt binary is incompatible. This is a known and recurring issue in `node-tree-sitter` issue tracker (issues #169, #188, #189).

**How to avoid:**
Use `web-tree-sitter` (the WASM build) instead of `node-tree-sitter` for all parsing. Pin `web-tree-sitter` and grammar WASM files to the same tree-sitter-cli ABI version — mixing `web-tree-sitter@0.26.x` with WASM files built by `tree-sitter-cli@0.20.x` also fails silently. The `@vscode/tree-sitter-wasm` package provides pre-built WASM files that match VS Code's own internal usage. Use that as the canonical source for grammar WASM files.

**Warning signs:**
- Extension loads in dev host but throws on install in a real VS Code window
- `Error: The module ... was compiled against a different Node.js version` in the Extension Host output
- Works on developer's machine, fails on teammate's machine with a different Node.js version

**Phase to address:**
Foundation / Extension Scaffolding phase — choose `web-tree-sitter` from day one. Switching later requires rewriting the entire AST layer.

---

### Pitfall 2: mDNS/UDP Broadcast LAN Discovery Silently Fails in Corporate and Multi-VLAN Networks

**What goes wrong:**
LAN peer discovery built on mDNS (UDP port 5353) or raw UDP broadcast will appear to work perfectly on home networks and dev machines, then completely fail in university networks, office networks, or any environment with VLANs, managed switches, or a strict firewall policy. Corporate IT actively disables mDNS. Even without a firewall, multicast/broadcast traffic does not cross VLAN boundaries by design. The failure is silent from the user's perspective — the "Join" flow just never finds the host.

**Why it happens:**
mDNS is link-local multicast: it is not routed between subnets. A hackathon where attendees are on different wireless SSIDs (common in universities), or an office with guest/corp VLANs, will segment participants even if they're physically nearby. Windows also has a known bug in Node.js `dgram` where UDP broadcast fails on ad-hoc networks with no internet connection.

**How to avoid:**
Never rely solely on automatic discovery. Always provide a manual "enter IP + port" fallback as the primary join path for LAN mode. mDNS discovery should be a convenience feature, not the required path. Design the join wizard to show the host's IP address prominently so it can be shared out-of-band (copy-paste in chat). For cloud mode, the rendezvous server eliminates this problem entirely.

**Warning signs:**
- Discovery works on dev machine but fails when testing across two physical machines
- "Join" wizard hangs with a spinner indefinitely instead of timing out with a helpful error
- No fallback to manual IP entry

**Phase to address:**
LAN Networking phase — build the manual IP join flow before the mDNS discovery feature, not after.

---

### Pitfall 3: Webview State Loss on Tab Switch Causes "Ghost" UI

**What goes wrong:**
VS Code destroys a webview's DOM and JavaScript context when its panel moves to a background tab. If the extension uses `retainContextWhenHidden: false` (the default), the entire split-pane UI state — which files are open, what's in the workspace pane, what's been dragged — vanishes the moment the user clicks another tab. When they return, the UI re-renders from scratch, potentially showing a stale or empty state that disagrees with what the extension host knows about the current workspace.

**Why it happens:**
Webviews are sandboxed iframes. VS Code deliberately destroys their context to save memory. The extension host (TypeScript/Node.js side) retains its in-memory state, but the webview (React/HTML side) does not. If the webview re-initializes without fetching current state from the extension host on mount, it shows its initial empty state.

**How to avoid:**
Implement a strict "webview is stateless" architecture. On every webview mount, fire a `webview-ready` message to the extension host; the host responds with the full current state snapshot. Store no authoritative state inside the webview — treat it purely as a rendering layer. Use `setState`/`getState` for lightweight ephemeral UI state (scroll position, open nodes), not for business data. Only use `retainContextWhenHidden: true` as a last resort: it has high memory cost and should never be the default.

**Warning signs:**
- Split-pane resets to empty when switching away and returning
- Workspace pane shows files that were dragged but the branch pane no longer highlights them
- `webview.html` is being set in full on every panel focus event

**Phase to address:**
Split-Pane UI phase — design the host↔webview state protocol before building any UI components.

---

### Pitfall 4: "One Folder on Disk" Assumption Breaks When Two Panes Diverge

**What goes wrong:**
The architecture decision — one real folder on disk, two visual panes — is correct and elegant. The pitfall is that the visual layer can silently diverge from filesystem reality. Scenarios where this happens: (1) a file is dragged to the workspace pane in the UI but the actual file copy operation fails mid-write; (2) an external editor or terminal modifies a file that the branch pane considers "unchanged"; (3) the user deletes a file from the OS file explorer, but the branch pane tree still shows it. The UI shows one thing; disk has another. If the push system operates on UI state rather than filesystem truth, corrupted or lost data follows.

**Why it happens:**
The UI tree model is maintained in memory (extension host) and the filesystem is the ground truth. When the two get out of sync — due to file watcher gaps, failed writes, or external changes — the extension has no mechanism to detect and reconcile the divergence.

**How to avoid:**
The extension host must treat the filesystem as the single source of truth at all times. The in-memory tree model is a cache of filesystem state, not a primary store. Any operation that modifies files (drag, copy, delete) must complete the filesystem operation atomically first, then update the in-memory model on success. File watcher events (chokidar) should trigger a reconciliation pass that updates the UI tree model, not the reverse. Add a periodic consistency check: compare in-memory tree against actual disk contents and flag discrepancies.

**Warning signs:**
- UI shows a file as "in workspace" but it does not exist on disk
- Push succeeds according to the UI but the host never received the file content
- File watcher and in-memory model update in different code paths

**Phase to address:**
File System & Workspace Model phase — establish the "filesystem is truth" invariant with tests before building any UI on top.

---

### Pitfall 5: File Watcher Events Are Unreliable Across OS and Editor Combos

**What goes wrong:**
Chokidar (and the underlying `fs.watch`) delivers file system events differently on macOS (FSEvents), Linux (inotify), and Windows (FileSystemWatcher). Specific failure modes: (1) some editors save by writing to a temp file and renaming — this generates `rename/create/delete` events rather than a `change` event, breaking logic that only watches for `change`; (2) on macOS, `fs.watch` doesn't report filenames and misses events from some editors; (3) rapid back-to-back saves cause events to coalesce, dropping intermediate states; (4) multiple chokidar instances watching the same directory conflict with each other.

**Why it happens:**
OS-level file APIs expose inconsistent abstractions. Editors like Vim, Emacs, and many others use rename-based atomic save patterns. The VS Code extension is required to work across all three OS targets and with any editor the user chooses to run alongside VS Code.

**How to avoid:**
Use chokidar with `awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }` to handle rename-based saves and burst writes. Watch only the paths that matter (workspace files, branch directory) rather than the entire project root. Ensure only one chokidar instance is active per watched path — dispose and recreate watchers on reconnect rather than accumulating them. Test on all three OS targets explicitly, not just the developer's platform.

**Warning signs:**
- File changes not detected when using Vim or Emacs as the editing backend
- Push misses recent saves that happened in rapid succession
- Extension spawns multiple watchers on the same directory over time (connection drops and reconnects)

**Phase to address:**
File System & Workspace Model phase — test file watcher behavior on all three OS targets in automated tests before any other feature depends on it.

---

### Pitfall 6: AST Dependency Analysis Produces False Positives from Dynamic Language Features

**What goes wrong:**
The dependency conflict detection system is built on static AST analysis. For Python and JavaScript/TypeScript, static analysis cannot reliably resolve all call sites because of dynamic dispatch, duck typing, monkey-patching, and runtime imports (`__import__`, `require` with a variable, `eval`). The system flags "Alice modified `calculate_total`, and you call it on line 34" — but the function at line 34 is actually a different `calculate_total` from a different module, resolved only at runtime. False positives (phantom conflicts) erode user trust faster than false negatives.

**Why it happens:**
Static AST analysis captures declared structure, not runtime behavior. Python's dynamic typing means two functions with the same name in different modules are indistinguishable without runtime context. Dynamic imports, decorators, and metaclasses make Python and JS codebases deliberately opaque to static analysis.

**How to avoid:**
Scope dependency tracking at the module-import level first, then function-call level within confirmed imports. For Python: only flag a conflict if the import statement for the affected module is present in the user's file AND the function name matches. Never cross-module-boundary match on name alone. Provide a confidence level on each conflict notification ("high confidence: direct import found" vs. "possible: same function name in project"). Build a feedback mechanism so users can dismiss false-positive warnings and the system learns.

**Warning signs:**
- Team members routinely dismissing conflict notifications without reading them
- Two files with no actual shared dependency both flagged as conflicting
- Conflict detection on generic function names like `init`, `get`, `update` generating noise constantly

**Phase to address:**
Dependency Analysis phase — validate precision (false positive rate) with real codebases before integrating with the push flow.

---

### Pitfall 7: AST Parsing Performance Degrades on Large Generated Files

**What goes wrong:**
`web-tree-sitter` incremental parsing is fast for human-edited files (typically <10k lines). But many codebases contain generated files: minified JS bundles, protobuf outputs, auto-generated TypeScript declaration files, large test fixtures with inline data. A single `node_modules` file or a `dist/bundle.js` at 100k+ lines can spike CPU for several seconds and block the push analysis pipeline.

**Why it happens:**
Tree-sitter's incremental approach shares unchanged tree regions between parses, but a first parse of a very large file with no prior tree is necessarily expensive. WASM execution is also slower than native — typically 2-5x overhead for large parse jobs.

**How to avoid:**
Implement a file size guard before parsing: skip files above a configurable threshold (default: 500KB) and fall back to line-level change detection. Always respect `.gitignore` patterns and exclude `node_modules`, `dist`, `build`, and other generated directories from the dependency graph entirely. Parse asynchronously in a Web Worker (or the extension host's worker thread) to avoid blocking the UI thread. Cache parse trees keyed by file path + content hash, and invalidate only on change events for that specific file.

**Warning signs:**
- Push analysis takes >2 seconds on projects with large generated files
- UI freezes during dependency scan
- Extension host CPU spikes on projects that include `node_modules` in the workspace

**Phase to address:**
Dependency Analysis phase — implement file size guard and `node_modules` exclusion before performance testing with real projects.

---

### Pitfall 8: Permission System Complexity Creep Derails the MVP

**What goes wrong:**
The branch permission model in the requirements (grant/revoke per person, lock branches, restrict to specific branches, merge-to-main rules) is designed as a full RBAC system. Teams typically start by building fine-grained permission matrices, then spend 30-40% of the project on permission UI, enforcement logic, and edge cases — before building the core collaboration features that actually provide value. The permission system ends up more complex than the product it protects.

**Why it happens:**
Permissions seem "structural" — like they must be in place before anything else. In reality, for a 5-10 person hackathon team, nobody uses fine-grained permissions. The admin is trusted. They only need broad controls: "this person can push to main" or "this person is read-only." Over-engineering for enterprise-scale RBAC on day one is a classic mistake in small-team collaboration tools.

**How to avoid:**
Ship Phase 1 with two roles only: `admin` and `member`. Admin can push anywhere; member can push only to branches they created. No per-branch, per-user permission matrices in the MVP. Add granular permissions only after validating that real users actually request them. Build the permission data model to be extensible from the start, but do not build the UI or enforcement for granular permissions until there is user demand.

**Warning signs:**
- Permission UI takes more than 1 sprint to build
- More than two roles exist in the MVP
- The team is discussing permission inheritance rules before shipping the first push

**Phase to address:**
Branch Management phase — explicitly document that granular RBAC is deferred and define what "admin/member" covers in a single sprint.

---

### Pitfall 9: Cross-Webview Drag-and-Drop Blocked by VS Code Security Policy

**What goes wrong:**
The split-pane drag-and-drop (branch → workspace, workspace → branch) requires dragging items between two webview panels. VS Code enforces a security policy that requires the user to hold `Shift` before dropping when the drag source is a webview, not a native VS Code UI element. This is a non-obvious UX friction point that many users never discover — they try to drag and the drop just does not work. There is also a known regression in VS Code 1.90+ where drag-and-drop between two custom-extension webviews broke entirely (issue #256444).

**Why it happens:**
VS Code sandboxes webview content to prevent XSS-based attacks that could leverage drag-and-drop as an exfiltration vector. The Shift modifier is required to signal user intent when crossing webview trust boundaries.

**How to avoid:**
Do not rely exclusively on HTML5 drag-and-drop between two webview panels. Implement drag-start in Webview A and listen for it in the extension host; route the drop event through the extension host as a message to Webview B. This avoids direct webview-to-webview DOM events entirely. Test drag-and-drop on every VS Code release that ships during development — the behavior has changed across minor versions. Provide a right-click context menu as a fallback action for all drag operations.

**Warning signs:**
- Drag initiates in one pane but the drop cursor never changes to "copy" in the other pane
- Works in VS Code 1.89 but not 1.90+
- No fallback action (button, context menu) for users who cannot figure out drag

**Phase to address:**
Split-Pane UI phase — prototype and test drag-and-drop on real VS Code before building other UI features that depend on it.

---

### Pitfall 10: WebSocket Connections Appear Alive but Are Actually Stale (Zombie Connections)

**What goes wrong:**
On LAN mode, a team member's laptop goes to sleep, a network interface changes, or a VPN disconnects. The TCP connection is not cleanly closed — it just stops responding. The server sees the connection as open; the client may also believe it is connected. Status indicators show "in sync" while no data is actually being exchanged. When the user wakes the laptop and tries to push, the extension either silently fails or takes 30+ seconds to time out before showing an error.

**Why it happens:**
TCP's `keepalive` mechanism at the OS level has a default timeout of minutes to hours, far too slow for a user-facing collaboration tool. Node.js `ws` library does not implement application-level heartbeats by default — connections must be explicitly pinged.

**How to avoid:**
Implement application-level heartbeats: send a `ping` from server to client every 15 seconds; if no `pong` arrives within 5 seconds, mark the connection as dead and trigger reconnection. Use the `reconnecting-websocket` library or equivalent on the client side to handle transparent reconnection. Display accurate connection status in the UI: "Connected," "Reconnecting," and "Disconnected" must reflect the actual state of the heartbeat, not just the WebSocket's `readyState`. Never infer connection health from the absence of errors.

**Warning signs:**
- Status indicator stays green after laptop wake-from-sleep
- Push fails silently after a period of inactivity
- Server-side connection count grows over hours without corresponding client connections

**Phase to address:**
LAN Networking phase — build heartbeat and reconnection before building any feature that depends on connection state.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Using `node-tree-sitter` instead of `web-tree-sitter` | Slightly simpler setup | Extension crashes on install for users with wrong Node version; unfixable without rewrite | Never — use WASM from day one |
| Storing UI state in webview JavaScript variables | Feels natural in React state | State lost on tab switch; two panes desync; bugs impossible to reproduce | Never — host is authoritative |
| mDNS-only discovery, no manual IP fallback | Simpler join flow | Completely unusable in office/university networks; unfixable without redesign | Never — ship manual IP first |
| Single-threaded synchronous AST parsing in extension host | Simpler code | Blocks UI thread on large files; unfixable without async refactor | Never — use worker from day one |
| Full RBAC permission system in MVP | Feels "enterprise-ready" | Consumes 30-40% of time before core features are validated | Never in MVP — two roles max |
| Polling filesystem instead of using chokidar | Easier cross-platform | High CPU usage, missed rapid changes, battery drain | Acceptable only for a short prototype sprint |
| Setting `retainContextWhenHidden: true` on all webviews | Prevents state loss easily | High memory cost, slows VS Code startup, causes issues on low-RAM machines | Only for panels that cannot be rebuilt from host state |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `web-tree-sitter` grammars | Mixing WASM files from different tree-sitter-cli ABI versions | Pin grammar WASM files to match the `web-tree-sitter` version exactly; use `@vscode/tree-sitter-wasm` |
| VS Code Webview API | Setting `webview.html` on every panel focus (triggers full reload) | Set `webview.html` once on panel creation; use message passing for state updates |
| Chokidar file watcher | Creating a new watcher on every connection event | Track watcher instances and dispose before recreating; one watcher per watched path |
| WebSocket (`ws` library) | No heartbeat mechanism | Implement ping/pong every 15 seconds; treat missing pong as dead connection |
| Node.js `dgram` UDP on Windows | Broadcast fails without internet on ad-hoc networks | Test on all three OS platforms; always provide manual IP join as fallback |
| VS Code `acquireVsCodeApi()` | Calling it multiple times or exposing it to global scope | Call once, store result, keep private to the webview module |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Parsing all files on every push | Push analysis takes seconds, users skip pushing | Parse incrementally; only re-parse changed files; cache trees by content hash | Projects with >50 files |
| Full dependency graph recompute on any file change | CPU spike on every keystroke/save | Invalidate only the changed file's subgraph; recompute lazily on push trigger | Codebases >100 files |
| Sending full branch state over WebSocket on every update | Bandwidth spike on large projects, slow sync | Send diffs only; full state only on initial connection or explicit resync | Teams with >500 files in branch |
| Loading entire push history into memory for log view | Extension host memory grows unboundedly | Paginate push history; load on demand; cap in-memory cache at N entries | After >1000 pushes |
| Synchronous file copy for "drag to workspace" on large folders | VS Code UI freezes during drag operation | Use async streaming copy with progress indicator; never block extension host event loop | Folders with >100 files |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| No CSP on webview HTML | XSS via injected branch filenames or commit messages renders arbitrary HTML | Set `Content-Security-Policy` with script nonce; sanitize all data rendered into webview innerHTML |
| Accepting arbitrary file paths from webview postMessage without validation | Path traversal: a malicious webview payload writes files outside the workspace | Validate all paths received from webview against the workspace root before any filesystem operation |
| Broadcasting host LAN IP + port without any auth token | Any machine on the LAN can join and read/write code | Require a join token (short alphanumeric code displayed by host); reject connections without valid token |
| Storing credentials (cloud mode tokens) in VS Code workspace settings | Settings checked into git; credentials leaked in `.vscode/settings.json` | Use VS Code `SecretStorage` API (`context.secrets`) for all credentials; never write tokens to settings |
| No rate limiting on incoming WebSocket messages | A malicious or buggy client can spam the host with push events, causing CPU/memory exhaustion | Rate-limit incoming messages per connection; drop connections that exceed threshold |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Conflict notification fires mid-typing | User interrupted at wrong moment; notification dismissed without reading | Buffer notifications; show at natural break points (on save, on focus-switch to another file) |
| "Fishbowl effect" — teammates see every keystroke in real-time | Writers feel watched; users work in other editors to avoid visibility | VersionCon's explicit push model avoids this — only push content is visible to team; presence shows file, not content |
| Conflict UI shows raw diff markers (`<<<` / `>>>`) without context | User cannot understand what changed or why it matters | Show named diff: "Alice changed `calculate_total` — you call this in line 34" with inline line preview |
| Push summary too long — blocks workflow for small changes | Users learn to skim or skip the summary entirely | Default to compact summary (N files, N functions changed); expand on click for full diff |
| Status indicator always shows green even when reconnecting | Users falsely trust sync state; push to stale branch | Three explicit states: Connected / Reconnecting (yellow) / Disconnected (red); never show green during uncertainty |
| "Sync before run" enforcement blocks debugging urgently | Frustrating when iterating rapidly on personal code | Make sync-before-run a warning by default, not a hard block; let users override with confirmation |
| Undo push notification fires for every team member on every revert | Notification fatigue; users disable all notifications | Notify only members whose workspace has files affected by the reverted push |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **LAN Discovery:** Often missing the manual IP fallback — verify that "enter IP manually" works end-to-end before calling discovery done
- [ ] **Drag-and-Drop:** Appears to work on macOS but not tested with VS Code 1.90+ on Windows — verify cross-webview drag on all three OS and multiple VS Code minor versions
- [ ] **Dependency Analysis:** Shows results in demo with simple projects — verify precision on a real-world codebase with dynamic imports and circular dependencies before integrating into push flow
- [ ] **Connection Status:** Status indicator shows "Connected" — verify it accurately reflects heartbeat state, not just WebSocket `readyState`; test after laptop sleep/wake
- [ ] **File Watcher:** Events fire in dev environment — verify with Vim/Emacs save patterns (rename-based atomic save) and rapid burst saves
- [ ] **Push History:** First 10 pushes display correctly — verify pagination and memory behavior after 500+ pushes
- [ ] **Permission Enforcement:** Admin role blocks pushes in UI — verify enforcement also exists server-side; never trust client-side role checks alone
- [ ] **Webview State:** Split pane shows correctly — verify state is fully restored after switching VS Code tabs away and back
- [ ] **tree-sitter WASM:** Parses correctly in dev host — verify on a fresh VS Code install without any development tooling present; test `web-tree-sitter` ABI version alignment

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| `node-tree-sitter` native module crash | HIGH | Rewrite AST layer to use `web-tree-sitter`; requires changes to every parser call site and build pipeline |
| mDNS-only discovery with no fallback | MEDIUM | Add manual IP entry to join wizard; mDNS remains as optional enhancement; 1-2 sprint effort |
| Webview state loss architecture (state in webview JS) | HIGH | Refactor all state to extension host as single source of truth; requires rewrite of host↔webview protocol |
| Filesystem-UI divergence (UI is source of truth) | HIGH | Add reconciliation pass; add filesystem-event-driven model updates; add consistency tests; 3-4 sprint effort |
| File watcher race conditions discovered late | MEDIUM | Add `awaitWriteFinish` to chokidar config; audit all watcher creation paths; 1 sprint + OS test suite |
| Permission system over-engineered in MVP | MEDIUM | Rip out fine-grained RBAC; replace with admin/member binary model; defers future granularity to config flags |
| Zombie WebSocket connections (no heartbeat) | LOW | Add ping/pong heartbeat + reconnecting-websocket; isolated change; 2-3 days |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| tree-sitter native module mismatch | Extension Scaffolding (Phase 1) | `web-tree-sitter` used in initial setup; no `node-tree-sitter` dependency anywhere |
| mDNS-only discovery failure | LAN Networking (Phase 2) | Manual IP join tested on two separate machines before mDNS is built |
| Webview state loss on tab switch | Split-Pane UI (Phase 2) | Switch tabs 10x in automated test; state is fully restored each time |
| Filesystem-UI divergence | File System & Workspace Model (Phase 2) | Consistency test compares in-memory model vs disk after every operation |
| File watcher OS differences | File System & Workspace Model (Phase 2) | Chokidar integration tested on macOS, Linux, Windows with Vim-style rename saves |
| AST false positives from dynamic languages | Dependency Analysis (Phase 3) | Precision test on 3 real-world codebases; false positive rate documented |
| AST performance on large files | Dependency Analysis (Phase 3) | File size guard implemented; parse time <500ms on 500KB file |
| Permission complexity creep | Branch Management (Phase 3) | MVP ships with exactly two roles; no fine-grained permission UI |
| Cross-webview drag-and-drop blocked | Split-Pane UI (Phase 2) | Drag tested on VS Code 1.90+ on Windows, macOS, Linux |
| Zombie WebSocket connections | LAN Networking (Phase 2) | Heartbeat test: laptop sleeps 60s, reconnects, push succeeds without manual intervention |
| Conflict notification fatigue | Push & Conflict UX (Phase 4) | Notification shown only on save/push trigger; A/B test shows <5% dismiss-without-reading rate |

---

## Sources

- VS Code Webview API official documentation: https://code.visualstudio.com/api/extension-guides/webview
- Trail of Bits VSCode extension escape vulnerability research: https://blog.trailofbits.com/2023/02/21/vscode-extension-escape-vulnerability/
- tree-sitter node module version mismatch (issue #169): https://github.com/tree-sitter/node-tree-sitter/issues/169
- tree-sitter can't use in VS Code extension (issue #189): https://github.com/tree-sitter/node-tree-sitter/issues/189
- @vscode/tree-sitter-wasm package: https://www.npmjs.com/package/@vscode/tree-sitter-wasm
- web-tree-sitter WASM ABI incompatibility (issue #5171): https://github.com/tree-sitter/tree-sitter/issues/5171
- mDNS in the Enterprise (Microsoft): https://techcommunity.microsoft.com/blog/networkingblog/mdns-in-the-enterprise/3275777
- mDNS across VLANs: https://www.xda-developers.com/make-mdns-work-across-vlans/
- Node.js dgram Windows ad-hoc UDP bug: https://github.com/nodejs/node/issues/17980
- Chokidar npm package documentation: https://www.npmjs.com/package/chokidar
- Chokidar race conditions and OS differences: https://github.com/paulmillr/chokidar
- VS Code drag-drop between webviews broken 1.90+ (issue #256444): https://github.com/microsoft/vscode/issues/256444
- Drop files from Explorer to CustomEditor broken (issue #182449): https://github.com/microsoft/vscode/issues/182449
- VS Code Live Share real-time collaborative programming study (ACM): https://dl.acm.org/doi/10.1145/3643672
- Ink & Switch Upwelling — collaborative version control UX research: https://www.inkandswitch.com/upwelling/
- WebSocket heartbeat implementation guide: https://oneuptime.com/blog/post/2026-01-27-websocket-heartbeat/view
- Reliable WebSockets at Close.io: https://making.close.com/posts/reliable-websockets/
- YASA multi-language AST taint analysis pitfalls: https://arxiv.org/pdf/2601.17390
- RBAC complexity creep in SaaS: https://www.ratomir.com/blog/why-most-saas-products-struggle-with-permission-management-and-how-to-build-a-scalable-rbac-model/
- VS Code extension bundling with esbuild: https://code.visualstudio.com/api/working-with-extensions/bundling-extension

---
*Pitfalls research for: VersionCon — Collaborative VS Code extension with LAN/cloud version control*
*Researched: 2026-05-04*
