# looperators

> **Design the loop, not every prompt.**

looperators is a **loop-native agent tool** for building, running, and
visualizing long-running workflows between code-agent sessions.

<img width="3202" height="1518" alt="looperators-2" src="https://github.com/user-attachments/assets/cf02610e-0c44-4a1b-91cf-cb23a1a9d2b8" />

Connect Claude Code, Codex, and Grok Build so that one session can wake another,
pass along context, request a review, return failed work for repair, or react to
an external event. Keep the relationship alive for one handoff, for a bounded
loop, or as a persistent watcher that responds whenever its trigger fires.

Start with a goal or a ready-made loop—not an empty canvas. For more complex
work, a Master Agent can propose the sessions, roles, feedback paths, triggers,
and stopping conditions for you. The graph becomes a live view and control
surface for collaboration that is already happening.

## Agents should not be islands

Most coding-agent tools treat every session as an island. You become both the
message bus and the loop engine: read Agent A, copy its output to Agent B, carry
the feedback back to A, and repeat.

looperators changes that default. Sessions live in relationships. They can wake
one another, exchange context, review one another, return work upstream, and
continue until a real stopping condition is met.

Two questions shape the product:

> When you step away, does the workflow keep moving?
>
> When you return, can you quickly understand what happened and why?

## Not another workflow builder

Traditional workflow tools ask you to manually assemble a pipeline before work
can begin. looperators starts with an outcome.

Choose a ready-made loop or describe the goal to a Master Agent. The system can
propose the participants, relationships, permissions, and stopping conditions.
You inspect the proposal, approve it, and use the graph to understand or change
the workflow—not to draw every step from scratch.

| Traditional workflow builder           | looperators                                                           |
| -------------------------------------- | --------------------------------------------------------------------- |
| Starts from an empty canvas            | Starts from a goal or ready-made loop                                 |
| Nodes are stateless actions            | Nodes are long-lived agent sessions                                   |
| Edges mainly route data forward        | Relationships carry context, reviews, evidence, retries, and triggers |
| Optimized for a DAG and its happy path | Rejection, repair, return paths, and repeated verification are native |
| The graph describes a planned pipeline | The graph remains live while agents work                              |

Unlike systems that call a model as a disposable step, every looperators node
remains a real session. Open it as a normal chat, inspect its messages and tool
activity, intervene, freeze future activations, or resume it with its existing
history.

## The graph defines the loop; prompts define the work

looperators does not need a built-in action for every job an agent might
perform.

Code review, testing, research, migration, triage, summarization, and security
analysis can all be expressed through prompts. The graph supplies the reusable
control semantics around them:

- what event triggers the next session;
- what context moves with the handoff;
- whether a transition is automatic or requires judgment;
- what happens when new work arrives while an agent is busy;
- what result, goal, deadline, or limit stops the loop;
- which relationships remain active for future events.

“Review until clean” is therefore one useful loop, not a special-purpose
boundary around what looperators can do. Change the prompts and the same shape
becomes a security audit, test-and-fix cycle, migration checker, or verification
workflow.

## Loops you can build

### Review until clean

One agent implements a change. Another reviews it and returns blocking issues.
The findings reactivate the original session, which repairs the work and sends
it back for another pass.

<img width="3840" height="1986" alt="looperators-review" src="https://github.com/user-attachments/assets/3af4c02e-aa7b-435c-b2e9-98997bae88d8" />


The loop stops only when the Reviewer reports clean or a configured guardrail
is reached. Every lap, verdict, and return path remains visible.

### Multi-model planning and debate

Run several agents or models as independent planners, let them read and
challenge one another, and then synthesize the strongest result.

The built-in **Plan Council** preserves the proposals, disagreements, peer
reviews, and route to the final decision—not only the final answer. More complex
deliberation workflows can continue exchanging feedback until a consensus rule
or round limit is met.

### Divide, verify, and repair

Give different sessions distinct responsibilities: investigate, implement,
review, test, and verify. Independent branches can work in parallel and rejoin
when all, any, or a quorum of results is ready.

