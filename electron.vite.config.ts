import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        external: ['@anthropic-ai/claude-agent-sdk', 'simple-git', 'octokit', 'chokidar']
      }
    }
  },
  preload: {
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: { alias: sharedAlias },
    plugins: [react()]
  }
})
