// Named model presets for headless runs. Presets are keyed by providerKind
// and merged into createSession runtimeSettings by the headless client; a
// caller's explicit runtimeSettings always win. Models ride the per-session
// runtime-settings path, so headless runs never touch the developer's global
// Claude Code / Codex configuration.
export const modelPresets = {
  cheap: {
    'claude-code': { model: 'claude-haiku-4-5' },
    codex: { model: 'gpt-5.3-codex-spark' },
  },
}
