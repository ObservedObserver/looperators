#!/usr/bin/env node

import fs from 'node:fs'

function loadBridgeCredentials() {
  const bootstrapFile = process.env.ORRERY_MEMBRANE_BOOTSTRAP_FILE
  if (typeof bootstrapFile === 'string' && bootstrapFile.length > 0) {
    const raw = fs.readFileSync(bootstrapFile, 'utf8')
    // Some MCP clients (Codex app-server) spawn the server several times per
    // run — discovery, inventory, session — so the bootstrap file must
    // survive until the run's handoff dir is cleaned up. Claude runs spawn
    // once and keep the delete-after-read hygiene.
    if (process.env.ORRERY_MEMBRANE_BOOTSTRAP_KEEP !== '1') {
      fs.rmSync(bootstrapFile, { force: true })
    }
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
          enum: ['claude-code', 'codex', 'grok'],
          description: 'Agent provider to launch: claude-code, codex, or grok.',
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
    name: 'inspect_scope',
    description:
      'Master-only, read-only. Inspect the governed Scope capability, summary, paged session refs, and workflow refs before proposing work.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Opaque pagination cursor from the previous response.' },
        pageSize: { type: 'number', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_workflow_wakeups',
    description:
      'Master-only, read-only. List durable Governor wakeups for the governed Scope, including coalesced failure, cap, missing-report, human-change, permission, and milestone facts.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['pending', 'notified', 'acknowledged', 'superseded'] },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'acknowledge_workflow_wakeup',
    description:
      'Master-only. Mark a durable Governor wakeup handled when no Workflow Patch is needed. Include a concise reason.',
    inputSchema: {
      type: 'object',
      properties: {
        wakeupId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['wakeupId', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'advance_plan_council',
    description:
      'Master-only. Advance a Plan Council phase that is explicitly delegated to the governing Master after inspecting the ready milestone.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        wakeupId: { type: 'string' },
        reason: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      required: ['workflowId', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_workflow',
    description:
      'Master-only. Create a durable, reviewable Workflow Proposal without creating sessions, relationships, or provider turns. ' +
      'Recipes: review input={coder,reviewer,blocking,maxLaps}; goal input={worker,goal,maxLaps,judgeProviderInstanceId?,judgeModel?}; ' +
      'handoff input={source,target,note}; plan-council input={objective,cwd,reviewFocus?,planners[2..8],synthesizer,reviewTopology?,coordinatorSessionId?}. ' +
      'For Plan Council, planners contains only the requested independent planners; cross-review is a built-in phase derived from reviewTopology, so never add a reviewer or cross-review entry as another planner. ' +
      'Councils above 4 planners must set reviewTopology="hub-and-spoke".',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', enum: ['review', 'goal', 'handoff', 'plan-council'] },
        objective: { type: 'string', description: 'User-facing outcome this workflow should achieve.' },
        input: {
          type: 'object',
          description:
            'The selected recipe input. New participants may omit provider/model/cwd/runtime settings to inherit safe Master defaults; always include their role-specific prompt or instruction. ' +
            'For plan-council, put exactly the requested number of independent planners in planners. Do not represent cross-review as a participant: the runtime creates the cross-review phase and relationships automatically.',
          properties: {
            objective: { type: 'string' },
            cwd: { type: 'string' },
            reviewFocus: { type: 'string' },
            planners: {
              type: 'array',
              minItems: 2,
              maxItems: 8,
              description:
                'Independent Plan Council planners only. The array length must equal the number requested by the user; do not add cross-review or reviewer entries.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  label: { type: 'string' },
                  prompt: { type: 'string' },
                  providerKind: { type: 'string', enum: ['claude-code', 'codex', 'grok'] },
                  providerInstanceId: { type: 'string' },
                  runtimeSettings: { type: 'object' },
                },
                required: ['prompt'],
              },
            },
            synthesizer: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                prompt: { type: 'string' },
                providerKind: { type: 'string', enum: ['claude-code', 'codex', 'grok'] },
                providerInstanceId: { type: 'string' },
                runtimeSettings: { type: 'object' },
              },
              required: ['prompt'],
            },
            reviewTopology: {
              type: 'string',
              enum: ['full-mesh', 'hub-and-spoke'],
              description: 'Omit for the full-mesh default. Councils above four planners require hub-and-spoke.',
            },
            coordinatorSessionId: { type: 'string' },
          },
        },
        reason: { type: 'string', description: 'Why this recipe and topology fit the user intent.' },
        expiresAt: { type: 'string', description: 'Optional ISO-8601 expiration time.' },
        idempotencyKey: { type: 'string', description: 'Stable key for retrying the same proposal.' },
      },
      required: ['recipe', 'objective', 'input', 'reason', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_workflow_patch',
    description:
      'Master-only. Propose a versioned, reviewable incremental patch to an active Workflow. ' +
      'Supported operations: replace-participant, add-verifier, add-dynamic-triage, stop-branch, change-relationship-policy, and Plan Council resynthesize. ' +
      'Every operations item uses the discriminator field op (not type). For add-verifier use {op:"add-verifier", verifier:{key,label,prompt,...}, observes:[participantKey]}; verifier fields are nested under verifier. ' +
      'add-dynamic-triage installs a bounded typed-issues create action from a fixed validated template; it never accepts prompt interpolation or raw graph authoring. ' +
      'The proposal records impact and rollback information and does not mutate the running graph.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        baseVersion: { type: 'number' },
        wakeupIds: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            description:
              'A constrained patch operation. Always set op. Participant specs may select a new provider or an existing in-Scope session.',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'replace-participant',
                  'add-verifier',
                  'add-dynamic-triage',
                  'stop-branch',
                  'change-relationship-policy',
                  'resynthesize',
                ],
              },
              participantKey: { type: 'string' },
              replacement: { type: 'object' },
              verifier: {
                type: 'object',
                description:
                  'Required for add-verifier. The key is the stable Workflow participant key; new verifiers may inherit provider and workspace fields from an observed participant.',
                properties: {
                  key: { type: 'string' },
                  label: { type: 'string' },
                  role: { type: 'string' },
                  prompt: { type: 'string' },
                  kind: { type: 'string', enum: ['new', 'existing'] },
                  sessionId: { type: 'string' },
                  providerKind: { type: 'string', enum: ['claude-code', 'codex', 'grok'] },
                  providerInstanceId: { type: 'string' },
                  runtimeSettings: { type: 'object' },
                  workspace: {
                    type: 'object',
                    properties: {
                      cwd: { type: 'string' },
                      access: { type: 'string', enum: ['read', 'write'] },
                      workMode: { type: 'string', enum: ['local', 'worktree'] },
                      branch: { type: 'string' },
                    },
                  },
                },
                required: ['key', 'prompt'],
              },
              observes: { type: 'array', items: { type: 'string' }, minItems: 1 },
              trigger: { type: 'string', enum: ['finished', 'report'] },
              gate: { type: 'string', enum: ['auto', 'master', 'human'] },
              stop: { type: 'string' },
              relationshipKey: { type: 'string' },
              relationshipKeys: { type: 'array', items: { type: 'string' } },
              sourceParticipantKey: { type: 'string' },
              ownerParticipantKey: { type: 'string' },
              action: { type: 'object' },
              maxFirings: { type: 'number', minimum: 1 },
              reason: { type: 'string' },
            },
            required: ['op'],
          },
          minItems: 1,
        },
        idempotencyKey: { type: 'string' },
      },
      required: ['workflowId', 'baseVersion', 'reason', 'operations', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'revise_workflow',
    description:
      'Master-only. Revise an existing uncommitted Proposal after feedback. Human-locked participants and relationships cannot be changed.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        recipe: { type: 'string', enum: ['review', 'goal', 'handoff', 'plan-council'] },
        objective: { type: 'string' },
        input: { type: 'object', description: 'Complete replacement input for the recipe.' },
        reason: { type: 'string' },
      },
      required: ['proposalId', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_workflow',
    description:
      'Master-only, read-only. Return a Proposal explanation including participants, relationships, safety policy, Graph Diff, warnings, and errors.',
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
      additionalProperties: false,
    },
  },
  {
    name: 'commit_workflow',
    description:
      'Master-only. Commit an already human-approved Proposal through the unified command executor. Never call this before approval.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        expectedBaseVersion: { type: 'number', minimum: 0 },
        idempotencyKey: { type: 'string', description: 'Required stable retry key for this exact commit.' },
        reason: { type: 'string' },
      },
      required: ['proposalId', 'expectedBaseVersion', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'abort_workflow',
    description: 'Master-only. Abort an uncommitted Workflow Proposal in the governed Scope.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['proposalId', 'reason'],
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
