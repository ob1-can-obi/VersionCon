---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Phase 7 Wave 2 STARTED — 07-04 (CloudTransport) shipped. 906 / 0 / 66 tests passing (+14 from new 'Phase 7 — cloud transport' suite). src/network/CloudTransport.ts implements ClientTransport (07-01 drop-in alongside LanClientTransport) with Bearer-header auth (T-07-03), CloudEnvelope wrap/unwrap (07-02), maxPayload 1 MiB (T-07-08), close-code → state mapping (4404 → session-not-found terminal, 1006 → relay-unreachable + reconnect, 1000 → disconnected), ReconnectManager reuse from heartbeat.ts (Pattern C — no hand-rolled backoff). Three-commit chain: da144cb RED + a5beef9 GREEN + 11086f4 REFACTOR. CloudTransport is byte-shape-only and relay-portable (zero vscode/UI imports). Wave 2 in progress; 07-05 / 07-06 / 07-07 unblocked.
last_updated: "2026-05-19T05:24:30.000Z"
last_activity: 2026-05-19 -- Plan 07-04 complete; CloudTransport + 14-case suite shipped (commits da144cb RED + a5beef9 GREEN + 11086f4 REFACTOR); Wave 2 1/4 plans done
progress:
  total_phases: 13
  completed_phases: 5
  total_plans: 59
  completed_plans: 48
  percent: 81
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-04)

**Core value:** Teams collaborate on code without merge conflict pain — dependency-aware tracking means you only stop coding when changes genuinely affect what you're working on.
**Current focus:** Phase 06 — inline-code-review

## Current Position

Phase: 07 (cloud-mode-relay-server) — EXECUTING (Wave 2 IN PROGRESS)
Plan: 4 of 13 done (07-01 ✓, 07-02 ✓, 07-03 ✓, 07-04 ✓; 07-05 / 07-06 / 07-07 unblocked)
Status: Wave 2 started. CloudTransport (07-04) is the byte-shape seam that lets SessionClient flip from LAN to cloud — outbound WSS, Bearer-header JWT, CloudEnvelope wrap/unwrap, 4-state lifecycle (connected/session-not-found/relay-unreachable/disconnected), ReconnectManager reuse. 906 tests pass (892 + 14 new). 07-05 (wizard cloud step), 07-06 (join + UriHandler), 07-07 (StatusBarManager) can begin.
Next: /gsd-execute-phase 7 — run 07-05 (wizard cloud step) OR 07-06 (join + UriHandler) OR 07-07 (StatusBarManager) — all three are parallel-ready
Last activity: 2026-05-19 -- /gsd-execute-phase 7 plan 07-04 complete (CloudTransport + 14-case suite); commits da144cb + a5beef9 + 11086f4

Progress: [██████████] 98%

## Performance Metrics

**Velocity:**

- Total plans completed: 19
- Average duration: 4.8 min
- Total execution time: 1.57 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 6 | 23 min | 3.8 min |
| 04 | 11 | 57.5 min | 5.2 min |

**Recent Trend:**

