import { GitBranch, Link2, Play, RotateCw, Trash2, UserRoundPlus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { GraphState } from '@/shared/graph-state';
import type { DraftGraphState } from '@/hooks/use-draft-graph';
import type { DraftAgentEndpoint, DraftRelationKind } from '@shared/draft-graph';
import { AgentRuntimeFields, ReviewPolicyFields } from '@/components/workflow-form-fields';

const fieldClass = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[11.5px] outline-none focus:border-violet-500/60';
const textAreaClass =
  'min-h-20 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px] leading-5 outline-none focus:border-violet-500/60';

const relationChoices: Array<{ kind: DraftRelationKind; title: string; detail: string }> = [
  { kind: 'handoff-once', title: 'Handoff once', detail: 'Run the receiver once after the source finishes, then remove the automation.' },
  { kind: 'trigger-on-completion', title: 'Trigger on completion', detail: 'Run the receiver after every future source completion.' },
  { kind: 'review-loop', title: 'Review loop', detail: 'Review each result and send blocking issues back until clean.' },
];

function relationTitle(kind: DraftRelationKind) {
  return relationChoices.find((choice) => choice.kind === kind)?.title ?? kind;
}

function endpointLabel(endpoint: DraftAgentEndpoint | undefined) {
  if (!endpoint) return 'Unknown Agent';
  return endpoint.kind === 'new' ? endpoint.label || 'Untitled Agent' : 'Existing Agent';
}

export function DraftWorkflowPanel({ runtimeState, draft }: { runtimeState: GraphState; draft: DraftGraphState }) {
  const selection = draft.graph.selection;
  const selectedNode = selection?.kind === 'node' ? draft.graph.nodes[selection.id] : undefined;
  const selectedNewEndpoint = selectedNode?.endpoint.kind === 'new' ? selectedNode.endpoint : undefined;
  const selectedRelation = selection?.kind === 'relation' ? draft.graph.relations[selection.id] : undefined;
  const incomingReview = selectedNode
    ? draft.graph.relationOrder
        .map((relationId) => draft.graph.relations[relationId])
        .find((relation) => relation.kind === 'review-loop' && relation.targetNodeId === selectedNode.id)
    : undefined;
  const selectedIssues = draft.validation.issues.filter(
    (issue) => issue.target === 'graph' || (selection && issue.target === selection.kind && issue.id === selection.id),
  );

  const updateEndpoint = (endpoint: DraftAgentEndpoint) => {
    if (selectedNode) draft.updateNodeEndpoint(selectedNode.id, endpoint);
  };

  const updateNewEndpoint = (patch: Partial<Extract<DraftAgentEndpoint, { kind: 'new' }>>) => {
    if (!selectedNode || selectedNode.endpoint.kind !== 'new') return;
    updateEndpoint({ ...selectedNode.endpoint, ...patch });
  };

  return (
    <aside className="absolute right-3 top-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[340px] flex-col overflow-hidden rounded-xl border border-violet-500/35 bg-background/97 shadow-xl backdrop-blur">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <UserRoundPlus className="size-3.5 text-violet-500" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em]">Draft workflow</h2>
          <p className="text-[10px] text-muted-foreground">Configure first. No Agent runs until Run workflow.</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close Draft selection"
          onClick={() => {
            draft.setPendingConnection(undefined);
            draft.dispatch({ type: 'select', selection: undefined });
          }}
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {draft.pendingConnection ? (
          <div className="space-y-2.5">
            <div>
              <h3 className="text-[12px] font-semibold">Choose the Relationship</h3>
              <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground">
                {endpointLabel(draft.graph.nodes[draft.pendingConnection.sourceNodeId]?.endpoint)} →{' '}
                {endpointLabel(draft.graph.nodes[draft.pendingConnection.targetNodeId]?.endpoint)}
              </p>
            </div>
            <div className="grid gap-2">
              {relationChoices.map((choice) => (
                <button
                  key={choice.kind}
                  type="button"
                  className="rounded-lg border border-border bg-card p-2.5 text-left transition hover:border-violet-500/55 hover:bg-violet-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
                  onClick={() => draft.confirmConnection(choice.kind)}
                >
                  <span className="block text-[11.5px] font-semibold">{choice.title}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-4 text-muted-foreground">{choice.detail}</span>
                </button>
              ))}
            </div>
            <Button className="w-full" variant="ghost" size="sm" onClick={() => draft.setPendingConnection(undefined)}>
              Cancel
            </Button>
          </div>
        ) : selectedNode ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold">Configure Agent</h3>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${selectedNode.id}`}
                onClick={() => draft.dispatch({ type: 'remove-node', id: selectedNode.id })}
              >
                <Trash2 className="size-3.5 text-rose-500" />
              </Button>
            </div>
            {selectedNewEndpoint ? (
              <>
                <label className="grid gap-1">
                  <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Agent name</span>
                  <input className={fieldClass} value={selectedNewEndpoint.label} onChange={(event) => updateNewEndpoint({ label: event.target.value })} />
                </label>
                <AgentRuntimeFields
                  value={{
                    providerKind: selectedNewEndpoint.providerKind,
                    providerInstanceId: selectedNewEndpoint.providerInstanceId,
                    model: selectedNewEndpoint.runtimeSettings.model ?? '',
                    reasoningEffort: selectedNewEndpoint.runtimeSettings.reasoningEffort ?? 'medium',
                    runtimeMode: selectedNewEndpoint.runtimeSettings.runtimeMode,
                  }}
                  instances={runtimeState.providerInstances}
                  modelCatalogs={runtimeState.providerModelCatalogs}
                  idPrefix={`draft-${selectedNode.id}`}
                  onChange={(value) =>
                    updateNewEndpoint({
                      providerKind: value.providerKind,
                      providerInstanceId: value.providerInstanceId,
                      runtimeSettings: {
                        ...selectedNewEndpoint.runtimeSettings,
                        model: value.model || undefined,
                        reasoningEffort: value.reasoningEffort,
                        runtimeMode: value.runtimeMode,
                      },
                    })
                  }
                />
                <label className="grid gap-1">
                  <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    <GitBranch className="size-3" /> Workspace
                  </span>
                  <input
                    className={fieldClass}
                    value={
                      incomingReview
                        ? `Shared with ${endpointLabel(draft.graph.nodes[incomingReview.sourceNodeId]?.endpoint)} at Run`
                        : selectedNewEndpoint.cwd
                    }
                    disabled={Boolean(incomingReview)}
                    onChange={(event) => updateNewEndpoint({ cwd: event.target.value })}
                  />
                </label>
                {incomingReview ? (
                  <p className="rounded-lg border border-violet-500/25 bg-violet-500/5 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
                    Reviewers share the Coder&apos;s final checkout automatically, including a newly created worktree. Provider, model, and reasoning stay independent.
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Work mode</span>
                    <select
                      className={fieldClass}
                      value={selectedNewEndpoint.workMode}
                      disabled={Boolean(incomingReview)}
                      onChange={(event) => updateNewEndpoint({ workMode: event.target.value as 'local' | 'worktree' })}
                    >
                      <option value="local">Local</option>
                      <option value="worktree">Worktree</option>
                    </select>
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Base branch</span>
                    <input
                      className={fieldClass}
                      value={selectedNewEndpoint.branch ?? ''}
                      disabled={Boolean(incomingReview) || selectedNewEndpoint.workMode !== 'worktree'}
                      onChange={(event) => updateNewEndpoint({ branch: event.target.value })}
                    />
                  </label>
                </div>
                <label className="grid gap-1">
                  <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Prompt</span>
                  <textarea
                    className={textAreaClass}
                    value={selectedNewEndpoint.prompt}
                    onChange={(event) => updateNewEndpoint({ prompt: event.target.value })}
                  />
                </label>
              </>
            ) : null}
          </div>
        ) : selectedRelation ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Link2 className="size-3.5 text-violet-500" />
              <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold">{relationTitle(selectedRelation.kind)}</h3>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${selectedRelation.id}`}
                onClick={() => draft.dispatch({ type: 'remove-relation', id: selectedRelation.id })}
              >
                <Trash2 className="size-3.5 text-rose-500" />
              </Button>
            </div>
            <label className="grid gap-1">
              <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Relationship</span>
              <select
                className={fieldClass}
                value={selectedRelation.kind}
                onChange={(event) => {
                  const kind = event.target.value as DraftRelationKind;
                  draft.dispatch({
                    type: 'update-relation',
                    id: selectedRelation.id,
                    patch: {
                      kind,
                      review: kind === 'review-loop' ? (selectedRelation.review ?? { blocking: { mode: 'p0-p1' }, maxLaps: 6 }) : undefined,
                    },
                  });
                }}
              >
                {relationChoices.map((choice) => (
                  <option key={choice.kind} value={choice.kind}>
                    {choice.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                {selectedRelation.kind === 'review-loop' ? 'Review instruction' : 'Activation note'}
              </span>
              <textarea
                className={textAreaClass}
                value={selectedRelation.instruction}
                onChange={(event) => draft.dispatch({ type: 'update-relation', id: selectedRelation.id, patch: { instruction: event.target.value } })}
              />
            </label>
            {selectedRelation.kind === 'review-loop' ? (
              <ReviewPolicyFields
                value={{
                  blockingMode: selectedRelation.review?.blocking.mode ?? 'p0-p1',
                  customCriteria: selectedRelation.review?.blocking.customCriteria ?? '',
                  maxLaps: String(selectedRelation.review?.maxLaps ?? 6),
                }}
                onChange={(value) =>
                  draft.dispatch({
                    type: 'update-relation',
                    id: selectedRelation.id,
                    patch: {
                      review: {
                        blocking: {
                          mode: value.blockingMode,
                          ...(value.blockingMode === 'custom' ? { customCriteria: value.customCriteria } : {}),
                        },
                        maxLaps: Number(value.maxLaps),
                      },
                    },
                  })
                }
              />
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-3 text-[11px] leading-5 text-muted-foreground">
            Select a Draft Agent to configure it, or drag from one connection handle to another to choose a Relationship.
          </div>
        )}

        {selectedIssues.length > 0 ? (
          <div className="mt-3 rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-700 dark:text-amber-300">Before Run</div>
            <ul className="mt-1.5 space-y-1 text-[10.5px] leading-4 text-muted-foreground">
              {selectedIssues.map((issue) => (
                <li key={`${issue.target}:${issue.id ?? 'graph'}:${issue.field}`}>• {issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {draft.isCheckingSetup ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/35 p-2.5 text-[10.5px] text-muted-foreground">
            <RotateCw className="size-3 animate-spin" /> Checking project and provider setup…
          </div>
        ) : null}
        {draft.setupMessages.length > 0 ? (
          <div className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/10 p-2.5 text-[10.5px] leading-4 text-rose-700 dark:text-rose-300">
            {draft.setupMessages.map((message) => (
              <div key={message}>{message}</div>
            ))}
          </div>
        ) : null}
      </div>

      <footer className="grid grid-cols-[auto_1fr] gap-2 border-t border-border p-3">
        <Button variant="outline" size="sm" disabled={draft.isStarting} onClick={draft.discard}>
          <Trash2 className="size-3.5" />
          Discard
        </Button>
        <Button size="sm" disabled={!draft.isReady || draft.isStarting} onClick={() => void draft.start()}>
          {draft.isStarting ? <RotateCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {draft.isStarting ? 'Starting…' : 'Run workflow'}
        </Button>
      </footer>
    </aside>
  );
}
