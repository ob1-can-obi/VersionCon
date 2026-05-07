---
phase: 4
slug: presence-chat-file-level-conflict-notifications
status: draft
shadcn_initialized: false
preset: not applicable
ui_target: vscode-extension
component_library: native vscode (TreeView + WebviewPanel + StatusBarItem + showInformationMessage)
icon_library: VS Code Codicons (`$(name)`)
font: VS Code editor font (`var(--vscode-font-family)`)
created: 2026-05-06
---

# Phase 4 — UI Design Contract

> Visual and interaction contract for the Presence + Chat + File-Level Conflict Notifications phase. VS Code extension surfaces only — no web app. All visual decisions inherit from VS Code theme tokens so the extension respects the user's light/dark/custom theme.

---

## 0. Surface Inventory

Five visual surfaces ship in this phase. Each is a native VS Code primitive — no custom rendering libraries beyond markdown-it + highlight.js inside the chat webview.

| Surface | VS Code primitive | View ID / Command | Owns requirements |
|---------|-------------------|-------------------|-------------------|
| Presence panel | `TreeView` (sidebar) | `versioncon.presence` | COLLAB-01, COLLAB-05, SC 1 |
| Activity log | `TreeView` (sidebar) | `versioncon.activityLog` | COLLAB-04, CONF-01 (persistent leg) |
| Chat panel | `WebviewPanel` (editor area, dedicated tab) | `versioncon.chatPanel` (command: `versioncon.openChat`) | COLLAB-02, COLLAB-03, COLLAB-06, SC 2, SC 3 |
| Status bar | Existing `StatusBarItem` (managed by `StatusBarManager`) | `versioncon.showSidebar` (click) | CONF-08, SC 5 (no-impact flash + unread badge) |
| Toast | `vscode.window.showInformationMessage` (transient) | n/a | CONF-01, CONF-07, SC 4 |
| Manage chat | `vscode.window.showQuickPick` | `versioncon.manageChat` | Locked CONTEXT.md "Chat user controls" |

Activity bar container reuses the existing `versioncon` activitybar id (the `V` icon already lives there). The two new TreeViews are appended to that container's `views` array in `package.json`.

---

## 1. Visual Hierarchy

For each surface, the rank-ordered information.

### 1.1 Presence panel (`versioncon.presence`)

| Rank | Element | Why |
|------|---------|-----|
| Primary | Member display name | "Who is this?" answers in one glance |
| Secondary | Active file name (basename) — shown as TreeItem `description` | "What are they touching?" |
| Tertiary | Branch name — shown in `tooltip` on hover, plus an icon if branch differs from mine | "Are they on my branch?" — only relevant when divergent |
| Suppressed | Member id, ws connection details — never shown |

Sort order: `self` first, then by display name ascending. The current user is bolded via TreeItem `description: "(you)"` since VS Code TreeView does not support font-weight in labels.

### 1.2 Activity log (`versioncon.activityLog`)

Reverse-chronological flat list. Each item is one push, revert, branch-create, or chat-unread marker.

| Rank | Element | Why |
|------|---------|-----|
| Primary | Event title (e.g. `"Alice pushed 3 file(s)"`) | The headline |
| Secondary | Relative timestamp shown as TreeItem `description` (e.g. `"2m ago"`) | When it happened |
| Tertiary | Push message / branch name — TreeItem `tooltip` only | Detail on hover |
| Suppressed | Member id, full ISO timestamp (tooltip only) |

Hard cap: most recent **200 entries** held in memory; older entries scroll off (chat-log.json keeps the durable record).

### 1.3 Chat panel (`versioncon.chatPanel`)

Three-zone layout, top-to-bottom:

| Zone | Rank | Content |
|------|------|---------|
| Header (fixed, ~36px tall) | Primary | Branch name; secondary: connected member count (`"3 online"`); tertiary: "Manage chat" gear icon |
| Message list (flex, scrollable) | Primary | Latest 100 messages, oldest at top, newest at bottom; auto-scroll to bottom on new message **only when user is already within 80px of bottom** (otherwise show a "↓ N new" jump button) |
| Composer (fixed, auto-grow textarea up to 6 lines) | Primary | Textarea; tertiary: send button + keyboard hint |

Inside each message row:

| Rank | Element |
|------|---------|
| Primary | Display name + message body (rendered markdown) |
| Secondary | Timestamp (relative, e.g. `"2m ago"`, refreshed every 30s) |
| Tertiary | Avatar circle (colored disc with first letter of display name) |

System events (push/revert/branch-create) render in a distinct row style — italic, muted, no avatar (see § 2.3).

### 1.4 Status bar

Coexists with existing connection status managed by `StatusBarManager`. Phase 4 adds two transient overrides: the green no-impact flash, and an unread chat badge.

| Mode | Priority |
|------|----------|
| Sync warning (PUSH-09 from Phase 3) | Highest — blocks all other modes |
| Reconnecting (Phase 1) | High |
| Green "no impact" flash (this phase, 5s) | Medium — overrides connected, returns to connected after 5s |
| Connected + unread chat badge (this phase) | Medium — appended `(N)` after `VersionCon` text |
| Connected | Default |
| Disconnected | Lowest |

### 1.5 Toast

Single-line auto-dismiss `showInformationMessage`. No buttons. No modal. Treat as "it might be off-screen by the time the user looks" — therefore the durable copy lives in the activity tree.

---

## 2. Component Anatomy

### 2.1 Presence TreeItem

```
┌─ $(account)  Alice                     src/api/users.ts (you) ─┐
│   tooltip: "On branch: feature-auth"
│   contextValue: "presenceMember-self" | "presenceMember-other"
│   color: themeColor("foreground")   — name uses default
│   description-color: themeColor("descriptionForeground")
└─────────────────────────────────────────────────────────────────┘
```

| Slot | Source | Token / Codicon |
|------|--------|------|
| Icon | `vscode.ThemeIcon('account')` | `$(account)` — neutral |
| Label | `presence.displayName` | default foreground |
| Description | basename of `presence.activeFilePath` or `"(no file)"` if unset | `descriptionForeground` |
| Tooltip | `"On branch: {branch}\nFile: {full path}"` | n/a |
| `(you)` suffix | appended to description when `memberId === self.id` | n/a |

