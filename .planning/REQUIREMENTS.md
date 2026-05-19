# Requirements: VersionCon

**Defined:** 2026-05-04
**Core Value:** Teams collaborate on code without merge conflict pain — dependency-aware tracking means you only stop coding when changes genuinely affect what you're working on.

## v1 Requirements

### Networking & Setup

- [ ] **NET-01**: Host can create a LAN session with full control (port, bandwidth limits, credentials per user)
- [ ] **NET-02**: Host setup uses a step-by-step wizard (sliding window style) with only essential fields
- [ ] **NET-03**: New members can join a session by entering host address + credentials — no terminal commands
- [ ] **NET-04**: One-click join experience — member is coding within seconds of connecting
- [ ] **NET-05**: Connection status indicator always visible (LAN/cloud up, in sync, out of sync)
- [x] **NET-06**: Cloud mode works with the same UX as LAN (same protocol, different transport) — Phase 7 Wave 4 (07-05b). SessionHostFactory.createCloud bootstraps a cloud SessionHost end-to-end via the same wizard; CloudHostTransport demultiplexer adapts the CloudTransport (07-04) to the HostTransport interface so SessionHost stays transport-agnostic; relay first-frame carve-out (07-05b server.ts) + envelope.target unicast routing close the relay-side flow. SC-1 + SC-2 paper-verifiable; live cloud UAT deferred to 07-12 + 07-13.
- [ ] **NET-07**: LAN discovery via mDNS/Bonjour with manual IP entry as primary fallback
- [ ] **NET-08**: Host can configure bandwidth limits for the session

### Split-Pane UI

