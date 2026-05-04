# Feature Research

**Domain:** Collaborative VS Code Extension — LAN/Cloud Version Control with Dependency-Aware Conflict Detection
**Researched:** 2026-05-04
**Confidence:** HIGH (core features), MEDIUM (differentiator boundaries), HIGH (anti-features)

---

## Feature Landscape

### Table Stakes (Users Expect These)

These are the baseline features that any collaborative coding/version control tool must have. Missing them makes the product feel incomplete or broken before users even evaluate the unique value proposition.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Real-time presence indicators (who's online, what file they're on) | Every collaborative tool since Google Docs has this — users feel blind without it | LOW | Cursor/user avatar + branch + file label; poll or push via WebSocket |
| Push with a message (commit-equivalent) | Users have internalized commit messages from git — "save without a message" feels dangerous | LOW | Required field before any push goes through |
| Full push history / activity log | Teams constantly ask "who changed this and when?" — no log = no accountability | MEDIUM | Append-only log with author, timestamp, branch, message, files changed |
| Side-by-side diff before pushing | Standard since git diff — users expect to see exactly what they're pushing before it lands | MEDIUM | Line-level diff UI; can use VS Code's native diff API |
| Undo / revert a push | Every VCS since SVN has had this — "I pushed bad code" is a daily occurrence | MEDIUM | Whole-push revert + file-level partial revert; must notify team |
| Branch creation and switching | Teams expect branches — one shared branch is a non-starter for any team > 2 people | MEDIUM | Branch list visible to all; creation gated by admin permissions |
| Inline code review with comments | GitHub/GitLab trained developers to expect inline review threads — any push flow without it feels incomplete | HIGH | Approve / request-changes / comment; threaded comments on specific lines |
| Connection status indicator | "Am I in sync? Is this live?" — always visible, always clear | LOW | LAN/cloud indicator in status bar; red/yellow/green state |
| Conflict notification when someone else's push touches your code | Every team tool flags this — silent overwriting destroys trust | MEDIUM | Soft notification (not blocking) at minimum; file-level is baseline |
| In-app text chat | Teams refuse to context-switch to Slack during active coding — chat must be co-located | MEDIUM | Simple message thread, not full Slack replacement |
| Setup wizard / onboarding flow | First-run UX is table stakes — users will not read docs to get started | MEDIUM | VS Code Walkthroughs API exists for this; step-by-step guided flow |
| Join flow without terminal commands | Any tool targeting students/hackathons must be join-by-link or join-by-IP, no CLI | LOW | One screen: enter host address + credentials → connected |
| Code snippet support in chat | Developers share code in chat constantly — raw text without syntax highlighting is painful | LOW | Markdown code blocks or inline editor snippet embed |
| Branch visibility (all branches visible to all members) | Siloed branches create confusion — teams expect a shared view of the branch tree | LOW | Read-only tree listing all branches; notification on new branch |
| Explicit push gate (no auto-publish on save) | Git taught developers that saves ≠ commits — auto-sync on every keystroke would terrify teams | LOW | "Stage" to branch pane → "Push" button → push goes live |
| Sync-before-run enforcement | Running stale code causes subtle bugs teams can't debug — enforcing sync before execution is expected in cloud IDEs | LOW | Warning/block before running tests if local is behind branch HEAD |

---

### Differentiators (Competitive Advantage)