Branch divergence indicator: when `presence.branch !== currentBranch`, prepend `$(git-compare)` to the description (e.g. `$(git-compare) feature-x · src/foo.ts`), color `editorWarning.foreground`. This is the only color override on this tree.

Empty state (no other members): `viewsWelcome` content `"You're the only one here.\nShare your session to invite teammates."` with a button-link to `versioncon.showSidebar`.

### 2.2 Activity log TreeItem

Five item shapes. Each uses a single Codicon, a label, a description (relative time), and a tooltip.

| Event | Icon | Icon `themeColor` | Label format |
|-------|------|-------------------|--------------|
| Push (mine) | `$(arrow-up)` | `testing.iconPassed` (green) | `"You pushed N file(s)"` |
| Push (remote, no impact) | `$(arrow-up)` | `charts.blue` (blue) | `"{name} pushed N file(s)"` |
| Push (remote, affects me) | `$(arrow-up)` | `editorWarning.foreground` (amber) | `"{name} pushed N file(s) — affects you"` |
| Revert | `$(discard)` | `errorForeground` (red) | `"{name} reverted N file(s)"` |
| Branch create | `$(git-branch)` | `descriptionForeground` (gray) | `"{name} created branch '{branchName}'"` |
| Chat (unread marker) | `$(comment)` | `charts.blue` (blue) | `"{count} unread message(s)"` — single sticky entry, click opens chat |

Per-item:

| Slot | Token |
|------|-------|
| Description (timestamp) | `descriptionForeground` |
| Tooltip | full ISO timestamp + push message if present |
| `command` | push events → open the smart push summary modal; revert → open same; branch → switchBranch picker; chat → `versioncon.openChat` |
| `contextValue` | `activity-push` / `activity-revert` / `activity-branch` / `activity-chat-unread` |

The unread-chat marker is a **single sticky row** at the top of the tree; it is removed when the chat panel is opened (or all messages are scrolled past).

### 2.3 Chat message row (webview DOM)

Two row variants: **user message** and **system event**.

#### User message

```
┌────────────────────────────────────────────────────────────────────┐
│ ┌─[A]─┐  Alice · 2m ago                                            │
│ │     │  Hey, look at this edge case in the auth flow:             │
│ │     │  ```ts                                                      │
│ │     │  if (token.expired) { ... }                                 │
│ │     │  ```                                                        │
│ └─────┘                                                             │
└────────────────────────────────────────────────────────────────────┘
```

| Slot | DOM element | Style tokens |
|------|-------------|--------------|
| Avatar (32×32 circle) | `<div class="avatar">A</div>` | `background: var(--vscode-charts-blue)` for self, hashed-from-id color from a fixed 6-color palette (`--vscode-charts-{red,blue,yellow,orange,green,purple}`) for others; foreground `var(--vscode-editor-background)` for contrast |
| Display name | `<span class="author">` | `font-weight: 600; color: var(--vscode-foreground)` |
| Timestamp | `<span class="ts">` | `color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size) - 1px)` |
| Markdown body | `<div class="body">` | `color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5` |
| Code block (fenced) | `<pre><code class="hljs">` | `background: var(--vscode-textCodeBlock-background); color: var(--vscode-textPreformat-foreground); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.45; padding: 12px` |
| Inline code | `<code>` | `background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px` |

Layout spacing: avatar column 32px, gap 8px, body grows. Vertical gap between consecutive messages from the same author within 60s: 4px (no avatar repeat — show only on the first). Otherwise: 12px gap, avatar shown.

Highlight.js classes (`.hljs-keyword`, `.hljs-string`, etc.) are mapped to VS Code semantic tokens via a small CSS shim:

```css
.hljs-keyword     { color: var(--vscode-symbolIcon-keywordForeground); }
.hljs-string      { color: var(--vscode-symbolIcon-stringForeground);  }
.hljs-number      { color: var(--vscode-symbolIcon-numberForeground);  }
.hljs-comment     { color: var(--vscode-symbolIcon-snippetForeground); font-style: italic; }
.hljs-function    { color: var(--vscode-symbolIcon-functionForeground); }
.hljs-class       { color: var(--vscode-symbolIcon-classForeground);   }
.hljs-variable    { color: var(--vscode-symbolIcon-variableForeground); }
.hljs-built_in    { color: var(--vscode-symbolIcon-classForeground);   }
.hljs-title       { color: var(--vscode-symbolIcon-functionForeground); }
.hljs-attr        { color: var(--vscode-symbolIcon-propertyForeground); }
```

This means highlight.js never emits hex colors; everything routes through the active VS Code theme.

#### System event row

```
┌────────────────────────────────────────────────────────────────────┐
│        $(arrow-up)  Bob pushed 3 file(s) to feature-auth · 2m ago  │
│                     "Wire up token refresh"                        │
└────────────────────────────────────────────────────────────────────┘
```

| Slot | Style |
|------|-------|
| Container | `border-left: 2px solid var(--vscode-textBlockQuote-border); padding: 6px 12px; background: var(--vscode-textBlockQuote-background); font-style: italic` |
| Icon | Codicon font (use `codicon` font-family loaded from the bundled `@vscode/codicons` CSS) |
| Text | `color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size) - 1px)` |
| Push message (if present) | quoted second line, same muted style |

