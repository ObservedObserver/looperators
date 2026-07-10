import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { URL } from 'node:url'
import { RuntimeSessionManager } from './runtime/sessionManager.js'

const loopbackHost = '127.0.0.1'
const defaultPort = 48274
const maxRequestBodyBytes = 2 * 1024 * 1024
const sseKeepAliveMs = 25000

type JsonRecord = Record<string, any>
type RouteParams = Record<string, string>
type RuntimeRouteHandler = (
  request: http.IncomingMessage,
  params: RouteParams
) => unknown | Promise<unknown>

type RuntimeRoute = {
  method: string
  pattern: RegExp
  handler: RuntimeRouteHandler
}

type RuntimeHttpServerOptions = {
  runtime?: RuntimeSessionManager
  storageFile?: string
  port?: number
  corsOrigins?: string[]
}

type RuntimeHttpServer = {
  server: http.Server
  runtime: RuntimeSessionManager
  host: typeof loopbackHost
  port: number
  listen: () => Promise<{ host: typeof loopbackHost; port: number }>
  close: () => Promise<void>
}

type SseClient = {
  id: number
  response: http.ServerResponse
  keepAlive: NodeJS.Timeout
}

class RuntimeHttpError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

function defaultStorageFile() {
  return path.join(os.homedir(), '.orrery', 'orrery-runtime-state.json')
}

function runtimePort(value: unknown) {
  const port = Number(value)
  if (Number.isInteger(port) && port >= 0 && port <= 65535) {
    return port
  }

  return defaultPort
}

function corsOriginsFromEnv() {
  const configured = process.env.ORRERY_RUNTIME_CORS_ORIGINS
  const origins = configured
    ? configured
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : []

  return [
    'http://127.0.0.1:48273',
    'http://localhost:48273',
    ...origins,
  ]
}

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requestOrigin(request: http.IncomingMessage) {
  const origin = request.headers.origin
  return typeof origin === 'string' ? origin : undefined
}

function isAllowedOrigin(
  request: http.IncomingMessage,
  allowedOrigins: Set<string>
) {
  const origin = requestOrigin(request)
  return !origin || allowedOrigins.has(origin)
}

function applyCors(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  allowedOrigins: Set<string>
) {
  const origin = requestOrigin(request)
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Last-Event-ID,X-Orrery-Source-Token'
  )
  response.setHeader('Access-Control-Max-Age', '600')
}

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown
) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(`${JSON.stringify(value)}\n`)
}

function sendError(
  response: http.ServerResponse,
  statusCode: number,
  error: unknown
) {
  const message = error instanceof Error ? error.message : String(error)
  sendJson(response, statusCode, { error: message })
}

function routePath(request: http.IncomingMessage) {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  return parsed.pathname
}

function queryParams(request: http.IncomingMessage) {
  return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
}

function notFoundOnUnknownSession<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown session:')) {
      throw new RuntimeHttpError(404, error.message)
    }
    throw error
  }
}

function notFoundOnUnknownLoop<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown loop:')) {
      throw new RuntimeHttpError(404, error.message)
    }
    throw error
  }
}

function notFoundOnUnknownSource<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Unknown external source:')
    ) {
      throw new RuntimeHttpError(404, error.message)
    }
    throw error
  }
}

function decodeParam(value: string | undefined) {
  try {
    return decodeURIComponent(value ?? '')
  } catch {
    // decodeURIComponent throws URIError on bad percent-encoding; without
    // this, one malformed URL becomes an unhandled rejection that kills the
    // whole runtime server process.
    throw new RuntimeHttpError(400, 'Malformed URL encoding in path parameter')
  }
}

