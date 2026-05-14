/**
 * Phase 6 Plan 06-04 — Review webview entry.
 *
 * Runs inside the WebviewPanel iframe (browser context). NO Node APIs — only
 * browser globals + bundled libs. esbuild bundles markdown-it into
 * dist/webview/review/main.js.
 *
 * Strict CSP per UI-SPEC §5.2 (same shape as Plan 04-10 chat panel):
 *   default-src 'none'; img-src cspSource data:; style-src cspSource 'nonce-X';
 *   font-src cspSource; script-src 'nonce-X';
 * — no inline scripts, no CDN, no remote fonts.
 *
 * Wire protocol with extension host:
 *   webview → ext: webview-ready, open-file-diff, review-vote-submit,
 *                  review-comment-submit, review-resolve-submit
 *   ext → webview: state (review/push/selfMemberId/hostMemberId snapshot)
 *
 * State model: stateless. On mount, post 'webview-ready'; the extension
 * responds with a full {type:'state', ...} payload that triggers a full
 * re-render. Every subsequent host event (review-opened/comment/vote/resolved)
 * triggers another 'state' message; the webview re-renders from the new
 * snapshot.
 *
 * T-06-02 mitigation: markdown-it `html: false` config is DUPLICATED from the
 * chat webview's main.ts. The duplication is intentional (extracting a shared
 * module is a future refactor) and pinned by a source-grep test in
 * reviewPanel.test.ts asserting `html: false` appears in BOTH webview
 * entries so silent drift breaks the build.
 */

import MarkdownIt from 'markdown-it';

// --- Markdown-it config (T-06-02 mitigation) ---
// html: false       -> raw <script>, <img onerror>, etc. are escaped (XSS gate)
// linkify: true     -> bare URLs auto-link
// breaks: false     -> single newline does NOT become <br>
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};
const vscode = acquireVsCodeApi();

// --- Types (mirror src/types/review.ts + src/types/push.ts) ---

interface ReviewVoteRecordShape {
  reviewerMemberId: string;
  reviewerDisplayName: string;
  vote: 'approved' | 'changes-requested' | 'commented';
  votedAt: number;
}

interface ReviewCommentShape {
  id: string;
  reviewId: string;
  authorMemberId: string;
  authorDisplayName: string;
  filePath: string;
  line: number;
  body: string;
  createdAt: number;
}

interface ReviewRequestShape {
  id: string;
  pushId: string;
  branch: string;
  authorMemberId: string;
  authorDisplayName: string;
  openedAt: number;
  status: 'open' | 'approved' | 'changes-requested' | 'resolved' | 'abandoned';
  votes: ReviewVoteRecordShape[];
  comments: ReviewCommentShape[];
  resolvedAt?: number;
  resolvedBy?: string;
  resolvedReason?: 'merged' | 'abandoned';
}

interface PushFileEntryShape {
  relativePath: string;
  status: 'added' | 'modified' | 'deleted';
  addedLines: number;
  removedLines: number;
}

interface PushRecordShape {
  id: string;
  memberId: string;
  memberDisplayName: string;
  message: string;
  branch: string;
  files: PushFileEntryShape[];
  timestamp: number;
}

interface ReviewStateMessage {
  type: 'state';
  review: ReviewRequestShape | null;
  push: PushRecordShape | null;
  selfMemberId: string;
  hostMemberId: string;
}

let state: {
  review: ReviewRequestShape | null;
  push: PushRecordShape | null;
  selfMemberId: string;
  hostMemberId: string;
} = { review: null, push: null, selfMemberId: '', hostMemberId: '' };

// --- Inbound message listener ---
window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { type?: string } | null;
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'state') {
    const sm = m as ReviewStateMessage;
    state = {
      review: sm.review,
      push: sm.push,
      selfMemberId: typeof sm.selfMemberId === 'string' ? sm.selfMemberId : '',
      hostMemberId: typeof sm.hostMemberId === 'string' ? sm.hostMemberId : '',
    };
    render();
  }
});

// --- Helpers ---

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (k === 'class') {
        node.className = attrs[k];
      } else if (k === 'data-action') {
        node.setAttribute('data-action', attrs[k]);
      } else if (k === 'data-arg') {
        node.setAttribute('data-arg', attrs[k]);
      } else {
        node.setAttribute(k, attrs[k]);
      }
    }
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTimestamp(ts: number): string {
  if (!ts || typeof ts !== 'number') return '';
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return '';
  }
}

// --- Render ---

function render(): void {
  renderHeader();
  renderFiles();
  renderVotes();
  renderComments();
  renderVoteBar();
  renderResolveBar();
  renderEmpty();
}

