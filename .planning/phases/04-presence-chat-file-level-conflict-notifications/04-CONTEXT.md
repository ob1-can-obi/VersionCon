# Phase 4: Presence, Chat + File-Level Conflict Notifications - Context

**Gathered:** 2026-05-07
**Status:** Ready for planning
**Source:** /gsd-discuss-phase 4 (default mode)

<domain>
## Phase Boundary

This phase delivers three loosely-coupled subsystems on top of the existing Phase 1 networking and Phase 3 push lifecycle:

1. **Presence** — every member sees a live panel of who's online, which file each person has open, and which branch they're on (COLLAB-01, ROADMAP SC 1).
2. **Chat** — in-app text chat with code snippet support, plus an automatic activity timeline of push/revert/branch events (COLLAB-02..05, COLLAB-07, SC 2-3).
3. **Soft conflict notifications** — when a teammate's push touches a file the user has open, surface a non-blocking notification; when a push is irrelevant, show a green "no impact" status (CONF-01, CONF-07, CONF-08, COLLAB-06, SC 4-5).

The phase does NOT include: dependency-aware (symbol-level) conflict detection (Phase 5), inline code review threads (Phase 6 — though COLLAB-07 says review comments are visible in chat, the comment authoring system is Phase 6), or any AI-driven summarization of chat history (deferred to Phase 8).

</domain>

<decisions>
## Implementation Decisions

### Chat persistence

**LOCKED.** Chat messages are persisted to `.versioncon/branches/<branch>/chat-log.json` on the **host's filesystem**. The host appends every chat message it receives. Mirrors the existing `PushHistory` (`push-history.json`) pattern.

- New joiners receive the most recent **100 messages** on connection (replay window). Older messages are not backfilled by default.
- The host broadcasts new messages to all connected members in real time (no polling).
- Push, revert, and branch-create events are ALSO appended to `chat-log.json` as system events — the activity timeline is the chat timeline. (COLLAB-04 + SC 3.)

### Chat user controls (must ship in v1)

The user explicitly asked for fine-grained controls over their chat history. These are LOCKED for Phase 4:

| Action | Scope | What it does |
|--------|-------|--------------|
| **Clear my view** | per-user, local only | Hides existing messages from THIS member's chat panel. Other members see chat unchanged. Backed by a `chat-hidden-before` timestamp in WorkspaceState. |
| **Delete entire chat (host)** | host action, affects all | Truncates `chat-log.json` to empty. Broadcasts a `chat-cleared` event. Other members' panels go blank. Permission: host only. |
| **Truncate: keep last 100 + activity events** | host action | Removes all but the most recent 100 user messages; KEEPS all push/revert/branch system events forever. |
| **Truncate: keep only activity events** | host action | Removes all user chat messages; KEEPS push/revert/branch events. (User asked: "only push history".) |
| **Export chat to file** | per-user | Save the user's current view to a `.json` or `.md` file on their machine. |

These five options surface in a `versioncon.manageChat` QuickPick command (or sidebar context menu). Each destructive action requires a confirmation modal.

### AI summarization of chat history

**DEFERRED to Phase 8 (AI Agent API / MCP Integration).** The user asked for an opt-in path where their AI assistant can read `chat-log.json` and summarize it. Phase 8 is where MCP tools live; this naturally belongs there as a read-only MCP tool exposing chat-log.json. Phase 4 ships the persistence so Phase 8 has something to read.

### Presence broadcast cadence

**LOCKED.** Broadcast presence on `vscode.window.onDidChangeActiveTextEditor`. No periodic heartbeat in v1.

- Each member sends a `presence-update` message when their active editor changes.
- Payload: `{ memberId, displayName, branch, activeFilePath?: string }`.
- Host accumulates into a `PresenceMap: Map<memberId, PresenceInfo>` and rebroadcasts changes to all members.
- A member who hasn't sent an update is shown with whatever path they last reported.
- AFK / offline detection: piggyback on existing connection-state events (member-left clears them from the map). Periodic heartbeats can be added in a later phase if AFK detection becomes important.

### Conflict notification surface

**LOCKED.** Two-channel notification:

1. **Soft toast (CONF-07).** `vscode.window.showInformationMessage(msg)` — non-modal, no buttons, auto-dismiss. Fired when a `push-received` event touches any file currently in the user's `vscode.window.tabGroups.all` (open tabs) OR `activeTextEditor`.
2. **Activity sidebar tree (persistent log).** A new TreeView at `versioncon.activityLog` (sidebar) shows every push/revert/branch event the user has received, in reverse-chronological order. Clicking an entry opens the relevant file or chat.

The two channels are independent — the toast is an in-the-moment alert, the tree is the scroll-back history. A toast that the user missed is still visible in the tree.

### Green "no impact" status (CONF-08, SC 5)

**LOCKED.** When a `push-received` event touches NO file the user has open, the status bar briefly flashes a green check (`$(check) VersionCon — no impact (3 files unaffected)`) for ~5 seconds, then returns to the normal connected status. No toast. No tree entry (or a low-priority "info" entry the user can filter out).

