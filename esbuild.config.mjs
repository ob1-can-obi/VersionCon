import * as esbuild from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const isWatch = process.argv.includes('--watch');

// Phase 4 Plan 04-10: copy webview-side static assets (HTML template, CSS,
// codicon font + CSS) into dist/ so they sit alongside the bundled JS and the
// extension's localResourceRoots reaches them. Called once at build start and
// on every watch rebuild via the chat-asset onEnd plugin below.
async function copyChatAssets() {
  await mkdir('dist/webview/chat/codicon', { recursive: true });
  await copyFile(
    'node_modules/@vscode/codicons/dist/codicon.css',
    'dist/webview/chat/codicon/codicon.css',
  );
  await copyFile(
    'node_modules/@vscode/codicons/dist/codicon.ttf',
    'dist/webview/chat/codicon/codicon.ttf',
  );
  await copyFile(
    'src/ui/webview/chat/index.html',
    'dist/webview/chat/index.html',
  );
  await copyFile(
    'src/ui/webview/chat/main.css',
    'dist/webview/chat/main.css',
  );
}

/**
 * onEnd plugin that re-copies chat assets after every successful rebuild.
 * Required for watch mode so editing index.html / main.css triggers a copy.
 */
const chatAssetsPlugin = {
  name: 'chat-assets-plugin',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors && result.errors.length > 0) return;
      try {
        await copyChatAssets();
      } catch (err) {
        console.error('[esbuild] copyChatAssets failed:', err);
      }
      try {
        await copyTreeSitterGrammars();
      } catch (err) {
        console.error('[esbuild] copyTreeSitterGrammars failed:', err);
      }
    });
  },
};

/**
 * Phase 5 Plan 05-02 (Wave 2 — JS/TS) + Plan 05-03 (Wave 3 — Python):
 * copy vendored tree-sitter grammar WASMs into dist/ so the forked AST worker
 * (Wave 4, runs as a Node child_process) can resolve them at runtime via
 * locateFile in grammars.ts. Mirrors the copyChatAssets() pattern above.
 *
 * The list of grammars is sourced from src/vendor/tree-sitter/ at build time —
 * each Wave only writes its own files into src/vendor/tree-sitter/, but ALL
 * present .wasm files are copied so adding a new grammar requires only the
 * vendor-side edit, not an esbuild.config.mjs change.
 *
 * Also copies the web-tree-sitter runtime WASM (the parser engine, distinct
 * from language grammars). The worker's grammars.ts locateFile resolver
 * points the runtime here.
 */
async function copyTreeSitterGrammars() {
  const { readdir } = await import('node:fs/promises');
  await mkdir('dist/vendor/tree-sitter', { recursive: true });
  let entries = [];
  try {
    entries = await readdir('src/vendor/tree-sitter');
  } catch {
    // Directory absent — no grammars to copy. Wave 2 + Wave 3 create it.
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.wasm')) continue;
    await copyFile(
      `src/vendor/tree-sitter/${entry}`,
      `dist/vendor/tree-sitter/${entry}`,
    );
  }
  // Runtime parser engine — separate from language grammars. Bundled with the
  // web-tree-sitter npm package.
  await copyFile(
    'node_modules/web-tree-sitter/web-tree-sitter.wasm',
    'dist/vendor/tree-sitter/web-tree-sitter.wasm',
  );
}

const extCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
});

// Phase 4 Plan 04-10: chat webview JS bundle. Browser platform / IIFE so the
// bundle runs inside the WebviewPanel iframe with strict CSP. markdown-it +
// highlight.js + their dependencies are all bundled — no CDN, no external
// scripts. CSP `script-src 'nonce-X'` only lets the bundled main.js run.
const chatCtx = await esbuild.context({
  entryPoints: ['src/ui/webview/chat/main.ts'],
  bundle: true,
  outfile: 'dist/webview/chat/main.js',
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch,
  plugins: [chatAssetsPlugin],
});

// Phase 5 Plan 05-04 (Wave 4): forked AST worker bundle. CJS / platform:node
// so it runs inside a child_process.fork()'d Node process. `external: vscode`
// is defense-in-depth — the worker has zero vscode imports (verified by
// source-grep + bundled-output grep in tests), but marking it external
// guarantees an immediate runtime error if a future refactor accidentally
// pulls vscode into worker.ts's dependency closure (T-05-01 isolation).
//
// web-tree-sitter IS bundled — it's a pure CJS module and bundling avoids a
// runtime node_modules lookup. The Wasm files it loads (grammars + the
// runtime engine itself) live in dist/vendor/tree-sitter/, copied by
// copyTreeSitterGrammars() above.
const workerCtx = await esbuild.context({
  entryPoints: ['src/ast/worker.ts'],
  bundle: true,
  outfile: 'dist/ast-worker.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
});

if (isWatch) {
  await Promise.all([extCtx.watch(), chatCtx.watch(), workerCtx.watch()]);
  // Initial copy in case watchers don't fire onEnd before the user edits.
  await copyChatAssets();
  await copyTreeSitterGrammars();
  console.log('Watching...');
} else {
  await Promise.all([extCtx.rebuild(), chatCtx.rebuild(), workerCtx.rebuild()]);
  // Belt-and-suspenders — onEnd already ran, but explicit copy guarantees
  // assets are present even if the plugin failed silently.
  await copyChatAssets();
  await copyTreeSitterGrammars();
  await extCtx.dispose();
  await chatCtx.dispose();
  await workerCtx.dispose();
}
