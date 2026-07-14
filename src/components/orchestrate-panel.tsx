import { Bot, ClipboardCheck, CirclePlay, GitBranch, MessageSquarePlus, MessagesSquare, Orbit, Snowflake, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TermChip, TermLabel, termInputCls, termTextareaCls, termActionBtnCls } from '@/components/terminal';
import { statePillBase } from '@/lib/session-display';
import { loopPolicySummary, loopStateStatus } from '@/lib/graph-view';
import { ProviderSegmentedControl, ProjectCwdField } from '@/components/new-chat-setup';
import { compactId } from '@/lib/format';
import { workflowStatusPillClassName, WorkflowStep, WorkflowSummaryRow } from '@/components/workflow';
import { type Dispatch, type SetStateAction } from 'react';
import { type RailTab } from '@/lib/layout-prefs';
import { type RuntimeCoreState } from '@/hooks/use-runtime-core';
import { type NewChatSetupState } from '@/hooks/use-new-chat-setup';
import { type SessionActionsState } from '@/hooks/use-session-actions';
import { type OrchestrationState } from '@/hooks/use-orchestration';

type OrchestratePanelProps = {
  core: RuntimeCoreState;
  newChat: NewChatSetupState;
  actions: SessionActionsState;
  orchestration: OrchestrationState;
  setActiveTab: Dispatch<SetStateAction<RailTab>>;
  activeClusterId: string | undefined;
  setActiveClusterId: Dispatch<SetStateAction<string | undefined>>;
};

