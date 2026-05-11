---
status: partial
phase: 04-presence-chat-file-level-conflict-notifications
source:
  - 04-01-protocol-and-types-SUMMARY.md
  - 04-02-chat-log-SUMMARY.md
  - 04-03-presence-map-SUMMARY.md
  - 04-04-host-relay-SUMMARY.md
  - 04-05-client-events-SUMMARY.md
  - 04-06-file-overlap-SUMMARY.md
  - 04-07-activity-tree-SUMMARY.md
  - 04-08-presence-panel-SUMMARY.md
  - 04-09-soft-notifications-SUMMARY.md
  - 04-10-chat-panel-SUMMARY.md
  - 04-11-manage-chat-SUMMARY.md
  - 04-12-system-events-in-chat-SUMMARY.md
  - 04-13-host-input-validation-SUMMARY.md
  - 04-14-chat-panel-lifecycle-SUMMARY.md
  - 04-15-gap-closure-v2-SUMMARY.md
  - 04-VERIFICATION.md (human_verification block — primary source for SC-1..5 tests)
started: 2026-05-08T18:00:44Z
updated: 2026-05-11T03:30:00Z
---

## Current Test

[testing paused — Test 2 (SC-1) failed with 3 blocker gaps that were closed inline at commit a420eb5 (999.3 peer presence propagation, 999.4 displayName "You" fallback, 999.5 joiner onboarding partial). Tests 2-6 are unblocked but need a retest pass with both Extension Development Host windows reloaded to pick up the new compiled extension. Resume via `/gsd-verify-work 4`.]

## Tests

### 1. Cold Start Smoke Test
expected: |
  Reload the VS Code Extension Development Host (or run `npm run watch` + F5 if it isn't open).
  The extension activates without errors in the Output panel ("VersionCon" channel) or the
  Extension Host devtools console. The VersionCon sidebar appears with its Activity Log and
  Presence views. No "Cannot find module" or "Activation failed" errors. No popup error toasts
  at startup.
result: pass
notes: |
  Extension activated cleanly; host session live (192.168.0.68:50874, invite 4R8DQ5);
  branch tree, workspace tree, branch list all rendered. Two design issues raised, captured
  in Gaps section below — paused UAT to address via /gsd-quick before continuing.

### 2. SC-1: Live Presence Panel
expected: |
  With two Extension Development Host windows running (machine A hosts, machine B joins via
  manual IP — single-machine is blocked by backlog 999.1 mDNS collision), open different files
  in each window. The Presence panel in BOTH windows shows both members with:
    - correct display name
    - active file basename
    - branch name
  The self-row shows a "(you)" suffix. If the two windows are on different branches, a
  $(git-compare) divergence indicator appears next to the divergent member.
  Bonus check (CR-03-NEW): create a file with a doubled-period name like `src/foo..bar.ts` on
  machine A and focus its tab. Machine B's presence panel should show the path verbatim — it
  must NOT silently drop or hide the entry.
result: issue
reported: "Each window only shows itself in PRESENCE — peer presence broadcasts not propagating end-to-end. Additionally the displayName renders as literal 'You' instead of the actual displayName ('Alice'/'Bob') captured by the wizard. Doubled-period filename DOES render verbatim in self-presence (CR-03-NEW preserved locally), but cross-peer propagation is broken so can't verify peer-side rendering."
severity: blocker
date_observed: 2026-05-11
gaps:
  - G3 (presence propagation)
  - G4 (displayName fallback to "You")

### 3. SC-2: Chat Send + Code Snippet Rendering
expected: |
  In a live two-window session, open the chat panel via the `versioncon.openChat` command.
  Send a plain text message — it appears immediately in BOTH members' chat panels.
  Send a fenced code block:
    ```ts
    function hello(name: string) { return `hi ${name}`; }
    ```
  The code renders with TypeScript syntax highlighting (colored keywords like `function`,
  `string`, `return`). Open the webview devtools (Cmd-Shift-P → "Developer: Open Webview
  Developer Tools") and confirm there is no CSP violation entry in the console.
result: blocked
blocked_by: prior-phase
reason: "Depends on Test 2 (SC-1 presence propagation) — chat-message wire transport shares the same routing layer."

### 4. SC-3: System Events — Actor Correctness + Host-Self Echo
expected: |
  This test confirms the CR-01-NEW + CR-02-NEW fixes from plan 04-15 work at runtime.
  Two windows: A (host) and B (joined member).
    a) On A, perform a push (commit + push via `versioncon.commit`). Both A's AND B's chat
       panels show a system row in real time reading "{HostName} pushed N file(s)".
       Critical: A sees its OWN system row immediately, not just B (this was broken before
       04-15 — host's own panel used to stay empty until reconnect).
    b) On A, open Push History and revert one of B's prior pushes (or simulate via
       `versioncon.revertPushFiles` targeting a B-authored push record). Both chat panels
       show "{B's display name} reverted N file(s)" — NOT "{HostName} reverted...". The
       actor must be B (the original pusher), not the host that performed the revert.
    c) Bonus: from B's window, create a branch (if you have create-branch permission). The
       chat panel system row reads "{B's display name} created branch '<name>'", with B's
       name resolved via the host's members map.
