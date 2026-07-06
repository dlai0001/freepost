import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const aliases = {
  '@core': resolve(__dirname, 'src/core'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@engine': resolve(__dirname, 'src/engine')
}

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: { alias: aliases },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: { alias: aliases },
    plugins: [react()]
  }
})
