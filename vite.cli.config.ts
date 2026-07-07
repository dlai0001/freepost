import { defineConfig } from 'vite'
import { resolve } from 'path'
import { builtinModules } from 'module'

/**
 * Standalone build for the headless CLI (`freepost run ...`). Bundles the
 * Electron-free core into out/cli/index.js as an ESM Node script. Node builtins
 * and runtime deps (ws/chai/js-yaml) stay external — resolved from node_modules.
 */
const external = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'ws',
  'chai',
  'js-yaml'
]

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@engine': resolve(__dirname, 'src/engine')
    }
  },
  build: {
    target: 'node20',
    outDir: 'out/cli',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/cli/index.ts'),
      formats: ['es'],
      // .mjs so Node treats it as ESM without a package.json "type": "module"
      // (which would break electron-vite's CJS main bundle).
      fileName: () => 'index.mjs'
    },
    rollupOptions: {
      external,
      output: { banner: '#!/usr/bin/env node' }
    }
  }
})
