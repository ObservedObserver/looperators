#!/usr/bin/env node

import fs from 'node:fs'

function loadBridgeCredentials() {
  const bootstrapFile = process.env.ORRERY_MEMBRANE_BOOTSTRAP_FILE
  if (typeof bootstrapFile === 'string' && bootstrapFile.length > 0) {
    const raw = fs.readFileSync(bootstrapFile, 'utf8')
    fs.rmSync(bootstrapFile, { force: true })
    const parsed = JSON.parse(raw)
    return {
      bridgeUrl: parsed.bridgeUrl,
      bearerToken: parsed.token,
    }
  }

  return { bridgeUrl: undefined, bearerToken: undefined }
}

const { bridgeUrl, bearerToken } = loadBridgeCredentials()

const tools = [
  {
    name: 'create_session',
    description:
      'Create a real downstream Orrery agent session/node and connect it from the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent preset to launch, for example claude-code.',
        },
        prompt: {
          type: 'string',
          description: 'Instruction for the new session.',
        },
        context: {
          type: 'string',
          description: 'Optional handoff context for the new session.',
        },
        cluster: {
          type: 'string',
          description: 'Optional cluster id for the new node.',
        },
        label: {
          type: 'string',
          description: 'Optional human-readable label.',
        },
      },
      required: ['agent', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'resume_session',
    description:
      'Append a user message to an existing Orrery session and resume that real session/node.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target Orrery session id. This is also the graph node id.',
        },
        message: {
          type: 'string',
          description: 'User message to append before resuming the target session.',
        },
        context: {
          type: 'string',
          description: 'Optional additional context for the resumed turn.',
        },
      },
      required: ['sessionId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'deliver',
    description:
      'Write data into another Orrery session\'s context channel without activating it. ' +
      'Omit content to forward your latest turn summary and workspace diff (the artifact bundle).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target Orrery session id. This is also the graph node id.',
        },
        topic: {
          type: 'string',
          description:
            'Optional semantic key. A newer delivery on the same topic supersedes older ones, for example diff.',
        },
        note: {
          type: 'string',
          description: 'Optional short note stored alongside the payload.',
        },
        content: {
          type: 'string',
          description: 'Optional payload text written into the delivery directory.',
        },
        filename: {
          type: 'string',
          description: 'Optional file name for the content payload, defaults to content.md.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'activate',
    description:
      'Run one turn on an existing Orrery session. The activation message is assembled by the ' +
      'runtime: your optional note plus the list of unread channel deliveries.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target Orrery session id. This is also the graph node id.',
        },
        note: {
          type: 'string',
          description: 'Optional instruction to prepend to the delivery listing.',
        },
        reason: {
          type: 'string',
          description: 'Optional rationale recorded on the activation for the blackboard.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'approve_activation',
    description:
      'Allow a pending subscription activation you govern to execute. The runtime then delivers ' +
      'the trigger payload and activates the target with the assembled message.',
    inputSchema: {
      type: 'object',
      properties: {
        slotKey: {
          type: 'string',
          description: 'The pending activation slot key from the request you received.',
        },
        note: {
          type: 'string',
          description: 'Optional extra instructions appended to the target activation message.',
        },
      },
      required: ['slotKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'deny_activation',
    description: 'Reject a pending subscription activation you govern.',
    inputSchema: {
      type: 'object',
      properties: {
        slotKey: {
          type: 'string',
          description: 'The pending activation slot key from the request you received.',
        },
        reason: {
          type: 'string',
          description: 'Why the activation is denied (recorded on the blackboard).',
        },
      },
      required: ['slotKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'link_sessions',
    description:
      'Declare a visible relationship edge from the current session to another Orrery session/node.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target Orrery session id to link to. This is also the graph node id.',
        },
        label: {
          type: 'string',
          description: 'Optional short edge label, for example reviews or depends-on.',
        },
        reason: {
          type: 'string',
          description: 'Optional explanation shown as the edge detail.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'report',
    description:
      'Submit a typed verdict, relationship, or info report to the Orrery graph blackboard.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['verdict', 'relationship', 'info'],
          description: 'Report payload kind.',
        },
        verdict: {
          type: 'string',
          description: 'Verdict value for type=verdict, for example clean or issues.',
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              file: { type: 'string' },
              line: { type: 'number' },
              severity: {
                type: 'string',
                enum: ['info', 'warn', 'error'],
              },
            },
            required: ['message'],
            additionalProperties: false,
          },
        },
        summary: { type: 'string' },
        target: {
          type: 'string',
          description: 'Relationship target for type=relationship.',
        },
        nature: { type: 'string' },
        sessionRef: { type: 'string' },
        payload: {
          description: 'Free-form payload for type=info.',
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
]

let buffer = ''
let transportMode = 'line'

function send(message) {
  const payload = JSON.stringify(message)
  if (transportMode === 'header') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
    return
  }

  process.stdout.write(`${payload}\n`)
}

function respond(id, result) {
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result })
  }
}

function fail(id, code, message) {
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code, message } })
  }
}

async function callBridge(tool, input) {
  if (!bridgeUrl || !bearerToken) {
    throw new Error('Orrery membrane bridge is not configured for this run.')
  }

  const response = await fetch(`${bridgeUrl}/membrane/${tool}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input ?? {}),
  })

  const text = await response.text()
  const parsed = text.length > 0 ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(parsed.error ?? `Bridge request failed: ${response.status}`)
  }

  return parsed
}

async function handleMessage(message) {
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'orrery_membrane', version: '0.1.0' },
    })
    return
  }

  if (message.method === 'notifications/initialized') {
    return
  }

  if (message.method === 'tools/list') {
    respond(message.id, { tools })
    return
  }

  if (message.method === 'tools/call') {
    const toolName = message.params?.name
    if (!tools.some((tool) => tool.name === toolName)) {
      fail(message.id, -32602, `Unknown tool: ${toolName}`)
      return
    }

    try {
      const result = await callBridge(toolName, message.params?.arguments)
      respond(message.id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      })
    } catch (error) {
      respond(message.id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      })
    }
    return
  }

  if (message.id !== undefined) {
    fail(message.id, -32601, `Unknown method: ${message.method}`)
  }
}

function consumeHeaderDelimitedMessages() {
  while (buffer.startsWith('Content-Length:')) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) {
      return
    }

    const header = buffer.slice(0, headerEnd)
    const lengthMatch = /^Content-Length:\s*(\d+)/im.exec(header)
    if (!lengthMatch) {
      throw new Error('Missing MCP Content-Length header')
    }

    const length = Number(lengthMatch[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + length
    if (buffer.length < bodyEnd) {
      return
    }

    const body = buffer.slice(bodyStart, bodyEnd)
    buffer = buffer.slice(bodyEnd)

    try {
      void handleMessage(JSON.parse(body))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
  }
}

function consumeLineDelimitedMessages() {
  let newlineIndex = buffer.indexOf('\n')
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    newlineIndex = buffer.indexOf('\n')

    if (line.length === 0) {
      continue
    }

    try {
      void handleMessage(JSON.parse(line))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  if (buffer.startsWith('Content-Length:')) {
    transportMode = 'header'
    consumeHeaderDelimitedMessages()
    return
  }

  consumeLineDelimitedMessages()
})
