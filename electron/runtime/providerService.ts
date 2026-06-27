import { LegacyClaudeCliAdapter } from './providers/legacyClaudeCliAdapter.js'
import { ClaudeAgentSdkAdapter } from './providers/claudeAgentSdkAdapter.js'
import { CodexAppServerAdapter } from './providers/codexAppServerAdapter.js'

type ProviderAdapter = {
  startTurn: (input: Record<string, any>) => any
  closeAll?: () => void
}

export class ProviderService {
  #adapters: Map<string, ProviderAdapter>

  constructor({ adapters }: { adapters?: Map<string, ProviderAdapter> } = {}) {
    this.#adapters =
      adapters ??
      new Map<string, ProviderAdapter>([
        ['legacy-claude-cli', new LegacyClaudeCliAdapter()],
        ['claude-code', new ClaudeAgentSdkAdapter()],
        ['codex', new CodexAppServerAdapter()],
      ])
  }

  startTurn(input: Record<string, any>) {
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
