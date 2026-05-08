import * as assert from 'assert';
// markdown-it ships ESM via "exports" — Node16 module resolution + ts esModuleInterop
// lets us import the default export directly. Mirrors the webview's main.ts import.
import MarkdownIt from 'markdown-it';

/**
 * Mirrors the EXACT MarkdownIt config used by src/ui/webview/chat/main.ts.
 * The webview entry imports browser-only DOM types and registers
 * highlight.js languages, so it can't be loaded directly in a Node test
 * environment. Duplicating the config here is the simplest way to keep
 * the XSS / formatting contract enforceable from a unit test.
 *
 * If a future refactor extracts the config into a shared util, point the
 * test at that util instead of re-instantiating here.
 */
function buildMarkdownIt(): MarkdownIt {
  return new MarkdownIt({ html: false, linkify: true, breaks: false });
}

suite('chat render — markdown-it config (T-04-10-01 XSS gate)', () => {
  let md: MarkdownIt;

  setup(() => {
    md = buildMarkdownIt();
  });

  test('html: false escapes raw <script> tags', () => {
    const out = md.render('<script>alert(1)</script>');
    assert.doesNotMatch(out, /<script>/, 'raw <script> must not pass through');
    assert.match(out, /&lt;script&gt;/, '<script> must be escaped to &lt;script&gt;');
  });

  test('html: false escapes raw <img onerror>', () => {
    const out = md.render('<img src=x onerror=alert(1)>');
    assert.doesNotMatch(out, /<img/, 'raw <img must not pass through');
    assert.match(out, /&lt;img/, '<img must be escaped');
  });

  test('html: false escapes <iframe src=javascript:...>', () => {
    const out = md.render('<iframe src=javascript:alert(1)></iframe>');
    assert.doesNotMatch(out, /<iframe/, 'raw <iframe must not pass through');
  });

  test('linkify: true auto-links bare URLs', () => {
    const out = md.render('See https://example.com for details');
    assert.match(out, /<a[^>]*href="https:\/\/example\.com"[^>]*>/);
  });

  test('breaks: false: single newline does NOT produce <br>', () => {
    const out = md.render('line1\nline2');
    assert.doesNotMatch(out, /<br\s*\/?>/);
  });

  test('double newline produces paragraph separation', () => {
    const out = md.render('line1\n\nline2');
    assert.match(out, /<p>line1<\/p>\s*<p>line2<\/p>/);
  });

  test('fenced code block with ```ts wraps in <pre><code class*="language-ts">', () => {
    const out = md.render('```ts\nconst x = 1;\n```');
    assert.match(
      out,
      /<pre><code class="[^"]*language-ts[^"]*">/,
      'fenced ```ts block should emit a code element with language-ts class',
    );
  });

  test('inline code uses <code>', () => {
    const out = md.render('use `npm test` to verify');
    assert.match(out, /<code>npm test<\/code>/);
  });

  test('plain text passes through with paragraph wrap', () => {
    const out = md.render('hello world');
    assert.strictEqual(out.trim(), '<p>hello world</p>');
  });

  test('markdown link with javascript: scheme is not auto-linkified as raw href', () => {
    // markdown-it explicit links of unsafe schemes still render as raw text by default
    // when html: false; this test documents the behavior so callers know the
    // T-04-10-02 mitigation depends on the open-external handler too.
    const out = md.render('[click](javascript:alert(1))');
    // markdown-it's link-validation rejects javascript: URIs by default; the
    // output should NOT carry an anchor element pointing at javascript:.
    assert.doesNotMatch(out, /href="javascript:/i,
      'javascript: link must be filtered by markdown-it link-validator');
  });
});

suite('chat render — relative time formatter', () => {
  /**
   * Mirrors the formatRelativeTime function in src/ui/webview/chat/main.ts.
   * UI-SPEC §6.3 contract: "just now" (<10s), "Ns ago" (<60s), "Nm ago"
   * (<60m), "Nh ago" (<24h), "Nd ago" (≥24h).
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

  test('formatRelativeTime branches', () => {
    assert.strictEqual(formatRelativeTime(0, 5_000), 'just now');
    assert.strictEqual(formatRelativeTime(0, 30_000), '30s ago');
    assert.strictEqual(formatRelativeTime(0, 5 * 60_000), '5m ago');
    assert.strictEqual(formatRelativeTime(0, 3 * 3_600_000), '3h ago');
    assert.strictEqual(formatRelativeTime(0, 2 * 86_400_000), '2d ago');
  });

  test('formatRelativeTime clamps negative diff (clock skew)', () => {
    // Future timestamp (clock skew) — should not produce negative output.
    assert.strictEqual(formatRelativeTime(1000, 0), 'just now');
  });

  test('formatRelativeTime boundary at 10s', () => {
    assert.strictEqual(formatRelativeTime(0, 9_999), 'just now');
    assert.strictEqual(formatRelativeTime(0, 10_000), '10s ago');
  });

  test('formatRelativeTime boundary at 60s', () => {
    assert.strictEqual(formatRelativeTime(0, 59_000), '59s ago');
    assert.strictEqual(formatRelativeTime(0, 60_000), '1m ago');
  });

  test('formatRelativeTime boundary at 60m', () => {
    assert.strictEqual(formatRelativeTime(0, 59 * 60_000), '59m ago');
    assert.strictEqual(formatRelativeTime(0, 60 * 60_000), '1h ago');
  });

  test('formatRelativeTime boundary at 24h', () => {
    assert.strictEqual(formatRelativeTime(0, 23 * 3_600_000), '23h ago');
    assert.strictEqual(formatRelativeTime(0, 24 * 3_600_000), '1d ago');
  });
});
