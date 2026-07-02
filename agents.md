# Agent Notes

For project vision and designs, please check the documentation under the `design-docs/`.

- Vision / initial idea: `design-docs/reactive-agent-session-graph.md` — why Orrery manages agents as a graph instead of a session list.
- Design (current source of truth for development): `design-docs/orrery-design.md` — the concrete control model (Skills membrane, Master Agent, scopes/clusters), UI shape, v1 scope, and the §12 Skill API.
- v1 plan: `design-docs/v1-implementation-plan.md` — phased implementation plan (critical path P0–P3 + parallel workstreams A–C), with goals and acceptance criteria.

- Verification: headless-first, three tiers — `npm run test:kernel` (kernel unit tests, fake providers allowed), `npm run acceptance:headless` (real-scenario acceptance on real providers with the cheap model preset, artifacts in `output/acceptance/`), then final UI acceptance. Commands and scenario-authoring rules: README §Verification and `design-docs/AGENTS.md`.

For development and technical planning, follow the design doc and the v1 plan.
