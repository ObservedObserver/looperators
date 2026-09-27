# Agent discussions: headless acceptance

Date: 2026-09-27. Status: the revised single-provider and mixed-provider chat-thread flows passed. Mixed convergence was verified after the goal-prompt correction with a plain user goal and no manual retries. Earlier passing journeys remain recorded below as historical evidence.

UI acceptance subsequently found a publish-only follow-up that left the author with a stale assessment and no pending turn. Discussion publication now queues the author too, while a current same-turn assessment removes the redundant pending turn. Two kernel regressions cover repeated publish-only follow-ups and publish-then-assess without an extra turn. The product direction now starts with ordinary chat reply threads and optionally adds a goal in that thread. New thread tests and the `collaboration-thread` real scenario cover that revised behavior; earlier passing results below remain historical evidence.

A later mixed-provider UI attempt repeatedly published agreement or status messages, invalidating earlier assessments; one follow-up ended without participation. The goal was cancelled with evidence preserved. The runtime did not falsely complete it. Product prompts now distinguish ordinary chat replies from goal contributions: publish only new evidence or changed proposals, record agreement through the visible assessment, and reassess the current version on every goal turn. The new `collaboration-mixed-thread` scenario uses a plain one-sentence user goal and does not supply assessment-only protocol instructions or manual retries.

The revised collaboration kernel file passed 24/24 tests after the final build (`/tmp/orrery-thread-kernel-final24.log`). Its nine added thread regressions cover scoped read cursors and publication, independent pending turns for the same member, root and recovery reference validation, persisted thread-to-goal context, late provider evidence and paused mentions, completed-goal stability, retry scope, and a non-required source whose outstanding thread work must block completion. Independent review also found and resolved two attention-origin bugs: an unrelated thread failure must not contaminate a previously successful source thread, and an explicit goal-turn origin must not fall back to an older failed thread when retried.

These are real-provider runs against isolated runtime storage and temporary project directories outside the checkout. No global provider configuration or saved model preset was changed. Successful scenarios require idle member sessions, settled collaboration triggers, and an empty provider queue.

## Passing evidence

| Scenario | Provider / model | Run ID | Settled provider turns | Result |
| --- | --- | --- | ---: | --- |
| `collaboration-room` | Claude / `claude-haiku-4-5` | `2026-09-27T21-24-43-873Z` | 1 | Pass, no manual intervention |
| `collaboration-discussion` | Claude / `claude-haiku-4-5` | `2026-09-27T21-21-58-138Z` | 4 | Pass, no manual intervention |
| `collaboration-room` | Codex / `gpt-5.6-luna`, low effort | `2026-09-27T21-04-52-856Z` | 1 | Pass |
| `collaboration-discussion` | Codex / `gpt-5.6-luna`, low effort | `2026-09-27T21-04-52-856Z` | 4 | Pass |
| `plan-council-follow-up` | Codex / `gpt-5.6-luna`, low effort | `2026-09-27T21-33-22-419Z` | 7 | Pass, three precise one-time reads |
| `collaboration-thread` | Claude / `claude-haiku-4-5` | `2026-09-27T22-01-31-131Z` | 5 | Pass on revised thread implementation, no intervention |
| `collaboration-mixed-thread` | Claude / `claude-haiku-4-5` + Codex / `gpt-5.6-luna`, low effort | `2026-09-27T22-19-59-910Z` | 5 | Pass with plain user goal, no intervention or retry |

The recorded passing runs contain 27 settled provider turns: 17 from the earlier matrix, five from the single-provider thread flow, and five from the mixed-provider thread flow. Claude room and discussion runs took 17 and 36 seconds; Council took 118 seconds; the single-provider and mixed-provider thread scenarios took 56 and 62 seconds.