### Code snippet rendering in chat

**LOCKED.** Chat lives in a dedicated **webview panel** (`versioncon.chatPanel`). Messages render as markdown via `markdown-it` (already common). Fenced code blocks (` ```ts `) get syntax highlighting via either:

- `highlight.js` (CDN-free, ~25KB minified), OR
- `shiki` (full TextMate grammar parity but heavier — ~200KB).

**Default to `highlight.js`** for v1 because the bundle size is an order of magnitude smaller and the highlight quality is fine for short snippets. Researcher should confirm whether VS Code's webview can use a local copy of either lib without CSP headaches.

The chat panel is opened by `versioncon.openChat` command, the activity bar `V` icon, OR a notification bubble on the sidebar when there are unread messages.

### Claude's Discretion

These are NOT design questions, just implementation details for the planner:

- Wire format / JSON schema for chat messages, presence-updates, chat-cleared events. Researcher will draft these in `protocol.ts`.
- Which existing files to extend vs. new files to create (e.g., a new `ChatLog.ts` mirroring `PushHistory.ts`, a new `PresenceMap.ts` or a Map kept inside SessionHost).
- Webview HTML scaffolding (CSP, message passing back to the extension host).
- Persistence on the workspace side (does the user's "clear my view" timestamp live in WorkspaceState or its own file?).
- Exact icon / color choices for the activity tree, the green status flash, etc.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Networking + protocol (Phase 1)
- `src/network/protocol.ts` — current ProtocolMessage union; this phase will add `ChatMessage`, `PresenceUpdate`, `ChatCleared`, `ChatTruncated` message types.
- `src/host/SessionHost.ts` — host-side relay logic; will add `chatLog` reference and `presenceMap` accumulator.
- `src/client/SessionClient.ts` — client-side event emitter; will add `chat-received`, `presence-update`, `chat-cleared` events.

### Persistence pattern to mirror (Phase 3)
- `src/filesystem/PushHistory.ts` — append-only JSON log, atomic writes, getRecords() reads file. ChatLog should mirror this.
- `src/filesystem/SyncTracker.ts` — in-memory state, no persistence. PresenceMap should mirror this.

### Existing UI patterns
- `src/ui/BranchListProvider.ts` — TreeDataProvider pattern (use for ActivityLogProvider).
- `src/ui/SidebarProvider.ts` — webview panel pattern (use for ChatPanel).
- `src/ui/StatusBarManager.ts` — status bar text + transient overrides (use for the green "no impact" flash).

### Permission model (Phase 3)
- `src/filesystem/BranchPermissions.ts` — used to gate destructive chat actions to the host. Truncate / Delete entire chat = host only.

### Workspace state
- `src/filesystem/WorkspaceState.ts` — already tracks per-user state. Add `chatHiddenBefore: timestamp` for the "Clear my view" feature.

</canonical_refs>

<specifics>
## Specific Ideas

- **Toast text format (CONF-07):** `"{name} pushed {N} file(s) — affects: {fileA}, {fileB}: '{msg}'"` (no buttons, auto-dismiss). If only one file overlaps, show that file by name; if more than three, show count.
- **Green status flash format (CONF-08):** `"$(check) VersionCon — no impact ({N} file(s) unaffected)"` for 5 seconds, then revert.
- **Activity tree icons:**
  - Push: `$(arrow-up)` (green if user pushed it, blue if remote)
  - Revert: `$(discard)` (red)
  - Branch create: `$(git-branch)` (gray)
  - Chat message: `$(comment)` (default)
- **Chat panel opens on:**
  1. `versioncon.openChat` command
  2. Activity bar `V` icon (already exists; add a "Chat" subview?)
  3. Click on the activity tree's "unread chat" badge
- **Presence map clears on disconnect:** when `member-left` arrives, remove from PresenceMap. When member rejoins, they re-broadcast on their first activeTextEditor change.

</specifics>

<deferred>
## Deferred Ideas

- **AI summarization of chat-log.json** — user wants their AI assistant (Claude / Cursor) to read and summarize chat history. Belongs in Phase 8 (AI Agent API / MCP) where the read-only MCP tool can expose `chat-log.json` as a resource. Phase 4 ships the persistence; Phase 8 ships the tool.
- **Periodic presence heartbeat for AFK detection** — out of scope for v1. Add when "who's actually active right now" becomes a felt need (likely Phase 7 cloud mode where latency makes on-change broadcasts noisier).
- **Cross-branch chat / global chat** — chat is per-branch in v1. Cross-branch is a v2 idea.
- **Inline review comment authoring (COLLAB-07)** — Phase 6 owns the comment authoring UI. Phase 4's chat will display review-comment events as system messages once Phase 6 emits them, but Phase 4 does not author them.
- **Status filter chips on activity tree** ("only show pushes", "only show chat") — nice-to-have; defer.
- **Chat search / message export to PDF** — the JSON export covers the basic export need; richer search is a v2 idea.

</deferred>

---

*Phase: 04-presence-chat-file-level-conflict-notifications*
*Context gathered: 2026-05-07 via /gsd-discuss-phase 4*
