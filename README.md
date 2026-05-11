# VersionCon

A VS Code extension that reimagines collaborative version control for teams. Instead of the git cycle of push / pull / resolve-conflicts, VersionCon gives teams a shared LAN or cloud repo with a split-pane UI, drag-and-drop code management, and dependency-aware conflict detection. Teams see what others are changing in real time and only deal with conflicts that actually affect their code.

**Core value:** Teams collaborate on code without merge-conflict pain — dependency-aware tracking means you only stop coding when changes genuinely affect what you're working on.

## Status

Pre-v1. Phases 1–4 (host/join, branches, push/sync, presence/chat/conflicts) and Phase 4.3 (git-style commands + cloud bridge) have shipped. See `.planning/ROADMAP.md` for the current milestone state.

## Install (development)

```bash
git clone <this repo>
cd VersionCon
npm install
npm run build
```

Open the folder in VS Code and press `F5` to launch an Extension Development Host. The host window will have the VersionCon extension loaded; open a folder there to start a session.

## Lifecycle Tour

VersionCon takes a project from "Alice creates a folder" through "we shipped v1 to GitHub and started v2" without ever leaving VS Code. Here is the full lifecycle.

### 1. Create the project locally

Alice opens VS Code on an empty folder named `PROJECT/` and runs **VersionCon: Host Session** from the Command Palette. The host setup wizard walks her through display name, network configuration, and an invite code. When she finishes, VersionCon is listening on the LAN and `.versioncon/branches/main/` is initialized.

The `.versioncon/` directory is hidden from her File Explorer automatically (Phase 4.3) — she sees only her project files.

### 2. Teammates join over LAN

Bob runs **VersionCon: Join Session**, enters Alice's host IP and the invite code. Within seconds he is in. His `.versioncon/` directory mirrors Alice's; both can see "Branch Files" (the shared branch view) and "My Workspace" (their personal scratch pad) in the VersionCon sidebar.

### 3. Edit and push (no drag required)

Either teammate edits files in VS Code's native File Explorer like they would for any project. When the workspace has unsaved-to-branch changes, the status bar shows `$(git-pull-request) N local changes`.

Clicking the indicator runs **VersionCon: Diff** — a QuickPick preview of every file that would be pushed.

Running **VersionCon: Push** diffs the workspace against the branch dir, then prompts for a message and pushes. The push broadcasts to teammates and appears in their Activity log within 2 seconds.

Drag-and-drop staging via the split-pane is still available for power users — both flows coexist.

### 4. Pull a teammate's push

When Bob's push arrives, Alice sees a notification (soft, non-blocking — Phase 4). She runs **VersionCon: Pull** which copies the branch state into her workspace. If she has unsaved local edits that conflict, she gets the standard "Keep mine / Take branch / Show diff" prompt (PUSH-11) per file.

### 5. Ship v1 to a real Git remote

When the team is done, Alice (host, admin) runs **VersionCon: Export to Git Remote**. She supplies a GitHub URL, a branch name on the remote (defaults to `main`), and a commit message. VersionCon shows a confirmation modal with the URL + file count, then runs `git init` / `git add .` / `git commit -m` / `git remote add origin` / `git push -u origin <branch>` inside `.versioncon/branches/main/`. Output streams to the `VersionCon: Git Bridge` Output channel for full visibility.

`git log` on the remote now shows the commit. The project is live on GitHub.

### 6. Start v2 from the remote

For the next version, the team starts fresh: Alice runs **VersionCon: Import from Git Remote**, enters the GitHub URL + branch name + a new local VersionCon branch name (e.g. `v2-work`). VersionCon clones the remote into `.versioncon/branches/v2-work/` and registers the branch. The team rejoins the session (or starts a new one) and the loop begins again.

## VersionCon for Git Users

If you already think in git, this table is a translation key. Every git-style command is a Command Palette entry under `VersionCon:`; the underlying canonical command id is shown for scripting.

| Git verb           | VersionCon command (Command Palette)       | Canonical command id              | Notes |
|--------------------|--------------------------------------------|-----------------------------------|-------|
| `git push`         | **VersionCon: Push**                       | `versioncon.cmd.push` → `versioncon.push` | Auto-stages workspace diff when nothing is drag-staged |
| `git pull`         | **VersionCon: Pull**                       | `versioncon.cmd.pull` → `versioncon.pull` | Per-file conflict prompt for byte-conflicts (PUSH-11) |
| `git checkout <b>` | **VersionCon: Checkout**                   | `versioncon.cmd.checkout` → `versioncon.switchBranch` | Switches the active branch |
| `git branch <new>` | **VersionCon: Branch**                     | `versioncon.cmd.branch` → `versioncon.createBranch` | Copies current branch as starting point |
| `git log`          | **VersionCon: Log**                        | `versioncon.cmd.log` → `versioncon.showPushHistory` | Full revert capability per push |
| `git diff`         | **VersionCon: Diff**                       | `versioncon.cmd.diff` → `versioncon.diff` | QuickPick over changed files; per-file diff is `versioncon.previewDiff` |
| `git merge <b>`    | **VersionCon: Merge**                      | `versioncon.cmd.merge` → `versioncon.mergeBranch` | Drag-and-drop or structured walkthrough |
| `git push <url>`   | **VersionCon: Export to Git Remote**       | `versioncon.exportToGitRemote`    | Host-only, admin-gated. Ships branch to a real Git remote. |
| `git clone <url>`  | **VersionCon: Import from Git Remote**     | `versioncon.importFromGitRemote`  | Host-only. Clones a real Git remote into a fresh VersionCon branch. |
| `git fetch` + reconcile | **VersionCon: Sync**                  | `versioncon.sync`                 | Resolves the out-of-sync tracker after teammate pushes |

The `cmd.*` aliases are thin pass-throughs to the canonical command ids — they exist purely to give git-fluent users a familiar Command Palette entry. Any behavior change lives on the canonical handler, never the alias module.

### Differences from git you should know

- VersionCon does NOT commit-as-you-go — changes are atomic pushes with messages, same as git, but the branch is the single source of truth and the workspace is a scratch pad. Re-pulling restores the branch state.
- Conflicts are file-level (Phase 4) and will be function-level in Phase 5 (dependency-aware). There is no three-way merge to resolve manually in v1.
- Cloud export is one-way per command — you can re-run **Export to Git Remote** any time, but each export is a fresh commit on top of the remote branch. No history reconciliation in v1.

## Development

- `npm run build` — esbuild bundle for the extension host
- `npx tsc --noEmit` — type check
- `npx tsc` — compile tests into `dist/`
- `npm test` — run the full test suite via `@vscode/test-electron`

The codebase lives under `src/`. Tests are co-located under `src/test/suite/`. Planning artifacts (phase plans, summaries, roadmap) live in `.planning/`.
