import type { AgentGraphModel } from "@looperators/agent-graph-ui";

export function projectionToAgentGraphModel(
  value: unknown,
  options?: {
    expectedProjectionDigest?: string;
    expectedRunId?: string;
  },
): AgentGraphModel;
