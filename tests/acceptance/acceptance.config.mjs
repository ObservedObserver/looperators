// Model presets for headless real-scenario acceptance runs. Presets are keyed
// by providerKind and merged into createSession runtimeSettings by the
// headless client; a scenario's explicit runtimeSettings always win.
// Models ride the per-session runtime-settings path, so acceptance runs never
// touch the developer's global Claude Code / Codex configuration.
export const modelPresets = {
  cheap: {
    'claude-code': { model: 'claude-haiku-4-5' },
    codex: { model: 'gpt-5.3-codex-spark' },
  },
}

export const defaultAcceptanceTimeoutMs = 300_000