function renderHeader(): void {
  const title = $('review-title');
  const badge = $('review-status-badge');
  const meta = $('review-meta');
  if (!title || !badge || !meta) return;

  if (!state.review) {
    title.textContent = 'Review';
    badge.textContent = '—';
    badge.className = 'status-badge status-open';
    meta.textContent = '';
    return;
  }
  const r = state.review;
  const shortPush = (r.pushId || '').substring(0, 7);
  title.textContent = `Review · push ${shortPush}`;
  badge.textContent = r.status;
  badge.className = `status-badge status-${r.status}`;
  meta.textContent = `Opened by ${r.authorDisplayName} on ${formatTimestamp(r.openedAt)} (branch: ${r.branch})`;
}

function renderFiles(): void {
  const list = $('review-file-list');
  const count = $('review-file-count');
  if (!list || !count) return;
  list.innerHTML = '';
  const files = state.push?.files ?? [];
  count.textContent = String(files.length);
  if (files.length === 0) {
    const li = el('li', { class: 'review-empty' }, 'No files in this push.');
    list.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = el('li', { class: 'review-file-row', role: 'button', tabindex: '0' });
    const pathSpan = el('span', { class: 'file-path' });
    // textContent is the right call (defense-in-depth) — file paths come from
    // PushRecord (host-trusted) but we keep DOM injection out anyway.
    pathSpan.textContent = f.relativePath;
    const statusSpan = el('span', { class: `file-status file-status-${f.status}` });
    statusSpan.textContent = `${f.status} +${f.addedLines} -${f.removedLines}`;
    li.appendChild(pathSpan);
    li.appendChild(statusSpan);
    li.addEventListener('click', () => {
      vscode.postMessage({ type: 'open-file-diff', filePath: f.relativePath });
    });
    li.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        vscode.postMessage({ type: 'open-file-diff', filePath: f.relativePath });
      }
    });
    list.appendChild(li);
  }
}

function renderVotes(): void {
  const list = $('review-vote-list');
  const count = $('review-vote-count');
  if (!list || !count) return;
  list.innerHTML = '';
  const votes = state.review?.votes ?? [];
  count.textContent = String(votes.length);
  if (votes.length === 0) {
    const li = el('li', { class: 'review-empty' }, 'No votes yet.');
    list.appendChild(li);
    return;
  }
  for (const v of votes) {
    const li = el('li', { class: 'review-vote-row' });
    const author = el('span', { class: 'vote-author' });
    author.textContent = v.reviewerDisplayName;
    const kind = el('span', { class: `vote-kind vote-kind-${v.vote}` });
    kind.textContent = v.vote;
    const ts = el('span', { class: 'comment-timestamp' });
    ts.textContent = formatTimestamp(v.votedAt);
    li.appendChild(author);
    li.appendChild(kind);
    li.appendChild(ts);
    list.appendChild(li);
  }
}

