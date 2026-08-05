import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/library',
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'agent-graph-ui.js',
      cssFileName: 'agent-graph-ui',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', '@xyflow/react'],
    },
  },
});
