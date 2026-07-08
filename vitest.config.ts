import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    // Force a single graphql instance — graphql-ws / graphql-sse otherwise pull
    // a second copy, and graphql's cross-realm instanceOf checks then reject a
    // schema built with the other copy (the "Duplicate graphql modules" error).
    dedupe: ['graphql'],
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@engine': resolve(__dirname, 'src/engine')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Let vite transform these ESM libs so they resolve the same graphql as the
    // test files (avoids the ESM/CJS dual-package hazard under the node pool).
    server: { deps: { inline: ['graphql-ws', 'graphql-sse'] } }
  }
})