result: blocked
blocked_by: prior-phase
reason: "Depends on Test 2 (SC-1 presence propagation). System events ride the same chat wire; without working presence routing, cannot verify actor correctness end-to-end."

### 5. SC-4: Soft Non-Blocking Toast on File Overlap
expected: |
  Two windows. Machine B has `src/foo.ts` open in its editor. Machine A (host) pushes a
  change to `src/foo.ts` with message "test push". Machine B sees a non-modal information
  notification appear in the bottom-right notification area reading approximately:
    "{HostName} pushed 1 file — affects: foo.ts: \"test push\""
  Critical: this is a NON-MODAL notification (no big center-screen modal, no buttons that
  block the editor). It auto-dismisses after a few seconds. The activity tree on B also
  gains a new row labelled with "— affects you" suffix.
result: blocked
blocked_by: prior-phase
reason: "Depends on Test 2 (SC-1 presence propagation). File-overlap computation reads the peer's active file from PresenceMap; without presence reaching the host, overlap detection has no input. Also blocked by 999.5 (no .versioncon/ on joiner's workspace means no push surface to test against)."

### 6. SC-5: Green "No Impact" Status Bar Flash
expected: |
  Two windows. Machine B does NOT have `src/bar.ts` open in any editor tab. Machine A (host)
  pushes a change to `src/bar.ts`. Machine B's status bar (bottom-left) flashes for ~5 seconds
  to:
    "$(check) VersionCon — no impact (1 file unaffected)"
  Then reverts to its normal "VersionCon — connected" state. NO toast notification appears
  for this case. The activity tree still gains a row but without the "— affects you" suffix.
result: blocked
blocked_by: prior-phase
reason: "Tests 3-6 depend on a working live two-member presence/chat session. Test 2 (SC-1) failed at the presence-propagation layer, so Tests 3-6 cannot be exercised until that gap is closed. Re-test after gap-closure plan lands."

## Summary

total: 6
passed: 1
issues: 1
pending: 0
skipped: 0
blocked: 4

## Gaps

### G1. Container default location — left activity bar instead of right sidebar
severity: medium
source: Test 1 user feedback
test: 1. Cold Start Smoke Test
description: |
  The "VersionCon" activity-bar container (Session, Branch Files, My Workspace, All Branches,
  Activity, Presence) opens on the left activity bar by default. User wants it on the right
  (secondary) sidebar by default. VS Code does not allow extensions to declare a default in
  the secondary sidebar via package.json — must be done via a one-shot
  `workbench.action.moveViewToAuxiliaryBar` command at activation, gated by a workspaceState
  flag so it only fires once per workspace.
