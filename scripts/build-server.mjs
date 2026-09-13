#!/usr/bin/env node
/**
 * Bundle the server into one file for the desktop build.
 *
 * The npm package runs index.js against node_modules; the desktop app ships a
 * single .mjs next to a Node binary. Same source, one less install step.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [path.join(ROOT, 'index.js')],
  bundle:   true,
  platform: 'node',
  format:   'esm',
  outfile:  path.join(ROOT, 'dist', 'server.mjs'),
  logLevel: 'warning',
  // Provider SDKs reach for CommonJS at runtime (cross-spawn asks for
  // child_process this way). An ESM bundle has no require of its own, so give
  // it one rather than rewriting dependencies.
  banner: { js: "import{createRequire as __litura_require}from'node:module';const require=__litura_require(import.meta.url);" },
  // index.js imports esbuild only to rebuild the frontend from src/, which the
  // desktop build does not ship. Bundling it would carry a wrapper looking for
  // a binary that is not there.
  external: ['esbuild'],
});

console.log('[build] dist/server.mjs ✓');
