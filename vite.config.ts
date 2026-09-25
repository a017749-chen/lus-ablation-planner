import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: false,
    host: '127.0.0.1',
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1500
  }
});