remediation: |
  In activate(): if context.workspaceState.get('versioncon.movedToAux') is falsy, schedule
  a moveViewToAuxiliaryBar on the container ID 'workbench.view.extension.versioncon' after
  the views are registered, then set the flag to true. User can drag back to left if they
  prefer; flag prevents re-moving on every reload.
status: closed-by 113d3ab
note: |
  Implementation lands in src/extension.ts activate() lines 188-204; wrapped in try/catch
  with console.error fallback because moveViewToAuxiliaryBar is not part of VS Code's
  stable public API and may rename/be unavailable on older versions. Reload the Extension
  Development Host to see the container appear on the right side.

### G2. Container + chat panel naming
severity: low
source: Test 1 user feedback
test: 1. Cold Start Smoke Test
description: |
  Container title "VersionCon" and chat panel header "CHAT VERSIONCON" are not as descriptive
  as they could be. User selected:
    - Container "VersionCon" → "Team Sync"
    - Chat panel "Chat VersionCon" → "Team Chat"
remediation: |
  package.json contributes.viewsContainers.activitybar[0].title = "Team Sync"
  ChatPanel webview title (in src/ui/ChatPanel.ts createOrShow) = "Team Chat"
  Webview <title> in src/ui/webview/chat/index.html = "Team Chat" (mirrored)
status: closed-by 07636a7,301c2ed
note: |
  Container renamed in commit 07636a7 (package.json line 20).
  Chat panel + webview <title> renamed in commit 301c2ed (ChatPanel.ts:92,
  src/ui/webview/chat/index.html:9).
  displayName ('VersionCon' for marketplace) and command palette category
  ('VersionCon: ...') deliberately left unchanged — those are different
  surfaces from the visible view-container header.

### G3. Peer presence-update messages don't propagate end-to-end
severity: blocker
source: Test 2 multi-window UAT, 2026-05-11
test: 2. SC-1: Live Presence Panel
description: |
  When two Extension Development Host windows are connected in a session (Alice hosts, Bob
  joins via manual IP), focusing a file in one window does NOT cause that member's row to
  appear in the other window's PRESENCE panel. Each window's PRESENCE tree only ever shows
  the self-row.

  Observed behavior across two focus cycles:
    - Alice opens src/foo..bar.ts in test-workspace-b: Alice's PRESENCE shows "You foo..bar.ts (you)"
      (the (you) suffix is correct — self-presence local upsert works).
    - Bob's PRESENCE does NOT show any Alice row.
    - Bob focuses a file in test-workspace: Bob's PRESENCE shows only his own row.
    - Alice's PRESENCE does NOT add a Bob row.

  This is a Phase 4 SC-1 blocker — the entire "live presence" promise of Phase 4 is unmet.

  Possible failure points to investigate (in order of likelihood):
    1. Client side: extension.ts onDidChangeActiveTextEditor → presenceUpdate postMessage not
       firing (Plan 04-09 100ms debounce regression?).
    2. Wire side: SessionHost relay of 'presence-update' broadcasting wrong (Plan 04-04
       sender-excluded vs. all-broadcast policy mismatch?).
    3. Client receive: SessionClient handler for 'presence-update' → PresenceMap.upsert not
       wiring to the TreeProvider refresh (Plan 04-08 wiring drift?).
    4. State sync: new joiners not getting initial peer presence (no presence-snapshot in
       state-sync, only members; presence is event-driven so a quiet joiner won't see
       already-focused peers until those peers re-focus).

  Affected file paths (likely):
    - src/extension.ts (presenceUpdate dispatch on onDidChangeActiveTextEditor)
    - src/host/SessionHost.ts (presence-update broadcast handler)
    - src/client/SessionClient.ts (presence-update receive → event emit)
    - src/ui/PresenceTreeProvider.ts (upsert + refresh wiring)

