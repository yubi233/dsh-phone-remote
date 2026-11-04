/**
 * Build the dual-face plugin package:
 *
 * - `lib/index.js`  — the Node half (cordis plugin, relay transport, console
 *   routes) as a self-contained ESM bundle; only `ws` stays external.
 * - `lib/client.js` — the browser half as a CJS factory in the exact shape
 *   `@deepseek-ai/dsh-client-modules` loads: a `window.__ModuleLoader__.load`
 *   banner with `(require)`, the `module`/`exports` intro, and a footer that
 *   returns `module.exports`. Platform modules (react, ui primitives, …) stay
 *   external: the shell serves them from its frozen module table.
 */

import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const manifestPath = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string }

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  sourcemap: true,
  external: ['ws'],
  logLevel: 'warning',
})

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'lib/client.js',
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
      'var module = { exports: {} };',
      'var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    'zod',
    '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ],
  jsx: 'automatic',
  logLevel: 'warning',
})

console.log('host-plugin: built lib/index.js and lib/client.js')
