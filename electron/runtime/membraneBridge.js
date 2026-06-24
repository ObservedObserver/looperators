import http from 'node:http'
import { randomUUID } from 'node:crypto'

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (body.trim().length === 0) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function bearerToken(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string') {
    return undefined
  }

  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]
}

export class MembraneBridge {
  #server
  #tokens = new Map()
  #handler
  #url

  constructor({ handler }) {
    this.#handler = handler
  }

  async start() {
    if (this.#url) {
      return this.#url
    }

    this.#server = http.createServer((request, response) => {
      void this.#handleRequest(request, response)
    })

    await new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', reject)
        resolve()
      })
    })

    const address = this.#server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind Orrery membrane bridge')
    }

    this.#url = `http://127.0.0.1:${address.port}`
    return this.#url
  }

  createRunToken(sourceSessionId) {
    const token = randomUUID()
    this.#tokens.set(token, sourceSessionId)
    return token
  }

  revokeRunToken(token) {
    this.#tokens.delete(token)
  }

  close() {
    this.#tokens.clear()
    this.#server?.close()
    this.#server = undefined
    this.#url = undefined
  }

  async #handleRequest(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const match = /^\/membrane\/([a-z_]+)$/.exec(url.pathname)
    if (!match) {
      sendJson(response, 404, { error: 'Unknown membrane route' })
      return
    }

    const token = bearerToken(request)
    const source = token ? this.#tokens.get(token) : undefined
    if (!token || !source) {
      sendJson(response, 401, { error: 'Invalid membrane token' })
      return
    }

    try {
      const input = await readJsonBody(request)
      const result = await this.#handler({
        tool: match[1],
        source,
        input,
      })
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
