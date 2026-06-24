/// <reference types="vite/client" />

import type {
  CreateRuntimeSessionInput,
  CreateRuntimeSessionResult,
  GraphState,
  ResumeRuntimeSessionInput,
  RuntimeEvent,
  SessionId,
} from './shared/graph-state'

declare global {
  interface Window {
    orrery?: {
      platform: string
      runtime: {
        getState: () => Promise<GraphState>
        createSession: (
          input: CreateRuntimeSessionInput
        ) => Promise<CreateRuntimeSessionResult>
        resumeSession: (
          input: ResumeRuntimeSessionInput
        ) => Promise<{ ok: boolean; state: GraphState }>
        killSession: (
          sessionId: SessionId
        ) => Promise<{ ok: boolean; state: GraphState }>
        onEvent: (listener: (event: RuntimeEvent) => void) => () => void
      }
    }
  }
}
