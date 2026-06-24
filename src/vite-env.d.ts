/// <reference types="vite/client" />

import type {
  AssignMasterToClusterInput,
  CreateMasterForClusterInput,
  CreateRuntimeSessionInput,
  CreateRuntimeSessionResult,
  FreezeInput,
  GraphState,
  ResumeRuntimeSessionInput,
  RuntimeEvent,
  SetClusterLoopPolicyInput,
  SessionId,
  StartMasterLoopInput,
  StopMasterLoopInput,
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
        startMasterLoop: (
          input: StartMasterLoopInput
        ) => Promise<{ state: GraphState }>
        stopMasterLoop: (
          input: StopMasterLoopInput
        ) => Promise<{ state: GraphState }>
        freeze: (input: FreezeInput) => Promise<{ ok: boolean; state: GraphState }>
        onEvent: (listener: (event: RuntimeEvent) => void) => () => void
      }
    }
  }
}
