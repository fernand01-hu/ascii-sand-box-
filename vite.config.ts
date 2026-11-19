import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  // Relative URLs so the built site works from any sub-path of a website.
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
});