### 2.4 Composer (chat footer)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────────────────────────────┐ ┌─[Send]─┐ │
│ │ Type a message…                                      │ └────────┘ │
│ └──────────────────────────────────────────────────────┘             │
│  $(code)  Paste code           Cmd/Ctrl + Enter to send              │
└──────────────────────────────────────────────────────────────────────┘
```

| Slot | Style / Behavior |
|------|------------------|
| Textarea | `min-height: 36px; max-height: 144px (6 lines); auto-grow on input; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px 12px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); resize: none` |
| Focus ring | `outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px` (replaces border on focus) |
| Send button | `background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 6px 14px; border-radius: 2px; min-width: 64px` — disabled when textarea is empty/whitespace-only (`background: var(--vscode-button-secondaryBackground); color: var(--vscode-disabledForeground); cursor: not-allowed`) |
| "Paste code" affordance | Inline button next to keyboard hint. Click → wraps current selection in fenced code block; if no selection, inserts ` ```ts\n\n``` ` and places cursor inside |
| Keyboard hint | `color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size) - 2px)` |

### 2.5 Status bar overrides

Reuses `StatusBarManager`. Add two new methods:

| Method | Text | Color token | Duration |
|--------|------|-------------|----------|
| `flashNoImpact(N)` | `"$(check) VersionCon — no impact ({N} file(s) unaffected)"` | `testing.iconPassed` | 5000ms (then `setStatus(currentStatus, sessionName)`) |
| `setUnreadCount(N)` | Connected text becomes `"$(circle-filled) VersionCon ($(comment) {N})"` when N>0; reverts when 0 or chat opened | unchanged (`testing.iconPassed`) | persistent until cleared |

If `flashNoImpact` and `setUnreadCount` collide, `flashNoImpact` wins for 5s (it's a fresh signal), then unread count re-applies. Sync warning beats both.

### 2.6 Toast (CONF-07)

`vscode.window.showInformationMessage(message)` — no items, returns void. Phase 4 never passes a `MessageOptions` with `modal: true`.

---

## 3. Interaction States

### 3.1 Presence TreeView

| State | Trigger | Visual change |
|-------|---------|---------------|
| Default | n/a | as § 2.1 |
| Hover | mouse over | VS Code default tree row hover (`list.hoverBackground`) — automatic |
| Selected | click | `list.activeSelectionBackground` — automatic |
| Stale (file path > 5min old) | client clock check | `description` color → `disabledForeground` |
| Member offline | `member-left` event | row removed entirely (no "offline" indicator in v1; locked in CONTEXT.md "AFK / offline detection") |

### 3.2 Activity log TreeView

| State | Trigger | Visual change |
|-------|---------|---------------|
| Default | n/a | as § 2.2 |
| Hover | mouse over | default row hover |
| Click | mouse click | execute `command` (push → smart summary modal; chat-unread → openChat) |
| Unread chat marker | new chat msg arrives + chat panel not focused | sticky row at top with `charts.blue` icon + bold-style label (TreeView has no bold; we prefix with `$(circle-filled)` instead to draw the eye) |
| Cleared (post-click) | click on unread marker | row removed; tree refreshes |

### 3.3 Chat webview

| Element | State | Visual |
|---------|-------|--------|
| Message row | hover | `background: var(--vscode-list-hoverBackground)` |
| Message row | own message | no special background; identifiable by `(you)` next to display name |
| Composer textarea | focus | `outline: 1px solid var(--vscode-focusBorder)` |
| Composer textarea | invalid (empty + send attempted) | shake animation 200ms (translateX ±4px); send remains disabled |
| Send button | enabled | normal button style |
| Send button | disabled (empty input) | grayed (see § 2.4) |
| Send button | sending (in-flight) | `$(loading~spin)` inside button, `disabled` true |
| Code block | hover | `$(copy)` icon appears top-right, click copies raw code; tooltip `"Copy code"` |
| Jump-to-bottom button | scrolled up + new msgs | floating pill at bottom-right of message list: `"↓ N new"`, `background: var(--vscode-button-background); color: var(--vscode-button-foreground)` |
| Reconnecting banner | `disconnected` or `reconnecting` event | full-width banner at top of message list: `background: var(--vscode-editorWarning-background); color: var(--vscode-editorWarning-foreground); padding: 8px 12px; font-size: calc(var(--vscode-font-size) - 1px)` — text per § 7 |
| Empty state | no messages in log | centered placeholder per § 7 |

### 3.4 Status bar

| State | Visual |
|-------|--------|
| No-impact flash | as § 2.5; no hover affordance |
| Unread badge present | hover tooltip → `"{N} unread message(s) — click to open chat"`; click → `versioncon.openChat` instead of `versioncon.showSidebar` |
| Unread badge zero | revert to existing tooltip |

When the unread badge is non-zero, the status bar item's `command` swaps from `versioncon.showSidebar` to `versioncon.openChat`. When it returns to zero, `command` reverts.

---

## 4. Theme Tokens (canonical list)

### 4.1 Colors — `vscode.ThemeColor` names (extension host) and `--vscode-*` CSS variables (webview)

> **Hard rule: no hex codes anywhere in this phase. Every color routes through these tokens.**

| Semantic role | ThemeColor name | CSS var |
|---------------|-----------------|---------|
| Default text | `foreground` | `--vscode-foreground` |
| Muted / secondary text | `descriptionForeground` | `--vscode-descriptionForeground` |
| Disabled / stale | `disabledForeground` | `--vscode-disabledForeground` |
| Success (no impact, my push) | `testing.iconPassed` | `--vscode-testing-iconPassed` |
| Info (remote push, no overlap) | `charts.blue` | `--vscode-charts-blue` |
| Warning (push affects me, branch divergence) | `editorWarning.foreground` | `--vscode-editorWarning-foreground` |
| Error (revert) | `errorForeground` | `--vscode-errorForeground` |
| Surface bg | n/a (host) | `--vscode-editor-background` |
| Panel bg (sidebar/webview chrome) | n/a (host) | `--vscode-sideBar-background` |
| List hover | `list.hoverBackground` (auto) | `--vscode-list-hoverBackground` |
| List selection | `list.activeSelectionBackground` (auto) | `--vscode-list-activeSelectionBackground` |
| Input bg | n/a | `--vscode-input-background` |
| Input border | n/a | `--vscode-input-border` |
| Input fg | n/a | `--vscode-input-foreground` |
| Focus ring | n/a | `--vscode-focusBorder` |
| Button bg / fg | n/a | `--vscode-button-background` / `--vscode-button-foreground` |
| Button secondary bg / fg | n/a | `--vscode-button-secondaryBackground` / `--vscode-button-secondaryForeground` |
| Code block bg | n/a | `--vscode-textCodeBlock-background` |
| Code text fg | n/a | `--vscode-textPreformat-foreground` |
| Block quote (system events) | n/a | `--vscode-textBlockQuote-background` / `--vscode-textBlockQuote-border` |
| Avatar palette (6 chart colors, hashed by memberId) | n/a | `--vscode-charts-{red,blue,yellow,orange,green,purple}` |
| Reconnecting banner bg/fg | n/a | `--vscode-editorWarning-background` / `--vscode-editorWarning-foreground` |
| Syntax: keyword | n/a | `--vscode-symbolIcon-keywordForeground` |
| Syntax: string | n/a | `--vscode-symbolIcon-stringForeground` |
| Syntax: number | n/a | `--vscode-symbolIcon-numberForeground` |
| Syntax: comment | n/a | `--vscode-symbolIcon-snippetForeground` |
| Syntax: function/title | n/a | `--vscode-symbolIcon-functionForeground` |
| Syntax: class/builtin | n/a | `--vscode-symbolIcon-classForeground` |
| Syntax: variable | n/a | `--vscode-symbolIcon-variableForeground` |
| Syntax: attr/property | n/a | `--vscode-symbolIcon-propertyForeground` |

Verification: when `vscode.window.activeColorTheme.kind` changes, the webview must NOT need to reload — all CSS uses `var(--vscode-*)` which VS Code re-injects automatically. Document this expectation in the planner's webview spec.

### 4.2 Codicons — `$(name)` in extension host, codicon CSS class in webview

| Semantic role | Codicon |
|---------------|---------|
| Member (presence) | `$(account)` |
| Branch divergence indicator | `$(git-compare)` |
| Push event | `$(arrow-up)` |
| Revert event | `$(discard)` |
| Branch-create event | `$(git-branch)` |
| Chat message / unread | `$(comment)` |
| Chat unread "bullet" prefix on sticky tree row | `$(circle-filled)` |
| No-impact flash | `$(check)` |
| Reconnecting / loading | `$(sync~spin)` (status bar) / `$(loading~spin)` (in-button) |
| Manage chat (header gear) | `$(gear)` |
| Paste code (composer) | `$(code)` |
| Copy (code block hover) | `$(copy)` |
| Jump-to-bottom badge | `$(arrow-down)` (rendered as Unicode `↓` in webview to avoid loading codicon font cost for one glyph; or use codicon class — planner picks) |
| Sync warning (Phase 3, mentioned for hierarchy only) | `$(warning)` |

The `@vscode/codicons` package must be bundled into the webview (locally — no CDN) so codicon font glyphs render under strict CSP.

### 4.3 Typography (webview)

VS Code's existing scale, no overrides:

| Role | Source |
|------|--------|
| Body / labels | `var(--vscode-font-family)` at `var(--vscode-font-size)` |
| Code | `var(--vscode-editor-font-family)` at `var(--vscode-editor-font-size)` |
| Secondary text (timestamps, hints) | same family, size = `calc(var(--vscode-font-size) - 1px)` |
| Smallest (keyboard hint, footer) | same family, size = `calc(var(--vscode-font-size) - 2px)` |
| Weights | only `400` (body) and `600` (display name + composer placeholder strong-emphasis); never `700` |
| Line height | `1.5` for body, `1.45` for code |

### 4.4 Spacing (webview internal)

VS Code does not expose a spacing CSS scale, so the chat webview declares its own. Multiples of 4 only.

| Token | Value | Usage |
|-------|-------|-------|
| `--gap-xs` | 4px | Inline icon gaps; intra-message-group rows |
| `--gap-sm` | 8px | Avatar↔body gap; message row inner padding |
| `--gap-md` | 12px | Inter-message vertical gap |
| `--gap-lg` | 16px | Header / composer outer padding |
| `--gap-xl` | 24px | Empty-state vertical rhythm |

No exceptions. TreeViews inherit VS Code's native row height — Phase 4 does not override.

---

## 5. Webview Chat Panel Layout

### 5.1 Structural skeleton

```
┌──────────────────────────────────────────────────────────────────────┐
│  HEADER (36px, sticky)                                               │
│  $(comment) feature-auth · 3 online                       $(gear)    │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  MESSAGE LIST (flex: 1; overflow-y: auto; padding: 16px 20px)        │
│   • System: "Bob pushed 3 file(s) — affects: src/api/users.ts"       │
│   • User msg: Alice · 2m ago — "Found a bug"                         │
│   • System: "You created branch 'fix-typo'"                          │
│   • ... (last 100 by default; older entries fetched on scroll-up?)   │
│                                                                      │
│                                          ┌──────────────┐            │
│                                          │ ↓ 3 new      │ (floating) │
│                                          └──────────────┘            │
├──────────────────────────────────────────────────────────────────────┤
│  COMPOSER (auto, max ~180px)                                         │
│  ┌────────────────────────────────────────────────┐ ┌───────┐        │
│  │ Type a message…                                │ │ Send  │        │
│  └────────────────────────────────────────────────┘ └───────┘        │
│  $(code) Paste code        Cmd/Ctrl + Enter to send                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 CSP

