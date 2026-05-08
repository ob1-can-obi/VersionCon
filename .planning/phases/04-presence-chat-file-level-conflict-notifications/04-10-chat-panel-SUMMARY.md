---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 10
subsystem: ui
tags: [webview, csp, markdown-it, highlight.js, codicons, vscode-webview, chat]

requires:
  - phase: 04-presence-chat-file-level-conflict-notifications
    provides: ChatRecord type (Plan 04-01), ChatLog persistence (Plan 04-02), SessionHost.handleLocalChatMessage public surface (Plan 04-04), SessionClient chat-* events (Plan 04-05), StatusBarManager.setUnreadCount integration point (Plan 04-09)
provides:
  - ChatPanel WebviewPanel singleton at view type 'versioncon.chatPanel'
  - Stateless webview pattern (retainContextWhenHidden:false; webview-ready handshake)
  - Strict CSP per UI-SPEC §5.2 — no unsafe-inline, no CDN, nonce-gated script + style
  - Bundled markdown-it (html:false / linkify:true / breaks:false) + highlight.js (lib/core, 7 languages) — primary T-04-10-01 XSS gate
  - Per-user chatHiddenBefore cutoff persisted via context.workspaceState (Plan 04-11 Clear-my-view dependency)
  - versioncon.openChat command + placeholder versioncon.manageChat command
  - Host-mode local-echo path (dispatchChatReceivedLocally) so the host sees their own message immediately
  - Module-level clientChatRecords cache that flows into ChatPanel state-update snapshots
