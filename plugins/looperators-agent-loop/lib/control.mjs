import { preview } from './control/draft.mjs';
import { applyGovernorDecision, rollForwardPrepared } from './control/history-apply.mjs';
import { bindWorker, prepareWorkerSpawn } from './control/legacy-identity.mjs';
import { previewLegacyRecovery, quarantineLegacy } from './control/legacy-recovery.mjs';
import { interruptForFactLimit } from './control/mutation-engine.mjs';
import { getLoop, getSnapshot, snapshotForRun } from './control/queries.mjs';
import { report } from './control/report-command.mjs';
import { cancel, pause, resume, start } from './control/root-commands.mjs';
import { LoopControlError } from './control/errors.mjs';
import { rootContextFromMcpMessage } from './control/input.mjs';

export { LoopControlError, rootContextFromMcpMessage };

export class LoopController {
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.fault = options.fault ?? (async () => {});
    this.actionTokens = new Map();
  }

  async preview(contextValue, input) {
    return preview(this, contextValue, input);
  }

  async previewLegacyRecovery(contextValue, input) {
    return previewLegacyRecovery(this, contextValue, input);
  }

  async quarantineLegacy(contextValue, input) {
    return quarantineLegacy(this, contextValue, input);
  }

  async getLoop(contextValue, input) {
    return getLoop(this, contextValue, input);
  }

  async getSnapshot(contextValue, input) {
    return getSnapshot(this, contextValue, input);
  }

  async snapshotForRun(targetRunIdValue, options = {}) {
    return snapshotForRun(this, targetRunIdValue, options);
  }

  async start(contextValue, input) {
    return start(this, contextValue, input);
  }

  async pause(contextValue, input) {
    return pause(this, contextValue, input);
  }

  async resume(contextValue, input) {
    return resume(this, contextValue, input);
  }

  async cancel(contextValue, input) {
    return cancel(this, contextValue, input);
  }

  async prepareWorkerSpawn(contextValue, input) {
    return prepareWorkerSpawn(this, contextValue, input);
  }

  async bindWorker(contextValue, input) {
    return bindWorker(this, contextValue, input);
  }

  async report(input) {
    return report(this, input);
  }

  async interruptForFactLimit(initialState, details = {}) {
    return interruptForFactLimit(this, initialState, details);
  }

  async rollForwardPrepared(initialState) {
    return rollForwardPrepared(this, initialState);
  }

  async applyGovernorDecision(state, decision) {
    return applyGovernorDecision(this, state, decision);
  }
}
