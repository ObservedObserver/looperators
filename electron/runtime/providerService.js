import { LegacyClaudeCliAdapter } from './providers/legacyClaudeCliAdapter.js'
import { ClaudeAgentSdkAdapter } from './providers/claudeAgentSdkAdapter.js'
import { CodexAppServerAdapter } from './providers/codexAppServerAdapter.js'

export class ProviderService {
  #adapters

  constructor({ adapters } = {}) {
    this.#adapters =
      adapters ??
      new Map([
        ['legacy-claude-cli', new LegacyClaudeCliAdapter()],
        ['claude-code', new ClaudeAgentSdkAdapter()],
        ['codex', new CodexAppServerAdapter()],
      ])
  }

  startTurn(input) {
    const providerKind = input.providerKind ?? 'legacy-claude-cli'
    const adapter = this.#adapters.get(providerKind)
    if (!adapter) {
      throw new Error(`Unsupported provider runtime: ${providerKind}`)
    }

    return adapter.startTurn(input)
  }

  closeAll() {
    for (const adapter of this.#adapters.values()) {
      if (typeof adapter.closeAll === 'function') {
        adapter.closeAll()
      }
    }
  }
}
