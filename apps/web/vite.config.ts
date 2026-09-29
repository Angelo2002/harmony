import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // Consume the shared package straight from source in dev.
      '@harmony/shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // Forward API and gateway traffic to the Node server.
      '/api': 'http://127.0.0.1:8787',
      '/gateway': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
