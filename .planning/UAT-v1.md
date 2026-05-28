# VersionCon v1 — User Acceptance Testing (UAT) Script

**Milestone:** v1.0
**Created:** 2026-05-23
**Scope:** 8 UAT items covering Phase 7 (Cloud Mode + Relay) + Phase 8 (MCP Integration)
**Status:** ⬜ In progress · ✅ Pass · ❌ Fail · ⏭️ Skipped · 🚧 Blocked

> **How to use this doc:** Run the UAT items in the order presented. After each step, mark the **Status** box and (optionally) write notes. The tests are sequenced so earlier ones build the artifacts later ones need (e.g. UAT-2 deploys the relay that UAT-3b joins). Total time estimate: **3–4 hours** if everything passes first try (Fly.io setup + two-machine coordination drives most of the budget).

---

## Pre-flight Checklist (one-time setup, ~20 min)

| # | Item | How to verify | Status |
|---|------|---------------|--------|
| P1 | **Node 20+ installed** | `node --version` → 20.x or higher | ⬜ |
| P2 | **Repo clean** | `git status` → "nothing to commit, working tree clean" on `main` | ⬜ |
| P3 | **Extension deps installed** | `npm install` exits 0 | ⬜ |
| P4 | **Extension builds** | `npm run build` exits 0; `dist/extension.js` exists | ⬜ |
| P5 | **Full test suite passes** | `npm test` → 1253 passing / 0 failing | ⬜ |
| P6 | **Relay deps installed** | `cd relay && npm install && cd ..` exits 0 | ⬜ |
| P7 | **Relay tests pass** | `cd relay && npm test && cd ..` → 79 passing / 0 failing | ⬜ |
| P8 | **Docker installed and running** *(needed for UAT-1)* | `docker version` shows Server + Client; daemon responding | ⬜ |
| P9 | **flyctl installed** *(needed for UAT-2)* | `fly version` → shows version | ⬜ |
| P10 | **Fly.io account + payment method** *(needed for UAT-2)* | `fly auth whoami` → shows your email | ⬜ |
| P11 | **Claude Code CLI installed** *(needed for UAT-8-2)* | `claude --version` shows version | ⬜ |
| P12 | **Cursor installed** *(optional — needed for UAT-8-4)* | Cursor.app exists in /Applications | ⬜ |
| P13 | **GitHub Copilot Chat extension** *(optional — needed for UAT-8-3)* | Installed in VS Code + logged in | ⬜ |
| P14 | **Second machine ready** *(needed for UAT-3b + UAT-8-5)* | A second physical machine on a DIFFERENT network than primary (use phone hotspot if needed). Has Node 20+, can `git clone` this repo, can install the extension | ⬜ |

**If P8–P14 fail:** skip the affected UATs and mark them ⏭️ in their own sections. P1–P7 are MANDATORY.

---

## Install the extension into VS Code (one-time, ~5 min)

Two options. Pick one:

**Option A — Extension Development Host (recommended for testing):**
1. Open this repo in VS Code: `code /Users/jishnuraviprolu/Desktop/VersionCon`
2. Press `F5` (or Run → Start Debugging)
3. A new "Extension Development Host" VS Code window opens with VersionCon pre-loaded
4. Use that window for ALL Phase 8 UATs (8-1..8-4)

**Option B — Install as VSIX:**
1. `npm install -g @vscode/vsce` (if not already)
2. `cd /Users/jishnuraviprolu/Desktop/VersionCon && vsce package` → produces `versioncon-X.Y.Z.vsix`
3. `code --install-extension versioncon-X.Y.Z.vsix`
4. Reload VS Code

| Step | Status | Notes |
|------|--------|-------|
| Extension loaded in VS Code | ⬜ | |

---

# PART A — Phase 7 UATs (Relay + Cloud Mode)

## UAT-1: Docker build smoke test (~5 min)

**Goal:** Confirm `relay/Dockerfile` builds clean and the resulting image starts a healthy relay.

**Pre-req:** Docker daemon running (P8 above).

### Steps