The webview's `Content-Security-Policy` meta tag (mirroring `SidebarProvider`'s pattern):

```
default-src 'none';
img-src ${webview.cspSource} data:;
style-src ${webview.cspSource} 'nonce-${nonce}';
font-src ${webview.cspSource};
script-src 'nonce-${nonce}';
```

Hard requirements:
- No `'unsafe-inline'` for scripts.
- No `https:` or `http:` sources — every JS/CSS/font/image loaded from `${webview.cspSource}` (extension's bundled assets).
- `markdown-it` and `highlight.js` must be **bundled into `dist/`** by esbuild — never loaded from CDN.
- The codicon font file must also be bundled and referenced via `font-src ${webview.cspSource}`.
- Markdown renderer config: `html: false` (escape inline HTML), `linkify: true` (auto-link URLs), `breaks: false` (single newline ≠ `<br>`).
- Links opened via webview→extension postMessage `open-external` with `vscode.env.openExternal`. Anchor `target="_blank"` is forbidden.

### 5.3 Unread badge behavior (webview ↔ extension protocol)

| Event | Effect |
|-------|--------|
| New chat message arrives, panel is `visible` and `active` | message appended; unread count stays at 0 |
| New chat message arrives, panel is hidden / not focused | extension increments unread count → `StatusBarManager.setUnreadCount(N)` → status bar shows `(comment) N`; activity tree adds/updates the sticky unread row |
| Panel becomes active (`webviewPanel.onDidChangeViewState` → `active=true`) | webview posts `chat-viewed`; extension sets unread to 0; clears sticky tree row; restores status bar `command` to `versioncon.showSidebar` |
| User scrolls within panel and reads | no per-message read tracking in v1 — focus = read-all |

State restore: when the panel becomes visible after being hidden, webview posts `webview-ready` and the extension replies with the full last-100 snapshot. The webview is stateless (matches Phase 1 pattern).

### 5.4 Auto-scroll rule

On `chat-message-received`:
- If the message list scroll position is within 80px of the bottom: smoothly scroll to bottom.
- Otherwise: do NOT scroll; show floating "↓ N new" pill (which clicking scrolls to bottom and dismisses).

### 5.5 Timestamp refresh

Every 30 seconds, the webview re-renders all visible timestamps from their absolute ISO ts in dataset. No layout shift (relative time strings have variable width but the timestamp slot has `min-width: 60px; text-align: right`).

---

## 6. Notification Copy (Authoritative Strings)

### 6.1 Toast — `vscode.window.showInformationMessage`

Locked in CONTEXT.md, restated for completeness.

| Scenario | Exact string |
|----------|--------------|
| One file overlap | `{name} pushed 1 file — affects: {fileBasename}: '{msg}'` |
| Two-to-three file overlap | `{name} pushed {N} file(s) — affects: {fileA}, {fileB}, {fileC}: '{msg}'` |
| More than three file overlap | `{name} pushed {N} file(s) — affects: {fileA}, {fileB}, +{N-2} more: '{msg}'` |
| Revert affects me | `{name} reverted {N} file(s) — restored: {fileA}, {fileB}: '{msg}'` |

If `msg` is empty, omit the trailing `: '{msg}'` entirely (don't render `: ''`).

### 6.2 Status bar

| Scenario | Exact string |
|----------|--------------|
| Connected, no unread | `$(circle-filled) VersionCon` (existing) |
| Connected, unread N | `$(circle-filled) VersionCon $(comment) {N}` |
| No-impact flash (5s) | `$(check) VersionCon — no impact ({N} file(s) unaffected)` |
| No-impact flash (single file) | `$(check) VersionCon — no impact (1 file unaffected)` |

### 6.3 Activity log labels

| Scenario | Exact string |
|----------|--------------|
| My push | `You pushed {N} file(s)` |
| Remote push, no overlap | `{name} pushed {N} file(s)` |
| Remote push, affects me | `{name} pushed {N} file(s) — affects you` |
| Revert (mine) | `You reverted {N} file(s)` |
| Revert (remote) | `{name} reverted {N} file(s)` |
| Branch create (mine) | `You created branch '{branchName}'` |
| Branch create (remote) | `{name} created branch '{branchName}'` |
| Unread chat sticky row | `$(circle-filled) {N} unread message(s)` |

Description (timestamp) format: relative — `"just now"` (<10s), `"{N}s ago"` (<60s), `"{N}m ago"` (<60m), `"{N}h ago"` (<24h), `"{N}d ago"` (≥24h).

### 6.4 QuickPick — `versioncon.manageChat`

```
Title:       VersionCon: Manage chat
Placeholder: Choose an action…

Items:
  1. $(eye-closed)    Clear my view
                      Hide existing messages from your panel only.
  2. $(trash)         Delete entire chat                       (host only)
                      Truncate chat-log.json. Affects everyone.
  3. $(history)       Truncate: keep last 100 + activity       (host only)
                      Removes old user messages, keeps push/revert/branch events.
  4. $(filter)        Truncate: keep only activity events      (host only)
                      Removes ALL user chat messages, keeps push/revert/branch events.
  5. $(export)        Export chat to file
                      Save your current view to .json or .md on your machine.
```

For non-host members, items 2-4 are still listed but rendered with `description: "(host only — disabled)"` and `alwaysShow: false` filtered out, OR shown with a `description` reading `"Only the host can run this"` and the picker rejects selection. Planner picks one approach — visual contract requires the **disabled-with-explanation** treatment so members understand why the option exists but isn't theirs.

### 6.5 Modal confirmations (destructive)

These use `vscode.window.showWarningMessage(message, { modal: true }, ...buttons)`.

| Action | Exact message | Detail | Buttons |
|--------|---------------|--------|---------|
| Delete entire chat | `Delete entire chat for everyone?` | `This permanently removes all chat messages and activity events from chat-log.json. Other members' panels will go blank. This cannot be undone.` | `Delete all` (destructive) / `Cancel` |
| Truncate keep-100 | `Truncate chat to last 100 messages?` | `Older user messages will be removed for everyone. Push, revert, and branch-create events will be kept.` | `Truncate` / `Cancel` |
| Truncate keep-only-activity | `Remove all user chat messages?` | `Every user message will be removed for everyone. Push, revert, and branch-create events will be kept.` | `Remove messages` / `Cancel` |
| Clear my view | `Clear chat from your view?` | `This hides existing messages from your panel only. Other members are not affected. Future messages will continue to appear.` | `Clear my view` / `Cancel` |
| Export | (no confirm — opens save dialog directly) | n/a | n/a |

All destructive button labels are positive verbs (e.g. `Delete all`, never `OK`). Cancel is always the second button so Escape cancels by default.

---

## 7. Empty / Loading / Error / Reconnecting States

### 7.1 Presence panel

| State | Treatment |
|-------|-----------|
| Not connected | `viewsWelcome`: `"Not connected.\nHost or join a session to see who's online."` with link to `versioncon.hostSession` and `versioncon.joinSession` |
| Connected, alone | `viewsWelcome`: `"You're the only one here.\nShare your session to invite teammates."` with link to `versioncon.showSidebar` |
| Connected, others present | normal tree |

### 7.2 Activity log

| State | Treatment |
|-------|-----------|
| Not connected | `viewsWelcome`: `"Not connected.\nActivity from your team will appear here once you're in a session."` |
| Connected, no events yet | `viewsWelcome`: `"No activity yet.\nPushes, reverts, and new branches show up here as your team works."` |
| Connected, with events | normal tree |

### 7.3 Chat panel

| State | Treatment |
|-------|-----------|
| First open, no messages in log | Centered card: `$(comment-discussion)` icon (48px), heading `"Start the conversation"`, body `"Send the first message in #{branchName}. Pushes, reverts, and branch events will also appear here automatically."`. Composer is enabled and focused. |
| First open, log has messages | Render messages, scroll to bottom. |
| Reconnecting (transport) | Top banner: `"$(sync~spin) Reconnecting to session…"`. Composer disabled with placeholder `"Reconnecting…"`. Send button disabled. |
| Disconnected | Top banner: `"$(error) Disconnected. Messages won't send until you reconnect."`. Composer disabled with placeholder `"Disconnected — your message won't send"`. Send button disabled. |
| Send in flight | Send button shows `$(loading~spin)`. On failure: textarea content is preserved; banner shows `"$(error) Couldn't send your last message. Reconnecting will retry."` for 4s. |
| Chat-cleared event from host | Snap to empty state with explanatory toast `"{hostName} cleared the chat for everyone."` (informational toast, no buttons). |
| Chat-truncated event from host | Snap to truncated view with toast `"{hostName} truncated the chat ({mode})."` where `{mode}` is `"keeping last 100 + activity"` or `"keeping activity only"`. |

### 7.4 Status bar

No empty state — status bar is always present (NET-05). Phase 4 only adds transient overlays.

---

## 8. Accessibility

### 8.1 Keyboard reachability (extension host)

Every Phase 4 command is a registered VS Code command — therefore reachable via the Command Palette (`Cmd/Ctrl + Shift + P`). New commands to register in `package.json`:

| Command id | Title | Reachable via |
|------------|-------|---------------|
| `versioncon.openChat` | `VersionCon: Open Chat` | palette + activity tree click + status bar click (when unread) |
| `versioncon.manageChat` | `VersionCon: Manage Chat` | palette + chat panel header gear + chat panel context menu |
| `versioncon.refreshActivityLog` | `Refresh` (icon `$(refresh)`) | activity log view title — `viewsWelcome` |
| `versioncon.refreshPresence` | `Refresh` (icon `$(refresh)`) | presence view title |

No new keybindings shipped in Phase 4 — palette + view title icons are sufficient. (Avoid stepping on user/system bindings without a strong reason.)

### 8.2 Keyboard reachability (webview)

| Action | Key |
|--------|-----|
| Send message | `Cmd/Ctrl + Enter` while composer focused |
| Insert newline in composer | `Enter` (default textarea) |
| Open Manage Chat | `Tab` to header gear icon, then `Enter` |
| Copy code block | `Tab` to code block, then `Enter` (synthesizes copy click); or click the hover `$(copy)` icon with mouse |
| Jump to bottom | when "↓ N new" pill is visible: `Tab` to it, then `Enter` |
| Focus composer from anywhere | `Cmd/Ctrl + L` (custom binding inside the webview only, no global VS Code keybinding) |

Tab order (top to bottom, left to right): header gear → message list (each focusable item is the message row, with code blocks reachable via `Tab` within) → jump-to-bottom pill (if visible) → composer textarea → "Paste code" button → Send button. `aria-label` on every interactive element.

### 8.3 Screen reader

| Element | `aria-` |
|---------|---------|
| Message row | `role="article" aria-label="{name} {relativeTime}: {plain-text body}"` |
| System event row | `role="status"` (live but not assertive) |
| New-message arrival, panel hidden | extension surfaces toast → screen reader announces toast text via VS Code's normal a11y path |
| Reconnecting banner | `role="status" aria-live="polite"` |
| Disconnected banner | `role="alert" aria-live="assertive"` |
| Composer textarea | `aria-label="Compose chat message in {branch}"`, `aria-describedby` pointing to the keyboard hint |
| Send button | `aria-label="Send message"`; when disabled: `aria-disabled="true"` |
| Code block | `aria-label="Code block, language: {lang}"`, copy button `aria-label="Copy code"` |
| Avatar | `aria-hidden="true"` (decorative; the name next to it is what matters) |

### 8.4 Contrast

All colors pull from VS Code theme tokens — VS Code's published themes (Light+, Dark+, High Contrast) already meet WCAG AA. Phase 4 must NOT introduce custom colors; therefore contrast is inherited. Verification step in the planner's UAT: visually inspect the chat panel under Dark+, Light+, and High Contrast Dark. The avatar palette (chart colors) is the one risk area — confirm `--vscode-charts-{color}` foreground (`--vscode-editor-background`) maintains ≥3:1 contrast in High Contrast themes; if not, replace avatar background with `--vscode-button-background` for all members and use a single foreground.

### 8.5 Motion

| Animation | Duration | Respects `prefers-reduced-motion`? |
|-----------|----------|-------------------------------------|
| Auto-scroll on new message | 200ms ease-out | yes — instant scroll if reduced |
| Shake on empty send | 200ms | yes — disabled if reduced |
| Spinner (`$(sync~spin)` / `$(loading~spin)`) | continuous | VS Code's built-in; uses CSS animation; respects platform |
| Status bar 5s no-impact flash | static (text swap, no animation) | n/a |

`@media (prefers-reduced-motion: reduce)` in the webview CSS overrides the two custom animations.

---

## 9. Required `package.json` Additions

For planner reference (not the contract itself, but the visual surfaces require these contributions to exist):

| Section | Addition |
|---------|----------|
| `views.versioncon` | append `{ id: "versioncon.presence", name: "Presence" }` and `{ id: "versioncon.activityLog", name: "Activity" }` |
| `commands` | `versioncon.openChat`, `versioncon.manageChat`, `versioncon.refreshActivityLog`, `versioncon.refreshPresence` |
| `menus.view/title` | refresh icons for the two new tree views; `$(gear)` opening `versioncon.manageChat` on the activity log |
| `viewsWelcome` | content for `versioncon.presence` and `versioncon.activityLog` per § 7 |

---

## 10. Out of Scope / Deferred

Explicit non-goals for Phase 4 — the checker and planner must reject any addition in these areas:

- **AI-driven chat summarization UI** — deferred to Phase 8 (MCP). Phase 4 ships chat-log.json persistence; no UI affordance for "summarize" exists in this phase.
- **AFK / online-vs-active indicator on presence panel** — no heartbeat in v1. A member in the panel might have closed their laptop 10 minutes ago; the panel does not signal that. Locked in CONTEXT.md.
- **Inline review comment authoring** — Phase 6 owns the authoring UI. Phase 4 will display review-event system messages once Phase 6 emits them, but renders nothing comment-specific in v1.
- **Symbol-level / dependency-aware conflict messages** — Phase 5 upgrades the toast text from file-level to symbol-level. Phase 4's toast is intentionally file-only.
- **Status filter chips on activity tree** ("only pushes", "only chat") — locked deferred in CONTEXT.md.
- **Cross-branch / global chat** — chat is per-branch (`.versioncon/branches/<branch>/chat-log.json`). v2 idea.
- **Chat search** — JSON export covers the base case; richer search is v2.
- **Custom keybindings** — Phase 4 ships zero new VS Code keybindings; everything is palette-reachable.
- **Per-user typing indicator** — out of scope (no protocol message for it; v2 if requested).
- **Chat read receipts (per-message)** — not tracked. Focus = read-all.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (VS Code extension — no shadcn/web framework) |
| Preset | not applicable |
| Component library | native VS Code: `TreeView`, `WebviewPanel`, `WebviewView`, `StatusBarItem`, `showInformationMessage`, `showWarningMessage`, `showQuickPick` |
| Icon library | VS Code Codicons (`$(name)` syntax + bundled `@vscode/codicons` font for webview) |
| Font | inherits from VS Code: `var(--vscode-font-family)` (UI), `var(--vscode-editor-font-family)` (code) |
| Markdown renderer (chat) | `markdown-it` (bundled, html: false, linkify: true, breaks: false) |
| Syntax highlighter (chat) | `highlight.js` (bundled locally, mapped to VS Code symbol theme tokens via CSS shim — never raw hex) |

---

## Spacing Scale

Multiples of 4 only. Applies to webview internals (TreeViews inherit native row metrics).

| Token | Value | Usage |
|-------|-------|-------|
| `--gap-xs` | 4px | Inline icon gaps; intra-message-group rows |
| `--gap-sm` | 8px | Avatar↔body gap; row inner padding |
| `--gap-md` | 12px | Inter-message vertical gap; row outer padding |
| `--gap-lg` | 16px | Panel header / composer outer padding |
| `--gap-xl` | 20px | Message list horizontal padding |
| `--gap-2xl` | 24px | Empty-state vertical rhythm |

Exceptions: avatar disc is 32×32 (intrinsic, not a spacing token); header is 36px tall (matches VS Code panel header convention).

---

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body / message text | `var(--vscode-font-size)` (typically 13px) | 400 | 1.5 |
| Display name / strong emphasis | `var(--vscode-font-size)` | 600 | 1.5 |
| Code (block + inline) | `var(--vscode-editor-font-size)` (typically 14px monospace) | 400 | 1.45 |
| Secondary text (timestamps, hints) | `calc(var(--vscode-font-size) - 1px)` | 400 | 1.4 |
| Smallest (keyboard hint) | `calc(var(--vscode-font-size) - 2px)` | 400 | 1.4 |

Two weights only: 400 + 600. No `700`, no italic except for muted system events (`font-style: italic` on system event row only).

---

## Color

Phase 4 does NOT define a custom palette. Every color routes through `vscode.ThemeColor` (host) or `var(--vscode-*)` (webview) — see § 4.1 for the canonical list of 30+ tokens used.

Conceptual 60/30/10 mapping (for the checker):

| Role | Token | Usage |
|------|-------|-------|
| Dominant (60%) | `--vscode-editor-background` / `--vscode-sideBar-background` | All chat + sidebar backgrounds |
| Secondary (30%) | `--vscode-foreground` + `--vscode-descriptionForeground` | All text (primary + muted) |
| Accent (10%) | `--vscode-charts-blue` (info), `--vscode-testing-iconPassed` (success), `--vscode-editorWarning-foreground` (warning), `--vscode-errorForeground` (destructive) | Activity tree event icons; status bar overrides; reconnecting banner; revert events; affects-you indicator |
| Destructive | `--vscode-errorForeground` | Revert event icon only — destructive *button* labels use the standard `--vscode-button-background` since VS Code's modal `showWarningMessage` renders its own destructive treatment |

Accent reserved for: activity-tree event icons (push/revert/branch/chat), the 5-second status bar no-impact flash, branch-divergence indicator on presence rows, reconnecting/disconnected banners, and the unread chat status-bar badge. **Not** used for default foreground text, default backgrounds, hover states, or composer chrome.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA (chat) | `Send` (button label); keyboard hint: `Cmd/Ctrl + Enter to send` |
| Secondary CTA (chat) | `$(code) Paste code` |
| Empty state heading (chat, first open) | `Start the conversation` |
| Empty state body (chat, first open) | `Send the first message in #{branchName}. Pushes, reverts, and branch events will also appear here automatically.` |
| Empty state heading (presence, alone) | `You're the only one here.` |
| Empty state body (presence, alone) | `Share your session to invite teammates.` |
| Empty state heading (activity, no events) | `No activity yet.` |
| Empty state body (activity, no events) | `Pushes, reverts, and new branches show up here as your team works.` |
| Reconnecting banner (chat) | `$(sync~spin) Reconnecting to session…` |
| Disconnected banner (chat) | `$(error) Disconnected. Messages won't send until you reconnect.` |
| Send-failed banner (chat, 4s) | `$(error) Couldn't send your last message. Reconnecting will retry.` |
| Toast (1 file overlap) | `{name} pushed 1 file — affects: {fileBasename}: '{msg}'` |
| Toast (2-3 file overlap) | `{name} pushed {N} file(s) — affects: {fileA}, {fileB}, {fileC}: '{msg}'` |
| Toast (>3 file overlap) | `{name} pushed {N} file(s) — affects: {fileA}, {fileB}, +{N-2} more: '{msg}'` |
| No-impact flash | `$(check) VersionCon — no impact ({N} file(s) unaffected)` |
| Status bar unread | `$(circle-filled) VersionCon $(comment) {N}` |
| Activity: my push | `You pushed {N} file(s)` |
| Activity: remote push, no overlap | `{name} pushed {N} file(s)` |
| Activity: remote push, affects me | `{name} pushed {N} file(s) — affects you` |
| Activity: revert (mine) | `You reverted {N} file(s)` |
| Activity: revert (remote) | `{name} reverted {N} file(s)` |
| Activity: branch create (mine) | `You created branch '{branchName}'` |
| Activity: branch create (remote) | `{name} created branch '{branchName}'` |
| Activity: unread chat sticky | `$(circle-filled) {N} unread message(s)` |
| QuickPick title (manage chat) | `VersionCon: Manage chat` |
| QuickPick placeholder | `Choose an action…` |
| Destructive: delete all (button) | `Delete all` |
| Destructive: delete all (message) | `Delete entire chat for everyone?` |
| Destructive: delete all (detail) | `This permanently removes all chat messages and activity events from chat-log.json. Other members' panels will go blank. This cannot be undone.` |
| Destructive: truncate-100 (button) | `Truncate` |
| Destructive: truncate-100 (message) | `Truncate chat to last 100 messages?` |
| Destructive: truncate-100 (detail) | `Older user messages will be removed for everyone. Push, revert, and branch-create events will be kept.` |
| Destructive: truncate-activity-only (button) | `Remove messages` |
| Destructive: truncate-activity-only (message) | `Remove all user chat messages?` |
| Destructive: truncate-activity-only (detail) | `Every user message will be removed for everyone. Push, revert, and branch-create events will be kept.` |
| Soft confirm: clear my view (button) | `Clear my view` |
| Soft confirm: clear my view (message) | `Clear chat from your view?` |
| Soft confirm: clear my view (detail) | `This hides existing messages from your panel only. Other members are not affected. Future messages will continue to appear.` |
| Info toast: chat cleared by host | `{hostName} cleared the chat for everyone.` |
| Info toast: chat truncated by host (keep-100) | `{hostName} truncated the chat (keeping last 100 + activity).` |
| Info toast: chat truncated by host (activity-only) | `{hostName} truncated the chat (keeping activity only).` |

Every destructive button uses a positive verb naming the action (`Delete all`, `Truncate`, `Remove messages`) — never `OK` or `Yes`. Cancel is always second so `Esc` cancels.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | not applicable (no web framework) | not required |
| Third-party registries | none | not applicable |

Phase 4 introduces three runtime libraries; all are bundled locally by esbuild — none load remote code at runtime:

| Library | Purpose | Bundling |
|---------|---------|----------|
| `markdown-it` | render markdown in chat webview | bundled to `dist/webview/chat.js` via esbuild |
| `highlight.js` | syntax-highlight code blocks; `core` build + only the languages we ship support for | bundled — no CDN |
| `@vscode/codicons` | codicon font for webview (extension host already has codicons natively) | bundled font + CSS to `dist/webview/codicon/` |

Locked: **never use `shiki`** for chat highlighting (CONTEXT.md decision — bundle size).

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending

---

## Source Map (for traceability)

| Field | Source |
|-------|--------|
| Toast format | CONTEXT.md `<specifics>` (locked) |
| Green flash format | CONTEXT.md `<specifics>` (locked) |
| Activity tree icon set | CONTEXT.md `<specifics>` (locked) |
| Chat lib choice (markdown-it + highlight.js) | CONTEXT.md `<decisions>` "Code snippet rendering in chat" (locked) |
| Five chat-control commands | CONTEXT.md `<decisions>` "Chat user controls" (locked) |
| Presence cadence (on activeEditor change) | CONTEXT.md `<decisions>` "Presence broadcast cadence" (locked) |
| Persistence file path | CONTEXT.md `<decisions>` "Chat persistence" (locked) |
| 100-message replay window | CONTEXT.md `<decisions>` (locked) |
| AFK / heartbeat OUT of scope | CONTEXT.md `<deferred>` (locked) |
| AI summarization OUT of scope | CONTEXT.md `<deferred>` + ROADMAP Phase 8 |
| Inline review authoring OUT of scope | CONTEXT.md `<deferred>` + ROADMAP Phase 6 |
| Status bar pattern (text+codicon+ThemeColor) | `src/ui/StatusBarManager.ts` (existing pattern mirrored) |
| Webview CSP + nonce pattern | `src/ui/SidebarProvider.ts` (existing pattern mirrored) |
| TreeDataProvider pattern | `src/ui/BranchListProvider.ts` (existing pattern mirrored) |
| Color tokens chosen | derived from existing `StatusBarManager` choices (`testing.iconPassed`, `editorWarning.foreground`, `disabledForeground`) extended with `errorForeground`, `charts.blue`, `descriptionForeground` for new event types |
| Codicon names | researcher selection from VS Code's published Codicon catalog, validated against existing usages in the codebase (`$(arrow-up)`, `$(discard)`, `$(git-branch)`, `$(comment)`, `$(check)`, `$(warning)`, `$(sync~spin)` already in use) |
| Empty-state copy | researcher draft following project tone (instructional, second-person, points to next action) |
| Modal copy | researcher draft following Phase 3 destructive-confirm pattern (verb buttons, plain-language detail, "cannot be undone" where true) |