affects: [Plan 04-11 manage-chat will replace placeholder + read chatHiddenBefore; Phase 6 review-comment authoring will reuse system-event row format; Phase 8 MCP chat-summarization tool will read chat-log.json that this plan's webview renders]

tech-stack:
  added:
    - markdown-it@14.1.0 — markdown rendering with html:false XSS gate (CommonMark spec)
    - highlight.js@11.11.1 — code syntax highlighting (lib/core + selective registerLanguage; class-only output, never inline styles)
    - "@vscode/codicons@0.0.45 — icon font bundled into dist/webview/chat/codicon/ (peer-dep upgrade from declared ^0.0.40 to satisfy @vscode-elements/elements peer requirement)"
    - "@types/markdown-it@14.1.2 (devDep) — type definitions for markdown-it"
  patterns:
    - "WebviewPanel singleton with refs-bundle dependency injection — lets the panel see fresh closures (sendChatMessage, getChatHiddenBefore) without holding direct module references"
    - "Stateless webview + state-update snapshot — extension owns all state, webview is render-only; mirror of WizardPanel pattern from Phase 1"
    - "Browser-side iife esbuild bundle as second context in esbuild.config.mjs; chat-assets onEnd plugin re-copies static assets on every rebuild"
    - "Module-level connection-status mirror so the chat panel's reconnecting/disconnected banner stays in sync without holding a SessionClient reference"

key-files:
  created:
    - src/ui/ChatPanel.ts
    - src/ui/webview/chat/index.html
    - src/ui/webview/chat/main.ts
    - src/ui/webview/chat/main.css
    - src/test/suite/chatRender.test.ts
  modified:
    - src/extension.ts
    - src/filesystem/WorkspaceState.ts
    - esbuild.config.mjs
    - package.json
    - package-lock.json

key-decisions:
  - "ChatPanel CSP exact-matches UI-SPEC §5.2 — no unsafe-inline, font-src cspSource only. Codicons + markdown-it + highlight.js are bundled to dist/webview/chat/, never CDN."
  - "highlight.js/lib/core (selective language imports) chosen over the full bundle to keep the webview JS at ~200KB; 7 languages registered (ts/js/python/java/cpp/json/markdown plus aliases)."
  - "highlight.js emits CLASS-only output (.hljs-keyword etc.); main.css maps each class to var(--vscode-symbolIcon-*Foreground) so syntax colors follow the active VS Code theme without any inline-style violations of the strict CSP."
  - "WorkspaceState.bindContext(context) loads chatHiddenBefore at activate-time from context.workspaceState; getter is sync. The IIFE-owned WorkspaceState is exposed via module-level workspaceStateRef so versioncon.openChat (registered at activate scope) can read the cutoff at panel-build time without an async hop."
  - "Host-local chat path: extension.ts calls activeHost.handleLocalChatMessage (Plan 04-04 owns the method; SessionHost.ts is unchanged in this plan), then dispatchChatReceivedLocally echoes the record into the host's own ChatPanel because the host does NOT receive its own broadcast back over the wire."
  - "open-external scheme filter — vscode.Uri.parse(url, true) followed by an http/https whitelist before vscode.env.openExternal; protects against javascript:/file:/data: schemes even though markdown-it's link validator already filters most of them (defense-in-depth for T-04-10-02)."
  - "ChatPanel.createOrShow(context, refs) refreshes refs on second-call so stale closures from a prior session never reach the singleton (host→client transition mid-life would otherwise leak the wrong sendChatMessage)."
  - "currentConnectionStatus is a module-level mirror, not a SessionClient call. Mirroring it lets the panel's setConnectionStatus banner update instantly via ChatPanel.currentPanel?.setConnectionStatus(...) calls inside connection-changed / session-ended / disconnect handlers."

patterns-established:
  - "Pattern: dual-bundle esbuild config — extension entry stays cjs/node, webview entries use iife/browser/es2022; chat-assets onEnd plugin copies HTML+CSS+codicon assets so localResourceRoots reaches them. Future webview panels (manage-chat, review-comments) follow the same shape."
  - "Pattern: webview unit tests mirror the markdown-it config in-place rather than importing browser modules; if a refactor extracts shared util, tests can repoint without changing assertions."
  - "Pattern: clientChatRecords cache + dispatchChatReceivedLocally helper — clients don't read chat-log.json directly; the cache is reseeded on chat-history (join replay) and appended on chat-received. Host echoes own messages locally because it doesn't receive its own broadcast."

requirements-completed: [COLLAB-02, COLLAB-03, COLLAB-07]

duration: 12min
completed: 2026-05-08
---

# Phase 4 Plan 10: Chat Panel Summary

**Chat WebviewPanel singleton with bundled markdown-it + highlight.js (strict CSP, no CDN), stateless render via state-update snapshots, per-user chatHiddenBefore cutoff, and full extension wiring for chat client events.**

## Performance

- **Duration:** 12min
- **Started:** 2026-05-08T03:16:40Z
- **Completed:** 2026-05-08T03:30:00Z
- **Tasks:** 5/5 completed
- **Files modified:** 9 (5 created + 4 modified)

## Accomplishments

- ChatPanel WebviewPanel singleton (src/ui/ChatPanel.ts) with strict CSP, stateless render, retainContextWhenHidden:false, view-type 'versioncon.chatPanel', and full postMessage protocol (6 inbound + 4 outbound message types).
- Bundled webview JS (~200KB minified) including markdown-it @14.1.0 + highlight.js @11.11.1 (lib/core + 7 languages via selective registerLanguage). Strict CSP `script-src 'nonce-X'` only — no CDN, no unsafe-inline. Codicon font + CSS copied into dist/webview/chat/codicon/.
- Hex-free CSS — every color routes through `var(--vscode-*)`. Highlight.js class shim maps `.hljs-*` to `--vscode-symbolIcon-*Foreground` so syntax colors follow the active theme (Light+, Dark+, High Contrast).
- WorkspaceState.bindContext + chatHiddenBefore getter/setter persisted via context.workspaceState (per-user / per-workspace; never broadcast).
- versioncon.openChat command registered; chat-received / chat-cleared / chat-truncated / chat-history listeners wired into ChatPanel + clientChatRecords cache + UI-SPEC §7.3 toasts.
- Host-mode local-echo path (dispatchChatReceivedLocally) so the host sees their own typed message immediately — they don't receive their own broadcast back over the wire.
- 16 new unit tests in chatRender.test.ts covering T-04-10-01 XSS gate (script/img onerror/iframe/javascript: scheme) + UI-SPEC §6.3 relative-time formatter boundaries; 246 → 262 total tests passing, zero regressions.

## Task Commits

Each task was committed atomically:

1. **Task 1: Build pipeline (esbuild + deps)** — `bffad31` (chore)
2. **Task 2: Webview source files (HTML/TS/CSS)** — `22f6b90` (feat)
3. **Task 3: ChatPanel singleton + WorkspaceState chatHiddenBefore** — `2ef31de` (feat)
4. **Task 4: extension.ts wiring (openChat command + chat events)** — `0e55f10` (feat)
5. **Task 5: chat render unit tests** — `82c783d` (test)

**Plan metadata commit:** _(see final commit after this SUMMARY)_

## Files Created/Modified

- `src/ui/ChatPanel.ts` — WebviewPanel singleton class (CREATED)
- `src/ui/webview/chat/index.html` — webview HTML scaffold with 5 placeholders (CREATED)
- `src/ui/webview/chat/main.ts` — webview entry, markdown-it + highlight.js + render protocol (CREATED)
- `src/ui/webview/chat/main.css` — VS Code theme-token CSS, hex-free (CREATED)
- `src/test/suite/chatRender.test.ts` — 16 unit tests for XSS + relative-time format (CREATED)
- `src/extension.ts` — versioncon.openChat command, chat client events forwarded to ChatPanel, clientChatRecords cache, currentConnectionStatus mirror, dispatchChatReceivedLocally helper, workspaceStateRef + workspaceState.bindContext call
- `src/filesystem/WorkspaceState.ts` — bindContext / getChatHiddenBefore / setChatHiddenBefore methods backed by context.workspaceState
- `esbuild.config.mjs` — second build context for webview iife bundle + chat-assets onEnd plugin (codicon + html/css copy)
- `package.json` — highlight.js, markdown-it, @vscode/codicons dependencies + @types/markdown-it dev dep + versioncon.openChat / versioncon.manageChat commands + activityLog $(gear) menu entry

## Decisions Made

- **CSP policy** — exact-match UI-SPEC §5.2; no unsafe-inline, no remote sources. markdown-it / highlight.js / codicons all bundled to `dist/webview/chat/`. The CSP is constructed in `ChatPanel.getWebviewContent` per panel instantiation with a fresh 16-byte nonce.
- **Codicon dependency version** — declared `^0.0.40` (npm resolved to `0.0.45`) because `@vscode-elements/elements` already in the project requires `>=0.0.40` peer; matched the floor instead of fighting the resolver.
- **WebviewPanel refs bundle** — passing closures over module state instead of direct references keeps ChatPanel decoupled from extension.ts module scope. createOrShow refreshes the bundle on second-call so stale closures from prior sessions never leak.
- **Module-level clientChatRecords cache** — clients don't read chat-log.json directly; this in-memory array is reseeded on chat-history (join replay), appended on chat-received, and cleared on chat-cleared / chat-truncated / disconnect / session-ended. ChatPanel.refs.getRecords() returns a defensive slice.
- **Host-mode local-echo** — extension.ts uses `dispatchChatReceivedLocally(record)` after invoking `activeHost.handleLocalChatMessage(msg)` because the host's own broadcast does NOT loop back to itself. This is the same pattern Plan 04-09 used for the host's own presence-update.
- **Module-level workspaceStateRef** — workspaceState is created INSIDE the workspace IIFE (line ~553), but openChat is registered at activate scope. workspaceStateRef = workspaceState (after bindContext) bridges the two scopes synchronously.
- **Manage-chat placeholder** — Plan 04-11 owns the QuickPick implementation; this plan registers a stub command so the package.json menu binding doesn't error when invoked from the activity-log title bar.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] markdown-it dependency missing from plan's package.json delta**
- **Found during:** Task 1 (build pipeline)
- **Issue:** The plan's package.json delta lists only `highlight.js`. The webview's main.ts imports `markdown-it` (per the plan's own action block in Task 2), so without adding `markdown-it` + `@types/markdown-it`, the chat bundle fails to compile.
- **Fix:** Added `markdown-it@^14.1.0` to dependencies and `@types/markdown-it@^14.1.2` to devDependencies in package.json.
- **Files modified:** `package.json`, `package-lock.json`
- **Verification:** `npx tsc --noEmit` exits 0; `npm run build` produces a complete `dist/webview/chat/main.js` containing both markdown-it + highlight.js.
- **Committed in:** `bffad31` (Task 1)

**2. [Rule 3 - Blocking] @vscode/codicons not declared as a dependency**
- **Found during:** Task 1 (build pipeline)
- **Issue:** esbuild.config.mjs's chat-assets onEnd plugin reads `node_modules/@vscode/codicons/dist/codicon.{css,ttf}`. The plan asks for "codicon assets bundled" but doesn't add `@vscode/codicons` to package.json. Without the dep, npm doesn't install the package.
- **Fix:** Added `@vscode/codicons@^0.0.40` to dependencies. (Resolver upgraded to `0.0.45` because `@vscode-elements/elements` requires `>=0.0.40` peer; declared floor matches reality.)
- **Files modified:** `package.json`, `package-lock.json`
- **Verification:** `ls node_modules/@vscode/codicons/dist/codicon.{css,ttf}` succeeds; `dist/webview/chat/codicon/codicon.{css,ttf}` exist after build.
- **Committed in:** `bffad31` (Task 1)

**3. [Rule 2 - Missing functionality] Module-level connection-status mirror**
- **Found during:** Task 4 (extension wiring)
- **Issue:** The plan's pseudo-code references `connectionStatus ?? 'disconnected'` as if there were a module-scoped variable, but no such field exists in extension.ts. Without it, ChatPanel's reconnecting / disconnected banners can never light up.
- **Fix:** Added `let currentConnectionStatus: ConnectionStatus = 'disconnected';` at module scope, updated by `client.on('connection-changed')`, `wireHostEvents`, `host.on('session-ended')`, `wireClientEvents`, and the sidebar disconnect handler. ChatPanel.currentPanel?.setConnectionStatus(...) is called at each transition.
- **Files modified:** `src/extension.ts`
- **Verification:** Type-checks pass; manually traced — every connection-status change flows into the mirror.
- **Committed in:** `0e55f10` (Task 4)

**4. [Rule 2 - Missing functionality] Module-level workspaceStateRef bridge**
- **Found during:** Task 4 (extension wiring)
- **Issue:** `workspaceState` is constructed INSIDE the workspace IIFE (line 553), but `versioncon.openChat` is registered at activate scope (line ~150) and needs `workspaceState.getChatHiddenBefore()` at panel-build time. The plan's pseudo-code references `workspaceState` directly — but it's not in scope.
- **Fix:** Added `let workspaceStateRef: WorkspaceState | null = null;` at module scope; the IIFE assigns `workspaceStateRef = workspaceState` after `bindContext(context)`. openChat reads via `workspaceStateRef?.getChatHiddenBefore() ?? null`.
- **Files modified:** `src/extension.ts`
- **Verification:** Compiles; openChat correctly returns null when no workspace is open (handled with explicit warning toast).
- **Committed in:** `0e55f10` (Task 4)

**5. [Rule 2 - Missing functionality] Manage-chat placeholder command registration**
- **Found during:** Task 4 (extension wiring)
- **Issue:** package.json declares `versioncon.manageChat` (Task 1, so menus.view/title can reference it), and the activity-log $(gear) menu binds to it. Without a registered command handler, clicking the gear fires "command 'versioncon.manageChat' not found." Plan 04-11 owns the QuickPick UX; we need a placeholder so the binding works in the interim.
- **Fix:** Registered `versioncon.manageChat` as a placeholder command that shows an info message indicating Plan 04-11 ownership.
- **Files modified:** `src/extension.ts`
- **Verification:** Command registers without error; clicking the gear icon will show the placeholder toast until Plan 04-11 replaces it.
- **Committed in:** `0e55f10` (Task 4)

**6. [Rule 2 - Defense-in-depth] open-external scheme filter**
- **Found during:** Task 3 (ChatPanel construction)
- **Issue:** The plan's open-external handler calls `vscode.env.openExternal(vscode.Uri.parse(url))` directly. T-04-10-02 mitigation states "explicit handling in webview's open-external handler ignores non-http(s) URLs," but the plan's pseudo-code does NOT include the scheme filter.
- **Fix:** Added scheme filter — only http / https schemes are passed to `vscode.env.openExternal`; everything else is silently dropped. markdown-it's link validator already filters javascript:/data: at render time, but defense-in-depth at the postMessage boundary catches anything that slipped through (e.g., a future markdown-it config change).
- **Files modified:** `src/ui/ChatPanel.ts`
- **Verification:** Code review — `parsed.scheme === 'http' || parsed.scheme === 'https'` is the gate; malformed URIs caught by try/catch.
- **Committed in:** `2ef31de` (Task 3)

---

**Total deviations:** 6 auto-fixed (4× Rule 2 missing functionality, 2× Rule 3 blocking)
**Impact on plan:** All deviations are gap-fillers — the plan's pseudo-code referenced fields/refs that didn't exist in the codebase or omitted dependencies needed for the bundle to compile. No scope creep beyond what the plan's behavior contract already required (functioning chat panel with strict CSP). SessionHost.ts diff is 0 lines, preserving Plan 04-04 ownership exactly per the ownership note in the plan frontmatter.

## Issues Encountered

- **codicon font version peer-dep** — `@vscode-elements/elements@2.5.1` declares `@vscode/codicons@>=0.0.40` peer. Plan asked for `^0.0.36`; npm resolved to 0.0.45 to satisfy both peers. Updated declared range to `^0.0.40` to match resolved reality. Resolved cleanly with one `npm install` retry.
- **Acceptance criterion ambiguity (Task 2)** — plan asked for `wc -l` returning 5 placeholder matches in index.html. Actual: 5 placeholders distributed over 4 lines (CSS_URI + CODICON_CSS_URI live on different lines but JS_URI shares its line with NONCE). All 5 distinct placeholders are present and the runtime substitution works correctly. Documented for clarity.

## User Setup Required

None - no external service configuration required. The chat panel is reachable via:
- Command palette → "VersionCon: Open Chat"
- Activity log "unread chat" sticky row click (when unread > 0)
- Status bar comment badge click (when unread > 0)

Manual UAT: open VS Code with two Extension Development Host windows, host a session in one, join from the other, exchange chat messages including a fenced ` ```ts ` code block. Verify syntax-highlighted output and that colors follow the active VS Code theme.

## Next Phase Readiness

- **Plan 04-11 (manage-chat)** is unblocked: ChatPanel.openManageChat ref calls `vscode.commands.executeCommand('versioncon.manageChat')`, which 04-11 will replace from a placeholder to the real QuickPick. ChatHiddenBefore getter/setter on WorkspaceState is in place for the "Clear my view" action.
- **Plan 04-12 (phase 4 verification)**: SC 2 (text + code chat in-VS Code) and SC 3 (push/revert/branch events appear in chat timeline) are end-to-end. COLLAB-02, COLLAB-03 user-visible. COLLAB-07 partial (system-event row format ready for Phase 6 review-comment reuse).
- **Phase 6 (review threads)** will reuse the system-event row pattern in ChatPanel; no schema changes anticipated.
- **Phase 8 (MCP)** chat-summarization tool will read `.versioncon/branches/<branch>/chat-log.json` directly — independent of this plan's webview, no coupling.

## Self-Check: PASSED

Verification of claimed artifacts:

**Files created:**
- FOUND: src/ui/ChatPanel.ts
- FOUND: src/ui/webview/chat/index.html
- FOUND: src/ui/webview/chat/main.ts
- FOUND: src/ui/webview/chat/main.css
- FOUND: src/test/suite/chatRender.test.ts

**Files modified:**
- FOUND modifications in: src/extension.ts (verified via git log)
- FOUND modifications in: src/filesystem/WorkspaceState.ts (verified via git log)
- FOUND modifications in: esbuild.config.mjs (verified via git log)
- FOUND modifications in: package.json (verified via git log)

**Commits:**
- FOUND: bffad31 (Task 1 — build pipeline)
- FOUND: 22f6b90 (Task 2 — webview source)
- FOUND: 2ef31de (Task 3 — ChatPanel + WorkspaceState)
- FOUND: 0e55f10 (Task 4 — extension wiring)
- FOUND: 82c783d (Task 5 — tests)

**Build verification:**
- `npm run build` exits 0 — extension.js + dist/webview/chat/{main.js, main.css, index.html, codicon/codicon.{css,ttf}} all generated
- `npx tsc --noEmit` exits 0 — full repo type-clean
- `npm test -- --grep "chat render"` — 16 passing
- `npm test` — 262 passing total (was 246; +16 new chat render tests)

**SessionHost.ts ownership preservation:**
- `git diff` against post-04-04 baseline of `src/host/SessionHost.ts`: 0 lines (Plan 04-04 ownership respected per plan frontmatter ownership note)

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
