import { startRuntimeHttpServer } from './runtimeHttpServer.js'

const runtimeServer = await startRuntimeHttpServer()
const { host, port } = runtimeServer

console.log(`Orrery runtime HTTP server listening on http://${host}:${port}`)

async function shutdown() {
  try {
    await runtimeServer.close()
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})
