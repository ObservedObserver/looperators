export const providerKinds = ['claude-code', 'codex', 'grok'] as const

export type ProviderKind = (typeof providerKinds)[number]
export type ProviderAgentKind = ProviderKind
export type ProviderBackend = 'claude-agent-sdk' | 'codex-app-server' | 'grok-acp'

export type ProviderMetadata = {
  agent: ProviderAgentKind
  backend: ProviderBackend
  defaultInstanceId: string
  instanceLabel: string
  labelPrefix: string
  commandEnv: 'ORRERY_CLAUDE_BIN' | 'ORRERY_CODEX_BIN' | 'ORRERY_GROK_BIN'
  defaultCommand: string
  diagnosticPattern: RegExp
}

export const providerMetadata: Record<ProviderKind, ProviderMetadata> = {
  'claude-code': {
    agent: 'claude-code',
    backend: 'claude-agent-sdk',
    defaultInstanceId: 'default-claude-sdk',
    instanceLabel: 'Claude SDK',
    labelPrefix: 'Claude',
    commandEnv: 'ORRERY_CLAUDE_BIN',
    defaultCommand: 'claude',
    diagnosticPattern: /claude|auth|login|account|rate.?limit/i,
  },
  codex: {
    agent: 'codex',
    backend: 'codex-app-server',
    defaultInstanceId: 'default-codex',
    instanceLabel: 'Codex',
    labelPrefix: 'Codex',
    commandEnv: 'ORRERY_CODEX_BIN',
    defaultCommand: 'codex',
    diagnosticPattern: /codex|auth|login|account|rate.?limit/i,
  },
  grok: {
    agent: 'grok',
    backend: 'grok-acp',
    defaultInstanceId: 'default-grok',
    instanceLabel: 'Grok Build',
    labelPrefix: 'Grok',
    commandEnv: 'ORRERY_GROK_BIN',
    defaultCommand: 'grok',
    diagnosticPattern: /grok|xai|auth|login|account|rate.?limit/i,
  },
}

export const defaultProviderInstances = providerKinds.map((kind) => ({
  providerInstanceId: providerMetadata[kind].defaultInstanceId,
  kind,
  label: providerMetadata[kind].instanceLabel,
}))

export function providerKindForOrdinal(ordinal: number): ProviderKind {
  return providerKinds[((ordinal % providerKinds.length) + providerKinds.length) % providerKinds.length]
}

export function nextProviderKind(kind: ProviderKind): ProviderKind {
  return providerKindForOrdinal(providerKinds.indexOf(kind) + 1)
}