These features go beyond what competitors offer. They are the core of VersionCon's value proposition and must be executed well to justify choosing this over existing tools.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Dependency-aware conflict detection (semantic, not line-based) | Git is line-based and dumb — it flags conflicts on whitespace and misses real ones. VersionCon alerts only when your code actually calls something that changed. Reduces false positives dramatically. | HIGH | Requires per-language AST parsing (Tree-sitter for Python/JS/TS; LSP-based for Java/C++); must build a live dependency graph per workspace |
| "You call this function" conflict attribution ("calculate_total() was modified by Alice — you call this in line 34") | No tool currently provides this granularity of "why should I care about this push." Transforms vague conflict warnings into actionable, specific notices. | HIGH | Dependency graph cross-referenced against incoming diff; impact scored per-user |
| Split-pane UI: personal workspace (left) vs. shared branch (right) | Visual separation of "my in-progress code" from "team's stable code" eliminates the ambiguity of git's staging area for non-expert users. | HIGH | VS Code WebviewPanel in split column; file tree on right is read-only view of branch HEAD |
| Drag-and-drop file management (branch → workspace, workspace → branch) | Direct manipulation model matches mental model — "pull this file into my work area" and "send this file to the team" is intuitive for students and hackathon devs who struggle with git commands | HIGH | Drag-and-drop between webview panels; known VS Code limitation: cross-webview drag requires security confirmation workaround |
| Smart push summary (file list + diff + dependency impact + who might be affected) | Teams don't know the blast radius of their pushes. Showing "this will affect Bob's line 34 and Carol's import" before committing makes teams more responsible and collaborative. | HIGH | Pre-push analysis pass; dependency graph lookup for all active workspace members |
| LAN-first, low-latency collaboration without cloud dependency | VS Code Live Share requires Microsoft servers. Gitpod requires cloud. VersionCon works on a closed LAN (classrooms, hackathon venues with spotty internet, corporate air-gapped networks). | HIGH | WebSocket server hosted on the "host" machine; LAN mDNS/Bonjour discovery or manual IP entry |
| AI agent API / protocol (expose branch state, sync status, dependency graph to AI tools) | As AI coding agents (Claude Code, Cursor, Codex) become standard teammates, they need to understand collaboration context. No existing tool exposes this. VersionCon becomes the first collaboration-aware AI context provider. | HIGH | Extension exposes a local API (REST or MCP-compatible) that AI agents can query; documents current branch state, who's working on what, dependency graph, chat log |
| Branch-level and person-level admin permissions (per-person branch access, push locks) | GitHub's branch protection is repo-level and static. VersionCon allows runtime, per-person permission grants — "only Alice can push to main, Bob is restricted to feature branches" — suited for teaching environments and hackathon organizers. | MEDIUM | Permissions stored in host's session state; enforced server-side before accepting a push |
| Workspace as a disposable scratch pad (break freely, re-pull to recover) | Mental safety model that encourages experimentation. Most tools' safety model is confusing — VersionCon's is explicit: workspace is yours to break, branch is the source of truth. | LOW | UI + copy framing; technically branch is read-only from workspace until explicit push; re-pull replaces workspace files from branch HEAD |
| Activity log auto-posted in chat (push events, reverts, branch creations as chat messages) | Removes the need for teams to separately check a log — team narrative unfolds in a single chat thread that mixes human messages and system events. Pioneered in tools like Slack's integrations but not in VS Code extensions. | MEDIUM | System-generated messages in chat thread on push/revert/branch events |
| Soft non-blocking conflict notifications (continue coding, just be informed) | Live Share blocks on conflicts; git makes you resolve before proceeding. VersionCon's model is "tell me, don't stop me" — teams stay in flow and address conflicts when ready. | MEDIUM | Notification badge / inline hint, not a modal dialog; includes severity (affected lines vs. unrelated change) |

---

### Anti-Features (Deliberately Avoid)

These are features that seem obviously useful but create serious problems. Many are in VersionCon's explicit "Out of Scope" list — this section explains why.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Real-time character-by-character sync (Google Docs style) | "Why can't I see their cursor moving live?" | Requires CRDT or OT — complex distributed algorithms that are notoriously hard to implement correctly. Network jitter causes ghost edits. Teams lose the "workspace as a private scratchpad" safety model. Adds massive latency burden on LAN and makes cloud sync prohibitively complex. | Manual explicit push model — teammates see your changes when you choose to share them, which is actually how professional teams work |
| Git CLI replacement / terminal workflow elimination | "Why do I need git at all?" | VersionCon's core use case is teams who don't want to think about git. But replacing git entirely means reimplementing object storage, tree diffing, blame, stash, bisect, and rebase — years of work for marginal gain. | VersionCon sits on top of or alongside git — it's a collaboration UX layer, not a storage format replacement |
| Voice / video chat | "Can't we just do a video call from here?" | Video/audio streaming is an entirely separate technical problem (WebRTC, codecs, STUN/TURN infrastructure). It bloats the extension, competes with purpose-built tools, and is lower quality than Zoom/Discord for the effort required. | Text chat + code snippets handles in-context communication; send users to Discord/Zoom for calls |
| Mobile / tablet support | "I want to review code on my phone" | VS Code does not run on mobile. The VS Code extension API is entirely desktop-bound. Building a separate mobile interface would be a separate product. | Not applicable for the extension — out of scope by platform constraint |
| Standalone app outside VS Code | "Can I use this without VS Code?" | Building a standalone app means reimplementing a code editor, file system access, language services, and extension infrastructure. The VS Code Extension API is the entire foundation. | Remain a VS Code extension; users who need a different editor are not the target audience |
| Automatic conflict auto-resolution (AI merges for you) | "Just fix it automatically" | Automated merging of semantic conflicts produces subtly wrong code that passes syntax checks but breaks behavior. Teams stop understanding their own code. AI auto-merge is only safe for trivial whitespace conflicts. | Provide clear attribution and impact analysis so humans can make informed decisions quickly |
| Full GitHub/GitLab integration (PRs, issues, CI/CD) | "Sync with our existing GitHub workflow" | VersionCon is a replacement workflow, not a wrapper on GitHub. Adding bidirectional GitHub sync creates a two-system consistency problem that is extremely hard to keep correct. | Accept that teams choose VersionCon OR GitHub flow for a session — don't try to be both |
| Offline mode with async reconciliation | "I want to keep coding when the host is down" | Full offline support requires CRDT or vector clocks to reconcile divergent histories. This is the same complexity as real-time sync. | Keep the simple model: host is the source of truth; if host is down, workspace is a local scratch pad with no sync |
| Video / screen recording of sessions | "Can we record our coding session for review?" | Screen recording is OS-level and outside VS Code's scope. Extension sandboxing prevents system-level capture. | Point to OBS, Loom, or system screen recording tools |

