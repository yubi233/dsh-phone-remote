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

import { existsSync, readFileSync, readdirSync, rmSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

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

// Ship the built phone shell so the built-in LAN relay can serve it without
// any separate deployment: the plugin package is the whole setup.
const shellSource = fileURLToPath(new URL('../../../apps/mobile-web', import.meta.url))
const shellTarget = fileURLToPath(new URL('../shell', import.meta.url))
if (existsSync(join(shellSource, 'index.html'))) {
  rmSync(shellTarget, { recursive: true, force: true })
  mkdirSync(shellTarget, { recursive: true })
  copyFileSync(join(shellSource, 'index.html'), join(shellTarget, 'index.html'))
  const loginPage = join(shellSource, 'login.html')
  if (existsSync(loginPage)) copyFileSync(loginPage, join(shellTarget, 'login.html'))
  copyDir(join(shellSource, 'dist'), join(shellTarget, 'dist'))
  console.log(`host-plugin: copied phone shell from ${shellSource}`)
} else if (existsSync(join(shellTarget, 'index.html'))) {
  console.log('host-plugin: using the prebuilt phone shell committed in shell/')
} else {
  console.warn(`host-plugin: no phone shell at ${shellSource}; run the mobile-web build first`)
}

console.log('host-plugin: built lib/index.js and lib/client.js')

/** Copy a directory tree without source maps (they double the package size). */
function copyDir(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      copyDir(from, to)
    } else if (!entry.name.endsWith('.map')) {
      copyFileSync(from, to)
    }
  }
}
