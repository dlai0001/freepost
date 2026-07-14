import { defineConfig } from 'vite'
import { resolve } from 'path'
import { builtinModules } from 'module'

/**
 * Standalone build for the headless CLI (`freepost run ...`). Bundles the
 * Electron-free core into out/cli/index.js as an ESM Node script. Node builtins
 * and runtime deps (ws/chai/js-yaml) stay external — resolved from node_modules.
 *
 * This is a NODE bundle and must resolve dependencies the way Node does. Vite's
 * default is BROWSER resolution — it honours each package's "browser" field and
 * the "browser" export condition — which silently swapped mqtt.js for its
 * browser build and pulled @jspm/core stubs in for `net` and `fs`. The bundle
 * still built, and only failed at RUNTIME: "Node.js net module is not supported
 * by JSPM core outside of Node.js" (MQTT publish) and "Cannot read properties
 * of null (reading 'readFileSync')" (gRPC's proto loader). The mainFields /
 * conditions below drop "browser" so Node's real modules win.
 */
const external = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'ws',
  'chai',
  'js-yaml',
  // gRPC stays external too, and browser-vs-node resolution is only half the
  // reason. protobufjs (under @grpc/proto-loader) reaches `fs` through
  // @protobufjs/inquire, which is a *dynamic* `require()` in a try/catch. Bundled
  // into ESM there is no `require`, so the call throws, inquire swallows it and
  // hands back null — and the first proto load dies on `null.readFileSync`.
  // Loading these from node_modules lets Node run them as the CJS they are.
  '@grpc/grpc-js',
  '@grpc/proto-loader'
]

export default defineConfig({
  resolve: {
    // Node resolution, not browser — see the note above. Without these, .grpc
    // and .mqtt requests are silently broken in the built CLI.
    mainFields: ['module', 'jsnext:main', 'jsnext', 'main'],
    conditions: ['node', 'import', 'module', 'default'],
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
