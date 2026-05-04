# VersionCon

## What This Is

A VS Code extension that reimagines collaborative version control for teams. Instead of the git cycle of push/pull/resolve conflicts, VersionCon gives teams a shared LAN or cloud repo with a split-pane UI, drag-and-drop code management, and dependency-aware conflict detection. Teams see what others are changing in real-time and only deal with conflicts that actually affect their code.

## Core Value

Teams collaborate on code without merge conflict pain — dependency-aware tracking means you only stop coding when changes genuinely affect what you're working on.

## Requirements

### Validated

(None yet — ship to validate)

### Active

**Split-Pane UI**
- [ ] VS Code window splits into two panes: left is personal workspace, right is shared branch view
- [ ] Drag-and-drop files/folders from branch (right) to workspace (left) to start working on them
- [ ] Drag-and-drop files/folders from workspace (left) back to branch (right) to stage for push
- [ ] Right-side branch view shows folder tree with expandable directories
- [ ] Left-side workspace is a full coding environment with file/folder creation
- [ ] Everything is one real folder on disk — split pane is a visual layer
- [ ] When dragging a folder to workspace, it appears empty (just the structure)
- [ ] When dragging a specific file, only that file + its parent folder path come over

**LAN + Cloud Networking**
- [ ] LAN mode: host creates a shared repo on the local network
- [ ] Cloud mode: repo hosted remotely, same UX as LAN
- [ ] Both LAN and cloud supported from day one
- [ ] Full-control setup for host: port, bandwidth limits, credentials per user, permissions
- [ ] Step-by-step setup wizard (sliding window style) — only essential fields, not overwhelming
- [ ] Join flow: new members select "Join," enter connection details, and are in
- [ ] One-click setup experience for joiners — coding within seconds, no terminal commands
- [ ] Status indicator showing LAN/cloud connection is up and in sync

**Branch Management**
- [ ] Branch creation permissions configurable by admin (grant/revoke per person)
- [ ] All branches visible to everyone (notifications when branches are created)
- [ ] Admin can lock branches so only specific people can push to them
- [ ] Admin can restrict a person to only work on specific branches

**Push & Sync System**
- [ ] Push is explicit — dragging to branch does NOT change shared code until "Push" is hit
- [ ] Push requires a message (like a commit message)
- [ ] Smart push summary before pushing: file list + line-by-line diff + dependency impact + who might be affected
- [ ] Must be in sync with latest branch state before running/testing code
- [ ] Push history — full log of all pushes with who, when, what, message
- [ ] Undo pushes: revert entire push or pick individual files to revert
- [ ] Others notified when a push is undone

**Dependency-Aware Conflict Detection**
- [ ] Track what each person's code uses: function calls, variable references, imports, string values
- [ ] When someone pushes changes, analyze impact on every other person's active workspace
- [ ] If changes don't affect your code: green status — "no impact, continue working"
- [ ] If changes affect something your code depends on: soft notification with what changed, by whom, and why it matters to you
- [ ] Notification includes specific items affected (e.g., "calculate_total() was modified by Alice — you call this in line 34")
- [ ] Language support for dependency analysis: Python, JavaScript/TypeScript, Java/C++
- [ ] For unsupported languages: fall back to file-level and line-level change detection

**Review System**
- [ ] Inline diff + approve flow (mini pull request inside VS Code)
- [ ] Side-by-side diff view showing exactly what changed
- [ ] Reviewers can approve, request changes, or add comments
- [ ] Merge-to-main permissions configurable: open to all, limited to some, or restricted with mandatory review
- [ ] Both drag-and-drop merge (quick, for small changes) and dedicated merge flow (structured, for full branch merges)

**Live Presence & Activity**
- [ ] See who's online, what file they're working on, what branch they're in
- [ ] Team awareness dashboard — no need to ask "who's doing what"

**Chat & Activity Log**
- [ ] In-extension chat with code snippet support (paste/reference code inline)
- [ ] Pushes automatically logged in chat (who pushed what, when, to which branch)
- [ ] Chat shows who's working on what and who might be affected by recent changes
- [ ] Soft notifications in chat when your code might be affected — by whom and why
- [ ] Comments on specific code during reviews visible in chat thread

**AI Coding Agent Awareness**
- [ ] Expose extension state via API/protocol so AI tools (Claude Code, Codex, Cursor, etc.) can understand the system
- [ ] AI agents can read: current branch state, sync status, dependency graph, recent activity, chat logs
- [ ] AI agents understand that syncing matters, merge conflicts exist, and can advise accordingly
- [ ] AI works within VersionCon's paradigm — aware of what's local vs branch, what needs pushing, who might be affected

**Testing**
- [ ] Normal VS Code run/test — no special flow needed since files are real on disk
- [ ] Extension enforces sync before run — must have latest branch state before executing
- [ ] Standard terminal, standard debugging, standard test runners

**Safety & Recovery**
- [ ] Branch is always the source of truth — read-only until explicit push
- [ ] Local workspace is a scratch pad — break things freely, re-pull from branch to recover
- [ ] Full push history with revert capability (whole-push or file-level)
- [ ] Notifications to team when a push is reverted

### Out of Scope

- Standalone app outside VS Code — VS Code extension only
- Real-time character-by-character sync (Google Docs style) — manual push model keeps things predictable
- Git CLI replacement — this complements or extends git, not replaces terminal workflows
- Mobile/tablet support — desktop VS Code only
- Video/voice chat — text chat + code snippets only; use existing tools for calls

## Context

- Target users are teams doing fast-paced collaborative coding (students, hackathons, dev teams)
- The core frustration is git's merge conflict cycle breaking flow — push, pull, conflict, resolve, repeat
- Git's conflict detection is line-based and has no semantic awareness — VersionCon adds dependency-level intelligence
- The "one folder on disk, two visual panes" architecture keeps things simple — no virtual file systems, no temp copies
- LAN-first design means low-latency sync; cloud uses the same protocol over the internet
- AI integration is forward-looking — as AI coding agents become standard, they should understand the collaboration context

## Constraints

- **Platform**: VS Code extension (Electron/Node.js runtime, VS Code Extension API)
- **Languages for dependency analysis**: Python, JS/TS, Java/C++ — each needs language-specific AST parsing
- **Networking**: Must work on LAN (local network) and cloud (internet) from v1
- **Performance**: Dependency analysis must be fast enough to run on every push without blocking the workflow
- **UX**: No terminal commands required — everything through the visual UI

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Manual push (not real-time sync) | Predictable, lightweight, avoids CRDT complexity. Teams push when ready. | — Pending |
| One folder on disk, visual split pane | Simplifies architecture massively — no virtual FS, no temp copies, testing just works | — Pending |
| Dependency-aware conflict detection | Core differentiator — git is line-based and dumb, VersionCon understands code semantics | — Pending |
| LAN + Cloud from day one | Design networking layer to handle both — same protocol, different transport | — Pending |
| Branch as source of truth, workspace as scratch | Simple safety model — branch is read-only until push, workspace is disposable | — Pending |
| AI agent API/protocol | Forward-looking — AI coding tools should understand the collaboration system | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-04 after initialization*
