import type { AgentMessage, SessionId, SessionStatus } from './graph-state'

export type ProviderKind = 'claude-code' | 'codex' | 'legacy-claude-cli'

export type ProviderRuntimeMode =
  | 'approval-required'
  | 'auto-accept-edits'
  | 'full-access'

export type ProviderApprovalPolicy = 'untrusted' | 'on-request' | 'never'

export type ProviderSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

export type ProviderReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type ProviderInteractionMode = 'default' | 'plan'

export type ProviderRuntimeSettings = {
  runtimeMode: ProviderRuntimeMode
  approvalPolicy?: ProviderApprovalPolicy
  sandbox?: ProviderSandboxMode
  model?: string
  reasoningEffort?: ProviderReasoningEffort
  serviceTier?: string
  interactionMode?: ProviderInteractionMode
}

export const defaultProviderRuntimeSettings: ProviderRuntimeSettings = {
  runtimeMode: 'approval-required',
}

export type ProviderInstance = {
  providerInstanceId: string
  kind: ProviderKind
  label: string
  binaryPath?: string
  homePath?: string
  shadowHomePath?: string
  launchArgs?: string[]
  env?: Record<string, string>
}

export type ProviderSessionBinding = {
  sessionId: SessionId
  providerInstanceId: string
  providerSessionId?: string
  resumeCursor?: string
  cwd: string
  createdAt: string
  updatedAt: string
}

export type RawEnvelope = {
  source:
    | 'claude.sdk'
    | 'claude.sdk.permission'
    | 'claude.sdk.user-dialog'
    | 'codex.app-server.notification'
    | 'codex.app-server.request'
    | 'legacy.claude-cli.stream-json'
  method?: string
  messageType?: string
  payload: unknown
}

export type RuntimeStreamKind =
  | 'assistant_text'
  | 'reasoning_text'
  | 'reasoning_summary_text'
  | 'command_output'
  | 'file_change_output'

export type RuntimeItemKind =
  | 'tool_call'
  | 'command'
  | 'file_change'
  | 'reasoning'
  | 'turn_result'

export type RuntimeItemStatus = 'pending' | 'running' | 'completed' | 'failed'

export type RuntimeItem = {
  id: string
  sessionId: SessionId
  turnId?: string
  kind: RuntimeItemKind
  providerName?: string
  command?: string
  args?: string
  title: string
  status: RuntimeItemStatus
  input?: unknown
  output?: string
  error?: string
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  durationMs?: number
  raw?: RawEnvelope
}

export type RuntimeActivity = RuntimeItem & {
  sublines?: { key?: string; value: string }[]
}

export type RuntimeRequest = {
  id: string
  sessionId: SessionId
  turnId?: string
  kind: 'approval' | 'permission' | 'confirmation'
  title: string
  body?: string
  status: 'open' | 'approved' | 'denied' | 'resolved' | 'stale' | 'canceled'
  createdAt: string
  resolvedAt?: string
  raw?: RawEnvelope
}

export type UserInputRequest = {
  id: string
  sessionId: SessionId
  turnId?: string
  prompt: string
  placeholder?: string
  status: 'open' | 'answered' | 'resolved' | 'stale' | 'canceled'
  createdAt: string
  answeredAt?: string
  answer?: string
  raw?: RawEnvelope
}

export type RuntimePlanItem = {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type RuntimePlan = {
  id: string
  sessionId: SessionId
  turnId?: string
  title?: string
  items: RuntimePlanItem[]
  updatedAt: string
  raw?: RawEnvelope
}

export type ProviderRuntimeEvent =
  | {
      id: string
      ts: string
      type: 'turn.started'
      sessionId: SessionId
      turnId: string
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'turn.completed'
      sessionId: SessionId
      turnId: string
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'content.delta'
      sessionId: SessionId
      turnId?: string
      itemId?: string
      streamKind: RuntimeStreamKind
      text: string
      isSnapshot?: boolean
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'item.started'
      sessionId: SessionId
      item: RuntimeItem
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'item.updated'
      sessionId: SessionId
      item: RuntimeItem
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'item.completed'
      sessionId: SessionId
      item: RuntimeItem
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'request.opened'
      sessionId: SessionId
      request: RuntimeRequest
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'request.resolved'
      sessionId: SessionId
      requestId: string
      status?: RuntimeRequest['status']
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'user-input.requested'
      sessionId: SessionId
      request: UserInputRequest
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'user-input.answered'
      sessionId: SessionId
      requestId: string
      answer?: string
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'user-input.resolved'
      sessionId: SessionId
      requestId: string
      status?: UserInputRequest['status']
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'plan.updated'
      sessionId: SessionId
      plan: RuntimePlan
      raw?: RawEnvelope
    }
  | {
      id: string
      ts: string
      type: 'session.state'
      sessionId: SessionId
      status: SessionStatus
      raw?: RawEnvelope
    }

export type NativeProviderEvent = {
  id: string
  ts: string
  sessionId: SessionId
  providerKind: ProviderKind
  turnId?: string
  raw: RawEnvelope
}

export type SessionProjection = {
  sessionId: SessionId
  messages: AgentMessage[]
  activities: RuntimeActivity[]
  openRequests: RuntimeRequest[]
  userInputRequests: UserInputRequest[]
  staleRequests: RuntimeRequest[]
  staleUserInputRequests: UserInputRequest[]
  plans: RuntimePlan[]
  status: SessionStatus
  runtimeSettings?: ProviderRuntimeSettings
}