```bash
cd /Users/jishnuraviprolu/Desktop/VersionCon/relay

# Build the image
docker build -t versioncon-relay-uat .
# Expected: exit 0; image labeled versioncon-relay-uat; build time < 60s on second run (uses cache)

# Run the image
docker run --rm -d --name versioncon-relay-uat -p 8080:8080 versioncon-relay-uat
# Expected: container started, returns container ID

# Wait 3s for boot, then healthcheck
sleep 3
curl -s http://localhost:8080/healthz
# Expected: {"ok":true,"sessions":0,"uptime_s":N}  (N is a small positive integer)

# Cleanup
docker stop versioncon-relay-uat
```

### Acceptance Criteria

- [ ] `docker build` exits 0 in <60s on cached re-run
- [ ] Image is multi-stage (runtime stage does NOT contain build tools) — verify with `docker image inspect versioncon-relay-uat | grep -i user` → shows `node` (not `root`)
- [ ] `/healthz` returns `{"ok":true, "sessions":0, "uptime_s":<int>}`
- [ ] Container stopped cleanly

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED
**Time spent:** ___ min
**Notes:**

```
(write any observations, error messages, or quirks here)
```

---

## UAT-2: Fly.io deploy quickstart (~10 min target, ≤30 min realistic)

**Goal:** Following `relay/README.md`, a developer with a fresh Fly.io account can deploy a working relay in ≤5 minutes (CONTEXT D-03 phase-gate test). Be lenient on the time bound for first-time Fly users.

**Pre-req:** P9 + P10 above.

### Steps

```bash
cd /Users/jishnuraviprolu/Desktop/VersionCon/relay

# Step 1: Authenticate (skip if already logged in)
fly auth login
# Expected: browser opens; after login, terminal shows your email

# Step 2: Launch
# Pick an app name (must be globally unique on Fly.io) — suggestion: yourname-versioncon-relay-uat
fly launch --copy-config --no-deploy
# Expected: prompts for app name + region (use 'iad' or your nearest)
#           creates the app; no deploy yet
#           DO NOT let it edit fly.toml — answer "no" to "Would you like to tweak these settings before proceeding?"

# Step 3: Deploy
fly deploy
# Expected: streams Docker build to Fly's remote builder; eventually shows "v0 deployed" with hostname

# Step 4: Capture the app hostname
APP_NAME=<the-app-name-you-chose>
fly status --app "$APP_NAME"
# Note the Hostname field — e.g. yourname-versioncon-relay-uat.fly.dev

# Step 5: Healthcheck
curl https://$APP_NAME.fly.dev/healthz
# Expected: {"ok":true,"sessions":0,"uptime_s":N}
```

### Acceptance Criteria

