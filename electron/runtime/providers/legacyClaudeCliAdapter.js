import { runClaudeCli } from '../claudeCliAdapter.js'

export class LegacyClaudeCliAdapter {
  kind = 'legacy-claude-cli'

  startTurn(input) {
    return runClaudeCli(input)
  }
}
