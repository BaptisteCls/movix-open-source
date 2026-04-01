import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const buildId = process.env.CF_PAGES_COMMIT_SHA || process.env.COMMIT_REF || new Date().toISOString()
process.env.VITE_APP_BUILD_ID = buildId

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    hmr: true,
    watch: {
      usePolling: true,
      interval: 100,
      ignored: ['**/node_modules/**', '**/.git/**'],
    },
  },
  preview: {
    host: true,
    port: 3000,
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      sourceMap: false,
      transformMixedEsModules: true
    },
    rollupOptions: {
      input: './index.html'
    }
  },
  optimizeDeps: {
    include: ['firebase/app', 'firebase/firestore']
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@firebase/app': resolve(__dirname, 'node_modules/@firebase/app'),
      '@firebase/firestore': resolve(__dirname, 'node_modules/@firebase/firestore')
    }
  }
})
