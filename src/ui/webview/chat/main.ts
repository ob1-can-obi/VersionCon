/**
 * Chat webview entry. Runs inside the WebviewPanel iframe (browser context).
 *
 * NO Node APIs — only browser globals + bundled libs. esbuild bundles markdown-it
 * and highlight.js (lib/core + selective registerLanguage) into dist/webview/chat/main.js.
 *
 * Strict CSP per UI-SPEC §5.2:
 *   default-src 'none'; img-src cspSource data:; style-src cspSource 'nonce-X';
 *   font-src cspSource; script-src 'nonce-X';
 * — no inline scripts, no CDN, no remote fonts.
 *
 * Wire protocol with extension host:
 *   webview → ext: webview-ready, send-chat, chat-viewed, manage-chat,
 *                  open-external, copy-code
 *   ext → webview: state-update, chat-message-received, chat-cleared, chat-truncated
 *
 * State model: webview is stateless. On mount, post 'webview-ready'; the extension
 * responds with a full state-update snapshot (records + selfId + branch + status).
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';

// --- Highlight.js language registration (Plan 04-10 supports 7 languages) ---
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);

// --- Markdown-it config (Edge case 7 in RESEARCH; T-04-10-01 mitigation) ---
// html: false       -> raw <script>, <img onerror>, etc. are escaped (XSS gate)
// linkify: true     -> bare URLs auto-link
// breaks: false     -> single newline does NOT become <br>
// highlight callback wraps fenced code blocks with hljs-highlighted spans;
// emits CLASS-only output (no inline styles) so CSS shim controls colors.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch (_) {
        // Fall through to escaped raw code on highlight failure.
      }
    }
    return escapeHtml(code);
  },
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

// --- Types (mirror src/types/chat.ts to keep this file standalone) ---
interface ChatRecord {
  id: string;
  kind: 'user' | 'system';
  subKind?: 'push' | 'revert' | 'branch-created';
  memberId: string;
  memberDisplayName: string;
  body: string;
  timestamp: number;
  meta?: {
    pushId?: string;
    branch?: string;
    files?: string[];
    affectsLocal?: boolean;
  };
}

interface ChatState {
  records: ChatRecord[];
  selfId: string;
  branch: string;
  memberCount: number;
  chatHiddenBefore: number | null;
  connectionStatus: 'connected' | 'reconnecting' | 'disconnected';
  unread: number;
}

let state: ChatState | null = null;

// VS Code webview API. Cast through `any` because the browser-side type
// declarations live in @types/vscode-webview which we don't add for one
// function. Equivalent guard pattern is used throughout the codebase.
interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode: VsCodeApi = (typeof acquireVsCodeApi === 'function')
  ? acquireVsCodeApi()
  : { postMessage: () => { /* no-op fallback for non-webview previews */ } };

// --- DOMContentLoaded boot ---
window.addEventListener('DOMContentLoaded', () => {
  vscode.postMessage({ type: 'webview-ready' });
  wireComposer();
  wireHeaderGear();
  wireMessageListClicks();
});

// --- Inbound message dispatcher (extension → webview) ---
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch ((msg as { type?: unknown }).type) {
    case 'state-update':
      state = (msg as { payload: ChatState }).payload;
      renderHeader();
      renderAll();
      applyConnectionBanner();
      break;
    case 'chat-message-received': {
      const record = (msg as { payload: ChatRecord }).payload;
      if (state) {
        state.records.push(record);
        appendOne(record);
      }
      break;
    }
    case 'chat-cleared':
      if (state) state.records = [];
      renderAll();
      break;
    case 'chat-truncated':
      // Extension follows up with a fresh state-update; clear in the interim
      // so the panel doesn't render stale records the host has already pruned.
      if (state) state.records = [];
      renderAll();
      break;
  }
});

function renderHeader(): void {
  if (!state) return;
  const titleEl = document.querySelector('.header-title');
  if (!titleEl) return;
  const onlineSuffix = state.memberCount > 0
    ? ` · ${state.memberCount} online`
    : '';
  titleEl.textContent = `#${state.branch}${onlineSuffix}`;
}

function renderAll(): void {
  if (!state) return;
  const list = document.getElementById('message-list');
  if (!list) return;
  list.innerHTML = '';
  const visible = state.chatHiddenBefore != null
    ? state.records.filter((r) => r.timestamp >= (state!.chatHiddenBefore as number))
    : state.records;
  if (visible.length === 0) {
    renderEmptyState(list);
    return;
  }
  for (const r of visible) appendOne(r, /* skipScroll */ true);
  // After bulk render, jump to bottom (UI-SPEC §5.4 default behavior on
  // first open / panel reveal).
  list.scrollTop = list.scrollHeight;
}

function renderEmptyState(list: HTMLElement): void {
  if (!state) return;
  const card = document.createElement('div');
  card.className = 'empty-state';
  card.innerHTML =
    `<span class="codicon codicon-comment-discussion empty-icon" aria-hidden="true"></span>` +
    `<h2 class="empty-heading">Start the conversation</h2>` +
    `<p class="empty-body">` +
    `Send the first message in #${escapeHtml(state.branch)}. ` +
    `Pushes, reverts, and branch events will also appear here automatically.` +
    `</p>`;
  list.appendChild(card);
}

function appendOne(record: ChatRecord, skipScroll = false): void {
  const list = document.getElementById('message-list');
  if (!list) return;
  // Strip empty-state card if present before appending the first real row.
  const existingEmpty = list.querySelector('.empty-state');
  if (existingEmpty) existingEmpty.remove();
  const wasNearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
  const row = record.kind === 'system' ? renderSystemRow(record) : renderUserRow(record);
  list.appendChild(row);
  if (!skipScroll && wasNearBottom) {
    list.scrollTop = list.scrollHeight;
  }
}

