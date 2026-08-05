import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { agentGraphScenarios } from '../../../packages/agent-graph-ui/dist/library/agent-graph-ui.js';

function pairedFixtureAsset(): Plugin {
  return {
    name: 'looperators-paired-agent-graph-fixtures',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'paired-scenarios.json',
        source: `${JSON.stringify(agentGraphScenarios, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [pairedFixtureAsset()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: resolve(import.meta.dirname, 'assets'),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    target: 'es2022',
    minify: 'oxc',
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'entry.tsx'),
      name: 'LooperatorsAgentLoopUI',
      formats: ['iife'],
      fileName: () => 'agent-loop-ui.iife.js',
      cssFileName: 'agent-loop-ui',
    },
  },
});
