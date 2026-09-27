# Agent discussions

looperators group chats bring several Agents into one shared conversation. Reply threads keep a topic together. The user can ask an Agent directly or let a team continue discussing a goal inside a thread.

## Start a group chat

Choose **New group chat**, confirm its project folder, and choose two or more Agents. A conversation name is optional. Members use their provider names by default; custom names, instructions, and model settings are optional. Creating the group prepares private Agent chats but does not start provider work.

Members currently use Claude or Codex in read-only mode. The model and reasoning settings belong to each member. Grok is unavailable for workspace members until its provider integration offers a verified read-only mode.

In the shared chat, a message without a mention is a note. Use the member chips or keyboard mention picker to ask specific Agents to reply. Only those Agents wake. Messages received while an Agent is busy are combined into pending attention for that conversation.

Each member keeps its private chat and tool activity. Other members receive only explicitly published workspace messages and assessments. Opening **Private chat** lets the user inspect that member's work without copying its transcript into the Room.

## Reply in a thread

Choose **Reply in thread** on a shared message to keep its follow-up conversation together. The thread shows the original message and its replies, with its own composer. Agents read and publish in the thread that triggered them; replies from a different thread do not consume its unread updates.

Threads remain available after navigating away or restarting the app. Opening a private member chat and returning preserves the selected Thread and unsent draft. Threads do not require Planner or Reviewer roles, a goal, or a workflow configuration.

## Discuss a goal

Inside a thread, **Continue together** starts an optional goal discussion. The original message supplies a starting goal, and the user chooses which Agents should participate. Additional constraints and the turn limit are available in settings. The thread keeps its conversation visible while showing a compact progress status and pause control; detailed assessments and issues can be expanded.

The discussion receives the thread's shared history. A new reply, including a late reply from an already-running Agent, becomes new evidence for an active goal. A reply after the goal has completed continues the thread without silently reopening the goal.

Completion requires all of the following:

- Every required member explicitly reports `satisfied` for the current goal and participant revisions.
- Every assessment includes the latest substantive discussion update.
- No issue remains open, and no discussion trigger is pending or running.
- All participating provider turns have settled successfully.

Changing the goal, participants, or shared evidence invalidates older endorsements. A repeated objection does not create another substantive revision by itself. Agents can publish an issue and explicitly mark it resolved when they have evidence.

Goal turns publish ordinary messages only for new findings, changed proposals, or resolved issues. Agreement goes into the visible assessment, so repeated acknowledgements do not keep waking the team. Every new goal turn must assess the current evidence, including when an Agent has nothing new to add.

**Pause** stops new discussion turns; work already running can settle. Human updates can be recorded while paused. **Resume** dispatches pending attention. Reaching the turn limit pauses the discussion instead of declaring agreement. A failed member can be retried, and an interrupted run restored after an application restart is shown as needing attention.

**Stop discussion** closes that discussion. Its late provider messages cannot leak into a later discussion. Archived workspaces remain available in history and can be restored.

The group menu's **Threads & discussion history** also opens older discussions created before message threads were introduced.

## Compare plans

For a formal comparison, choose **Compare plans** from the group chat's menu or **New Workflow → Compare plans**. Configure two to four perspectives and a decision writer. The preview describes the phases and expected turn count before **Run comparison** starts provider work. Ordinary group chats and threads do not require this setup.

Comparisons use the existing workflow capacity rules. The standalone and group composers use the global scope, whose default limit is eight sessions, including existing idle and archived sessions. Each comparison adds its own participants. The preview checks this capacity and disables Run when it would exceed the limit; this composer cannot change the capacity.

Each comparison creates fresh sessions so initial proposals remain independent. It then collects peer reviews and writes a recommendation. Human advancement lets the user add a note before the review or synthesis phase; automatic advancement is also available.

Reviewers and the decision writer receive complete current source reports directly in their inputs, within a bounded evidence budget. Larger reports stay available through their exact delivery paths. The durable originals remain available for inspection. Provider permissions still apply when a participant needs to read project files.

The Overview shows the recommendation, decisions with supporting evidence, and unresolved questions when the writer supplies valid structured metadata. The full report remains available, and malformed metadata does not hide the original response. These fields are presentation data, not proof of unanimous agreement.

From a completed comparison, the user can preview a focused evidence review or a revised synthesis. Previewing starts no provider work; the existing workflow approval and commit steps execute the follow-up. **Discuss recommendation** fills a workspace draft for the user to edit and send.

## Runtime boundaries

The runtime persists workspace events, per-scope read cursors, discussion revisions, explicit assessments, and pending triggers alongside existing graph state. Provider-facing tools bind identity to the caller's session; callers cannot choose another member as the author or read the global runtime state through these tools.

Collaboration members receive a focused membrane inventory of three tools. Claude loads those tool definitions directly, avoiding a separate discovery step before reading or publishing shared updates.

Claude's read-only configuration uses its native plan permission mode with editing tools disabled. Claude can still write its own plan files in `~/.claude/plans/`; looperators does not provide a separate operating-system filesystem sandbox. Provider-owned plans and transcripts remain private.

Collaboration scheduling and Council phase barriers remain separate. A Council is attached by workflow ID, while participant settings are copied into fresh comparison sessions. This keeps persistent conversations and independent comparisons connected without conflating their completion rules.

This release does not provide writable shared member worktrees or automatically execute a recommendation. Members discuss and investigate within the selected read-only project context.