export function OrchestratePanel({ core, newChat, actions, orchestration, setActiveTab, activeClusterId, setActiveClusterId }: OrchestratePanelProps) {
  const { isRuntimeAvailable, runtimeState, setSelectedSessionId, selectedSession, selectedSessionFrozen, selectedSessionIsMaster } = core;
  const { newProviderKind, newCwd, setNewCwd, changeNewProviderKind, newCwdValidation } = newChat;
  const { setPendingLinkedSourceId } = actions;
  const {
    clusterLabel,
    setClusterLabel,
    maxIterations,
    setMaxIterations,
    masterPrompt,
    setMasterPrompt,
    isUpdatingCluster,
    isCreatingMaster,
    isStartingLoop,
    isStoppingLoop,
    isFreezingSelected,
    isFreezingCluster,
    clusters,
    activeCluster,
    workflowManagedNodeIds,
    activeManagedSessions,
    activeMasterSession,
    activeLoopStatus,
    activeLoopIterations,
    activeLoopMaxIterations,
    activeLoopReason,
    activeLoopLastEvent,
    activeLoopCoder,
    activeLoopReviewer,
    canStartLoop,
    canStopLoop,
    canFreezeSelectedSession,
    selectedSessionInheritedFreeze,
    canFreezeActiveCluster,
    setupSteps,
    currentLoopPolicy,
    upsertManagedCluster,
    saveLoopPolicy,
    createMasterForCluster,
    assignSelectedAsMaster,
    startMasterLoop,
    stopMasterLoop,
    freezeSelectedSession,
    freezeActiveCluster,
    unfreezeSelectedSession,
    unfreezeActiveCluster,
  } = orchestration;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
      <section className="space-y-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-mono text-[12px]">
              <Orbit className="size-3.5 text-accent-ink" />
              <span className="text-foreground">Advanced orchestration</span>
            </div>
            <p className="mt-1 font-mono text-[11px] leading-4 text-muted-foreground">Master and cluster controls for governed workflows</p>
          </div>
          <span
            className={cn(
              statePillBase,
              activeLoopStatus === 'running'
                ? 'border-term-amber/30 bg-term-amber/10 text-term-amber'
                : activeCluster?.frozen
                  ? 'border-border bg-muted text-muted-foreground'
                  : 'border-ink-line bg-foreground/[0.04] text-term-dim',
            )}
          >
            {activeCluster?.frozen ? 'frozen' : activeLoopStatus}
          </span>
        </div>

        <div className="grid gap-2">
          {setupSteps.map((step, index) => (
            <WorkflowStep key={step.title} index={index + 1} title={step.title} detail={step.detail} status={step.status} />
          ))}
        </div>
      </section>

      <section className="space-y-2.5 rounded-lg border border-ink-line bg-ink p-3 font-mono">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="size-3.5 text-term-cyan" />
          <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">Active workflow</span>
          <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">{activeCluster ? activeManagedSessions.length : 0} managed</span>
        </div>

        <div className="space-y-1.5">
          <WorkflowSummaryRow label="cluster">{activeCluster?.label ?? <span className="text-term-faint">none</span>}</WorkflowSummaryRow>
          <WorkflowSummaryRow label="workers">
            {activeManagedSessions.length ? (
              <span className="flex flex-wrap gap-1.5">
                {activeManagedSessions.slice(0, 4).map((session) => (
                  <TermChip key={session.sessionId}>{session.label}</TermChip>
                ))}
                {activeManagedSessions.length > 4 ? <TermChip>+{activeManagedSessions.length - 4}</TermChip> : null}
              </span>
            ) : (
              <span className="text-term-faint">none</span>
            )}
          </WorkflowSummaryRow>
          <WorkflowSummaryRow label="master">
            {activeMasterSession ? (
              <button
                type="button"
                className="max-w-full truncate text-term-amber underline-offset-2 hover:underline"
                onClick={() => {
                  setPendingLinkedSourceId(null);
                  setSelectedSessionId(activeMasterSession.sessionId);
                  setActiveTab('chat');
                }}
              >
                {activeMasterSession.label}
              </button>
            ) : (
              <span className="text-term-faint">none</span>
            )}
          </WorkflowSummaryRow>
          <WorkflowSummaryRow label="policy">
            {activeCluster ? (
              (loopPolicySummary(activeCluster) ?? <span className="text-term-faint">none</span>)
            ) : (
              <span className="text-term-faint">none</span>
            )}
          </WorkflowSummaryRow>
          <WorkflowSummaryRow label="loop">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  statePillBase,
                  activeLoopStatus === 'running'
                    ? 'border-term-amber/30 bg-term-amber/10 text-term-amber'
                    : 'border-ink-line bg-foreground/[0.04] text-term-dim',
                )}
              >
                {activeLoopStatus}
              </span>
              <span className="tabular-nums text-term-cyan">
                {activeLoopIterations}/{activeLoopMaxIterations}
              </span>
            </span>
          </WorkflowSummaryRow>
          <WorkflowSummaryRow label="coder">{activeLoopCoder?.label ?? <span className="text-term-faint">none</span>}</WorkflowSummaryRow>
          <WorkflowSummaryRow label="reviewer">{activeLoopReviewer?.label ?? <span className="text-term-faint">none</span>}</WorkflowSummaryRow>
          <WorkflowSummaryRow label="last">
            <span className="truncate">{activeLoopLastEvent}</span>
          </WorkflowSummaryRow>
          <WorkflowSummaryRow label="reason">
            {activeLoopReason ?? activeCluster?.freezeReason ?? <span className="text-term-faint">none</span>}
          </WorkflowSummaryRow>
          <WorkflowSummaryRow label="frozen">
            {activeCluster?.frozen ? (
              <span className="inline-flex items-center gap-1 text-term-amber">
                <Snowflake className="size-3" />
                {activeCluster.freezeReason ?? 'yes'}
              </span>
            ) : (
              <span className="text-term-dim2">no</span>
            )}
          </WorkflowSummaryRow>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2 font-mono">
          <GitBranch className="size-3.5 text-accent-ink" />
          <span className="text-[12px] text-foreground">1. Cluster scope</span>
          <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">{workflowManagedNodeIds.length} managed</span>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
          <label className="min-w-0 space-y-1.5">
            <TermLabel>cluster name</TermLabel>
            <input className={termInputCls} value={clusterLabel} onChange={(event) => setClusterLabel(event.target.value)} />
          </label>
          <label className="space-y-1.5">
            <TermLabel>max turns</TermLabel>
            <input
              className={cn(termInputCls, 'tabular-nums')}
              inputMode="numeric"
              min={1}
              max={100}
              type="number"
              value={maxIterations}
              onChange={(event) => setMaxIterations(event.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <TermChip tone="accent">Governed loop policy</TermChip>
          <TermChip>Freeze on stop</TermChip>
          <TermChip>Max {currentLoopPolicy().maxIterations}</TermChip>
        </div>

        <div className="rounded-lg border border-ink-line bg-ink px-3 py-2 font-mono">
          <WorkflowSummaryRow label="workers">
            {workflowManagedNodeIds.length ? (
              <span className="flex flex-wrap gap-1.5">
                {workflowManagedNodeIds.slice(0, 4).map((sessionId) => (
                  <TermChip key={sessionId}>{runtimeState.sessions[sessionId]?.label ?? compactId(sessionId)}</TermChip>
                ))}
                {workflowManagedNodeIds.length > 4 ? <TermChip>+{workflowManagedNodeIds.length - 4}</TermChip> : null}
              </span>
            ) : (
              <span className="text-term-faint">canvas selection or current worker chat</span>
            )}
          </WorkflowSummaryRow>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            className={termActionBtnCls}
            variant="outline"
            disabled={!isRuntimeAvailable || isUpdatingCluster || workflowManagedNodeIds.length === 0}
            onClick={upsertManagedCluster}
          >
            <GitBranch className="size-4 shrink-0" />
            <span className="truncate">Save cluster</span>
          </Button>
          <Button
            className={termActionBtnCls}
            variant="outline"
            disabled={!isRuntimeAvailable || isUpdatingCluster || !activeClusterId}
            onClick={saveLoopPolicy}
          >
            <ClipboardCheck className="size-4 shrink-0" />
            <span className="truncate">Save policy</span>
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2 font-mono">
          <Bot className="size-3.5 text-term-amber" />
          <span className="text-[12px] text-foreground">2. Master chat</span>
          <span className="ml-auto truncate text-[10.5px] text-muted-foreground">{activeMasterSession?.label ?? 'none'}</span>
        </div>

        <ProjectCwdField value={newCwd} validation={newCwdValidation} disabled={isCreatingMaster} onChange={setNewCwd} />

        <div className="space-y-1.5">
          <TermLabel>provider</TermLabel>
          <ProviderSegmentedControl value={newProviderKind} disabled={isCreatingMaster} onChange={changeNewProviderKind} />
        </div>

        <label className="block space-y-1.5">
          <TermLabel>master instructions</TermLabel>
          <textarea
            className={cn(termTextareaCls, 'min-h-20 max-h-32 text-xs leading-5')}
            value={masterPrompt}
            onChange={(event) => setMasterPrompt(event.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <Button
            className={termActionBtnCls}
            disabled={!isRuntimeAvailable || isCreatingMaster || !activeClusterId || !newCwdValidation.ok}
            onClick={createMasterForCluster}
          >
            <Bot className="size-4 shrink-0" />
            <span className="truncate">{activeCluster?.masterSessionId ? 'Open master' : 'Create master'}</span>
          </Button>
          <Button
            className={termActionBtnCls}
            variant="outline"
            disabled={!isRuntimeAvailable || isCreatingMaster || !activeClusterId || !selectedSession || selectedSessionIsMaster}
            onClick={assignSelectedAsMaster}
          >
            <MessageSquarePlus className="size-4 shrink-0" />
            <span className="truncate">Use selected</span>
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2 font-mono">
          <CirclePlay className="size-3.5 text-accent-ink" />
          <span className="text-[12px] text-foreground">3. Run and freeze</span>
          <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
            {activeLoopIterations}/{activeLoopMaxIterations}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button className={termActionBtnCls} disabled={!isRuntimeAvailable || isStartingLoop || !canStartLoop} onClick={startMasterLoop}>
            <CirclePlay className="size-4 shrink-0" />
            <span className="truncate">{isStartingLoop ? 'Starting...' : 'Run governed loop'}</span>
          </Button>
          <Button className={termActionBtnCls} variant="outline" disabled={!isRuntimeAvailable || isStoppingLoop || !canStopLoop} onClick={stopMasterLoop}>
            <Square className="size-4 shrink-0" />
            <span className="truncate">{isStoppingLoop ? 'Stopping...' : 'Stop loop'}</span>
          </Button>
        </div>

        <div className="space-y-2">
          <div className="rounded-lg border border-ink-line bg-ink p-3 font-mono">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-term-name">{selectedSession?.label ?? 'Selected chat'}</span>
              <span className={cn(statePillBase, workflowStatusPillClassName(!selectedSession ? 'blocked' : selectedSessionFrozen ? 'done' : 'active'))}>
                {!selectedSession ? 'no chat' : selectedSessionFrozen ? 'frozen' : 'ready'}
              </span>
            </div>
            <Button
              className={cn(termActionBtnCls, 'mt-2 w-full')}
              variant="outline"
              disabled={!isRuntimeAvailable || isFreezingSelected || (!selectedSessionFrozen && !canFreezeSelectedSession)}
              onClick={selectedSessionFrozen ? unfreezeSelectedSession : freezeSelectedSession}
            >
              <Snowflake className="size-4 shrink-0" />
              <span className="truncate">
                {isFreezingSelected
                  ? 'Updating...'
                  : selectedSessionInheritedFreeze
                    ? 'Unfreeze cluster'
                    : selectedSessionFrozen
                      ? 'Unfreeze chat'
                      : 'Freeze chat'}
              </span>
            </Button>
          </div>

          <div className="rounded-lg border border-ink-line bg-ink p-3 font-mono">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-term-name">{activeCluster?.label ?? 'Active cluster'}</span>
              <span className={cn(statePillBase, workflowStatusPillClassName(!activeCluster ? 'blocked' : activeCluster.frozen ? 'done' : 'active'))}>
                {!activeCluster ? 'no cluster' : activeCluster.frozen ? 'frozen' : 'ready'}
              </span>
            </div>
            <Button
              className={cn(termActionBtnCls, 'mt-2 w-full')}
              variant="outline"
              disabled={!isRuntimeAvailable || isFreezingCluster || (!activeCluster?.frozen && !canFreezeActiveCluster)}
              onClick={activeCluster?.frozen ? unfreezeActiveCluster : freezeActiveCluster}
            >
              <Snowflake className="size-4 shrink-0" />
              <span className="truncate">{isFreezingCluster ? 'Updating...' : activeCluster?.frozen ? 'Unfreeze cluster' : 'Freeze cluster'}</span>
            </Button>
          </div>
        </div>
      </section>

      {clusters.length ? (
        <section className="space-y-2">
          <div className="flex items-center gap-2 font-mono">
            <MessagesSquare className="size-3.5 text-accent-ink" />
            <span className="text-[12px] text-foreground">Saved workflows</span>
            <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">{clusters.length}</span>
          </div>
          <div className="space-y-1.5">
            {clusters.map((cluster) => {
              const isActive = activeClusterId === cluster.clusterId;
              const master = cluster.masterSessionId ? runtimeState.sessions[cluster.masterSessionId] : undefined;
              const loopStatus = loopStateStatus(cluster);
              return (
                <button
                  key={cluster.clusterId}
                  type="button"
                  className={cn(
                    'w-full rounded-lg border bg-ink px-3 py-2 text-left font-mono transition',
                    isActive ? 'border-term-accent-hi/50 ring-1 ring-term-accent-hi/25' : 'border-ink-line hover:border-foreground/20',
                  )}
                  onClick={() => {
                    setActiveClusterId(cluster.clusterId);
                    if (cluster.masterSessionId) {
                      setPendingLinkedSourceId(null);
                      setSelectedSessionId(cluster.masterSessionId);
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cn('w-3.5 shrink-0 text-center text-[12px] leading-none', isActive ? 'text-term-accent-hi' : 'text-term-dim2')}>
                      {isActive ? '●' : '○'}
                    </span>
                    <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', isActive ? 'text-term-accent-hi' : 'text-term-accent')}>
                      {cluster.label}
                    </span>
                    {cluster.frozen ? <Snowflake className="size-3.5 shrink-0 text-term-amber" /> : null}
                    <span
                      className={cn(
                        statePillBase,
                        loopStatus === 'running'
                          ? 'border-term-amber/30 bg-term-amber/10 text-term-amber'
                          : 'border-ink-line bg-foreground/[0.04] text-term-dim',
                      )}
                    >
                      {cluster.frozen ? 'frozen' : loopStatus}
                    </span>
                  </div>
                  <div className="mt-1.5 grid gap-0.5 text-[11px]">
                    <div className="flex min-w-0 gap-2">
                      <span className="text-term-faint">├</span>
                      <span className="w-14 shrink-0 text-term-dim2">nodes</span>
                      <span className="truncate text-term-dim">
                        {cluster.nodeIds.length} managed
                        {master ? ` · ${master.label}` : ''}
                      </span>
                    </div>
                    <div className="flex min-w-0 gap-2">
                      <span className="text-term-faint">└</span>
                      <span className="w-14 shrink-0 text-term-dim2">policy</span>
                      <span className="truncate text-term-dim2">{loopPolicySummary(cluster) ?? 'no policy'}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
