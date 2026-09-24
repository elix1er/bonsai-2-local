import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    proxy: {
      '^/api/(health|v1/chat/completions)$': {
        target: 'http://127.0.0.1:8080',
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
});