function renderUserRow(r: ChatRecord): HTMLElement {
  const row = document.createElement('article');
  row.className = 'msg-row msg-user';
  row.setAttribute('role', 'article');
  row.setAttribute('aria-label', `${r.memberDisplayName}: ${r.body}`);
  const isSelf = state?.selfId === r.memberId;
  const avatarChar = (r.memberDisplayName[0] || '?').toUpperCase();
  // markdown-it + html: false escapes embedded HTML in `body`. The other
  // user-controlled fields (memberDisplayName, avatarChar) flow through
  // escapeHtml before reaching innerHTML.
  row.innerHTML =
    `<div class="avatar" aria-hidden="true">${escapeHtml(avatarChar)}</div>` +
    `<div class="msg-content">` +
      `<div class="msg-meta">` +
        `<span class="author">${escapeHtml(r.memberDisplayName)}` +
          (isSelf ? ' <span class="you">(you)</span>' : '') +
        `</span>` +
        `<span class="ts" data-ts="${r.timestamp}">${formatRelativeTime(r.timestamp)}</span>` +
      `</div>` +
      `<div class="body">${md.render(r.body)}</div>` +
    `</div>`;
  return row;
}

function renderSystemRow(r: ChatRecord): HTMLElement {
  const row = document.createElement('div');
  row.className = 'msg-row msg-system';
  row.setAttribute('role', 'status');
  const iconClass = r.subKind === 'revert'
    ? 'discard'
    : r.subKind === 'branch-created'
      ? 'git-branch'
      : 'arrow-up';  // 'push' default
  row.innerHTML =
    `<span class="codicon codicon-${iconClass}" aria-hidden="true"></span> ` +
    `<span class="sys-text">${escapeHtml(r.body)}</span> ` +
    `<span class="ts" data-ts="${r.timestamp}">${formatRelativeTime(r.timestamp)}</span>`;
  return row;
}

/**
 * UI-SPEC §6.3 relative time format. Exported on `window` for testability —
 * the same formatter is duplicated in src/test/suite/chatRender.test.ts because
 * importing browser modules in Node tests is not supported by the existing
 * vscode-test harness.
 */
function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function applyConnectionBanner(): void {
  const recon = document.querySelector('.banner-reconnecting') as HTMLElement | null;
  const disc = document.querySelector('.banner-disconnected') as HTMLElement | null;
  const send = document.getElementById('send-button') as HTMLButtonElement | null;
  const composer = document.getElementById('composer') as HTMLTextAreaElement | null;
  if (!recon || !disc || !send || !composer) return;
  recon.hidden = state?.connectionStatus !== 'reconnecting';
  disc.hidden = state?.connectionStatus !== 'disconnected';
  if (state?.connectionStatus !== 'connected') {
    composer.disabled = true;
    composer.placeholder = state?.connectionStatus === 'disconnected'
      ? "Disconnected — your message won't send"
      : 'Reconnecting…';
    send.disabled = true;
  } else {
    composer.disabled = false;
    composer.placeholder = 'Type a message…';
    send.disabled = composer.value.trim().length === 0;
  }
}

function wireComposer(): void {
  const composer = document.getElementById('composer') as HTMLTextAreaElement | null;
  const send = document.getElementById('send-button') as HTMLButtonElement | null;
  const pasteCode = document.querySelector('.paste-code') as HTMLButtonElement | null;
  if (!composer || !send) return;

  composer.addEventListener('input', () => {
    send.disabled = composer.value.trim().length === 0;
    composer.style.height = 'auto';
    composer.style.height = Math.min(144, composer.scrollHeight) + 'px';
  });

  composer.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      doSend();
    }
  });

  send.addEventListener('click', doSend);

  pasteCode?.addEventListener('click', () => {
    // UI-SPEC §2.4: insert ```ts\n\n``` and place cursor inside.
    const start = composer.selectionStart ?? composer.value.length;
    const end = composer.selectionEnd ?? composer.value.length;
    const before = composer.value.slice(0, start);
    const selected = composer.value.slice(start, end);
    const after = composer.value.slice(end);
    const fence = selected.length > 0
      ? '```ts\n' + selected + '\n```'
      : '```ts\n\n```';
    composer.value = before + fence + after;
    const cursorPos = before.length + (selected.length > 0
      ? fence.length            // place cursor at end of fenced block
      : '```ts\n'.length);       // place cursor inside empty fence
    composer.selectionStart = composer.selectionEnd = cursorPos;
    composer.dispatchEvent(new Event('input'));
    composer.focus();
  });

  function doSend(): void {
    if (!composer || !send) return;
    const body = composer.value.trim();
    if (!body) return;
    vscode.postMessage({ type: 'send-chat', payload: { body } });
    composer.value = '';
    composer.style.height = 'auto';
    send.disabled = true;
  }
}

function wireHeaderGear(): void {
  document.querySelector('.header-gear')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'manage-chat' });
  });
}

function wireMessageListClicks(): void {
  document.getElementById('message-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // External link → route through extension so VS Code's safety prompt fires.
    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (anchor && anchor.href) {
      e.preventDefault();
      vscode.postMessage({ type: 'open-external', payload: { url: anchor.href } });
    }
  });
}

// --- Timestamp refresh (UI-SPEC §5.5: every 30s) ---
setInterval(() => {
  document.querySelectorAll('.ts').forEach((el) => {
    const tsAttr = (el as HTMLElement).dataset.ts;
    if (!tsAttr) return;
    const ts = Number(tsAttr);
    if (!Number.isFinite(ts)) return;
    el.textContent = formatRelativeTime(ts);
  });
}, 30000);
