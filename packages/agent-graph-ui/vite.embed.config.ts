import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist/embed',
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    target: 'es2022',
    minify: 'oxc',
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/embed.tsx'),
      name: 'LooperatorsAgentGraphUI',
      formats: ['iife'],
      fileName: () => 'agent-graph-ui.iife.js',
      cssFileName: 'agent-graph-ui',
    },
  },
});
