import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  // Relative URLs so the built site works from any sub-path of a website.
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    // three.js alone is ~140 kB gzipped; that's expected, not a bloat signal.
    chunkSizeWarningLimit: 700,
  },
  worker: { format: 'es' },
});
