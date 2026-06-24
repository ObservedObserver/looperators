/// <reference types="vite/client" />

import type {
  AssignMasterToClusterInput,
  CreateMasterForClusterInput,
  CreateRuntimeSessionInput,
  CreateRuntimeSessionResult,
  GraphState,
  ResumeRuntimeSessionInput,
  RuntimeEvent,
  SetClusterLoopPolicyInput,
  SessionId,
  UpsertClusterInput,
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
        upsertCluster: (
          input: UpsertClusterInput
        ) => Promise<{ clusterId: string; state: GraphState }>
        createMasterForCluster: (
          input: CreateMasterForClusterInput
        ) => Promise<{ sessionId: SessionId; state: GraphState }>
        assignMasterToCluster: (
          input: AssignMasterToClusterInput
        ) => Promise<{ state: GraphState }>
        setClusterLoopPolicy: (
          input: SetClusterLoopPolicyInput
        ) => Promise<{ state: GraphState }>
        onEvent: (listener: (event: RuntimeEvent) => void) => () => void
      }
    }
  }
}