---

## Feature Dependencies

```
[LAN/Cloud Networking Layer]
    └──required by──> [Connection Status Indicator]
    └──required by──> [Push & Sync System]
    └──required by──> [Real-Time Presence]
    └──required by──> [In-App Chat]
    └──required by──> [Branch Management]
    └──required by──> [Admin Permissions]

[Push & Sync System]
    └──required by──> [Push History / Activity Log]
    └──required by──> [Undo / Revert Push]
    └──required by──> [Smart Push Summary]
    └──required by──> [Sync-Before-Run Enforcement]
    └──required by──> [Activity Log in Chat]

[Dependency Graph (AST Parsing)]
    └──required by──> [Dependency-Aware Conflict Detection]
    └──required by──> [Smart Push Summary (impact section)]
    └──required by──> [AI Agent API (dependency graph endpoint)]

[Dependency-Aware Conflict Detection]
    └──enhances──> [Soft Non-Blocking Notifications]
    └──enhances──> [Smart Push Summary]

[Split-Pane UI (Webview)]
    └──required by──> [Drag-and-Drop File Management]
    └──required by──> [Branch Folder Tree (right pane)]
    └──required by──> [Workspace View (left pane)]

[Branch Management]
    └──required by──> [Admin Permissions]
    └──required by──> [Inline Code Review]
    └──required by──> [Branch Visibility]

[Inline Code Review]
    └──required by──> [Review Comments in Chat]
    └──enhances──> [Push & Sync System]

[Push & Sync System] ──conflicts-with──> [Real-time char-by-char sync]
    (cannot have both explicit push model AND live sync — pick one)

[AI Agent API]
    └──requires──> [Dependency Graph]
    └──requires──> [Push History]
    └──requires──> [Real-Time Presence]
    └──requires──> [Branch Management]
```

### Dependency Notes

- **LAN/Cloud Networking Layer is the critical foundation:** Nothing works without the transport layer. Must be Phase 1 infrastructure.
- **Split-Pane UI is independent of networking:** Can be scaffolded early as a local-only UI prototype before networking is live.
- **Dependency Graph (AST) is a late dependency:** All table stakes features work without it. It unlocks the primary differentiators. Should be its own phase.
- **Admin Permissions requires Branch Management:** You can't assign per-branch permissions without branches existing first.
- **Smart Push Summary is blocked by Dependency Graph:** Can ship a "files changed only" summary first, then upgrade to full dependency impact once AST parsing is live.
- **AI Agent API is the last phase:** It requires everything else to be working first — it's a read layer over the whole system.
- **Real-time char-by-char sync conflicts with the explicit push model:** These are architecturally incompatible. The push model is simpler, safer, and correct for the use case.

---

## MVP Definition

### Launch With (v1) — Validate Core Value

The minimum needed to prove "dependency-aware collaborative version control in VS Code":

- [ ] **LAN networking + host/join flow** — without this there is no product; join must be instant, no terminal
- [ ] **Split-pane UI (left = workspace, right = branch)** — the core visual metaphor; proves the interaction model
- [ ] **Drag-and-drop file management (branch ↔ workspace)** — validates the direct manipulation approach
- [ ] **Explicit push with message + pre-push diff** — table stakes; team needs to know what lands
- [ ] **Push history + revert** — trust layer; "I can undo this" is a prerequisite for teams adopting the tool
- [ ] **Real-time presence (who's online, what file they're on)** — table stakes awareness; teams feel blind without it
- [ ] **Soft conflict notification (file-level at minimum, dependency-level if AST is ready)** — core differentiator; even file-level is better than silent overwrites
- [ ] **In-app text chat with push events auto-logged** — keeps team context co-located; validates the "one screen" vision
- [ ] **Branch management with admin permissions** — needed for any multi-person session beyond 2 people
- [ ] **Connection status indicator** — users must know sync state at a glance
- [ ] **Setup wizard + join flow** — required for the "coding within seconds" UX promise

