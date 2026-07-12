import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const membraneServerPath = path.join(__dirname, 'membraneMcpServer.js')

const commonCliPaths = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function buildPath() {
  const currentPath = process.env.PATH ?? ''
  // Respect the user's configured runtime first. Common GUI-app fallback
  // paths come afterwards so they cannot shadow a newer CLI already on PATH.
  return [currentPath, ...commonCliPaths].filter(Boolean).join(path.delimiter)
}

export function claudeCommand() {
  return process.env.ORRERY_CLAUDE_BIN || 'claude'
}

export const membraneToolNames = [
  'mcp__orrery_membrane__create_session',
  'mcp__orrery_membrane__resume_session',
  'mcp__orrery_membrane__deliver',
  'mcp__orrery_membrane__activate',
  'mcp__orrery_membrane__approve_activation',
  'mcp__orrery_membrane__deny_activation',
  'mcp__orrery_membrane__report',
  'mcp__orrery_membrane__link_sessions',
]

export function membraneSystemPrompt() {
  return [
    'You are running inside Orrery.',
    'Use the orrery_membrane MCP tools when you need to affect the agent graph:',
    '- mcp__orrery_membrane__create_session creates a real downstream session/node.',
    '- mcp__orrery_membrane__resume_session appends a user message to an existing session/node and resumes it.',
    '- mcp__orrery_membrane__deliver writes data into another session\'s context channel without activating it (omit content to forward your latest turn summary and diff).',
    '- mcp__orrery_membrane__activate runs one turn on an existing session; the runtime prefixes your note with the list of its unread channel deliveries.',
    '- mcp__orrery_membrane__approve_activation / deny_activation decide a pending subscription activation you govern (you receive these requests with a slotKey).',
    '- mcp__orrery_membrane__report submits typed verdict, relationship, or info data to the graph blackboard.',
    '- mcp__orrery_membrane__link_sessions declares a visible relationship edge to another session/node.',
    'Sessions have a context channel (an inbox directory outside the repo): deliveries you receive are listed in your activation message with absolute file paths — read those files before acting.',
    'Do not invent session ids. Use ids returned by create_session or provided in the user prompt.',
  ].join('\n')
}

function writeJson0600(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), {
    encoding: 'utf8',
    mode: 0o600,
  })
  fs.chmodSync(filePath, 0o600)
}

export function createMcpHandoff(membrane, { keepBootstrap = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-membrane-'))
  fs.chmodSync(dir, 0o700)

  const bootstrapPath = path.join(dir, 'bootstrap.json')
  const configPath = path.join(dir, 'mcp-config.json')

  writeJson0600(bootstrapPath, {
    bridgeUrl: membrane.bridgeUrl,
    token: membrane.token,
  })

  writeJson0600(configPath, {
    mcpServers: {
      orrery_membrane: {
        command: process.execPath,
        args: [membraneServerPath],
        env: {
          ORRERY_MEMBRANE_BOOTSTRAP_FILE: bootstrapPath,
          ...(keepBootstrap ? { ORRERY_MEMBRANE_BOOTSTRAP_KEEP: '1' } : {}),
        },
      },
    },
  })

  return { dir, configPath }
}

export function cleanupMcpHandoff(handoff) {
  if (handoff) {
    fs.rmSync(handoff.dir, { recursive: true, force: true })
  }
}

export function expandHomePath(value) {
  if (!nonEmptyString(value)) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed === '~') {
    return os.homedir()
  }
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}