function renderComments(): void {
  const groupList = $('review-comment-groups');
  const count = $('review-comment-count');
  if (!groupList || !count) return;
  groupList.innerHTML = '';
  const comments = state.review?.comments ?? [];
  count.textContent = String(comments.length);
  if (comments.length === 0) {
    const li = el('li', { class: 'review-empty' }, 'No comments yet.');
    groupList.appendChild(li);
    return;
  }
  // Group by `{filePath}:{line}`.
  const groups = new Map<string, ReviewCommentShape[]>();
  for (const c of comments) {
    const key = `${c.filePath}:${c.line}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(c);
  }
  for (const [key, arr] of groups) {
    const li = el('li', { class: 'review-comment-group' });
    const header = el('div', { class: 'review-comment-group-header' });
    const [fp, lnStr] = splitKey(key);
    const fileSpan = el('span', { class: 'comment-file-label' });
    fileSpan.textContent = fp;
    const lineBadge = el('span', { class: 'comment-line-badge' });
    lineBadge.textContent = `L${lnStr}`;
    header.appendChild(fileSpan);
    header.appendChild(lineBadge);
    li.appendChild(header);
    for (const c of arr) {
      li.appendChild(renderCommentItem(c));
    }
    groupList.appendChild(li);
  }
}

function splitKey(key: string): [string, string] {
  const idx = key.lastIndexOf(':');
  if (idx < 0) return [key, '?'];
  return [key.substring(0, idx), key.substring(idx + 1)];
}

function renderCommentItem(c: ReviewCommentShape): HTMLElement {
  const wrap = el('div', { class: 'review-comment-item' });
  const authorRow = el('div', { class: 'comment-author-row' });
  const author = el('span', { class: 'comment-author' });
  author.textContent = c.authorDisplayName;
  const ts = el('span', { class: 'comment-timestamp' });
  ts.textContent = formatTimestamp(c.createdAt);
  authorRow.appendChild(author);
  authorRow.appendChild(ts);
  const body = el('div', { class: 'comment-body' });
  // markdown-it html:false (T-06-02) — raw HTML is escaped before render.
  // The output goes through innerHTML because we WANT the rendered markdown
  // (h1/p/strong/code) to apply; the html:false config is what makes this
  // safe. NO direct user-text → innerHTML elsewhere in this file.
  body.innerHTML = md.render(c.body || '');
  wrap.appendChild(authorRow);
  wrap.appendChild(body);
  return wrap;
}

function renderVoteBar(): void {
  const bar = $('review-vote-bar');
  if (!bar) return;
  // Hide vote bar once review is resolved/abandoned.
  const status = state.review?.status;
  if (status === 'resolved' || status === 'abandoned' || !state.review) {
    bar.setAttribute('hidden', '');
  } else {
    bar.removeAttribute('hidden');
  }
}

function renderResolveBar(): void {
  const bar = $('review-resolve-bar');
  if (!bar) return;
  if (!state.review) {
    bar.setAttribute('hidden', '');
    return;
  }
  // Resolve bar visible to the push author OR the host (admin proxy for v1).
  // Best-effort UI hint — the host re-validates on the wire.
  const isAuthor = state.selfMemberId === state.review.authorMemberId;
  const isHost = state.selfMemberId === state.hostMemberId;
  const status = state.review.status;
  const canResolve = (isAuthor || isHost)
    && status !== 'resolved'
    && status !== 'abandoned';
  if (canResolve) {
    bar.removeAttribute('hidden');
  } else {
    bar.setAttribute('hidden', '');
  }
}

function renderEmpty(): void {
  const empty = $('review-empty');
  if (!empty) return;
  if (!state.review) {
    empty.removeAttribute('hidden');
    empty.textContent = state.push
      ? 'No review has been opened for this push yet.'
      : 'Loading review…';
  } else {
    empty.setAttribute('hidden', '');
  }
}

// --- Wire button listeners (once on load — they consult state when fired) ---

function wireListeners(): void {
  const approve = $('vote-approve');
  const changes = $('vote-changes');
  const commentOnly = $('vote-comment');
  const resolveMerged = $('resolve-merged');
  const resolveAbandoned = $('resolve-abandoned');
  const commentBtn = $('comment-submit-btn');
  const commentBody = $('comment-body-input');

  approve?.addEventListener('click', () => submitVote('approved'));
  changes?.addEventListener('click', () => submitVote('changes-requested'));
  commentOnly?.addEventListener('click', () => submitVote('commented'));
  resolveMerged?.addEventListener('click', () => submitResolve('merged'));
  resolveAbandoned?.addEventListener('click', () => submitResolve('abandoned'));
  commentBtn?.addEventListener('click', submitComment);

  // Enable the comment submit button when the body has content.
  commentBody?.addEventListener('input', () => {
    const ta = commentBody as HTMLTextAreaElement;
    const btn = commentBtn as HTMLButtonElement | null;
    if (btn) btn.disabled = !ta.value || ta.value.trim().length === 0;
  });
}

function submitVote(vote: 'approved' | 'changes-requested' | 'commented'): void {
  if (!state.review) return;
  vscode.postMessage({
    type: 'review-vote-submit',
    reviewId: state.review.id,
    vote,
  });
}

function submitResolve(resolvedReason: 'merged' | 'abandoned'): void {
  if (!state.review) return;
  vscode.postMessage({
    type: 'review-resolve-submit',
    reviewId: state.review.id,
    resolvedReason,
  });
}

function submitComment(): void {
  if (!state.review) return;
  const filePathInput = $('comment-file-input') as HTMLInputElement | null;
  const lineInput = $('comment-line-input') as HTMLInputElement | null;
  const bodyInput = $('comment-body-input') as HTMLTextAreaElement | null;
  if (!filePathInput || !lineInput || !bodyInput) return;
  const filePath = (filePathInput.value || '').trim();
  const lineRaw = (lineInput.value || '').trim();
  const body = (bodyInput.value || '').trim();
  if (filePath.length === 0 || body.length === 0) return;
  const line = parseInt(lineRaw, 10);
  if (!Number.isInteger(line) || line < 1) return;
  if (body.length > 16_384) return;
  vscode.postMessage({
    type: 'review-comment-submit',
    reviewId: state.review.id,
    filePath,
    line,
    body,
  });
  // Optimistic clear so the user can stage another comment without waiting
  // for the round-trip refresh.
  bodyInput.value = '';
  const btn = $('comment-submit-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
}

// --- Boot ---
wireListeners();
vscode.postMessage({ type: 'webview-ready' });
setText('review-title', 'Review');