function compileRoutes(
  runtime: RuntimeSessionManager,
  config: JsonRecord
): RuntimeRoute[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/config$/,
      handler: () => config,
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/state$/,
      handler: () => runtime.getState(),
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/graph$/,
      handler: () => runtime.getGraphTopology(),
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/sessions$/,
      handler: () => runtime.listSessionSummaries(),
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/loops\/([^/]+)\/timeline$/,
      handler: (_request, params) =>
        notFoundOnUnknownLoop(() =>
          runtime.getLoopTimeline({ loopId: params.loopId })
        ),
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/kernel-events$/,
      handler: (request) => {
        const params = queryParams(request)
        return runtime.getKernelEvents({
          since: params.get('since') ?? undefined,
          limit: params.get('limit') ?? undefined,
          type: params.get('type') ?? undefined,
          tail: params.get('tail') ?? undefined,
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/sessions\/([^/]+)$/,
      handler: (request, params) =>
        notFoundOnUnknownSession(() =>
          runtime.getSessionView({
            sessionId: params.sessionId,
            view: queryParams(request).get('view') ?? undefined,
          })
        ),
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/sessions\/([^/]+)\/events$/,
      handler: (request, params) =>
        notFoundOnUnknownSession(() =>
          runtime.getSessionEvents({
            sessionId: params.sessionId,
            since: queryParams(request).get('since') ?? undefined,
          })
        ),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/project-context$/,
      handler: async (request) => runtime.getProjectContext(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/provider-setup-status$/,
      handler: async (request) =>
        runtime.getProviderSetupStatus(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/provider-instances$/,
      handler: async (request) =>
        runtime.upsertProviderInstance(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sessions$/,
      handler: async (request) => runtime.createSession(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sessions\/([^/]+)\/resume$/,
      handler: async (request, params) =>
        runtime.resumeSession({
          ...(await readJsonBody(request)),
          sessionId: params.sessionId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sessions\/([^/]+)\/deliver$/,
      handler: async (request, params) =>
        runtime.deliverToSession({
          ...(await readJsonBody(request)),
          sessionId: params.sessionId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sessions\/([^/]+)\/activate$/,
      handler: async (request, params) =>
        runtime.activateSession({
          ...(await readJsonBody(request)),
          sessionId: params.sessionId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sessions\/([^/]+)\/archive$/,
      handler: async (request, params) =>
        runtime.archiveSession({
          ...(await readJsonBody(request)),
          sessionId: params.sessionId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sessions\/([^/]+)\/kill$/,
      handler: (_request, params) => runtime.killSession(params.sessionId),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/requests\/([^/]+)\/respond$/,
      handler: async (request, params) =>
        runtime.respondRuntimeRequest({
          ...(await readJsonBody(request)),
          requestId: params.requestId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/user-input\/([^/]+)\/answer$/,
      handler: async (request, params) =>
        runtime.answerUserInput({
          ...(await readJsonBody(request)),
          requestId: params.requestId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/edges$/,
      handler: async (request) => runtime.linkSessions(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/edges\/([^/]+)\/remove$/,
      handler: (_request, params) => runtime.removeEdge({ edgeId: params.edgeId }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/clusters$/,
      handler: async (request) => runtime.upsertCluster(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/clusters\/([^/]+)\/master$/,
      handler: async (request, params) =>
        runtime.createMasterForCluster({
          ...(await readJsonBody(request)),
          clusterId: params.clusterId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/clusters\/([^/]+)\/assign-master$/,
      handler: async (request, params) =>
        runtime.assignMasterToCluster({
          ...(await readJsonBody(request)),
          clusterId: params.clusterId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/clusters\/([^/]+)\/loop-policy$/,
      handler: async (request, params) =>
        runtime.setClusterLoopPolicy({
          ...(await readJsonBody(request)),
          clusterId: params.clusterId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/clusters\/([^/]+)\/start-loop$/,
      handler: async (request, params) =>
        runtime.startMasterLoop({
          ...(await readJsonBody(request)),
          clusterId: params.clusterId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/clusters\/([^/]+)\/stop-loop$/,
      handler: async (request, params) =>
        runtime.stopMasterLoop({
          ...(await readJsonBody(request)),
          clusterId: params.clusterId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/freeze$/,
      handler: async (request) => runtime.freeze(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/subscriptions$/,
      handler: async (request) =>
        runtime.authorSubscription(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/goal-loops$/,
      handler: async (request) =>
        runtime.createGoalLoop(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/subscriptions\/([^/]+)\/stop$/,
      handler: async (request, params) =>
        runtime.stopSubscription({
          ...(await readJsonBody(request)),
          subscriptionId: params.subscriptionId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sources$/,
      handler: async (request) =>
        runtime.registerExternalSource(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/sources\/([^/]+)\/remove$/,
      handler: async (request, params) => {
        const body = await readJsonBody(request)
        return notFoundOnUnknownSource(() =>
          runtime.removeExternalSource({ ...body, sourceId: params.sourceId })
        )
      },
    },
    {
      // The L2 ingestion endpoint — this IS the webhook form of a source:
      // point any local sender (curl, CI hook relay, npm run emit) at it.
      method: 'POST',
      pattern: /^\/api\/runtime\/external-events$/,
      handler: async (request) => {
        const body = await readJsonBody(request)
        const headerToken = request.headers['x-orrery-source-token']
        const token =
          typeof headerToken === 'string' ? headerToken : body.token
        delete body.token
        if (!runtime.verifyExternalSourceToken(body.sourceId, token)) {
          throw new RuntimeHttpError(401, 'Invalid or missing source token')
        }
        return notFoundOnUnknownSource(() => runtime.emitExternalEvent(body))
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/templates$/,
      handler: async () => runtime.listTemplates(),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/templates\/apply$/,
      handler: async (request) =>
        runtime.applyTemplate(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/review-workflows$/,
      handler: async (request) =>
        runtime.startReviewWorkflow(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/templates\/save$/,
      handler: async (request) =>
        runtime.saveTemplate(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/templates\/([^/]+)\/remove$/,
      handler: async (request, params) =>
        runtime.removeTemplate({
          ...(await readJsonBody(request)),
          templateId: params.templateId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/activations\/approve$/,
      handler: async (request) =>
        runtime.approveActivation(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/activations\/deny$/,
      handler: async (request) =>
        runtime.denyActivation(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/node-positions$/,
      handler: async (request) =>
        runtime.updateNodePositions(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/working-tree-diff$/,
      handler: async (request) =>
        runtime.getWorkingTreeDiff(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/workspace-files$/,
      handler: async (request) =>
        runtime.getWorkspaceFiles(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/workspace-file-content$/,
      handler: async (request) =>
        runtime.getWorkspaceFileContent(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/open-workspace$/,
      handler: async (request) =>
        runtime.openWorkspace(await readJsonBody(request)),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/terminals$/,
      handler: async (request) =>
        runtime.createTerminal(await readJsonBody(request)),
    },
    {
      method: 'GET',
      pattern: /^\/api\/runtime\/terminals\/([^/]+)$/,
      handler: async (_request, params) =>
        runtime.getTerminal({ terminalId: params.terminalId }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/terminals\/([^/]+)\/command$/,
      handler: async (request, params) =>
        runtime.runTerminalCommand({
          ...(await readJsonBody(request)),
          terminalId: params.terminalId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/terminals\/([^/]+)\/stdin$/,
      handler: async (request, params) =>
        runtime.writeTerminalInput({
          ...(await readJsonBody(request)),
          terminalId: params.terminalId,
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/terminals\/([^/]+)\/clear$/,
      handler: async (_request, params) =>
        runtime.clearTerminal({ terminalId: params.terminalId }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/runtime\/terminals\/([^/]+)\/close$/,
      handler: async (_request, params) =>
        runtime.closeTerminal({ terminalId: params.terminalId }),
    },
  ]
}

function routeParams(pattern: RegExp, pathname: string) {
  const match = pattern.exec(pathname)
  if (!match) {
    return undefined
  }

  if (pathname.includes('/sessions/') && match[1]) {
    return { sessionId: decodeParam(match[1]) }
  }
  if (pathname.includes('/requests/') && match[1]) {
    return { requestId: decodeParam(match[1]) }
  }
  if (pathname.includes('/user-input/') && match[1]) {
    return { requestId: decodeParam(match[1]) }
  }
  if (pathname.includes('/edges/') && match[1]) {
    return { edgeId: decodeParam(match[1]) }
  }
  if (pathname.includes('/subscriptions/') && match[1]) {
    return { subscriptionId: decodeParam(match[1]) }
  }
  if (pathname.includes('/loops/') && match[1]) {
    return { loopId: decodeParam(match[1]) }
  }
  if (pathname.includes('/sources/') && match[1]) {
    return { sourceId: decodeParam(match[1]) }
  }
  if (pathname.includes('/templates/') && match[1]) {
    return { templateId: decodeParam(match[1]) }
  }
  if (pathname.includes('/clusters/') && match[1]) {
    return { clusterId: decodeParam(match[1]) }
  }
  if (pathname.includes('/terminals/') && match[1]) {
    return { terminalId: decodeParam(match[1]) }
  }

  return {}
}

async function readJsonBody(request: http.IncomingMessage) {
  let totalBytes = 0
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > maxRequestBodyBytes) {
      throw new Error('Request body exceeds 2MB')
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) {
    return {}
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) {
    return {}
  }

  const contentType = request.headers['content-type']
  if (
    typeof contentType !== 'string' ||
    !contentType.toLowerCase().includes('application/json')
  ) {
    throw new RuntimeHttpError(415, 'Request body must be application/json')
  }

  const parsed = JSON.parse(raw)
  if (!isObject(parsed)) {
    throw new Error('Request body must be a JSON object')
  }

  return parsed
}

function writeSseEvent(client: SseClient, id: number, event: JsonRecord) {
  client.response.write(`id: ${id}\n`)
  client.response.write('event: runtime\n')
  client.response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export function createRuntimeHttpServer(
  options: RuntimeHttpServerOptions = {}
): RuntimeHttpServer {
  const clients = new Map<number, SseClient>()
  let nextClientId = 1
  let nextEventId = 1
  const port = runtimePort(options.port ?? process.env.ORRERY_RUNTIME_HTTP_PORT)
  const storageFile =
    options.storageFile ??
    process.env.ORRERY_RUNTIME_STORAGE_FILE ??
    defaultStorageFile()
  const allowedOrigins = new Set(options.corsOrigins ?? corsOriginsFromEnv())

  const broadcastRuntimeEvent = (event: JsonRecord) => {
    const eventId = nextEventId
    nextEventId += 1
    for (const client of clients.values()) {
      writeSseEvent(client, eventId, event)
    }
  }

  const runtime =
    options.runtime ??
    new RuntimeSessionManager({
      storageFile,
      broadcastRuntimeEvent,
    })

  const config = {
    mode: 'node-http',
    host: loopbackHost,
    port,
    baseUrl: `http://${loopbackHost}:${port}`,
    eventsUrl: `http://${loopbackHost}:${port}/api/runtime/events`,
    storageFile,
    platform: process.platform,
    workspace: {
      defaultCwd: process.cwd(),
    },
  }
  const routes = compileRoutes(runtime, config)

  const server = http.createServer(async (request, response) => {
    applyCors(request, response, allowedOrigins)

    if (!isAllowedOrigin(request, allowedOrigins)) {
      sendError(response, 403, 'Origin is not allowed')
      return
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const pathname = routePath(request)
    if (request.method === 'GET' && pathname === '/api/runtime/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.write(': connected\n\n')

      const clientId = nextClientId
      nextClientId += 1
      const client: SseClient = {
        id: clientId,
        response,
        keepAlive: setInterval(() => response.write(': keep-alive\n\n'), sseKeepAliveMs),
      }
      clients.set(clientId, client)
      request.on('close', () => {
        clearInterval(client.keepAlive)
        clients.delete(client.id)
      })
      return
    }

    const routeMethod = request.method === 'HEAD' ? 'GET' : request.method
    const route = routes.find((candidate) => {
      if (candidate.method !== routeMethod) {
        return false
      }

      return candidate.pattern.test(pathname)
    })

    if (!route) {
      sendError(response, 404, 'Not found')
      return
    }

    try {
      const params = routeParams(route.pattern, pathname) ?? {}
      const result = await route.handler(request, params)
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end()
        return
      }
      sendJson(response, 200, result ?? { ok: true })
    } catch (error) {
      const statusCode =
        error instanceof RuntimeHttpError
          ? error.statusCode
          : error instanceof SyntaxError ||
        (error instanceof Error && error.message.includes('Request body'))
          ? 400
          : 500
      sendError(response, statusCode, error)
    }
  })

  return {
    server,
    runtime,
    host: loopbackHost,
    port,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, loopbackHost, () => {
          server.off('error', reject)
          const address = server.address()
          const actualPort =
            typeof address === 'object' && address
              ? address.port
              : port
          config.port = actualPort
          config.baseUrl = `http://${loopbackHost}:${actualPort}`
          config.eventsUrl = `${config.baseUrl}/api/runtime/events`
          resolve({
            host: loopbackHost,
            port: actualPort,
          })
        })
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of clients.values()) {
          clearInterval(client.keepAlive)
          client.response.end()
        }
        clients.clear()
        server.close((error) => {
          runtime.killAll()
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}

export async function startRuntimeHttpServer(
  options: RuntimeHttpServerOptions = {}
) {
  const runtimeServer = createRuntimeHttpServer(options)
  const address = await runtimeServer.listen()
  runtimeServer.port = address.port
  return runtimeServer
}
