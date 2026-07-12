# Agent Notes

For project vision and designs, please check the documentation under the `design-docs/`.

- Vision / initial idea: `design-docs/reactive-agent-session-graph.md` — why Orrery manages agents as a graph instead of a session list.
- Design (current source of truth for development): `design-docs/orrery-design.md` — the concrete control model (Skills membrane, Master Agent, scopes/clusters), UI shape, v1 scope, and the §12 Skill API.
- v1 plan: `design-docs/v1-implementation-plan.md` — phased implementation plan (critical path P0–P3 + parallel workstreams A–C), with goals and acceptance criteria.
- Internal implementation roadmap / current post-P4 baseline: `internal_docs/plans/master-agent-plan-council-implementation-plan.md` — Master-as-Intent-Compiler/Governor/Replanner, Plan Council as the first high-frequency workflow, reliability convergence, correlation/barriers, dynamic topology, and concurrency/safety. Its rationale and discussion replay live in `internal_docs/commit-log/2026-07-12-master-agent-plan-council-direction.md`. This roadmap supersedes the old priority of expanding manual canvas authoring first; existing kernel semantics remain governed by `design-docs/session-graph-kernel.md` until each migration phase lands.

- Verification: headless-first, three tiers — `npm run test:kernel` (kernel unit tests, fake providers allowed), `npm run acceptance:headless` (real-scenario acceptance on real providers with the cheap model preset, artifacts in `output/acceptance/`), then final UI acceptance. Commands and scenario-authoring rules: README §Verification and `design-docs/AGENTS.md`.

For development and technical planning, follow the design doc and the v1 plan.