### Add After Validation (v1.x) — Deepen the Differentiator

- [ ] **Full dependency-aware conflict detection (AST-based, per-language)** — add once the file-level version is validated in real use; this is the product's primary differentiator but requires significant engineering
- [ ] **Smart push summary with dependency impact + affected teammates** — upgrade from "files changed" to "who will be affected and how"
- [ ] **Inline code review (approve / request changes / comment)** — add once push flow is stable; reviews become necessary as team size grows
- [ ] **Cloud mode** — add once LAN protocol is proven; same protocol over internet, just needs relay/hosting infrastructure

### Future Consideration (v2+) — Expand Surface Area

- [ ] **AI Agent API (expose state to Claude Code, Cursor, Codex)** — requires all other features to be stable; high value but no user is waiting for it on day one
- [ ] **Additional language support for dependency analysis (beyond Python/JS/TS/Java/C++)** — add based on user demand signal; core languages cover 80%+ of target users
- [ ] **Notifications to team when a push is undone** — enhancement on top of revert; teams tolerate not knowing about reverts early on
- [ ] **Workspace snapshot / export** — "save my scratch pad as a named state" — nice to have, not blocking flow
- [ ] **Integration with external CI/CD hooks** — complex, out of core use case, appeals to more advanced teams

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| LAN/Cloud networking layer | HIGH | HIGH | P1 |
| Split-pane UI | HIGH | HIGH | P1 |
| Drag-and-drop file management | HIGH | HIGH | P1 |
| Explicit push + message + diff | HIGH | MEDIUM | P1 |
| Push history + revert | HIGH | MEDIUM | P1 |
| Real-time presence indicators | HIGH | LOW | P1 |
| In-app text chat + push events | HIGH | MEDIUM | P1 |
| Connection status indicator | HIGH | LOW | P1 |
| Setup wizard / join flow | HIGH | MEDIUM | P1 |
| Branch management + admin perms | HIGH | MEDIUM | P1 |
| Soft conflict notification (file-level) | HIGH | LOW | P1 |
| Dependency-aware conflict detection (AST) | HIGH | HIGH | P2 |
| Smart push summary (impact analysis) | HIGH | HIGH | P2 |
| Inline code review | MEDIUM | HIGH | P2 |
| Cloud mode | HIGH | HIGH | P2 |
| Sync-before-run enforcement | MEDIUM | LOW | P2 |
| Review comments in chat | MEDIUM | MEDIUM | P2 |
| AI Agent API / protocol | MEDIUM | HIGH | P3 |
| Additional language AST support | MEDIUM | HIGH | P3 |
| Workspace snapshot / export | LOW | MEDIUM | P3 |
| CI/CD hooks | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch — validates core concept
- P2: Should have — add when core is validated, before v1.0 is considered done
- P3: Nice to have — future consideration post product-market fit

---

## Competitor Feature Analysis

| Feature | VS Code Live Share | GitLens | GitHub Codespaces | JetBrains Code With Me (discontinued 2026) | VersionCon Approach |
|---------|-------------------|---------|-------------------|---------------------------------------------|---------------------|
| Real-time sync model | Character-by-character, live cursors | N/A (git only) | Via Live Share extension | Character-by-character | Explicit push model — no live sync |
| Conflict detection | None (overwrites silently) | Line-based git conflicts | Line-based git | None (overwrites silently) | Dependency-level semantic detection |
| LAN mode | No (requires Microsoft servers) | No | No (cloud only) | No (requires JetBrains servers) | First-class LAN support, no cloud dependency |
| Offline/air-gap support | No | Partial (local git) | No | No | LAN-only sessions work offline |
| Presence awareness | Yes — cursors, selections | No | Via Live Share | Yes — cursors | Yes — file, branch, online status |
| Branch management | No | Full git branch support | Via GitHub | No | Custom per-session branch model with permissions |
| Admin / permission controls | Host read-only mode only | Repo-level git perms | GitHub org permissions | Host control only | Per-person, per-branch runtime permissions |
| Inline code review | No | GitHub PR integration | GitHub PR | No | Built-in mini-PR flow |
| In-app chat | Yes (text + audio) | No | No | Yes (text + video) | Text chat + code snippets; no video |
| AI agent context API | No | No | No | No | Planned API exposing full system state |
| Setup complexity | Moderate (Microsoft account required) | Low (install + open repo) | High (GitHub account + billing) | Moderate (JetBrains account) | Low — wizard, join by IP, no account required |
| Push history / revert | No | Full git history | GitHub git history | No | Per-session push log with whole/file revert |
| Cloud dependency | Required | Optional | Required | Required | Optional — LAN works standalone |