A failed verifier can route its evidence back to the responsible session; a
passing verdict can release the next stage. Verification becomes part of the
workflow rather than a final prompt someone must remember to run.

### Run until the goal is actually done

Describe “done” in one sentence and pair a Worker with an independent Judge.
The Judge can use executable evidence—tests, lint, metrics, searches, or other
checks—then return a structured verdict.

A failed check sends the evidence back to the Worker. A passing check stops the
loop. The Worker does not get to declare itself finished simply because it made
progress.

### Watch and react

A loop does not have to begin with a person sending a message. It can wake on a
schedule, a Git change, a script result, a webhook, or another registered
event.

Use this for recurring maintenance, CI failure response, code-change review,
issue triage, or scheduled summaries. Leave out the stopping condition and a
relationship can remain ready for the next event.

## How it works

### Long-lived sessions

Each participant is a real code-agent session with its own history, context,
model, tools, and workspace state. A loop resumes the session that already knows
the work instead of recreating a disposable agent at every step.

### Executable relationships

Relationships define who reacts to whom, what wakes the next session, what
context moves, whether approval is required, and when work returns upstream or
stops. They are durable rules, not lines drawn after execution.

### Outcome-first creation

Start with **Review until clean**, **Run until goal**, **Handoff**, or **Plan
Council**, or describe a more complex objective to a Master Agent. The Master
acts as an intent compiler: it proposes the participants, relationships, safety
policy, and graph changes without silently starting work.

You can review and lock the proposal before approval. Once a stable workflow is
running, the Master only needs to wake for judgment, exceptions, or replanning;
it does not sit in the middle of every mechanical transition.

### A live graph and timeline

The graph brings together three views of the same work:

- **Intent:** the relationships that say what should happen next.
- **Activity:** the turns, handoffs, triggers, verdicts, and failures that
  already happened—and why.
- **Governance:** the approvals, locks, scopes, and Master roles that determine
  who may change the workflow.

Loops appear as readable units with their current lap, state, stop condition,
and timeline. See whether a loop is running, waiting for a gate, blocked,
complete, frozen, or stopped by a guardrail, then open the exact session or
event that explains it.

## Deterministic mechanics, agentic judgment

Reliable agent loops need both.

looperators handles the mechanical parts deterministically: event matching,
context delivery, activation, joins, stopping rules, concurrency behavior,
persistence, recovery, and resource limits. If new events arrive while an agent
is busy, they can be coalesced so the agent handles the latest accumulated state
once instead of processing a queue of stale intermediate work.

Agents handle the parts that require judgment: planning, implementation,
review, synthesis, diagnosis, and deciding whether evidence satisfies the
goal.

That separation keeps loops flexible without asking a model—or a person—to
remember how to route every turn.

## Built to be left running

Autonomy is useful only when its limits are explicit. Depending on the loop,
looperators can enforce:

- maximum laps, deadlines, fan-out, concurrency, and session limits;
- automatic, Master Agent, or human approval gates;
- optional usage warnings or hard budgets;
- workspace coordination so parallel writers do not silently collide;
- durable workflow state, artifacts, decisions, and causal history;
- freeze, stop, retry, and consistent recovery controls.

The goal is not simply to start more agents. It is to make long-running agent
collaboration visible, bounded, and safe enough to trust.

## Get started

looperators is under active development and currently runs from source. Install
and authenticate at least one supported code agent—Claude Code, Codex, or Grok
Build. From the project directory, run:

```sh
npm install
npm run dev
```

Start with **New Workflow** for a ready-made loop, or open a Master chat to
describe a more complex objective. Chat and the Agent graph remain available
throughout the run.

## Project status

looperators is an early alpha. Interfaces, storage contracts, and advanced
controls may evolve before a stable release.

The current build includes direct agent chats, the live Agent graph, handoffs,
Review-until-clean loops, Goal loops, Plan Council, schedules and external
triggers, loop timelines, Master-authored workflow proposals and replanning,
barriers, persistent state, usage and concurrency controls.

Please report rough edges, failed setups, unclear concepts, and workflows you
would like to run. Early feedback will directly shape the product.

## License

Licensed under the [Apache License 2.0](./LICENSE).
