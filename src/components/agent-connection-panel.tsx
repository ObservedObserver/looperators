import { GitPullRequestArrow, Loader2, Play, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AgentConnectionState } from '@/hooks/use-agent-connection';
import type { GraphState } from '@/shared/graph-state';
import { cn } from '@/lib/utils';
import type { AgentConnectionBehavior, AgentConnectionTiming } from '@shared/agent-connection';
import { AgentRuntimeFields, ReviewPolicyFields } from '@/components/workflow-form-fields';

const fieldClass = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[11.5px] outline-none focus:border-term-accent-hi/60';
const textAreaClass =
  'min-h-20 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px] leading-5 outline-none focus:border-term-accent-hi/60';

const behaviorChoices: Array<{ id: AgentConnectionBehavior; title: string; detail: string }> = [
  { id: 'handoff-once', title: 'Handoff once', detail: 'Continue the work once. No standing automation remains for a current result.' },
  { id: 'one-review', title: 'One review', detail: 'Review one result, then stop.' },
  { id: 'keep-reviewing', title: 'Keep reviewing', detail: 'Review now or next, then review every later completion.' },
  { id: 'review-loop', title: 'Review loop', detail: 'Send blocking issues back until the review is clean or reaches its cap.' },
];

function statusText(state: GraphState, sessionId: string) {
  const session = state.sessions[sessionId];
  return session ? `${session.label} · ${session.status}` : sessionId;
}

export function AgentConnectionPanel({ runtimeState, connection }: { runtimeState: GraphState; connection: AgentConnectionState }) {
  const draft = connection.draft;
  if (!draft) return null;
  const target = draft.target;
  const sourceStatus = runtimeState.sessions[draft.sourceSessionId]?.status;
  const sourceBusy = sourceStatus === 'running' || sourceStatus === 'pending';

  return (
    <aside
      className="absolute right-3 top-3 z-40 flex max-h-[calc(100%-1.5rem)] w-[360px] flex-col overflow-hidden rounded-xl border border-term-accent-hi/35 bg-background/97 shadow-xl backdrop-blur"
      aria-label="Connect Agents"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <GitPullRequestArrow className="size-3.5 text-lime-700 dark:text-lime-300" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em]">Connect Agents</h2>
          <p className="truncate text-[10px] text-muted-foreground">
            {statusText(runtimeState, draft.sourceSessionId)} →{' '}
            {target.kind === 'existing' ? statusText(runtimeState, target.sessionId) : target.label || 'New Agent'}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Cancel Agent connection" onClick={() => connection.setDraft(undefined)}>
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <fieldset className="space-y-2">
          <legend className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">When should it start?</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['current-result', 'Use current result', 'Deliver the latest completed artifact now.'],
                ['next-completion', 'Wait for next completion', 'Ignore history and start after a future turn finishes.'],
              ] as Array<[AgentConnectionTiming, string, string]>
            ).map(([id, title, detail]) => (
              <button
                key={id}
                type="button"
                disabled={id === 'current-result' && sourceBusy}
                className={cn(
                  'rounded-lg border p-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-accent-hi/40',
                  draft.timing === id ? 'border-term-accent-hi/55 bg-term-accent-hi/10' : 'border-border bg-card hover:border-term-accent-hi/35',
                  id === 'current-result' && sourceBusy && 'cursor-not-allowed opacity-45',
                )}
                onClick={() => connection.update({ timing: id })}
              >
                <span className="block text-[10.5px] font-semibold">{title}</span>
                <span className="mt-0.5 block text-[9.5px] leading-4 text-muted-foreground">
                  {id === 'current-result' && sourceBusy ? 'Available after the source Agent finishes; live workspaces are never snapshotted mid-turn.' : detail}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">What should the receiver do?</legend>
          <div className="grid gap-1.5">
            {behaviorChoices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className={cn(
                  'rounded-lg border px-2.5 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-accent-hi/40',
                  draft.behavior === choice.id ? 'border-term-accent-hi/55 bg-term-accent-hi/10' : 'border-border bg-card hover:border-term-accent-hi/35',
                )}
                onClick={() => connection.update({ behavior: choice.id })}
              >
                <span className="block text-[10.5px] font-semibold">{choice.title}</span>
                <span className="block text-[9.5px] leading-4 text-muted-foreground">{choice.detail}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {target.kind === 'new' ? (
          <section className="space-y-2" aria-label="New receiving Agent">
            <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">New receiving Agent</div>
            <label className="grid gap-1">
              <span className="text-[9.5px] text-muted-foreground">Name</span>
              <input className={fieldClass} value={target.label} onChange={(event) => connection.updateNewTarget({ label: event.target.value })} />
            </label>
            <AgentRuntimeFields
              value={target}
              instances={runtimeState.providerInstances}
              modelCatalogs={runtimeState.providerModelCatalogs}
              idPrefix="dynamic-agent"
              onChange={(value) => connection.updateNewTarget(value)}
            />
            <label className="grid gap-1">
              <span className="text-[9.5px] text-muted-foreground">Workspace</span>
              <input className={fieldClass} value={target.cwd} onChange={(event) => connection.updateNewTarget({ cwd: event.target.value })} />
            </label>
          </section>
        ) : null}

        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {draft.behavior === 'handoff-once' ? 'Handoff instruction' : 'Review instruction'}
          </span>
          <textarea className={textAreaClass} value={draft.instruction} onChange={(event) => connection.update({ instruction: event.target.value })} />
        </label>

        {draft.behavior === 'review-loop' ? (
          <section aria-label="Review loop stop conditions">
            <ReviewPolicyFields
              value={{ blockingMode: draft.blockingMode, customCriteria: draft.customCriteria, maxLaps: draft.maxLaps }}
              onChange={(value) => connection.update(value)}
            />
          </section>
        ) : null}

        {connection.validation.issues.length > 0 ? (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-[10.5px] leading-4 text-amber-800 dark:text-amber-300">
            {connection.validation.issues.map((issue) => (
              <div key={`${issue.field}:${issue.message}`}>{issue.message}</div>
            ))}
          </div>
        ) : null}
        {connection.isCheckingSetup ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/35 px-2.5 py-2 text-[10.5px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Checking project and provider setup…
          </div>
        ) : null}
        {connection.setupMessages.length > 0 ? (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-2.5 py-2 text-[10.5px] leading-4 text-rose-700 dark:text-rose-300">
            {connection.setupMessages.map((message) => (
              <div key={message}>{message}</div>
            ))}
          </div>
        ) : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-border p-3">
        <Button className="flex-1" variant="outline" onClick={() => connection.setDraft(undefined)}>
          Cancel
        </Button>
        <Button className="flex-1" disabled={!connection.isReady || connection.isStarting} onClick={() => void connection.start()}>
          {connection.isStarting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          Connect
        </Button>
      </footer>
    </aside>
  );
}
