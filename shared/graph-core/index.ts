// graph-core: the pure, IO-free logic of the session graph kernel.
// Baseline design: design-docs/session-graph-kernel.md (§2 math model,
// §6 operators, §7 schemas). Wired into the runtime in G3.

export * from './types.js'
export { applyEvent, fold } from './fold.js'
export {
  graphScopeId,
  scopeChain,
  lowestCommonScope,
  governingMaster,
  reportRoute,
} from './scope.js'
export {
  evaluate,
  matchesPattern,
  eventSourceSession,
  type SchedulerDecision,
} from './scheduler.js'
export {
  staticCheck,
  defaultCycleMaxFirings,
  type StaticCheckResult,
  type StaticCheckViolation,
} from './static-check.js'
