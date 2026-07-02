// Acceptance-run configuration. Model presets live with the headless client
// (scripts/lib/model-presets.mjs) so named presets resolve everywhere; this
// module re-exports them for scenario code.
export { modelPresets } from '../../scripts/lib/model-presets.mjs'

export const defaultAcceptanceTimeoutMs = 300_000