The mixed scenario used the ordinary goal “Agree on the original root marker and the latest accepted human fact in this thread, stating both exact values in your conclusion.” Neither that goal nor its human update mentioned tools or required an assessment-only response. Product prompts supplied the protocol. Both providers submitted current satisfied assessments at goal revision 1, cohort revision 1, and substantive sequence 10. The only ordinary public Agent message was the initial requested thread acknowledgement; the goal turns published no redundant acknowledgement or completion messages. Five triggers completed, both sessions were idle, and there were zero attention notices, permission requests, pending triggers, queued runs, or active leases. No retry or manual intervention occurred, and no failed mixed headless attempt was omitted.

The final thread run reused exactly two member sessions across ordinary reply, goal creation, pause, a human thread update mentioning both members, resume, and completion. The paused mentions did not schedule separate room turns. Both current assessments referenced substantive sequence 10 and included the original root marker plus the final human fact. All five triggers completed, both sessions were idle, and there were no permission requests, queued runs, or active leases. An ordinary unaddressed reply after completion left the goal closed. Evidence is in `thread-paused-evidence.json` and `thread-completion-evidence.json` for the listed run.

Room checks cover provider-cold creation, an unaddressed shared note that starts no work, one explicitly mentioned member publishing exactly once, and a second member that never runs. Discussion checks cover pause, a human update saved while paused, resume, and explicit endorsements from both members tied to the current goal, participant set, and substantive message sequence. The older assessments cannot complete the updated discussion.

Deterministic kernel regressions separately cover repeated `not_satisfied` without a wakeup loop, failed members and interrupted restarts never completing, stale assessments after new evidence, private turns with queued mentions, cancellation, cursor scoping, and persisted paused triggers. Those fake-provider tests are kernel evidence, not additional real-provider acceptance runs.

The Council run verified two independent proposals, two peer reviews incorporating a human update, initial synthesis, a preview that creates no specialist session or provider work, one source-based specialist verification, and a revised synthesis incorporating its token. It ended with seven artifacts, synthesis versions 1 and 2, four idle sessions, no open requests, an empty run queue, and zero active workspace leases. All sessions retained read-only settings and the fixture file was unchanged. Exactly three single-use README approvals occurred: two planners and the specialist. No channel-file request or persistent grant was needed.

## Model selection

The saved `cheap` preset requests `gpt-5.3-codex-spark`, which this machine's current Codex ChatGPT account rejected as unsupported. A live catalog query returned `gpt-5.6-luna` as a fast, efficient available model. The Codex runs used an in-memory process override to that model with low effort; the mixed scenario injects the same setting directly into its Codex member. This is an explicit lightweight fallback, not a claim about verified per-token pricing. Claude used the unchanged `claude-haiku-4-5` preset.

## Failed attempts and diagnosis

Failures remain in the local artifact history. They are not counted as passing acceptance.

| Run ID | Scenario / outcome | Diagnosis and response |
| --- | --- | --- |
| `2026-09-27T21-03-16-537Z` | Both Codex collaboration scenarios failed at startup | The account rejected Spark. Failed triggers and a degraded discussion were preserved; the discussion did not falsely complete. Queried the live catalog before choosing the process override. |
| `2026-09-27T21-03-10-945Z` | Claude room passed; discussion timed out | One member assessed successfully. The other attempted a shell placeholder instead of invoking the exposed collaboration tool and waited for write permission. No write was approved. The timeout retained artifacts and the harness stopped the unfinished member. |
| `2026-09-27T21-09-10-181Z` | Claude room passed; discussion stopped | Full tool names and explicit instructions against shell simulation did not resolve the second member's behavior. Captured the open request, stopped that member, and retained failure evidence. Prompt-only repetition was discontinued. |
| `2026-09-27T21-07-04-398Z` | Council failed before any provider session existed | The acceptance helper omitted the idempotency key required by workflow authoring. Added unique command and idempotency IDs. Zero provider turns were started. |
| `2026-09-27T21-09-12-099Z` | Council stopped during initial proposals | Codex requested approval for the exact read-only README command. Added a narrow, one-time approval handler rather than changing provider sandbox or approval policy. |
| `2026-09-27T21-14-15-989Z` | Council completed two proposals, then failed during peer review | The handler approved two exact README reads. A reviewer then requested a malformed path for a delivered proposal file, outside the whitelist. The scenario failed immediately and retained artifacts. |
| `2026-09-27T21-22-00-903Z` | Council completed proposals, peer reviews, and initial synthesis, then failed during specialist verification | All four source artifacts were inline, but the activation's generic channel footer still required reading delivered files. After the third exact README approval, the specialist requested a channel glob read. That request was not approved; the scenario failed immediately. Five completed turns and five artifacts were retained. |

