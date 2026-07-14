import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type Connection, type ReactFlowInstance } from '@xyflow/react';
import { Activity, FileText, MessageSquarePlus, Moon, PanelRightClose, Plus, Sun, Webhook, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { canvasPanelMinWidth, type RailTab } from '@/lib/layout-prefs';
import { edgeKindClassNames, activityTitle, kernelActorLabel, kernelEventLabel, kernelEventSubject, type GraphEdgeData } from '@/lib/graph-view';
import { nodeTypes, edgeTypes } from '@/components/canvas';
import { WorkingTreeDiffPanel } from '@/components/working-tree-diff-panel';
import { LoopPanel } from '@/components/loop-panel';
import { SourceDirectoryPanel } from '@/components/source-directory';
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useState } from 'react';
import { type RuntimeCoreState } from '@/hooks/use-runtime-core';
import { type LayoutPrefsState } from '@/hooks/use-layout-prefs';
import { type SessionActionsState } from '@/hooks/use-session-actions';
import { type DiffPanelState } from '@/hooks/use-diff-panel';
import { type CanvasState } from '@/hooks/use-canvas';
import { workflowEmptyState } from '@shared/workflow-catalog';
import type { DraftGraphState } from '@/hooks/use-draft-graph';
import { DraftWorkflowPanel } from '@/components/draft-workflow-panel';
import type { DraftEdgeData } from '@/lib/draft-graph-view';
import { useAgentConnection } from '@/hooks/use-agent-connection';
import { AgentConnectionPanel } from '@/components/agent-connection-panel';
import { RelationshipInspectorPanel } from '@/components/relationship-inspector-panel';
import { ThemePicker } from '@/components/theme-picker';

type SessionGraphPanelProps = {
  core: RuntimeCoreState;
  layout: LayoutPrefsState;
  actions: SessionActionsState;
  diff: DiffPanelState;
  canvas: CanvasState;
  draft: DraftGraphState;
  isWorkflowLibraryOpen: boolean;
  setIsWorkflowLibraryOpen: Dispatch<SetStateAction<boolean>>;
  setActiveTab: Dispatch<SetStateAction<RailTab>>;
  setActiveClusterId: Dispatch<SetStateAction<string | undefined>>;
  openLoopId: string | undefined;
  setOpenLoopId: Dispatch<SetStateAction<string | undefined>>;
  requestWorkflowClose: () => void;
  onOpenProviderSetup: (sessionId: string) => void;
};

const kernelActorClassNames: Record<string, string> = {
  human: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  master: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  agent: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  rule: 'border-lime-600/50 bg-lime-500/10 text-lime-700 dark:text-lime-300',
  provider: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  runtime: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
};

