import { defineConfig } from 'vitest/config'

/** Resolve the package's own name to source so tests never depend on a build. */
export default defineConfig({
  resolve: {
    alias: { 'dsh-phone-remote': new URL('./src/index.ts', import.meta.url).pathname },
  },
})
