import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
  preview: {
    // e2e serves the production build via `vite preview`; its API runs on 3100
    // (see playwright.config.ts). Override with E2E_API_ORIGIN when different.
    proxy: { '/api': { target: process.env.E2E_API_ORIGIN ?? 'http://localhost:3100', changeOrigin: true } },
  },
});
