import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Opt-in same-origin proxy to a runtime HTTP server. Sandboxed preview
// browsers block cross-origin localhost ports, so headless-acceptance
// previews set this and point VITE_ORRERY_RUNTIME_URL at the vite origin.
const runtimeProxyTarget = process.env.ORRERY_RUNTIME_PROXY_TARGET

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  ...(runtimeProxyTarget
    ? {
        server: {
          proxy: {
            '/api/runtime': {
              target: runtimeProxyTarget,
              changeOrigin: true,
              // Browsers attach Origin to same-origin non-GET requests and
              // http-proxy forwards it verbatim, which the runtime's
              // server-side allowlist would 403. Proxied traffic is
              // same-origin by construction, so drop the header.
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'))
              },
            },
          },
        },
      }
    : {}),
})
