import '@xyflow/react/dist/style.css';
import { type KeyboardEvent as ReactKeyboardEvent, useRef, useState } from 'react';
import { Activity, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { chatPanelMinWidth } from '@/lib/layout-prefs';
import { RuntimeDiagnosticsToast } from '@/components/recovery';

import { type RailTab } from '@/lib/layout-prefs';
import { SidebarRail } from '@/components/sidebar-rail';
import { OrchestratePanel } from '@/components/orchestrate-panel';
import { ChatDetail } from '@/components/chat-detail';
import { SessionGraphPanel } from '@/components/session-graph-panel';
import { SessionWorkspacePanel } from '@/components/session-workspace-panel';
import { TemplateLibraryPanel } from '@/components/template-library';
import { useRuntimeCore } from '@/hooks/use-runtime-core';
import { useLayoutPrefs } from '@/hooks/use-layout-prefs';
import { useComposer } from '@/hooks/use-composer';
import { useNewChatSetup } from '@/hooks/use-new-chat-setup';
import { useSessionList } from '@/hooks/use-session-list';
import { useTerminalPanel } from '@/hooks/use-terminal-panel';
import { useRuntimeSubscription } from '@/hooks/use-runtime-subscription';
import { useSessionActions } from '@/hooks/use-session-actions';
import { useInteractions } from '@/hooks/use-interactions';
import { useDiffPanel } from '@/hooks/use-diff-panel';
import { useCanvas } from '@/hooks/use-canvas';
import { useOrchestration } from '@/hooks/use-orchestration';

function App() {
  const [activeTab, setActiveTab] = useState<RailTab>('chat');
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [isWorkspacePanelOpen, setIsWorkspacePanelOpen] = useState(false);
  const [isWorkflowLibraryOpen, setIsWorkflowLibraryOpen] = useState(false);
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<string[]>([]);
  const [activeClusterId, setActiveClusterId] = useState<string>();
  const [workflowNotice, setWorkflowNotice] = useState<string>();
  const [openLoopId, setOpenLoopId] = useState<string>();
  const workflowCloseRequestRef = useRef<(() => void) | undefined>(undefined);

  const core = useRuntimeCore();
  const {
    runtimeClient,
    runtimeApi,
    isRuntimeAvailable,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    runtimeError,
    setRuntimeError,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    selectedSessionFrozen,
    sessions,
    providerInstances,
    runtimeDiagnostics,
    invalidProjectCwds,
    reportsById,
    canResume,
  } = core;

  const layout = useLayoutPrefs();
  const {
    splitContainerRef,
    chatPanelWidth,
    isResizingChatPanel,
    setIsResizingChatPanel,
    setGraphCollapsed,
    adjustChatPanelWidth,
    graphForcedCollapsed,
    effectiveGraphCollapsed,
  } = layout;

  const composer = useComposer({ setRuntimeError });
  const { message, composerAttachments, composerEditorRef, setComposerText, clearComposer } = composer;

  const newChat = useNewChatSetup({
    runtimeApi,
    runtimeClient,
    runtimeUnavailableText,
    setRuntimeState,
    setRuntimeError,
    sessions,
    invalidProjectCwds,
    providerInstances,
    selectedSession,
    showRawEvents,
  });
  const {
    newProviderKind,
    newCwd,
    setNewCwd,
    newWorkMode,
    setNewWorkMode,
    newBranch,
    setNewBranch,
    newRuntimeMode,
    newModel,
    newReasoningEffort,
    newProviderInstance,
    changeNewProviderKind,
    restoreCwdFallback,
  } = newChat;

  const sessionList = useSessionList({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    sessions,
    runtimeDiagnostics,
  });

  const terminal = useTerminalPanel({
    runtimeApi,
    runtimeUnavailableText,
    setRuntimeError,
    selectedSession,
    isRuntimeAvailable,
  });
  const { syncTerminalFromEvent } = terminal;

  useRuntimeSubscription({
    runtimeApi,
    setRuntimeState,
    setSelectedSessionId,
    setRuntimeError,
    syncTerminalFromEvent,
    restoreCwdFallback,
    ingestKernelEvents: core.ingestKernelEvents,
  });

  const actions = useSessionActions({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    sessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    isRuntimeAvailable,
    canResume,
    invalidProjectCwds,
    setActiveTab,
    setShowRawEvents,
    composer: {
      message,
      composerAttachments,
      clearComposer,
      setComposerText,
      composerEditorRef,
    },
    newChat: {
      newCwd,
      setNewCwd,
      newWorkMode,
      setNewWorkMode,
      newBranch,
      setNewBranch,
      newProviderKind,
      newRuntimeMode,
      newModel,
      newReasoningEffort,
      newProviderInstance,
      changeNewProviderKind,
    },
  });
  const { setPendingLinkedSourceId } = actions;

  const interactions = useInteractions({
    runtimeApi,
    runtimeUnavailableText,
    setRuntimeState,
    setRuntimeError,
  });

  const diff = useDiffPanel({
    runtimeApi,
    runtimeUnavailableText,
    isRuntimeAvailable,
    selectedSession,
    selectedSessionId,
  });

  const canvas = useCanvas({
    runtimeApi,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    reportsById,
    setSelectedCanvasNodeIds,
    setActiveClusterId,
  });

  const orchestration = useOrchestration({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    selectedSessionFrozen,
    selectedCanvasNodeIds,
    activeClusterId,
    setActiveClusterId,
    setPendingLinkedSourceId,
    newChat: {
      newCwd,
      newProviderKind,
      newRuntimeMode,
      newModel,
      newReasoningEffort,
      newProviderInstance,
    },
  });

  return (
    <TooltipProvider>
      <main ref={splitContainerRef} className="relative flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        {/* ===== Sidebar: nav + chat list ===== */}
        <SidebarRail
          core={core}
          sessionList={sessionList}
          actions={actions}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onStartWorkflow={() => {
            setGraphCollapsed(false);
            setIsWorkflowLibraryOpen(true);
          }}
        />

        {/* ===== Detail: selected chat or orchestrate ===== */}
        <section
          className={cn('relative flex min-h-0 flex-col overflow-hidden bg-background', effectiveGraphCollapsed ? 'flex-1' : 'shrink-0')}
          style={effectiveGraphCollapsed ? undefined : { width: chatPanelWidth, minWidth: chatPanelMinWidth }}
        >
          {runtimeError ? (
            <div className="app-region-no-drag mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11.5px] leading-5 text-destructive">
              <span className="shrink-0">✗</span>
              <span className="min-w-0 break-words">{runtimeError}</span>
            </div>
          ) : null}
          <RuntimeDiagnosticsToast diagnostics={runtimeDiagnostics} sessions={sessions} />
          <div className="app-region-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === 'orchestrate' ? (
              <OrchestratePanel
                core={core}
                newChat={newChat}
                actions={actions}
                orchestration={orchestration}
                setActiveTab={setActiveTab}
                activeClusterId={activeClusterId}
                setActiveClusterId={setActiveClusterId}
              />
            ) : null}
            {activeTab === 'chat' ? (
              <ChatDetail
                core={core}
                layout={layout}
                composer={composer}
                newChat={newChat}
                terminal={terminal}
                actions={actions}
                interactions={interactions}
                diff={diff}
                showRawEvents={showRawEvents}
                setShowRawEvents={setShowRawEvents}
                isWorkspacePanelOpen={isWorkspacePanelOpen}
                setIsWorkspacePanelOpen={setIsWorkspacePanelOpen}
              />
            ) : null}
          </div>
        </section>

        {/* ===== Resize handle (chat width) — only when graph visible ===== */}
        {effectiveGraphCollapsed ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            tabIndex={0}
            className={cn(
              'app-region-no-drag group/split relative z-20 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center bg-background outline-none transition focus-visible:bg-accent',
              isResizingChatPanel && 'bg-accent',
            )}
            onPointerDown={(event) => {
              event.preventDefault();
              setIsResizingChatPanel(true);
            }}
            onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
              const step = event.shiftKey ? 48 : 24;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                adjustChatPanelWidth(-step);
              }
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                adjustChatPanelWidth(step);
              }
            }}
          >
            <span className="h-10 w-px rounded-full bg-border transition group-hover/split:bg-accent-ink group-focus-visible/split:bg-accent-ink" />
          </div>
        )}

        {/* ===== Session graph (collapsible) ===== */}
        {effectiveGraphCollapsed ? (
          <div className="flex h-dvh shrink-0 flex-col items-center gap-3 border-l border-border bg-background px-1.5 py-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Show Agent graph" onClick={() => setGraphCollapsed(false)}>
                  <PanelRightOpen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{graphForcedCollapsed ? 'Widen window to show Agent graph' : 'Show Agent graph'}</TooltipContent>
            </Tooltip>
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground [writing-mode:vertical-rl]">
              <Activity className="size-3.5 text-accent-ink" />
              Agent graph
            </span>
          </div>
        ) : (
          <SessionGraphPanel
            core={core}
            layout={layout}
            actions={actions}
            diff={diff}
            canvas={canvas}
            isWorkflowLibraryOpen={isWorkflowLibraryOpen}
            setIsWorkflowLibraryOpen={setIsWorkflowLibraryOpen}
            setActiveTab={setActiveTab}
            setActiveClusterId={setActiveClusterId}
            openLoopId={openLoopId}
            setOpenLoopId={setOpenLoopId}
            requestWorkflowClose={() => workflowCloseRequestRef.current?.()}
          />
        )}
        {selectedSession && isWorkspacePanelOpen ? (
          <div className="app-region-no-drag absolute inset-y-0 right-0 z-40 flex max-w-full shadow-2xl">
            <SessionWorkspacePanel
              sessionId={selectedSession.sessionId}
              cwd={selectedSession.cwd}
              runtimeApi={runtimeApi}
              onClose={() => setIsWorkspacePanelOpen(false)}
            />
          </div>
        ) : null}
        {isWorkflowLibraryOpen ? (
          <div
            className="app-region-no-drag absolute bottom-0 right-0 top-14 z-50 flex max-w-full shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="New Workflow"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setIsWorkflowLibraryOpen(false);
              }
            }}
          >
            <TemplateLibraryPanel
              runtimeApi={runtimeApi}
              runtimeState={runtimeState}
              onClose={() => setIsWorkflowLibraryOpen(false)}
              onStateChange={setRuntimeState}
              onError={setRuntimeError}
              autoFocusClose
              defaultCwd={newCwd}
              onWorkflowStarted={({ coderSessionId, loopId }) => {
                setSelectedSessionId(coderSessionId);
                setActiveTab('chat');
                setOpenLoopId(loopId);
                setWorkflowNotice('Coder started · Reviewer waiting');
              }}
              requestCloseRef={workflowCloseRequestRef}
            />
          </div>
        ) : null}
        {workflowNotice ? (
          <button
            type="button"
            className="app-region-no-drag absolute bottom-4 left-1/2 z-[70] -translate-x-1/2 rounded-xl border border-lime-500/35 bg-background/95 px-4 py-2 font-mono text-[11px] text-lime-700 shadow-lg backdrop-blur dark:text-lime-300"
            onClick={() => setWorkflowNotice(undefined)}
          >
            {workflowNotice}
          </button>
        ) : null}
      </main>
    </TooltipProvider>
  );
}

export default App;