---

## Key Research Findings

### Semantic Conflict Detection is Genuinely Novel

Research on "DeltaImpactFinder" (2015) and "SAM" (2024) confirms that function-level semantic merge conflict detection is an active research problem, not a solved commercial feature. Git remains line-based. GitHub Copilot is beginning to suggest merge resolutions but does not analyze dependency impact. VersionCon's approach of computing a live dependency graph per workspace and cross-referencing incoming diffs against it is architecturally sound and differentiating.

**Confidence:** HIGH (verified against academic literature and competitor feature sets)

### Tree-sitter is the Right Foundation for Multi-Language AST Parsing

Tree-sitter supports incremental parsing across all required languages (Python, JavaScript/TypeScript, Java, C++). It is already embedded in VS Code's core (Neovim and VS Code both use it). It produces CSTs that are sufficient for dependency extraction (function calls, variable references, imports). Incremental updates mean re-parsing on file change is fast. This is the correct technical foundation for the dependency analysis layer.

**Confidence:** HIGH (verified via Tree-sitter GitHub and Dropstone Research article on 40-language support)

### VS Code Drag-and-Drop Between Webviews Has a Known Bug

GitHub issue #256444 on the VS Code repository documents a regression in VS Code >= 1.90.0 where drag-and-drop between two separate WebviewPanel instances stops working. This is a known open bug. Workarounds exist (use DataTransfer API explicitly, implement internal drag state management) but require non-trivial effort. This affects the core split-pane drag-and-drop interaction.

**Confidence:** HIGH (direct GitHub issue documentation)

### JetBrains Code With Me is Being Discontinued

JetBrains announced Code With Me will be discontinued after the 2026.1 IDE release. This eliminates one major competitor and signals that the market for in-IDE real-time collaboration is underserved. Users currently on Code With Me will be looking for alternatives.

**Confidence:** HIGH (verified in search results citing JetBrains blog announcement)

### The "Explicit Push" Model is Correct for Teams

Git's own design philosophy (staging area, explicit commit, explicit push) prevails because it gives teams control. Google Docs-style real-time sync is appropriate for documents but creates anxiety in codebases — developers want to test before sharing. The manual push model VersionCon uses is validated by git's 20-year success and by VS Code Live Share's adoption pattern (people use it for pair sessions, not for persistent team collaboration, specifically because live sync is too invasive).

**Confidence:** HIGH (developer community surveys, git design history)

---

## Sources

- [VS Code Live Share — Microsoft](https://visualstudio.microsoft.com/services/live-share/)
- [GitLens — GitKraken/VS Code Marketplace](https://www.gitkraken.com/gitlens)
- [JetBrains Code With Me — Discontinued announcement](https://www.jetbrains.com/code-with-me/)
- [GitHub Codespaces Documentation](https://docs.github.com/codespaces/overview)
- [Gitpod Collaboration & Sharing](https://www.gitpod.io/docs/configure/workspaces/collaboration)
- [Tree-sitter: Incremental Parsing Library](https://github.com/tree-sitter/tree-sitter)
- [DeltaImpactFinder: Semantic Merge Conflict Detection via Dependency Analysis](https://arxiv.org/abs/1509.04207)
- [VS Code Webview Drag/Drop Bug #256444](https://github.com/microsoft/vscode/issues/256444)
- [VS Code Walkthroughs — Onboarding UX API](https://code.visualstudio.com/api/ux-guidelines/walkthroughs)
- [P2P Live Share — LAN WebSocket VS Code extension](https://github.com/kermanx/p2p-live-share)
- [Martin Fowler: Semantic Conflict](https://martinfowler.com/bliki/SemanticConflict.html)
- [OT vs CRDT — Real-time Collaboration](https://www.tiny.cloud/blog/real-time-collaboration-ot-vs-crdt/)
- [Pull Request Cycle Pain Points — Qodo](https://www.qodo.ai/blog/understanding-the-challenges-and-pain-points-of-the-pull-request-cycle/)
- [Awareness in Collaborative Programming — ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0164121224003200)

---
*Feature research for: VersionCon — Collaborative VS Code Extension with Dependency-Aware Version Control*
*Researched: 2026-05-04*