remediation: |
  Needs a Phase 4 gap-closure plan (04-16 or equivalent). Plan should:
    1. Reproduce: connect two clients, focus a file in each, assert PresenceMap.getSnapshot()
       on the host contains both entries AND state-sync to each client contains the peer's
       presence.
    2. Trace presence-update from onDidChangeActiveTextEditor → postMessage → host relay
       → other-client receive → PresenceTreeProvider.upsert at each hop.
    3. Add a presence-snapshot to the state-sync auth-response so a new joiner gets all
       already-known peer presence immediately (currently presence is only fire-on-focus).
    4. Add an integration test that mocks two clients, has each fire a presence-update, and
       asserts each client's view of the other.

### G4. Presence displayName renders as literal "You" instead of actual displayName
severity: blocker
source: Test 2 multi-window UAT, 2026-05-11
test: 2. SC-1: Live Presence Panel
description: |
  The PRESENCE panel row for any member renders the displayName as the literal string "You"
  instead of the actual displayName captured by the wizard ("Alice" / "Bob"). The (you)
  self-suffix logic is correct (only appears on the self-row), but the leading displayName
  is wrong for every row.

  Specifically, Alice's panel reads: "You foo..bar.ts (you)" — should be "Alice foo..bar.ts (you)".
  Bob reported his panel also renders "You" for the displayName.

  Likely cause: the host-side local presence upsert (Plan 04-09 explicit upsert because the
  host's broadcast excludes the sender) is being called with a hardcoded "You" string or with
  a misnamed field. The wizard now correctly threads displayName through HostIdentity (Plan
  04.1-03), but the presence-upsert call site may be reading a different placeholder.

  Affected file paths (likely):
    - src/extension.ts wireHostEvents (host's local presence upsert)
    - src/ui/PresenceTreeProvider.ts (rendering — verify it reads info.displayName not a
      hardcoded "You" for self-rows)
    - Verify that activeHostIdentity.displayName is what flows into the upsert, not the
      'You' literal that may have leaked in from a UI-SPEC self-label that should only
      appear as a suffix.

remediation: |
  Audit the path from HostIdentity.displayName → presence upsert → tree render. Fix the
  call site that's using "You" as the name field. Should be a tiny code fix once the call
  site is found. Likely closes alongside G3 in the same gap-closure plan.

  After fix, a member's row should render: "{displayName} [{file basename}] {[(you)] if self}".

### G5. Joining a session doesn't set up the local .versioncon/ hierarchy
severity: medium
source: Test 2 multi-window UAT, 2026-05-11 (user UX request)
test: 2. SC-1: Live Presence Panel (setup phase)
description: |
  When Bob joins Alice's session, his local workspace (test-workspace-b in the UAT case) has
  no .versioncon/ directory. Phase 3 v1 was scoped to "sync-state-only; file-pull deferred",
  so peers don't auto-create or sync the .versioncon/branches/{branch}/ hierarchy on join.

  This produces a confusing UX: Bob's BRANCH FILES sidebar shows "No branch files found.
  Open a folder with a .versioncon/ directory to see branch files." Bob has no way to start
  collaborating without manually setting up the directory structure, and the extension
  doesn't tell him how to do that or where to put it.

  User feedback (verbatim): "When we join a session. The hierarchy must come in right. We
  can ask them where they want the repo to be in maybe - in their local at least. And get
  them set."

remediation: |
  Two possible approaches:
    A) On successful Join, run a small post-connect wizard step: "Where should VersionCon
       store collaborative files locally?" → defaults to <workspace>/.versioncon/, creates
       branches/{branchName}/ on disk, registers FileSystemLayer at that path.
    B) Auto-create <workspace>/.versioncon/branches/{branchName}/ silently on first
       successful auth-response, with a Welcome notification explaining what was created and
       a "Change location" command for customization.

  Either approach unblocks Phase 4 SC-4 (file-overlap toast) and SC-5 (no-impact flash) UAT,
  which require Bob to actually have files in branch hierarchy that Alice can push to / from.

  Scope-wise this could:
    - Land as part of the Phase 4 gap-closure plan (04-16), OR
    - Become a small dedicated phase (4.2 INSERTED) similar to how 4.1 was inserted for
      host-identity, OR
    - Remain backlog 999.5 and get rolled into a future Phase 2-completion or Phase 3.1.
