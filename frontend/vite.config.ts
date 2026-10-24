import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    host: '0.0.0.0',
    port: 4204,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:4201',
      '/ws': {
        target: 'ws://localhost:4201',
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4204,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:4201',
      '/ws': {
        target: 'ws://localhost:4201',
        ws: true,
      },
    },
  },
})
