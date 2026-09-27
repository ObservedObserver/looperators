import { memberInput } from './collaboration-helpers.mjs'
import { runThreadScenario } from './collaboration-thread.scenario.mjs'

export const name = 'collaboration-mixed-thread'
export const description = 'Claude Haiku and Codex Luna converge on an ordinary one-sentence thread goal after a paused update, without protocol instructions from the user or manual retry.'
// Claude is the runner's preflight provider; the two members use explicit per-run models.
export const providers = ['claude-code']
export const timeoutMs = 600_000

export async function run(ctx) {
  const claude = memberInput(ctx, 'Claude Reader')
  const codex = memberInput({ ...ctx, provider: { providerKind: 'codex' },
    modelPreset: { ...ctx.modelPreset, codex: { model: 'gpt-5.6-luna', reasoningEffort: 'low' } },
  }, 'Codex Checker')
  return runThreadScenario(ctx, {
    members: [
      { ...claude, role: 'Read the shared conversation and check the evidence.' },
      { ...codex, role: 'Check the shared evidence and whether the requested outcome is met.' },
    ],
    roomRequest: 'Please confirm that you have read this thread by replying exactly THREAD_READ_OK.',
    goal: 'Agree on the original root marker and the latest accepted human fact in this thread, stating both exact values in your conclusion.',
    update: 'The latest accepted human fact is FINAL_THREAD_271, replacing INITIAL_THREAD_271; the original root marker remains unchanged.',
  })
}