The Council approval handler accepts only the exact `sed -n '1,240p' README.md` command, optionally wrapped by `/bin/zsh -lc`, after checking the native request source, session cwd, requested cwd, sole read action, and canonical fixture path. It sends `accept` once for that request. It never sends an execpolicy amendment or session-wide grant. Approvals are recorded in `fixture-read-approvals.json`; other permissions and user-input requests fail the scenario.

The final Claude discussion used a collaboration-specific membrane profile with only the three collaboration tools and eager tool schemas through Claude's `alwaysLoad` setting. Membership selects the profile; ordinary sessions keep their existing tool configuration. All four turns settled without permission requests, shell workarounds, or human intervention.

Council now embeds complete current proposal and review artifacts as JSON records in review, synthesis, retry, and specialist prompts. The inline evidence has a 64 KiB budget; larger artifacts are deferred whole to their durable channel paths. Independent initial proposals receive no peer evidence, superseded artifacts are excluded, and peer reviewers do not receive their own proposal as a peer source. This addresses the malformed delivery-path request found during real acceptance while retaining durable artifact storage.

Inline delivery topics also travel through activation metadata to the channel footer. The footer omits file paths for complete inline sources and lists exact paths only for deferred sources. Specialist delivery topics use the same source identity as the inline metadata; versioned filenames remain durable. This removes the contradictory file-read instruction found in the next real run.

## Artifacts and reproduction

Artifacts are stored locally under `output/acceptance/<run-id>/<scenario>/`. Each directory contains `result.json`, `graph-state.json`, the event timeline, and per-session transcripts. Additional files contain routing or completion assertions, exact read approvals, or sanitized permission-blockage evidence. This report does not reproduce private transcripts or account identifiers.

After building the runtime, the Claude matrix command is:

```sh
node scripts/acceptance-runner.mjs --filter collaboration --provider claude-code
```

The tested Codex override is process-local:

```js
import { modelPresets } from './scripts/lib/model-presets.mjs'
modelPresets.cheap.codex = { model: 'gpt-5.6-luna', reasoningEffort: 'low' }
process.argv = ['node', 'scripts/acceptance-runner.mjs', '--filter', 'collaboration', '--provider', 'codex']
await import('./scripts/acceptance-runner.mjs')
```

Use `plan-council-follow-up` as the filter for the Council scenario. Recheck the live model catalog if the account or installed provider changes. These runs do not replace final UI acceptance.

Use `--filter collaboration-thread --provider claude-code` to reproduce only the revised five-turn thread flow. Its first real run passed; no failed thread acceptance attempt was omitted.

Use `--filter collaboration-mixed-thread --provider claude-code` for the mixed flow. The runner preflights Claude; the scenario explicitly configures both Claude and Codex members. Both providers must be available. Member models and the final public evidence are recorded in `thread-completion-evidence.json`.

All six new acceptance modules passed `node --check`, and `git diff --check` passed. Independent product review found no remaining actionable issue in the final collaboration tool profile, thread scope and attention provenance, Council inline delivery metadata, or corrected goal-turn prompts. Kernel tests already assert the specialist's actual activation footer; the real Council scenario additionally verifies the completed source-based result and fails immediately on any unexpected permission request.

The UI pass separately found that six existing runtime sessions plus three Council members exceed the default global eight-session cap. The capacity check was correct, but the preview had omitted it. The corrected composer uses the shared workflow compiler and validator before Run, and its authoring helper stops an invalid server proposal before approval. Four focused regressions and independent review passed without changing the scope or its limit. Final visual verification is recorded in the UI report.
