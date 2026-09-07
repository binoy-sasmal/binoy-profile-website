import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // keep data maps / fonts as real files
  },
});
