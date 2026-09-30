import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/public', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Match API routes only. The /api prefix also matches Vite's /api.ts module.
    proxy: { '/api/': 'http://127.0.0.1:4317' },
  },
});