- [ ] **UI-01**: VS Code window splits into two panes — left is personal workspace, right is shared branch view
- [ ] **UI-02**: Right pane shows branch folder tree with expandable directories (read-only until push)
- [ ] **UI-03**: Left pane is a full workspace — create files, folders, edit code as normal
- [ ] **UI-04**: Drag-and-drop files/folders from branch (right) to workspace (left) to start working on them
- [ ] **UI-05**: When dragging a folder to workspace, it appears with structure only (empty)
- [ ] **UI-06**: When dragging a specific file, only that file + its parent folder path come to workspace
- [ ] **UI-07**: Drag-and-drop files/folders from workspace (left) back to branch (right) to stage for push
- [ ] **UI-08**: Everything is one real folder on disk — split pane is a visual layer over the filesystem
- [ ] **UI-09**: Workaround for VS Code 1.90+ cross-webview drag-and-drop regression (issue #256444)

### Push & Sync

- [ ] **PUSH-01**: Dragging to branch does NOT change shared code — push is a separate explicit action
- [ ] **PUSH-02**: Push requires a message describing the changes
- [ ] **PUSH-03**: Smart push summary before pushing: file list + line-by-line diff + dependency impact + who might be affected
- [ ] **PUSH-04**: Side-by-side diff view showing exactly what changed in each file before pushing
- [ ] **PUSH-05**: Full push history log — who pushed, when, what files, what message, to which branch
- [ ] **PUSH-06**: Undo a push by reverting the entire push (all files rolled back, team notified)
- [ ] **PUSH-07**: Undo a push at file level — pick which files to revert, keep others
- [ ] **PUSH-08**: Team receives notification when a push is undone
- [ ] **PUSH-09**: Must be in sync with latest branch state — out-of-sync workspaces are blocked from running code, debugging, AND staging/unstaging files; UI surfaces the block as a modal that points the user to the Sync command, not a dismissable toast
- [ ] **PUSH-10**: Out-of-sync state is resolved by a real Sync command that pulls the latest branch versions of each affected file into the workspace; Mark Synced (acknowledge-only, no file pull) is removed from v1 — the only path back to in-sync is pulling the actual code
- [ ] **PUSH-11**: When a Sync would overwrite local edits to a file, the user is presented with a per-file conflict prompt (Keep mine / Take branch / Show diff) before any file is touched; "Keep mine" preserves the local edit but leaves the user out-of-sync for that file until resolved

### Branch Management

- [ ] **BRANCH-01**: Admin can grant or revoke branch creation permissions per person
- [ ] **BRANCH-02**: Permitted members can create branches visible to everyone
- [ ] **BRANCH-03**: All branches visible to all members (branch tree view with notifications on new branches)
- [ ] **BRANCH-04**: Admin can lock branches so only specific people can push to them
- [ ] **BRANCH-05**: Admin can restrict a person to work on specific branches only
- [ ] **BRANCH-06**: Permissions can be changed at runtime (grant/revoke dynamically)
- [ ] **BRANCH-07**: Quick merge via drag-and-drop (drag files from one branch into another)
- [ ] **BRANCH-08**: Dedicated merge flow for full branch merges (structured walkthrough of all changes)
- [ ] **BRANCH-09**: Merge-to-main permissions configurable: open to all, limited to some, or restricted with mandatory review

### Conflict Detection

- [ ] **CONF-01**: File-level conflict notification when someone's push touches a file you're working on
- [ ] **CONF-02**: Dependency-aware detection via AST parsing — track function calls, variable references, imports, string values, class attributes, constants, enum values, and function signatures
- [ ] **CONF-03**: Symbol-level granularity — if ANY symbol your code uses is modified by someone else's push, you are notified
- [ ] **CONF-04**: "You call this function" attribution — notification says exactly what changed, by whom, and why it matters to you (e.g., "calculate_total() was modified by Alice — you call this in line 34")
- [ ] **CONF-05**: Variable tracking — if a variable name, value, or type changes and your code references it, you are notified
- [ ] **CONF-06**: Import/dependency tracking — if an imported module or its exports change, users of those imports are notified
- [ ] **CONF-07**: Soft non-blocking notifications — "continue coding, just be informed" (not modal dialogs)
- [ ] **CONF-08**: Green status when unaffected — "your code is not affected by the latest changes"
- [ ] **CONF-09**: Language support: Python, JavaScript/TypeScript, Java, C++
- [ ] **CONF-10**: Fallback to file-level and line-level detection for unsupported languages

### Collaboration

- [ ] **COLLAB-01**: Real-time presence — see who's online, what file they're working on, what branch they're in
- [ ] **COLLAB-02**: In-app text chat within the extension
- [ ] **COLLAB-03**: Code snippet support in chat (syntax-highlighted, paste/reference code inline)
- [ ] **COLLAB-04**: Push events automatically logged in chat (who pushed what, when, to which branch)
- [ ] **COLLAB-05**: Chat shows who's working on what and who might be affected by recent changes
- [ ] **COLLAB-06**: Soft notifications in chat when your code might be affected — by whom and why
- [ ] **COLLAB-07**: Review comments visible in chat thread

### Code Review

- [ ] **REVIEW-01**: Inline diff + approve flow (mini pull request inside VS Code)
- [ ] **REVIEW-02**: Side-by-side diff view showing what changed
- [ ] **REVIEW-03**: Reviewers can approve, request changes, or add line-level comments
- [ ] **REVIEW-04**: Review required before merge when admin configures it (mandatory review gate)

### AI Integration

- [ ] **AI-01**: Expose extension state via MCP protocol so AI tools (Claude Code, Codex, Cursor, etc.) can understand the system
- [ ] **AI-02**: AI agents can read: current branch state, sync status, recent activity, chat logs
- [ ] **AI-03**: AI agents can read: dependency graph (what symbols are used where, who depends on what)
- [ ] **AI-04**: AI agents understand sync matters — advise on when to sync, flag potential conflicts

### Safety & Recovery

- [ ] **SAFE-01**: Branch is always the source of truth — read-only from workspace until explicit push
- [ ] **SAFE-02**: Local workspace is a scratch pad — break things freely, re-pull from branch to recover
- [ ] **SAFE-03**: Full push history with revert capability serves as the safety net
- [ ] **SAFE-04**: Notifications to team when a push is reverted

## v2 Requirements

### Extended Language Support

- **LANG-01**: Additional language support for dependency analysis beyond Python/JS/TS/Java/C++
- **LANG-02**: Language-specific smart suggestions for conflict resolution

### Advanced Features

- **ADV-01**: Workspace snapshot/export — save scratch pad as a named state
- **ADV-02**: Integration with external CI/CD hooks
- **ADV-03**: AI agent as active participant — can push, create branches, review code (not just read)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Real-time character-by-character sync (Google Docs style) | Requires CRDT/OT complexity, destroys "workspace as scratch pad" safety model, architecturally incompatible with explicit push |
| Git CLI replacement | VersionCon is a collaboration UX layer, not a storage format replacement — reimplementing git internals is years of work for marginal gain |
| Voice/video chat | Entirely separate technical problem (WebRTC, codecs, STUN/TURN) — use Discord/Zoom for calls |
| Mobile/tablet support | VS Code extension API is desktop-only — mobile would be a separate product |
| Standalone app outside VS Code | VS Code Extension API is the entire foundation — another editor means reimplementing everything |
| Automatic AI conflict auto-resolution | Automated merging produces subtly wrong code — humans must make informed decisions, AI provides context |
| Full GitHub/GitLab integration (PRs, issues, CI/CD sync) | VersionCon is a replacement workflow, not a GitHub wrapper — bidirectional sync creates consistency nightmares |
| Offline mode with async reconciliation | Requires CRDT/vector clocks — same complexity as real-time sync; host-down means no sync |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| NET-01 | Phase 1 | In Progress (01-02) |
| NET-02 | Phase 1 | Pending |
| NET-03 | Phase 1 | In Progress (01-02) |
| NET-04 | Phase 1 | Pending |
| NET-05 | Phase 1 | In Progress (01-02) |
| NET-06 | Phase 7 | Complete (07-05b) |
| NET-07 | Phase 1 | Pending |
| NET-08 | Phase 1 | In Progress (01-02) |
| UI-01 | Phase 2 | Pending |
| UI-02 | Phase 2 | Pending |
| UI-03 | Phase 2 | Pending |
| UI-04 | Phase 2 | Pending |
| UI-05 | Phase 2 | Pending |
| UI-06 | Phase 2 | Pending |
| UI-07 | Phase 2 | Pending |
| UI-08 | Phase 2 | Pending |
| UI-09 | Phase 2 | Pending |
| PUSH-01 | Phase 3 | Pending |
| PUSH-02 | Phase 3 | Pending |
| PUSH-03 | Phase 3 | Pending |
| PUSH-04 | Phase 3 | Pending |
| PUSH-05 | Phase 3 | Pending |
| PUSH-06 | Phase 3 | Pending |
| PUSH-07 | Phase 3 | Pending |
| PUSH-08 | Phase 3 | Pending |
| PUSH-09 | Phase 3 | Pending |
| PUSH-10 | Phase 3 | Pending |
| PUSH-11 | Phase 3 | Pending |
| BRANCH-01 | Phase 3 | Pending |
| BRANCH-02 | Phase 3 | Pending |
| BRANCH-03 | Phase 3 | Pending |
| BRANCH-04 | Phase 3 | Pending |
| BRANCH-05 | Phase 3 | Pending |
| BRANCH-06 | Phase 3 | Pending |
| BRANCH-07 | Phase 3 | Pending |
| BRANCH-08 | Phase 3 | Pending |
| BRANCH-09 | Phase 3 | Pending |
| CONF-01 | Phase 4 | Pending |
| CONF-02 | Phase 5 | Pending |
| CONF-03 | Phase 5 | Pending |
| CONF-04 | Phase 5 | Pending |
| CONF-05 | Phase 5 | Pending |
| CONF-06 | Phase 5 | Pending |
| CONF-07 | Phase 4 | Pending |
| CONF-08 | Phase 4 | Pending |
| CONF-09 | Phase 5 | Pending |
| CONF-10 | Phase 5 | Pending |
| COLLAB-01 | Phase 4 | Pending |
| COLLAB-02 | Phase 4 | Pending |
| COLLAB-03 | Phase 4 | Pending |
| COLLAB-04 | Phase 4 | Pending |
| COLLAB-05 | Phase 4 | Pending |
| COLLAB-06 | Phase 4 | Pending |
| COLLAB-07 | Phase 6 | Pending |
| REVIEW-01 | Phase 6 | Pending |
| REVIEW-02 | Phase 6 | Pending |
| REVIEW-03 | Phase 6 | Pending |
| REVIEW-04 | Phase 6 | Pending |
| AI-01 | Phase 8 | Pending |
| AI-02 | Phase 8 | Pending |
| AI-03 | Phase 8 | Pending |
| AI-04 | Phase 8 | Pending |
| SAFE-01 | Phase 1 | Pending |
| SAFE-02 | Phase 1 | In Progress (01-02) |
| SAFE-03 | Phase 3 | Pending |
| SAFE-04 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 64 total
- Mapped to phases: 64
- Unmapped: 0

---
*Requirements defined: 2026-05-04*
*Last updated: 2026-05-04 after roadmap creation — all 64 requirements mapped*