- Last 5 plans: 07-04 (~8 min — CloudTransport + 14-case suite incl. StubWebSocket + SpyReconnectManager helpers), 07-03 (~6 min — TokenService + 8-case JWT test suite), 07-01 (~30 min — surgical refactor of two ~2000-line controllers), 07-02 (CloudEnvelope), 06-05 (Wave 4 mandatory review gate)
- Trend: 07-04 is a clean additive plan — zero modifications to existing files, two new files (~436 + ~592 LOC), three-commit TDD chain (RED + GREEN + REFACTOR). One Rule 1 deviation (maxPayload split between const decl + usage broke source-grep; inlined post-GREEN) and one Rule 1 inline-fix (JSDoc literal `?token=` substring caught by its own test). No Rule 2/3/4 deviations. 906 tests pass (892 + 14 new). Two-run flake check: identical.

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Pre-Phase 1]: Use `web-tree-sitter` (WASM) from day one — never `node-tree-sitter`. Switching later requires rewriting entire AST layer.
- [Pre-Phase 1]: Manual IP join path must be built BEFORE mDNS discovery. mDNS fails silently in VLANs and corporate/university networks.
- [Pre-Phase 1]: Stateless webview architecture — all state in extension host; webview fires `webview-ready` on mount and receives full state snapshot.
- [Pre-Phase 2]: Route drag-and-drop events through extension host to avoid VS Code 1.90+ cross-webview regression (issue #256444).
- [Plan 01-00]: Test stubs created as Wave 0 before production code — every requirement tagged in test descriptions for traceability.
- [Plan 01-01]: Added @types/node and types array to tsconfig for Node16 module resolution compatibility with test stubs.
- [Plan 01-01]: Updated .gitignore to exclude node_modules, dist, .venv, .vscode-test, and *.vsix.
- [Plan 01-02]: First authenticated member gets host role; tracked via hostMemberId for admin command authorization.
- [Plan 01-02]: SessionClient uses null-ws pattern to distinguish intentional disconnect from connection drops.
- [Plan 01-03]: Used optional chaining for bonjour-service Service.stop (type declares it as optional).
- [Plan 04-01]: Phase 4 wire types added contract-first in Wave 1 so Waves 2-4 share one canonical shape.
- [Plan 04-01]: ChatRecord.meta.affectsLocal is computed client-side only — JSDoc documents non-persistence (T-04-01-03).
- [Plan 04-01]: PresenceInfo.activeFilePath uses 'string | null' rather than 'string | undefined' so the value travels through JSON cleanly.
- [Plan 04-01]: VALID_TYPES gate test verifies T-04-01-02 mitigation — invented chat-* types are rejected at the parser layer.
- [Plan 04-06]: computeFileOverlap takes platform as injectable arg so darwin/linux/win32 branches all unit-test on any host OS.
- [Plan 04-06]: pathLib selection inside the function (path.win32 vs path.posix) decouples relative-path correctness from the runtime OS — reproducible win32 tests on macOS CI.
- [Plan 04-06]: Path normalization splits on both path.sep and backslash so synthetic win32 inputs normalize correctly when the host platform differs (deviation Rule 2 — correctness improvement, no behavior change in production).
- [Plan 04-06]: TabInputTextDiff in getOpenTabPaths includes BOTH original and modified URIs — user clearly cares about both files visible in the diff view.
- [Plan 04-02]: ChatLog mirrors PushHistory.ts pattern verbatim — same load/save/append shape, same whole-file rewrite, no .tmp+rename (atomic-rename upgrade deferred jointly with PushHistory).
- [Plan 04-02]: ChatLog.getRecords() returns chronological (oldest first), opposite of PushHistory — chat displays oldest-at-top, scrolling down to newest.
- [Plan 04-02]: truncateKeepLast100PlusActivity uses (timestamp, id.localeCompare) sort tiebreaker so equal-ms records produce deterministic output across reloads (V8 sort is unstable for ties without it).
- [Plan 04-02]: ChatLog.getRecords() returns a defensive copy ([...this.records]) so external mutation cannot corrupt the in-memory cache; worth applying retroactively to PushHistory.
- [Plan 04-02]: exportToFile honors hiddenBefore with >= boundary semantics so per-user clear-view does not leak hidden context into exports.
- [Plan 04-03]: PresenceMap is a class (not a bare Map) so Plan 04-08 (TreeProvider) has something to wrap with refresh() side effects and Plan 04-04 (host) can choose to use it or keep an inline Map — overrides RESEARCH §"PresenceMap location" advice based on Plan 04-08's needs.
- [Plan 04-03]: getSnapshot() returns Array.from(values()) defensive copy — consistent with SyncTracker.getOutOfSyncPaths() and ChatLog.getRecords() patterns; tested explicitly so the invariant survives refactors.
- [Plan 04-03]: PresenceMap is policy-agnostic — sanitization of memberId (T-04-03-01) and activeFilePath (T-04-03-03) is the caller's responsibility (Plan 04-04 and Plan 04-06); documented in upsert() JSDoc cross-referencing STRIDE threat IDs.
- [Plan 04-05]: Wire→event field renames (recordId → id, timestamp → lastUpdated) happen at the SessionClient routing boundary so downstream code never sees wire-only field names — keeps the event-payload contract authoritative once it leaves SessionClient.
- [Plan 04-05]: Conditional spread for optional subKind/meta fields preserves the JSDoc invariant 'subKind only set when kind === system' from src/types/chat.ts; carrying explicit undefined would leak wire-shape into consumers.
- [Plan 04-05]: Test harness invokes private handleMessage via typed bracket cast — avoids real WebSocket spin-up for routing-only assertions; cleaner than mocking ws because the contract is purely 'wire shape in, event shape out'.
- [Plan 04-05]: Build-script ordering quirk discovered — `npm run build` only bundles extension.ts; downstream plans that touch test files must run `npx tsc` (no flag) before `npm test` to compile dist/test/*.js, otherwise vscode-test runs stale compiled tests.
- [Plan 04-04]: setChatLog widened to (chatLog, branchName) two-arg signature — SessionHost has no existing branch-tracking field that Task 3's chat-history send could read from; storing activeBranch on the host is the cleanest fix. Plan 04-09 (extension wiring) must call setChatLog(chatLog, branchName) accordingly.
- [Plan 04-04]: handleLocalChatMessage uses this.hostMemberId ?? 'host' fallback — the host process may not have self-authenticated as a member; using a stable 'host' marker keeps the local-compose path working regardless of self-auth state.
- [Plan 04-04]: T-04-04-04 (chat-cleared/chat-truncated spoofing) mitigation is structural, not code — the ProtocolMessage union permits both wire types but the onmessage switch has NO inbound branches; spoofed messages from non-host clients silently drop. Verified by integration test that spoofed cleared/truncated never reach other clients AND host doesn't crash.
- [Plan 04-04]: chat-message broadcast includes sender (no exclude) per RESEARCH Open Q #1 — sender sees own message after host echo. presence-update excludes sender (mirrors member-joined). Both branches mirror tracked-paths-update precedent (T-03-14) for the closure-bound memberId override.
- [Plan 04-04]: Test harness uses raw ws package, not full SessionClient — routing-level integration tests don't need reconnect/heartbeat machinery. Smaller harness (connectClient + waitFor, ~50 lines) gives precise wire-level send/receive assertions; mirrors Plan 04-05's typed-bracket-cast decision at one level higher.
- [Plan 04-07]: Sticky unread row exempt from RING_BUFFER_CAP — UI-SPEC §1.2 caps activity entries; the sticky marker is a UX affordance, not a buffer entry. Tested via "sticky unread row preserved during ring buffer trim".
- [Plan 04-07]: Click command split — provider declares `versioncon.activityLog.openEntry`; Plan 04-09 will register the actual handler that routes by kind (push/revert → smart push summary; branch → switchBranch picker). Keeps per-kind UX routing out of the provider.
- [Plan 04-07]: ActivityKind compile-time exhaustiveness check (`SystemEventSubKind extends ActivityKind ? true : never`) breaks the build if a new system event kind is added to chat.ts without extending ActivityKind — prevents silent drift between chat-log and activity tree.
- [Plan 04-07]: getEntries returns a defensive copy `[...this.entries]` — mirrors Plan 04-02 ChatLog.getRecords + Plan 04-03 PresenceMap.getSnapshot patterns; explicit test guards against future regression.
- [Plan 04-07]: package.json edit minimal/surgical (single view append, two commands, one menu, two viewsWelcome blocks) — Plan 04-08 will append a sibling presence view to the same arrays without conflict.
- [Plan 04-08]: PresenceTreeProvider OWNS its PresenceMap instance privately — single object reference for Plan 04-09 wiring; mirrors ActivityLogProvider's private entries[] ownership pattern. Mutators delegate then refresh.
- [Plan 04-08]: Branch divergence prefix gated on `currentBranch !== null` — until extension.ts wires the active branch via setCurrentBranch (or session is disconnected), divergence indicator stays off rather than annotating every member as divergent. Matches UI-SPEC §2.1 literal "when presence.branch !== currentBranch" only when both are known.
- [Plan 04-08]: Description format `$(git-compare) {branch} · {basename}` — divergent rows show BOTH the divergent branch name AND the file the member is working on, in the same row.
- [Plan 04-08]: Self-first sort comparator branches BEFORE locale-compare — explicit short-circuit returns -1/+1 for self before falling through to localeCompare; cleaner than partition-then-concat and tested directly.
- [Plan 04-08]: package.json edit minimal/surgical — sibling-append only (versioncon.presence after versioncon.activityLog). Co-exists with Plan 04-07's registration without disturbing existing rows.
- [Plan 04-09]: Module-level provider singletons (presenceTreeProvider, activityLogProvider) constructed in activate() BEFORE the workspace IIFE — both wireClientEvents (module scope) and the IIFE can reference them without nullability surprises beyond the explicit `?.` chain.
- [Plan 04-09]: Self-identity mirror fields (currentSelfMemberId / currentSelfDisplayName) added at module scope rather than reusing the IIFE's currentMemberId — the IIFE's value is the Phase 1/3 'local-user' placeholder; module mirrors are populated from authenticated client.getMemberId() at join time. Unblocks isMine detection on the activity log without refactoring placeholder fields.
- [Plan 04-09]: Active-branch mirror (currentBranchName) updated at IIFE init AND on every switchBranch — switchBranch additionally calls sendPresenceUpdate(activeTextEditor) so remote panels' divergence indicators refresh immediately when the local user moves to a different branch.
- [Plan 04-09]: 100ms debounce on onDidChangeActiveTextEditor → presence-update — defensive Rule 2 guard against rapid focus events (Cmd-P open + activate fires the event multiple times). One outbound message per intent without sacrificing real-time feel.
- [Plan 04-09]: Host's local presence upsert (presenceTreeProvider.upsert(info)) is explicit — the host's broadcast EXCLUDES the sender per Plan 04-04 broadcast policy, so without local upsert the host's own row would never appear in their panel.
- [Plan 04-09]: chat-received handler only acts on kind='user' — system events (push/revert/branch-created) ride both the chat stream AND the dedicated client events; activity-log feed routes through the dedicated events to avoid duplicate rows.
- [Plan 04-09]: setChatLog NOT wired here — Plan 04-10 (chat panel) constructs the ChatLog instance and owns the wiring. Host's chat-history send is a no-op until then (null-guarded by Plan 04-04). No regression.
- [Plan 04-09]: setUnreadCount precedence — sync warning suppresses the badge visually but PRESERVES the count internally; setStatus tail re-applies the overlay when the warning clears AND status is 'connected'. setSyncWarning(true/false) mirrors the boolean into syncWarningActive so flashNoImpact and applyUnreadOverlay can read it.
- [Plan 04-09]: Task 4 (manual two-client UAT) deferred — autonomous: false. Visual UX confirmation across two VS Code Extension Development Host windows requires human eyeball verification of toast text + status bar flash; cannot be automated. Wiring verified at unit-test layer (8 new tests) + grep-shape integration check.
- [Plan 04-10]: ChatPanel CSP exact-matches UI-SPEC §5.2 — no unsafe-inline, font-src cspSource only. Codicons + markdown-it + highlight.js bundled to dist/webview/chat/, never CDN. Fresh 16-byte nonce per panel construction.
- [Plan 04-10]: highlight.js/lib/core (selective registerLanguage for 7 languages) chosen over the full bundle to keep the webview JS at ~200KB; .hljs-* classes shimmed via main.css to var(--vscode-symbolIcon-*Foreground) so syntax colors follow the active VS Code theme without inline styles.
- [Plan 04-10]: WorkspaceState.bindContext(context) loads chatHiddenBefore at activate-time from context.workspaceState; getter is sync. The IIFE-owned WorkspaceState is exposed via module-level workspaceStateRef so versioncon.openChat (registered at activate scope) can read the cutoff at panel-build time without an async hop.
- [Plan 04-10]: Host-local chat path: extension.ts calls activeHost.handleLocalChatMessage (Plan 04-04 owns the method; SessionHost.ts is unchanged in this plan), then dispatchChatReceivedLocally echoes the record into the host's own ChatPanel because the host does NOT receive its own broadcast back over the wire. Mirrors Plan 04-09's local presence upsert pattern.
- [Plan 04-10]: open-external scheme filter — vscode.Uri.parse(url, true) followed by an http/https whitelist before vscode.env.openExternal protects against javascript:/file:/data: schemes even though markdown-it's link validator already filters most of them (defense-in-depth for T-04-10-02).
- [Plan 04-10]: ChatPanel.createOrShow refreshes refs on second-call so stale closures from a prior session never reach the singleton (host→client transition mid-life would otherwise leak the wrong sendChatMessage closure).
- [Plan 04-10]: currentConnectionStatus is a module-level mirror, not a SessionClient call. Mirroring lets ChatPanel.currentPanel?.setConnectionStatus(...) calls inside connection-changed / session-ended / sidebar-disconnect handlers update the banner instantly. Plan's pseudo-code referenced a connectionStatus field that didn't exist; added as Rule 2 missing functionality.
- [Plan 04-10]: chat unit tests duplicate the markdown-it config + formatRelativeTime in-place rather than importing browser modules — webview's main.ts can't load in Node tests because it imports highlight.js sub-modules + DOM types. Documented for future shared-util refactor.
- [Plan 04-10]: versioncon.manageChat registered as a placeholder command — Plan 04-11 owns the QuickPick UX, but package.json's $(gear) menu binds to it via this plan's command declaration; placeholder prevents "command not found" until 04-11 ships.
- [Plan 04-11]: Items 2-4 visible to non-host members with description "(host only — disabled)" — UI-SPEC §6.4 mandates the disabled-with-explanation visual contract over filtering items out for non-hosts. Defense-in-depth: UI gate + protocol gate (Plan 04-04 has no inbound chat-cleared/chat-truncated handler).
- [Plan 04-11]: Modal confirm pattern uses a single positive-verb button — `if (yes !== 'Verb') return`. Cancel is implicit via Esc / VS Code modal default. UI-SPEC §6.5 "Cancel always second so Esc cancels by default" satisfied without passing a Cancel item.
- [Plan 04-11]: Member-side export uses the in-memory clientChatRecords cache (not an on-demand chat-history fetch) — v1 has no on-demand chat-history request protocol; members export what their panel currently shows. Same scope decision as ChatLog.exportToFile's hiddenBefore filter from Plan 04-02.
- [Plan 04-11]: Per-branch ChatLog reconstruction on switchBranch — chat-log.json is per-branch, so switching branches rebuilds the ChatLog and re-wires it into the host alongside fsLayer.setBranchDir. Late-arriving wiring resolves both ways (IIFE wires host if active; wireHostEvents wires chat-log if loaded).
- [Plan 04-11]: ChatLog wiring landed in extension.ts in this plan, not Plan 04-10 — Plan 04-09 deferred to 04-10, but 04-10's host chat-message handler null-guarded chatLog so the wiring never landed. Plan 04-11 needs activeChatLog for clearAll/truncate*/exportToFile to do anything meaningful, so it became a Rule 2 deviation here.
- [Plan 04-11]: UI-SPEC literal verification via source-grep tests — extension.ts read as a string, modal copy + button labels asserted against UI-SPEC §6.5 + §6.4. Catches future drift away from the spec without needing a VS Code extension host to mount the QuickPick. Pattern reusable for any future spec'd UI strings.
- [Plan 06-05]: checkRequireReviewGate extracted to src/state/requireReviewGate.ts as a pure function with a deps object — cleaner test surface AND a single source of truth shared by the 3 merge entry points. Same pattern as Plan 04-06 computeFileOverlap.
- [Plan 06-05]: SessionHost.appendAndBroadcastSystemEvent visibility widened private → public to let extension.ts merge-block paths fire system chat events from the activate IIFE. JSDoc pins the explicit scope (only SessionHost instance methods AND extension.ts with an activeHost ref). Smaller diff than adding a public wrapper.
- [Plan 06-05]: Resolved-review status explicitly does NOT count as approved for the gate. ReviewState.getActiveReviewForPush filters resolved+abandoned, so the gate naturally falls into the 'no review opened' branch when an admin override resolves a 'changes-requested' review. Next merge still blocks until an explicit approve vote lands — pinned by behavior test.
- [Plan 06-05]: Reused 'review-resolved' SystemEventSubKind for the merge-block system event rather than introducing a 6th sub-kind. The body string carries the merge-block specifics; new sub-kind would churn Wave 1 + Wave 2 contract surfaces.
- [Plan 06-05]: Singleton-per-pushId vscode.CommentController lifecycle managed at module scope (activeReviewController + activeReviewThreadDisposables + activeReviewPushIdForController). Wired into ReviewPanel.addOwnedDisposable via a synthetic disposable that clears all 3 refs on dispose — singleton mirrors ReviewPanel.currentPanel pattern.
- [Plan 06-05]: Full rebuild of inline CommentThreads on every review event (vs. diff-and-patch) — bounded by host's 500-cap. Diff-and-patch would need a per-comment-id → thread map kept in sync with ReviewState; not justified for v1.
- [Plan 06-05]: v1 contract: NO bare-line gutter 'Add comment' affordance. commentingRangeProvider returns [] for all lines. Users compose new threads via the ReviewPanel webview's per-file-row composer. Gutter add-comment is a Phase 6.x deliverable.
- [Plan 07-01]: Transport seam shipped via optional `transport?` constructor parameter (LAN default = `new LanHostTransport()` / `new LanClientTransport(ip, port)`) instead of a separate SessionHostFactory.ts file. The source-grep gate forbids `from 'ws'` and `new WebSocketServer(` LITERALS — importing LanHostTransport into SessionHost.ts matches neither pattern, so seam discipline holds. Net: 20+ existing call-sites (WizardPanel.ts:546, JoinPanel.ts:229, all eight host/client/review/ast test fixtures) compile unchanged, preserving the Plan's byte-identical-behavior invariant. Future cloud callers (07-05, 07-06) pass an explicit CloudHostTransport / CloudClientTransport.
- [Plan 07-01]: Added `HostTransport.sendRaw(conn, data): number` on top of `HostTransport.send(conn, msg)` (Rule 2 — missing critical API). SessionHost.broadcast pre-serializes JSON ONCE and writes the same bytes to every member to feed BandwidthMonitor exact wire-byte counts (pre-refactor line 2011-2013). A naive transport.send(conn, msg) loop would re-stringify per member, breaking the byte-accuracy contract. Documented in JSDoc; only SessionHost.broadcast should call sendRaw.
- [Plan 07-01]: SessionClient registers transport handlers ONCE per instance via `transportHandlersInstalled` flag. Pre-refactor, `new WebSocket(...)` was constructed inline per connect() call so handlers were naturally re-attached to the new socket. With Transport: LanClientTransport.connect() re-binds the underlying ws.on(...) calls to the SAME registered handler arrays on every reconnect — SessionClient's one-shot install pattern prevents handler array duplication across reconnects (caught during Task 2 — would have caused 2× / 3× / Nx message processing after N reconnects).
- [Plan 07-01]: `intentionalClose: boolean` flag in SessionClient replaces the pre-refactor null-ws sentinel (`this.ws = null` BEFORE `ws.close()` at line 550-551). Flipped true inside `disconnectInternal()` before `transport.close()` so the onClose handler short-circuits and does NOT trigger attemptReconnect. Semantically identical, no `markIntentionalClose` method added to the ClientTransport interface (would have leaked controller state into the wire layer).
- [Plan 07-01]: findFreePort migrated from SessionHost into LanHostTransport — wire-layer concern. SessionHost no longer imports from `net`.
- [Plan 07-03]: jose downgraded from planned ^6.2.3 → ^5.10.0. jose@6.x is ESM-only (`"type": "module"`); the extension compiles to CommonJS, so `tsc` errors with TS1479. jose@5.10.0 ships a CJS entry (`./dist/node/cjs/index.js`) and has the IDENTICAL `SignJWT` / `jwtVerify` / `algorithms` / `audience` / `clockTolerance` API used by the plan. Same outcome for plan 07-09 (relay) — it will also pin jose@^5 unless that package opts into ESM. Rule 3 deviation (blocking issue: locked version doesn't compile), NOT Rule 4 (architectural pivot) — library/algorithm/claim-schema all preserved verbatim.
- [Plan 07-03]: verify() post-checks `payload.role ∈ {'host','member'}` and throws `'Missing role claim'` otherwise. jose's `jwtVerify` only checks signature + standard claims (iss/aud/exp) — custom claims like `role` aren't validated. Without this post-check a buggy or compromised issuer could mint tokens with `role: 'admin'` and they'd pass jose verification. Rule 2 defense-in-depth.
- [Plan 07-03]: RS256 test feeds Node's KeyObject directly into `SignJWT.sign(privateKey)` — no `importPKCS8` round-trip needed. Confirmed jose 5.10.0 accepts `KeyObject` arguments for asymmetric signing keys. Plan 07-09 (relay verifier integration tests) can use the same shortcut to construct adversarial RS256 tokens for its own algorithm-confusion gate.
- [Plan 07-03]: Rejection-test assertions use bare `assert.rejects(() => svc.verify(...))` with NO error matcher — survives jose minor-version upgrades that rename error classes (e.g. `JWTClaimValidationFailed`). Tradeoff: asymmetric RED phase (4 of 8 tests passed via stub-throw rejection in RED commit 9935789). Documented as design choice, not TDD violation.
- [Plan 07-04]: `maxPayload: 1024 * 1024` inlined at the WebSocket construction site (NOT a module-level `MAX_PAYLOAD_BYTES` constant). Plan §Verification grep matches `maxPayload:\s*1024\s*\*\s*1024` AT THE CALL SITE — a named constant would split the grep between declaration and usage. Inlining keeps the T-07-08 mitigation auditable on one line. REFACTOR commit 11086f4 made the change post-GREEN.
- [Plan 07-04]: Added narrow `ReconnectManagerLike` interface (scheduleReconnect + abort only) for the test-seam injection parameter. Production constructs `new ReconnectManager()` from heartbeat.ts (Pattern C reuse — source-grep gate enforced). Tests inject a `SpyReconnectManager` that structurally satisfies the narrow interface without implementing the full class — keeps the test fully synchronous and the spy ~15 LOC.
- [Plan 07-04]: `markIntentionalClose()` is on the `CloudTransport` class but NOT widened onto the `ClientTransport` interface from 07-01. 07-01 deliberately did not add it (LAN semantics work via SessionClient.intentionalClose + transport.close()). Cloud mode adds it because ReconnectManager can schedule retries even after a code=1000 close in some edge cases. 07-06's SessionClient.disconnectInternal will downcast via `instanceof CloudTransport` to call it — 07-06's wiring problem, not this plan's.
- [Plan 07-04]: Receive path re-serializes `env.payload` to `Buffer` (NOT a typed ProtocolMessage delivery). 07-01's `ClientTransport.onMessage` contract is `Buffer` so SessionClient's upstream `parseMessage(raw.toString())` is byte-identical for LAN and cloud. The JSON.stringify of an already-parsed object is microseconds and out of any hot path. Widening ClientTransport to accept ProtocolMessage directly would force a 07-01 refactor — defer.
- [Plan 07-04]: SessionHost in cloud mode is an OPEN QUESTION deferred to 07-05. SessionHost's constructor expects `HostTransport` (many connections, server-side); CloudTransport implements `ClientTransport` (single connection, client-side). D-04 says host is "client to relay" — so 07-05 will need a `CloudHostAdapter implements HostTransport` that wraps a single CloudTransport and demultiplexes inbound envelopes by sender. This plan deliberately ships only the CloudTransport (07-04 scope); the adapter is 07-05b's call.

### Roadmap Evolution

- Phase 4.1 inserted after Phase 4 on 2026-05-08 (URGENT) — Host Identity + Creation Wizard. Surfaced during Phase 4 multi-window UAT: (1) Wizard does not prompt for hostDisplayName (WizardPanel.ts:426-429 reads versioncon.displayName silently, defaults to literal 'Host'); (2) "first authenticated WebSocket connection wins" host designation (SessionHost.ts:501-502) lets a remote joiner hijack the host role from the session creator. Both are v1-blocking architectural defects.

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 4 UAT 2026-05-11]: 3 blocker gaps surfaced during multi-window UAT (999.3 peer presence propagation, 999.4 displayName "You" fallback, 999.5 joiner onboarding) — all CLOSED same-day inline at commit a420eb5. Tests 2-6 unblocked; retest pending. Test suite at 350 passing.
- [Phase 2]: Cross-webview drag-and-drop VS Code 1.90+ regression (issue #256444) requires a throwaway spike before full UI implementation
- [Phase 5]: tree-sitter-java and tree-sitter-cpp WASM compatibility with web-tree-sitter@0.26 — partially mitigated via SC-3 fallback path. Phase 5 ships Java + C++ adapters that register the language IDs and route to FallbackAdapter (line-level diff, no AST). Real grammars deferred to Phase 5.x. Adding them later is a one-WASM-plus-one-adapter PR; the AstFactory seam is in place.
- [Phase 7]: ~~Cloud relay operational model not yet decided~~ — RESOLVED 2026-05-17 via /gsd-discuss-phase 7. Self-host only for v1, Fly.io primary deploy target, Docker image works anywhere. L3 E2E + L4 enterprise deferred to a future dedicated security phase (architectural seams shipped in Phase 7). See `.planning/phases/07-cloud-mode-relay-server/07-CONTEXT.md`.
- [Phase 8]: VS Code MCP API is new (2025) — McpStdioServerDefinition vs McpHttpServerDefinition tradeoffs need research during Phase 8 planning

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260510-sdm | Phase 4.1 UAT gap (Test 3): surface displayName validation errors in wizard step 1 — relaxed wizard.js maxlength 64→256, added paste handler preserving control chars; +4 source-grep tests | 2026-05-10 | b8515d4 | [260510-sdm-phase-4-1-uat-gap-test-3-surface-display](./quick/260510-sdm-phase-4-1-uat-gap-test-3-surface-display/) |

### Phases Completed

| Phase | Description | Date | Plans | Commits | Tests Added |
|-------|-------------|------|-------|---------|-------------|
| 4 | Presence, Chat + File-Level Conflict Notifications | 2026-05-11 | 15 | (across many) | 337+ |
| 4.1 | Host Identity + Creation Wizard (INSERTED) | 2026-05-09 | 4 | (across waves) | +20 |
| 4.3 | Git-Style Commands + File Explorer Workflow + Cloud Bridge (INSERTED) | 2026-05-11 | 5 | 9e20df0..69ffeaf (14 commits) | +89 (350→439) |
| 5 | Dependency-Aware Conflict Detection (AST) | 2026-05-11 | 5 | 754c0e8..7d4d75b (25 commits) | +245 (439→684) |
| 6 | Inline Code Review | 2026-05-14 | 5 | 24c257d..c72e0ed (Wave 1-4 across many) | +183 (684→867) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-05-19T05:24:30Z
Stopped at: Plan 07-04 (CloudTransport) complete. Wave 2 1/4 plans done. 906 tests passing (892 + 14 new in 'Phase 7 — cloud transport' suite); 0 failing; 66 pending. Three-commit TDD chain: da144cb (RED — 14-case suite) + a5beef9 (GREEN — CloudTransport implementation) + 11086f4 (REFACTOR — inline maxPayload literal). src/network/CloudTransport.ts implements ClientTransport (drop-in alongside LanClientTransport from 07-01): outbound `wss://` with Authorization Bearer header (T-07-03 mitigation), maxPayload 1 MiB (T-07-08), CloudEnvelope wrap/unwrap (07-02), close-code → state mapping via exported `mapCloseCodeToState` (4404 → 'session-not-found' terminal, 1000 → 'disconnected', 1006/other → 'relay-unreachable' + reconnect), ReconnectManager reuse from heartbeat.ts (PATTERNS Pattern C — no hand-rolled Math.pow backoff; source-grep gate enforces). CloudTransport is byte-shape-only (zero msg.type discrimination) and relay-portable (zero vscode/UI imports). markIntentionalClose() public on CloudTransport but NOT widened onto ClientTransport. 07-05 (wizard cloud step), 07-06 (join + UriHandler), 07-07 (StatusBarManager — `onStateChange` returns the exact 4-tuple state union, ready) unblocked. 07-05b CloudHostAdapter (host-fanout) deferred for 07-05's discretion.
Resume file: None
Last activity: 2026-05-19 -- Plan 07-04 complete; Wave 2 started