- [ ] `fly launch` accepts the included `fly.toml` (didn't auto-generate a new one)
- [ ] `fly deploy` exits 0 within 5 min from `fly auth login` complete
- [ ] `curl https://<app>.fly.dev/healthz` returns `{"ok":true,"sessions":0,"uptime_s":<int>}`
- [ ] HTTPS works (Let's Encrypt cert auto-provisioned by Fly)
- [ ] You captured the WSS URL: `wss://<app>.fly.dev` (you'll use this in UAT-3b)

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED
**Time spent:** ___ min
**Relay URL captured:** `wss://__________________________.fly.dev`
**Notes:**

```
```

### Common gotchas

- **App name collision:** Fly app names are global. Pick something unique. If `fly launch` errors with "name taken", try a different one.
- **No payment method:** Fly requires a card on file even for the free tier. Add via web dashboard before retry.
- **Health check fails for first 30s:** Normal — give it time. `fly logs --app <app>` to watch boot.
- **502 from healthz:** Build stage failed silently — check `fly logs` for the error.

---

# PART B — Phase 8 UATs (MCP Integration — single-machine)

> **Important:** For UAT-8-1 through UAT-8-4, use a **fresh workspace** that has never had VersionCon active before, so the first-run consent flow triggers. Easiest way: open a brand-new folder (`mkdir ~/versioncon-uat-workspace && cd $_ && git init && code .`) in the Extension Development Host (Option A above).

## UAT-8-1: First-run consent prompt UX (~5 min)

**Goal:** First activation in a workspace prompts user before writing `.vscode/mcp.json`. Allow → both config files written. Decline → neither written + extension disables MCP for this workspace.

### Steps — Path 1: Accept the prompt

1. Open a fresh workspace in the Extension Development Host (no `.vscode/mcp.json`, no prior VersionCon activation)
2. Wait ~3 seconds after VS Code finishes loading
3. **Expected:** A modal appears with the exact text:
   > *"VersionCon wants to register an MCP server with this workspace so AI agents (Claude Code, Copilot, Cursor) can read your collab state. The server is local-only and read-only. Allow?"*
   with buttons `[Allow]` and `[Decline]`
4. Click **Allow**
5. Verify both files exist with their per-consumer schemas:
   ```bash
   # .vscode/mcp.json uses the VS Code Copilot Chat schema (top-level "servers"):
   cat .vscode/mcp.json   # { "servers": { "versioncon": { "type": "http", "url": "http://127.0.0.1:NNNNN/mcp" } } }
   # .mcp.json uses the Claude Code schema (top-level "mcpServers" — note the different key):
   cat .mcp.json          # { "mcpServers": { "versioncon": { "type": "http", "url": "http://127.0.0.1:NNNNN/mcp" } } }
   ```
   The two files intentionally use **different top-level keys** because their consumers (VS Code Copilot Chat vs Claude Code) require different schemas. VersionCon writes the correct shape for each.
6. Verify the port is reachable:
   ```bash
   # Extract the port from .vscode/mcp.json, then:
   PORT=$(grep -oE '127\.0\.0\.1:[0-9]+' .vscode/mcp.json | head -1 | cut -d: -f2)
   curl -X POST http://127.0.0.1:$PORT/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"uat","version":"1"}}}'
   # Expected: SSE event stream begins; first event contains result.protocolVersion
   ```

### Steps — Path 2: Decline the prompt

1. Reset state: close the workspace, delete the workspace folder, recreate it fresh
2. Also reset the global setting: in VS Code → Settings → search `versioncon.mcp.consent` → reset to default
3. Open the fresh workspace in Extension Dev Host again
4. **Expected:** Same modal appears
5. Click **Decline** (or just close the modal with the `x`)
6. Verify NEITHER file written:
   ```bash
   ls -la .vscode/mcp.json   # No such file
   ls -la .mcp.json          # No such file
   ```
7. Verify the setting flipped: in VS Code Settings, `versioncon.mcp.enabled` should now be `false`

### Acceptance Criteria

- [ ] Modal text matches exactly (no typos, no truncation)
- [ ] Both `[Allow]` and `[Decline]` buttons visible
- [ ] **Path 1 (Allow):** both `.vscode/mcp.json` AND `.mcp.json` written; port URL reachable via curl
- [ ] **Path 2 (Decline):** neither file written; `versioncon.mcp.enabled` flipped to `false`
- [ ] **Subsequent activations after Allow:** no prompt re-appears (consent persists Globally)

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED
**Time spent:** ___ min
**Notes:**

```
```

---

## UAT-8-2: Claude Code CLI reads the MCP server (~5 min)

**Goal:** Claude Code's `.mcp.json` reader picks up the workspace-root `.mcp.json` (or `.vscode/mcp.json`) and lists the VersionCon server with 7 tools.

**Pre-req:** UAT-8-1 Path 1 completed (Allow path — config files exist). Claude Code CLI installed (P11).

### Steps

```bash
cd ~/versioncon-uat-workspace   # the workspace from UAT-8-1

# Confirm .mcp.json is at workspace root
ls .mcp.json

# Open Claude Code in this workspace
claude
```

Inside the Claude Code REPL:

1. Type `/mcp` and press Enter
2. **Expected:** A list of MCP servers includes `versioncon` with status `connected` and 7 tools listed
3. Verify each tool name appears: `advise_sync`, `get_branch_status`, `get_chat_log`, `get_recent_activity`, `get_sync_status`, `list_dependents`, `query_dependencies`
4. Live invocation test — type:
   > *"What's my current branch status?"*
5. **Expected:** Claude responds by calling `get_branch_status` (you'll see a tool-use indicator) and reports the result. Approve the tool call when prompted (or ensure VersionCon's tools are auto-approved in your Claude Code settings).
6. Try another:
   > *"What did I push recently?"*
7. **Expected:** Claude calls `get_recent_activity` and reports the result.

### Acceptance Criteria

- [ ] `/mcp` lists `versioncon` server with `connected` status
- [ ] All 7 tools enumerated by name
- [ ] At least 2 live tool calls succeed (one read + one cross-reference)
- [ ] No `Error: Connection refused` or `Bearer token required` (server is unauthenticated localhost, as designed)

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED
**Time spent:** ___ min
**Notes:**

```
```

### Common gotchas

- **`versioncon` shows `disconnected`:** the VS Code extension isn't running. Make sure your Extension Dev Host window is still open and the workspace is loaded there.
- **Claude Code doesn't find `.mcp.json`:** check that you launched `claude` from the workspace root, not a parent dir.

---

## UAT-8-3: VS Code Copilot Chat agent mode (~5 min)

**Goal:** Copilot Chat in agent mode discovers the `.vscode/mcp.json`-declared server and can invoke a tool.

**Pre-req:** UAT-8-1 Path 1 completed. Copilot Chat extension installed + logged in (P13).

### Steps

1. In the Extension Dev Host VS Code window (same one with the workspace from UAT-8-1):
2. Open Copilot Chat: `Cmd+Ctrl+I` (or View → Chat)
3. Switch to **Agent** mode (dropdown at the top of the chat panel)
4. In the chat input, type `@` — **Expected:** an autocomplete list appears that includes `@versioncon` (or shows VersionCon tools under "MCP servers")
5. Ask: *"What's my current branch status?"*
6. **Expected:** Copilot calls `get_branch_status` (shows a tool-use card) and renders the result
7. Optionally: ask *"Should I push my changes?"* — should call `advise_sync`

### Acceptance Criteria

- [ ] Copilot Chat agent mode is available
- [ ] `@versioncon` (or VersionCon tools) appears in the autocomplete
- [ ] At least 1 tool call returns a real result (not an error)

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED
**Time spent:** ___ min
**Notes:**

```
```

### Common gotchas

- **No agent mode dropdown:** Copilot Chat may be on an older version that lacks agent mode. Update the extension.
- **Tools not discovered:** Reload window (`Cmd+Shift+P` → "Reload Window"). VS Code re-scans `.vscode/mcp.json` on workspace reload.

---

## UAT-8-4: Cursor reads the same mcp.json (~5 min)

**Goal:** Cursor's MCP integration picks up the same `.vscode/mcp.json` (Cursor supports the same config format).

**Pre-req:** UAT-8-1 Path 1 completed. Cursor installed (P12). The VS Code Extension Dev Host must still be running (Cursor is just an MCP client; the server lives inside the VS Code extension process).

### Steps

1. Open the workspace in Cursor: `cursor ~/versioncon-uat-workspace`
2. Open Cursor's MCP panel: Cmd+Shift+P → "MCP" or via Settings → MCP
3. **Expected:** `versioncon` listed as a connected MCP server with 7 tools
4. Open Cursor Chat (Cmd+L), switch to agent mode if needed
5. Ask: *"What does this codebase look like in terms of branch state?"*
6. **Expected:** Cursor's agent invokes one of the VersionCon tools and weaves the result into its response

### Acceptance Criteria

- [ ] `versioncon` server visible in Cursor's MCP panel
- [ ] At least 1 successful tool invocation from Cursor chat

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED
**Time spent:** ___ min
**Notes:**

```
```

---

# PART C — Two-machine UATs (combined: UAT-3b + UAT-8-5)

> **The biggest test.** These two UATs share the same physical setup — host on Machine A, joiner on Machine B, both on different networks, connected through the Fly.io-deployed relay from UAT-2.

## Setup for both UAT-3b + UAT-8-5 (~15 min)

### Machine A (host) — your primary dev machine

Should already have:
- Extension built and installed (Option A or B)
- Fly.io relay deployed (UAT-2 done; URL captured: `wss://<app>.fly.dev`)

### Machine B (joiner) — second physical machine

**Choose ONE network-separation strategy:**
- (a) Different physical machine on a different WiFi
- (b) Different physical machine on phone hotspot
- (c) Same machine but the network goes through a different ISP route — NOT recommended; defeats the cross-network test

**Setup steps:**
1. SSH/RDP into Machine B (or use it directly if it's a laptop you can carry)
2. Install Node 20+, Git, VS Code
3. Clone the repo: `git clone <this-repo-url> /tmp/versioncon && cd /tmp/versioncon && git checkout main`
4. `npm install`
5. `npm run build`
6. Launch the extension via Extension Dev Host: open VS Code on Machine B, open this repo, press F5

| Setup item | Status |
|---|---|
| Machine A ready (extension + relay URL) | ⬜ |
| Machine B ready (Node + repo + extension built) | ⬜ |
| Machine A and Machine B on DIFFERENT networks | ⬜ |
| Relay URL works from Machine B: `curl https://<app>.fly.dev/healthz` returns ok | ⬜ |

---

## UAT-3b: Two-machine live cloud session (~30 min)

**Goal:** A host on one network and a joiner on another network can establish a real cloud session through the Fly.io relay. Joiner sees host's presence; host sees joiner's presence; chat works both directions; status bar accurately reflects connection lifecycle.

This is the canonical end-to-end test for Phase 7 (SC-1 + SC-2 + SC-3 combined).

### Steps

#### Phase 1 — Host starts the session (Machine A)

1. In the Extension Dev Host VS Code on Machine A, open ANY workspace folder
2. Cmd+Shift+P → `VersionCon: Host Session`
3. Wizard opens. Enter your display name (e.g. "Alice on A").
4. On *"Where will your team connect from?"*, select **Different networks (Cloud)**
5. In **Relay URL**, paste: `wss://<your-fly-app>.fly.dev`
6. Click **Test connection** — wait for green check ✓
7. Continue through wizard until the "Share invite" screen
8. **Expected:** The deep-link displayed has the shape `vscode://versioncon.versioncon/join?relay=wss%3A%2F%2F...&session=vc-XXXXXX&code=XXXXXX&bt=eyJ...` — note especially the `&bt=` query parameter (Phase 7 BLOCKER 2 fix; if `&bt=` is missing, **stop and report**)
9. Click **Copy link**
10. Status bar at bottom of VS Code should show `VersionCon: connected` (or similar — green/blue indicator)

#### Phase 2 — Joiner receives the link (Machine B)

11. Send the deep-link to Machine B via any channel: email, Slack DM, SMS, paste into a notes app you can access from both. **Do NOT use AirDrop** — it strips URL schemes on some macOS versions.
12. On Machine B, open the deep-link (click it in your mail client, or right-click → "Open with VS Code" if your OS doesn't auto-route `vscode://` URLs)
13. VS Code window on Machine B activates (or pops to front)
14. **Expected:** A confirmation prompt appears: *"VersionCon: A teammate wants you to join session vc-XXXXXX on wss://...fly.dev. Continue?"* with `[Join]` and `[Cancel]`
15. Click **Join**
16. A join wizard opens with relay + session pre-filled. Enter your display name (e.g. "Bob on B") and the invite code (which the host should have shared too — typically via the same channel as the deep-link)
17. Click **Join session**
18. **Expected:**
    - Status bar transitions: `connecting` → `connected`
    - The joiner sees a presence entry for the host (Alice)

#### Phase 3 — Verify presence + chat both directions

19. On Machine A (host), open the VersionCon presence panel
20. **Expected:** Bob appears in the active members list
21. On Machine A, send a chat message: "Hi from Alice"
22. **Expected on Machine B:** the chat panel shows "Alice: Hi from Alice" within 2 seconds
23. On Machine B, reply: "Hi back from Bob"
24. **Expected on Machine A:** "Bob: Hi back from Bob" appears within 2 seconds

#### Phase 4 — Status bar state transitions (manual reproduction)

25. On Machine B, disconnect from the network for 10 seconds (turn off WiFi)
26. **Expected on Machine B status bar:** `connected` → `reconnecting` → eventually `relay-unreachable` after ~30s
27. Re-enable WiFi on Machine B
28. **Expected:** status bar returns to `connected` within ~10s; chat continues to work

#### Phase 5 — Clean shutdown

29. On Machine B, close the joined session
30. **Expected on Machine A:** Bob disappears from presence within ~5s
31. On Machine A, end the session
32. **Expected on Machine A status bar:** `connected` → `idle`

### Acceptance Criteria

- [ ] Deep-link contains `&bt=` parameter (BLOCKER 2 fix evidence)
- [ ] Joiner successfully connects to relay through the Fly.io public IP
- [ ] Both machines see each other in presence
- [ ] Bidirectional chat works
- [ ] Status bar transitions: `connecting → connected → reconnecting → connected` survive a 10s network drop
- [ ] Clean shutdown removes presence entries on the peer

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED / BLOCKED
**Time spent:** ___ min
**Fly.io relay URL used:** `_______________________`
**Notes:**

```
```

### Common gotchas

- **Deep-link doesn't open VS Code on Machine B:** macOS sometimes needs a one-time "Always open vscode:// URLs with Visual Studio Code" approval. If it opens but nothing happens, check Console.app for `vscode://` URL handler errors.
- **`relay-unreachable` even though the host is up:** firewall on Machine B blocking outbound WSS to Fly.io. Try a different network on Machine B.
- **`session-not-found`:** the host session expired (15min idle), or the relay restarted. Restart the host session and re-share the deep-link.

---

## UAT-8-5: Live conflict-prediction scenario (~20 min)

**Goal:** With both machines joined to a session, the AI agent on one machine calls `advise_sync` and receives a meaningful prediction that mentions the OTHER machine's edits — proving the dep-graph + presence fusion works end-to-end across the wire.

**Pre-req:** UAT-3b complete and both machines are still in the same cloud session.

### Steps

1. Machine A and Machine B both in the same active cloud session (carry over from UAT-3b)
2. Both machines have a Claude Code CLI active in the workspace
3. **On Machine A:** Open `src/auth/TokenService.ts` and edit the `parseToken` function (any change — add a comment, change a variable name; just make it dirty). **Do NOT push yet.**
4. **On Machine B:** Open a file that depends on `parseToken` — `src/host/AuthHandler.ts` would be a real example (Phase 5 AST graph established this dependency). Edit something in there. **Do NOT push.**
5. **On Machine B (in Claude Code):** Type:
   > *"Should I push my changes? Is anyone else editing related code?"*
6. **Expected:** Claude calls `advise_sync` and the returned `predicted_conflicts` array includes an entry like:
   ```json
   {
     "file": "src/auth/TokenService.ts",
     "reason": "ast-symbol-overlap",
     "confidence": 0.6,
     "detail": "Symbol 'parseToken' is referenced by your dirty file src/host/AuthHandler.ts; Alice is editing TokenService.ts",
     "peer": "Alice on A"
   }
   ```
   Then Claude's natural-language answer recommends pulling first or coordinating with Alice.
7. **Verify on Machine A** — same exercise in reverse: on Machine A's Claude Code, ask the same question. Should return a `predicted_conflicts` entry mentioning Bob editing AuthHandler.ts.

### Acceptance Criteria

- [ ] `advise_sync` returns `predicted_conflicts.length >= 1` when peers are editing dependent files
- [ ] At least one prediction's `reason` is one of the valid values: `ast-symbol-overlap`, `file-edit-overlap`, `lock-held-by-peer`
- [ ] Prediction `confidence` is a number in `(0, 1]`
- [ ] Prediction `peer` field correctly identifies the other machine's user
- [ ] Claude's natural-language response is conflict-aware (mentions the peer or suggests coordination)

### Result

**Status:** ⬜ PASS / FAIL / SKIPPED / BLOCKED
**Time spent:** ___ min
**Notes:**

```
```

### Acceptable v1 limitations (not failures)

- **Reverse symbol-overlap may not trigger:** v1's `DependencyReader.reverseDeps` always returns empty (Phase 5 has no standing reverse index). Forward-direction `ast-symbol-overlap` should still work (the v1 path that 08-08 actually implements).
- **`predicted_conflicts` may be empty if Phase 5 didn't index the workspace at session start:** the AST graph might not have been built for the test files. If empty, file an issue but mark this UAT as ⏭️ for now — the v1 contract is that `advise_sync` returns the empty-but-valid shape (no error), and the LLM should still mention sync state (`behind > 0` etc.).

---

# PART D — Final tally + sign-off

## UAT Summary Table

| ID | Title | Status | Time | Phase |
|---|---|---|---|---|
| UAT-1 | Docker build smoke test | ⬜ | ___ min | 7 |
| UAT-2 | Fly.io deploy quickstart | ⬜ | ___ min | 7 |
| UAT-8-1 | First-run consent prompt | ⬜ | ___ min | 8 |
| UAT-8-2 | Claude Code CLI integration | ⬜ | ___ min | 8 |
| UAT-8-3 | Copilot Chat agent mode | ⬜ | ___ min | 8 |
| UAT-8-4 | Cursor integration | ⬜ | ___ min | 8 |
| UAT-3b | Two-machine live cloud session | ⬜ | ___ min | 7 |
| UAT-8-5 | Live conflict prediction | ⬜ | ___ min | 8 |

**Total elapsed:** ___ hours ___ min

## v1 milestone sign-off

When ALL 8 UATs are PASS (or you've explicitly decided to ship with some SKIPPED for documented reasons):

- [ ] **Phase 7 ready for marked-complete in ROADMAP.md** (currently `human_needed`)
- [ ] **Phase 8 ready for marked-complete in ROADMAP.md** (currently `human_needed`)
- [ ] **v1 milestone ready for `/gsd-complete-milestone`** — archives current phases, preps for v1.1 or whatever's next
- [ ] **Tag and release** — optional, but `git tag v1.0.0` + a release note is recommended

**Tester:** _______________________
**Date completed:** _______________________
**Decision:** ⬜ SHIP / ⬜ HOLD / ⬜ HOLD-WITH-NOTES

### If HOLD or HOLD-WITH-NOTES — issues to address before ship

```
(list any UAT failures and their root cause + fix-plan path forward)
```

---

## Appendix: Quick-reference commands

```bash
# Local extension dev loop
npm run build && npm test

# Relay local boot (for debugging)
cd relay && npm run build && PORT=8080 node dist/server.js
curl http://localhost:8080/healthz

# Fly.io quick commands
fly status --app <app-name>
fly logs --app <app-name>
fly machine list --app <app-name>
fly machine stop <machine-id> --app <app-name>   # cost-saving when not testing

# Reset workspace state between UAT runs
rm -rf .vscode/mcp.json .mcp.json
# In VS Code: Cmd+Shift+P → "Preferences: Open Settings (JSON)" → remove "versioncon.mcp.*" entries

# Tear down Fly.io relay (when done with UATs)
fly apps destroy <app-name>
```

## Appendix: Where to file issues

- **UAT-X failed with a code-level bug:** `/gsd-debug` on the failing scenario; or create a `.planning/phases/999.N-<short-name>/` backlog entry
- **Documentation gap (test instructions unclear):** edit this file (`.planning/UAT-v1.md`) directly and commit
- **Cross-tool issue (Claude Code/Copilot/Cursor changed their MCP shape):** note in the UAT-8-X "Notes" section + flag for a Phase 8.1 update
