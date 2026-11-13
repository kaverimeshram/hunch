import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: { rollupOptions: { input: ['index.html', 'fact/index.html'] } },
});