export function SessionGraphPanel({
  core,
  layout,
  actions,
  diff,
  canvas,
  draft,
  isWorkflowLibraryOpen,
  setIsWorkflowLibraryOpen,
  setActiveTab,
  setActiveClusterId,
  openLoopId,
  setOpenLoopId,
  requestWorkflowClose,
  onOpenProviderSetup,
}: SessionGraphPanelProps) {
  const { runtimeState, setRuntimeState, setRuntimeError, runtimeApi, setSelectedSessionId, selectedSession, graphActivity, kernelEvents } = core;
  // L4 loop timeline panel: opened by clicking a ring badge on the canvas.
  // L2 trigger-source directory: opened from the header or a source node.
  const [isSourcesOpen, setIsSourcesOpen] = useState(false);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance>();
  const [selectedRelationship, setSelectedRelationship] = useState<GraphEdgeData>();
  const connectionSourceRef = useRef<string | undefined>(undefined);
  const connectionHandledRef = useRef(false);
  const { setGraphCollapsed, colorScheme, setColorScheme, theme, setTheme } = layout;
  const { setPendingLinkedSourceId, startNewChat } = actions;
  const {
    isDiffPanelOpen,
    setIsDiffPanelOpen,
    isLoadingDiff,
    selectedWorkingTreeDiff,
    diffPanelError,
    canOpenDiffPanel,
    loadSelectedWorkingTreeDiff,
    openWorkingTreeDiff,
  } = diff;
  const { edges, canvasNodes, updateCanvasNodePositions, beginCanvasNodeDrag, persistCanvasNodePositions, updateCanvasSelection } = canvas;
  const emptyState = workflowEmptyState(Object.keys(runtimeState.sessions).length);
  const showEmptyState = emptyState.show && draft.graph.nodeOrder.length === 0;
  const agentConnection = useAgentConnection({
    runtimeApi,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    setSelectedSessionId,
  });
  const { setDraft: setAgentConnectionDraft } = agentConnection;
  const { dispatch: dispatchDraft, setPendingConnection: setDraftPendingConnection } = draft;

  const inspectRelationship = useCallback(
    (data: GraphEdgeData) => {
      setAgentConnectionDraft(undefined);
      setDraftPendingConnection(undefined);
      dispatchDraft({ type: 'select', selection: undefined });
      setSelectedRelationship(data);
    },
    [dispatchDraft, setAgentConnectionDraft, setDraftPendingConnection],
  );

  const inspectDraftRelationship = useCallback(
    (relationId: string) => {
      setSelectedRelationship(undefined);
      setAgentConnectionDraft(undefined);
      setDraftPendingConnection(undefined);
      dispatchDraft({ type: 'select', selection: { kind: 'relation', id: relationId } });
    },
    [dispatchDraft, setAgentConnectionDraft, setDraftPendingConnection],
  );

  const renderedEdges = useMemo(
    () =>
      edges.map((edge) => {
        if (!edge.data) return edge;
        if (edge.type === 'draft') {
          const data = edge.data as DraftEdgeData;
          return {
            ...edge,
            data: {
              ...data,
              inspect: () => inspectDraftRelationship(data.relationId),
            },
          };
        }
        if (edge.type !== 'readability') return edge;
        const data = edge.data as GraphEdgeData;
        return {
          ...edge,
          data: {
            ...data,
            inspect: () => inspectRelationship(data),
          },
        };
      }),
    [edges, inspectDraftRelationship, inspectRelationship],
  );

  const connectNodes = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (draft.graph.nodes[connection.source] && draft.graph.nodes[connection.target]) {
      connectionHandledRef.current = true;
      setSelectedRelationship(undefined);
      agentConnection.setDraft(undefined);
      draft.connect(connection);
      return;
    }
    if (runtimeState.sessions[connection.source] && runtimeState.sessions[connection.target]) {
      connectionHandledRef.current = true;
      setSelectedRelationship(undefined);
      draft.setPendingConnection(undefined);
      draft.dispatch({ type: 'select', selection: undefined });
      agentConnection.openExisting(connection.source, connection.target);
    }
  };

  const completeConnectionAt = (sourceNodeId: string, clientX: number, clientY: number, eventTarget?: EventTarget | null) => {
    if (!flowInstance) return;
    const hitTarget = document.elementFromPoint(clientX, clientY);
    const targetHandle =
      hitTarget?.closest<HTMLElement>('.react-flow__handle') ??
      (eventTarget instanceof Element ? eventTarget.closest<HTMLElement>('.react-flow__handle') : null);
    const targetNodeId = targetHandle?.dataset.nodeid;
    if (targetNodeId && targetNodeId !== sourceNodeId && targetHandle?.matches('.target')) {
      connectNodes({ source: sourceNodeId, target: targetNodeId, sourceHandle: null, targetHandle: targetHandle.dataset.handleid ?? null });
      connectionHandledRef.current = false;
      return;
    }
    if (targetHandle) return;
    if (!runtimeState.sessions[sourceNodeId]) return;
    draft.setPendingConnection(undefined);
    draft.dispatch({ type: 'select', selection: undefined });
    setSelectedRelationship(undefined);
    agentConnection.openNew(sourceNodeId, flowInstance.screenToFlowPosition({ x: clientX, y: clientY }));
  };

  const connectToBlank = (event: MouseEvent | TouchEvent) => {
    const sourceNodeId = connectionSourceRef.current;
    connectionSourceRef.current = undefined;
    if (connectionHandledRef.current) {
      connectionHandledRef.current = false;
      return;
    }
    if (!sourceNodeId) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!point) return;
    completeConnectionAt(sourceNodeId, point.clientX, point.clientY, event.target);
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background" style={{ minWidth: canvasPanelMinWidth }}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4 font-mono">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex shrink-0 items-center gap-2 text-[12px] text-foreground">
            <Activity className="size-4 text-accent-ink" />
            Agent graph
          </span>
          <span className="truncate text-[12px] text-muted-foreground">Code-agent chats and handoffs</span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            className="h-8 font-mono text-[11px] uppercase tracking-[0.08em]"
            variant={draft.graph.nodeOrder.length > 0 ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => draft.addAgent()}
          >
            <Plus className="size-3.5" />
            <span className="truncate">Agent</span>
          </Button>
          <Button
            className="h-8 font-mono text-[11px] uppercase tracking-[0.08em]"
            variant={isWorkflowLibraryOpen ? 'secondary' : 'outline'}
            size="sm"
            disabled={!runtimeApi}
            onClick={() => {
              if (isWorkflowLibraryOpen) {
                requestWorkflowClose();
              } else {
                setIsWorkflowLibraryOpen(true);
              }
            }}
          >
            <Workflow className="size-3.5" />
            <span className="truncate">New Workflow</span>
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isSourcesOpen ? 'secondary' : 'ghost'}
                size="icon"
                disabled={!runtimeApi}
                aria-label="Advanced event sources"
                onClick={() => setIsSourcesOpen((open) => !open)}
              >
                <Webhook className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Advanced event sources</TooltipContent>
          </Tooltip>

          <Button
            className="h-8 font-mono text-[11px] uppercase tracking-[0.08em]"
            variant={isDiffPanelOpen ? 'secondary' : 'outline'}
            size="sm"
            disabled={!canOpenDiffPanel}
            onClick={openWorkingTreeDiff}
          >
            <FileText className="size-3.5" />
            <span className="truncate">Diff</span>
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Hide Agent graph" onClick={() => setGraphCollapsed(true)}>
                <PanelRightClose className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide Agent graph</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Switch to ${colorScheme === 'dark' ? 'light' : 'dark'} mode`}
                onClick={() => setColorScheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              >
                {colorScheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}</TooltipContent>
          </Tooltip>

          <ThemePicker theme={theme} setTheme={setTheme} colorScheme={colorScheme} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          className="relative min-h-0 flex-1"
          onPointerDownCapture={(event) => {
            const sourceHandle =
              event.target instanceof Element ? event.target.closest<HTMLElement>('.react-flow__handle.source') : null;
            const sourceNodeId = sourceHandle?.dataset.nodeid;
            if (!sourceNodeId) return;
            connectionHandledRef.current = false;
            connectionSourceRef.current = sourceNodeId;
          }}
          onPointerUpCapture={(event) => {
            const sourceNodeId = connectionSourceRef.current;
            if (!sourceNodeId) return;
            const { clientX, clientY } = event;
            const eventTarget = event.target;
            requestAnimationFrame(() => {
              if (connectionSourceRef.current !== sourceNodeId) return;
              connectionSourceRef.current = undefined;
              if (connectionHandledRef.current) {
                connectionHandledRef.current = false;
                return;
              }
              completeConnectionAt(sourceNodeId, clientX, clientY, eventTarget);
            });
          }}
          onPointerCancelCapture={() => {
            connectionSourceRef.current = undefined;
            connectionHandledRef.current = false;
          }}
        >
          {showEmptyState ? (
            <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center p-8">
              <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-border bg-background/92 p-5 text-center shadow-sm backdrop-blur">
                <div className="mx-auto flex size-10 items-center justify-center rounded-xl border border-accent-ink/25 bg-accent-ink/10">
                  <Workflow className="size-5 text-accent-ink" />
                </div>
                <h2 className="mt-3 text-sm font-semibold text-foreground">Start with one Agent — or connect several</h2>
                <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
                  A Chat starts one Agent now. A Workflow connects Agents so work can be handed off, reviewed, or repeated toward a goal.
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {emptyState.actions.map((action) =>
                    action === 'start-chat' ? (
                      <Button key={action} className="font-mono text-[10.5px] uppercase tracking-[0.06em]" variant="outline" onClick={startNewChat}>
                        <MessageSquarePlus className="size-3.5" />
                        Start a chat
                      </Button>
                    ) : (
                      <Button key={action} className="font-mono text-[10.5px] uppercase tracking-[0.06em]" onClick={() => setIsWorkflowLibraryOpen(true)}>
                        <Workflow className="size-3.5" />
                        Build a workflow
                      </Button>
                    ),
                  )}
                </div>
              </div>
            </div>
          ) : null}
          {kernelEvents.length > 0 ? (
            <div className="pointer-events-none absolute bottom-3 left-14 z-10 w-[320px] max-w-[calc(100%-4.5rem)] opacity-80 transition-opacity hover:opacity-100">
              <div className="pointer-events-auto rounded-lg border border-border bg-background/88 font-mono shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-2">
                  <Activity className="size-3 shrink-0 text-accent-ink" />
                  <h2 className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Kernel timeline</h2>
                  <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">#{kernelEvents.at(-1)?.seq}</span>
                </div>

                <ol className="max-h-44 space-y-2 overflow-y-auto p-2.5">
                  {[...kernelEvents].reverse().map((event) => (
                    <li key={event.id} className="grid grid-cols-[auto_1fr] gap-2.5 text-xs">
                      <span className="pt-0.5 text-[11px] tabular-nums text-term-faint">{event.seq}</span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em]',
                              kernelActorClassNames[event.actor.kind] ?? kernelActorClassNames.runtime,
                            )}
                            title={`actor: ${event.actor.kind}${event.actor.ref ? ` (${event.actor.ref})` : ''}${event.causeId ? `\ncause: ${event.causeId}` : ''}`}
                          >
                            {kernelActorLabel(runtimeState, event.actor)}
                          </span>
                          <span className="truncate font-medium text-foreground/90">
                            {kernelEventLabel(event.type)}
                            {(() => {
                              const subject = kernelEventSubject(runtimeState, event);
                              return subject ? ` · ${subject}` : '';
                            })()}
                          </span>
                        </div>
                        {event.reason ? <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">reason: {event.reason}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          ) : graphActivity.length > 0 ? (
            <div className="pointer-events-none absolute bottom-3 left-14 z-10 w-[280px] max-w-[calc(100%-4.5rem)] opacity-80 transition-opacity hover:opacity-100">
              <div className="pointer-events-auto rounded-lg border border-border bg-background/88 font-mono shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-2">
                  <Activity className="size-3 shrink-0 text-accent-ink" />
                  <h2 className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Graph events</h2>
                  <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">{graphActivity.length}</span>
                </div>

                <ol className="max-h-36 space-y-2 overflow-y-auto p-2.5">
                  {graphActivity.slice(-4).map((event, index) => (
                    <li key={event.id} className="grid grid-cols-[auto_1fr] gap-2.5 text-xs">
                      <span className="pt-0.5 text-[11px] tabular-nums text-term-faint">
                        {String(graphActivity.length - Math.min(graphActivity.length, 4) + index + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em]',
                              event.kind === 'report' ? edgeKindClassNames.report : edgeKindClassNames[event.kind],
                            )}
                          >
                            {activityTitle(event.kind)}
                          </span>
                          <span className="truncate font-medium text-foreground/90">{event.title}</span>
                        </div>
                        {event.detail ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{event.detail}</p> : null}
                        {event.reason ? <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">reason: {event.reason}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          ) : null}
          <ReactFlow
            colorMode={colorScheme}
            nodes={canvasNodes}
            edges={renderedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setFlowInstance}
            onNodesChange={updateCanvasNodePositions}
            onNodeDragStart={beginCanvasNodeDrag}
            onNodeDragStop={persistCanvasNodePositions}
            onNodeClick={(_event, node) => {
              if (draft.graph.nodes[node.id]) {
                setSelectedRelationship(undefined);
                agentConnection.setDraft(undefined);
                draft.setPendingConnection(undefined);
                draft.dispatch({ type: 'select', selection: { kind: 'node', id: node.id } });
                return;
              }
              if (node.id.startsWith('loop:')) {
                setOpenLoopId(node.id.slice('loop:'.length));
                return;
              }
              if (node.id.startsWith('source:')) {
                setIsSourcesOpen(true);
                return;
              }
              if (!node.id.startsWith('cluster:') && !node.id.startsWith('timer:')) {
                setSelectedRelationship(undefined);
                agentConnection.setDraft(undefined);
                const graphNode = runtimeState.nodes.find((candidate) => candidate.nodeId === node.id);
                if (graphNode?.clusterId) {
                  setActiveClusterId(graphNode.clusterId);
                }
                setPendingLinkedSourceId(null);
                setSelectedSessionId(node.id);
                setActiveTab('chat');
              }
            }}
            onEdgeClick={(_event, edge) => {
              if (edge.type === 'draft') {
                const relationId = (edge.data as DraftEdgeData | undefined)?.relationId;
                if (relationId) {
                  inspectDraftRelationship(relationId);
                }
                return;
              }
              const data = edge.data as GraphEdgeData | undefined;
              if (data) {
                inspectRelationship(data);
              }
            }}
            onConnectStart={(_event, params) => {
              connectionHandledRef.current = false;
              connectionSourceRef.current = params.handleType === 'source' && typeof params.nodeId === 'string' ? params.nodeId : undefined;
            }}
            onConnect={connectNodes}
            onConnectEnd={connectToBlank}
            onSelectionChange={updateCanvasSelection}
            selectionOnDrag
            fitView
            fitViewOptions={{ padding: 0.24 }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <Controls />
            <MiniMap
              pannable
              zoomable
              bgColor="var(--card)"
              maskColor="color-mix(in oklch, var(--background) 55%, transparent)"
              nodeColor="var(--muted)"
              nodeStrokeColor="var(--border)"
            />
          </ReactFlow>
          {agentConnection.draft ? <AgentConnectionPanel runtimeState={runtimeState} connection={agentConnection} /> : null}
          {!agentConnection.draft && selectedRelationship ? (
            <RelationshipInspectorPanel
              data={selectedRelationship}
              runtimeState={runtimeState}
              runtimeApi={runtimeApi}
              onClose={() => setSelectedRelationship(undefined)}
              onStateChange={setRuntimeState}
              onError={(message) => setRuntimeError(message)}
            />
          ) : null}
          {!agentConnection.draft && !selectedRelationship && (draft.graph.selection || draft.pendingConnection) ? (
            <DraftWorkflowPanel runtimeState={runtimeState} draft={draft} />
          ) : null}
        </div>

        {openLoopId ? (
          <LoopPanel
            loopId={openLoopId}
            runtimeApi={runtimeApi}
            runtimeState={runtimeState}
            latestKernelSeq={kernelEvents.at(-1)?.seq ?? 0}
            onClose={() => setOpenLoopId(undefined)}
            onStateChange={setRuntimeState}
            onOpenAgent={(sessionId) => {
              setSelectedSessionId(sessionId);
              setActiveTab('chat');
            }}
            onOpenProviderSetup={onOpenProviderSetup}
            onOpenWorkflowBuilder={() => {
              setOpenLoopId(undefined);
              requestWorkflowClose();
              setIsWorkflowLibraryOpen(true);
            }}
            onOpenDiff={(sessionId) => {
              setSelectedSessionId(sessionId);
              setActiveTab('chat');
              setIsDiffPanelOpen(true);
            }}
            onFreezeRing={(memberSessionIds) => {
              if (!runtimeApi) {
                return;
              }
              // The badge's freeze shortcut is just the existing freeze verb
              // fanned over the ring's members — no new kernel operator.
              void (async () => {
                try {
                  let lastState: typeof runtimeState | undefined;
                  for (const sessionId of memberSessionIds) {
                    const frozen = runtimeState.nodes.find((node) => node.nodeId === sessionId)?.frozen;
                    if (frozen) {
                      continue;
                    }
                    const result = await runtimeApi.freeze({ target: sessionId, reason: 'Frozen from the ring badge.' });
                    lastState = result.state;
                  }
                  if (lastState) {
                    setRuntimeState(lastState);
                  }
                } catch (error: unknown) {
                  setRuntimeError(error instanceof Error ? error.message : String(error));
                }
              })();
            }}
          />
        ) : null}

        {isSourcesOpen ? (
          <SourceDirectoryPanel
            runtimeApi={runtimeApi}
            runtimeState={runtimeState}
            onClose={() => setIsSourcesOpen(false)}
            onStateChange={setRuntimeState}
            onError={(message) => setRuntimeError(message)}
          />
        ) : null}

        {isDiffPanelOpen ? (
          <WorkingTreeDiffPanel
            session={selectedSession}
            diff={selectedWorkingTreeDiff}
            isLoading={isLoadingDiff}
            error={diffPanelError}
            onRefresh={() => void loadSelectedWorkingTreeDiff()}
            onClose={() => setIsDiffPanelOpen(false)}
          />
        ) : null}
      </div>
    </section>
  );
}
