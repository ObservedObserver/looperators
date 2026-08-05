import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist/inline',
    emptyOutDir: false,
    cssCodeSplit: false,
    target: 'es2022',
    minify: 'oxc',
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/inline.ts'),
      formats: ['es'],
      fileName: () => 'agent-graph-ui-inline.js',
      cssFileName: 'agent-graph-ui-inline',
    },
  },
});
