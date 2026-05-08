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
    });
  },
};

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

if (isWatch) {
  await Promise.all([extCtx.watch(), chatCtx.watch()]);
  // Initial copy in case watchers don't fire onEnd before the user edits.
  await copyChatAssets();
  console.log('Watching...');
} else {
  await Promise.all([extCtx.rebuild(), chatCtx.rebuild()]);
  // Belt-and-suspenders — onEnd already ran, but explicit copy guarantees
  // assets are present even if the plugin failed silently.
  await copyChatAssets();
  await extCtx.dispose();
  await chatCtx.dispose();
}
