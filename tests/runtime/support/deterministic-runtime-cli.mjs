import { startRuntimeHttpServer } from '../../../dist-electron/electron/runtimeHttpServer.js'
import { deterministicProviderAdapters } from './deterministic-provider.mjs'

const runtimeServer = await startRuntimeHttpServer({
  providerAdapters: deterministicProviderAdapters(),
})
const { host, port } = runtimeServer

console.log(`Orrery runtime HTTP server listening on http://${host}:${port}`)

async function shutdown() {
  try {
    await runtimeServer.close()
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
