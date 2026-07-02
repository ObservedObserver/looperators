import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
} from '@xyflow/react'
import {
  Activity,
  FileText,
  Moon,
  PanelRightClose,
  Sun,
} from 'lucide-react'
import {
  Button,
} from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  cn,
} from '@/lib/utils'
import {
  canvasPanelMinWidth,
  type RailTab,
} from '@/lib/layout-prefs'
import {
  edgeKindClassNames,
  activityTitle,
} from '@/lib/graph-view'
import {
  nodeTypes,
  edgeTypes,
} from '@/components/canvas'
import {
  WorkingTreeDiffPanel,
} from '@/components/working-tree-diff-panel'
import {
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  type RuntimeCoreState,
} from '@/hooks/use-runtime-core'
import {
  type LayoutPrefsState,
} from '@/hooks/use-layout-prefs'
import {
  type SessionActionsState,
} from '@/hooks/use-session-actions'
import {
  type DiffPanelState,
} from '@/hooks/use-diff-panel'
import {
  type CanvasState,
} from '@/hooks/use-canvas'

type SessionGraphPanelProps = {
  core: RuntimeCoreState
  layout: LayoutPrefsState
  actions: SessionActionsState
  diff: DiffPanelState
  canvas: CanvasState
  setActiveTab: Dispatch<SetStateAction<RailTab>>
  setActiveClusterId: Dispatch<SetStateAction<string | undefined>>
}

export function SessionGraphPanel({
  core,
  layout,
  actions,
  diff,
  canvas,
  setActiveTab,
  setActiveClusterId,
}: SessionGraphPanelProps) {
  const {
    runtimeState,
    setSelectedSessionId,
    selectedSession,
    graphActivity,
  } = core
  const {
    setGraphCollapsed,
    colorScheme,
    setColorScheme,
  } = layout
  const {
    setPendingLinkedSourceId,
  } = actions
  const {
    isDiffPanelOpen,
    setIsDiffPanelOpen,
    isLoadingDiff,
    selectedWorkingTreeDiff,
    diffPanelError,
    canOpenDiffPanel,
    loadSelectedWorkingTreeDiff,
    openWorkingTreeDiff,
  } = diff
  const {
    edges,
    canvasNodes,
    updateCanvasNodePositions,
    beginCanvasNodeDrag,
    persistCanvasNodePositions,
    updateCanvasSelection,
  } = canvas

  return (
        <section
          className="flex min-w-0 flex-1 flex-col bg-background"
          style={{ minWidth: canvasPanelMinWidth }}
        >
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4 font-mono">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex shrink-0 items-center gap-2 text-[12px] text-foreground">
                <Activity className="size-4 text-accent-ink" />
                Session graph
              </span>
              <span className="truncate text-[12px] text-muted-foreground">
                Code-agent chats and handoffs
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-2">
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
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Hide session graph"
                    onClick={() => setGraphCollapsed(true)}
                  >
                    <PanelRightClose className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Hide session graph</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Switch to ${
                      colorScheme === 'dark' ? 'light' : 'dark'
                    } mode`}
                    onClick={() =>
                      setColorScheme((current) =>
                        current === 'dark' ? 'light' : 'dark'
                      )
                    }
                  >
                    {colorScheme === 'dark' ? (
                      <Sun className="size-4" />
                    ) : (
                      <Moon className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}
                </TooltipContent>
              </Tooltip>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <div className="relative min-h-0 flex-1">
              {graphActivity.length > 0 ? (
                <div className="pointer-events-none absolute bottom-3 left-14 z-10 w-[280px] max-w-[calc(100%-4.5rem)] opacity-80 transition-opacity hover:opacity-100">
                  <div className="pointer-events-auto rounded-lg border border-border bg-background/88 font-mono shadow-sm backdrop-blur">
                    <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-2">
                      <Activity className="size-3 shrink-0 text-accent-ink" />
                      <h2 className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                        Graph events
                      </h2>
                      <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">
                        {graphActivity.length}
                      </span>
                    </div>

                    <ol className="max-h-36 space-y-2 overflow-y-auto p-2.5">
                      {graphActivity.slice(-4).map((event, index) => (
                        <li
                          key={event.id}
                          className="grid grid-cols-[auto_1fr] gap-2.5 text-xs"
                        >
                          <span className="pt-0.5 text-[11px] tabular-nums text-term-faint">
                            {String(
                              graphActivity.length -
                                Math.min(graphActivity.length, 4) +
                                index +
                                1
                            ).padStart(2, '0')}
                          </span>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={cn(
                                  'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em]',
                                  event.kind === 'report'
                                    ? edgeKindClassNames.report
                                    : edgeKindClassNames[event.kind]
                                )}
                              >
                                {activityTitle(event.kind)}
                              </span>
                              <span className="truncate font-medium text-foreground/90">
                                {event.title}
                              </span>
                            </div>
                            {event.detail ? (
                              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                                {event.detail}
                              </p>
                            ) : null}
                            {event.reason ? (
                              <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                                reason: {event.reason}
                              </p>
                            ) : null}
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
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={updateCanvasNodePositions}
                onNodeDragStart={beginCanvasNodeDrag}
                onNodeDragStop={persistCanvasNodePositions}
                onNodeClick={(_event, node) => {
                  if (!node.id.startsWith('cluster:')) {
                    const graphNode = runtimeState.nodes.find(
                      (candidate) => candidate.nodeId === node.id
                    )
                    if (graphNode?.clusterId) {
                      setActiveClusterId(graphNode.clusterId)
                    }
                    setPendingLinkedSourceId(null)
                    setSelectedSessionId(node.id)
                    setActiveTab('chat')
                  }
                }}
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
            </div>

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
  )
}
