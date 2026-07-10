import { ArrowUp, Braces, FolderTree, GitBranch, Paperclip, RefreshCw, Square, Terminal, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { statusLabels, statusDotClassNames, sessionProviderLabel, sessionChatId, sessionDisplayLabel } from '@/lib/session-display';
import { providerOption, runtimeConfigSummary } from '@/lib/provider-catalog';
import { OpenWorkspaceSplitButton, NewChatSetupBar } from '@/components/new-chat-setup';
import { GoalLoopButton } from '@/components/goal-loop-button';
import { compactPath, compactId } from '@/lib/format';
import { RecoveryNotice } from '@/components/recovery';
import { SessionTerminalPanel } from '@/components/session-terminal-panel';
import { SessionTimeline } from '@/components/timeline';
import { RuntimeInteractionPanel } from '@/components/runtime-interaction-panel';
import { ProviderEventDrawer } from '@/components/provider-event-drawer';
import { ProviderSetupDiagnostics } from '@/components/provider-settings';
import { ComposerAttachmentPill } from '@/components/composer-attachment-pill';
import { type Dispatch, type SetStateAction } from 'react';
import { type RuntimeCoreState } from '@/hooks/use-runtime-core';
import { type LayoutPrefsState } from '@/hooks/use-layout-prefs';
import { type ComposerState } from '@/hooks/use-composer';
import { type NewChatSetupState } from '@/hooks/use-new-chat-setup';
import { type TerminalPanelState } from '@/hooks/use-terminal-panel';
import { type SessionActionsState } from '@/hooks/use-session-actions';
import { type InteractionsState } from '@/hooks/use-interactions';
import { type DiffPanelState } from '@/hooks/use-diff-panel';

const isMacPlatform = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

const sendShortcutHint = isMacPlatform ? '⌘⏎' : 'Ctrl+⏎';

type ChatDetailProps = {
  core: RuntimeCoreState;
  layout: LayoutPrefsState;
  composer: ComposerState;
  newChat: NewChatSetupState;
  terminal: TerminalPanelState;
  actions: SessionActionsState;
  interactions: InteractionsState;
  diff: DiffPanelState;
  showRawEvents: boolean;
  setShowRawEvents: Dispatch<SetStateAction<boolean>>;
  isWorkspacePanelOpen: boolean;
  setIsWorkspacePanelOpen: Dispatch<SetStateAction<boolean>>;
};

export function ChatDetail({
  core,
  layout,
  composer,
  newChat,
  terminal,
  actions,
  interactions,
  diff,
  showRawEvents,
  setShowRawEvents,
  isWorkspacePanelOpen,
  setIsWorkspacePanelOpen,
}: ChatDetailProps) {
  const {
    runtimeClient,
    runtimeApi,
    isRuntimeAvailable,
    isElectron,
    runtimeHostPlatform,
    runtimeStatusText,
    runtimeUnavailableText,
    runtimeError,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    selectedSession,
    selectedSessionProjection,
    openRuntimeRequests,
    openUserInputRequests,
    providerInstances,
    selectedRecoveryState,
    canResume,
    canKill,
    canActOnPlan,
  } = core;
  const { openWorkspaceTarget, setOpenWorkspaceTarget } = layout;
  const {
    setMessage,
    composerAttachments,
    isComposerDragActive,
    setIsComposerDragActive,
    composerEditorRef,
    composerFileInputRef,
    addComposerFiles,
    removeComposerAttachment,
    handleComposerPaste,
    handleComposerDrop,
    composerHasPayload,
  } = composer;
  const {
    newProviderKind,
    newCwd,
    setNewCwd,
    newWorkMode,
    setNewWorkMode,
    newBranch,
    setNewBranch,
    newRuntimeMode,
    setNewRuntimeMode,
    newModel,
    setNewModel,
    newReasoningEffort,
    setNewReasoningEffort,
    providerSetupStatus,
    isLoadingProviderSetupStatus,
    savingProviderInstanceId,
    providerInstanceError,
    changeNewProviderKind,
    newCwdValidation,
    newChatProjects,
    chooseNewChatProject,
    saveProviderInstance,
  } = newChat;
  const {
    isTerminalPanelOpen,
    isOpeningTerminal,
    isSendingTerminalCommand,
    selectedTerminal,
    canOpenSelectedTerminal,
    openSelectedTerminal,
    runSelectedTerminalCommand,
    clearSelectedTerminal,
    closeSelectedTerminal,
  } = terminal;
  const {
    isCreating,
    isResuming,
    pendingLinkedSource,
    openingWorkspaceTarget,
    composerDisabled,
    canOpenSelectedWorkspace,
    startLinkedChat,
    sendChatMessage,
    killSelectedSession,
    openSelectedWorkspace,
    continueRuntimePlan,
    reviseRuntimePlan,
  } = actions;
  const { userInputDrafts, setUserInputDraft, pendingInteractionIds, respondToRuntimeRequest, answerRuntimeUserInput } = interactions;
  const { openTurnDiff } = diff;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="@container shrink-0 border-b border-border bg-card px-3.5 py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Chat</span>
              <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={selectedSession ? sessionDisplayLabel(selectedSession) : undefined}>
                {selectedSession ? sessionDisplayLabel(selectedSession) : pendingLinkedSource ? 'New Agent' : 'New Chat'}
              </h2>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {selectedSession ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  <span className={cn('size-1.5 rounded-full', statusDotClassNames[selectedSession.status])} />
                  {statusLabels[selectedSession.status]}
                </span>
              ) : null}
              {selectedSession ? (
                <OpenWorkspaceSplitButton
                  target={openWorkspaceTarget}
                  platform={runtimeHostPlatform}
                  disabled={!canOpenSelectedWorkspace}
                  pendingTarget={openingWorkspaceTarget}
                  onTargetChange={setOpenWorkspaceTarget}
                  onOpen={openSelectedWorkspace}
                />
              ) : null}
              {selectedSession ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="app-region-no-drag h-7 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
                      variant={isTerminalPanelOpen && selectedTerminal ? 'secondary' : 'outline'}
                      size="sm"
                      disabled={!canOpenSelectedTerminal || isOpeningTerminal}
                      aria-label="Open Terminal"
                      onClick={openSelectedTerminal}
                    >
                      {isOpeningTerminal ? <RefreshCw className="size-3.5 animate-spin" /> : <Terminal className="size-3.5" />}
                      <span className="hidden @[34rem]:inline">Terminal</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open Terminal</TooltipContent>
                </Tooltip>
              ) : null}
              {selectedSession ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="app-region-no-drag h-7 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
                      variant={isWorkspacePanelOpen ? 'secondary' : 'outline'}
                      size="sm"
                      disabled={!selectedSession.cwd.trim()}
                      aria-label="Workspace files"
                      onClick={() => setIsWorkspacePanelOpen((current) => !current)}
                    >
                      <FolderTree className="size-3.5" />
                      <span className="hidden @[34rem]:inline">Files</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Workspace files</TooltipContent>
                </Tooltip>
              ) : null}
              {selectedSession ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="app-region-no-drag h-7 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
                      variant="outline"
                      size="sm"
                      disabled={!isRuntimeAvailable}
                      aria-label="Create Agent from this Chat"
                      onClick={startLinkedChat}
                    >
                      <GitBranch className="size-3.5" />
                      <span className="hidden @[34rem]:inline">New Agent</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create one Agent from this Chat. Use New Workflow for ongoing automation.</TooltipContent>
                </Tooltip>
              ) : null}
              {selectedSession ? (
                <GoalLoopButton
                  sessionId={selectedSession.sessionId}
                  subscriptions={runtimeState.subscriptions}
                  runtimeApi={runtimeApi}
                  onStateChange={setRuntimeState}
                  onError={setRuntimeError}
                />
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="app-region-no-drag size-7"
                    variant={showRawEvents ? 'secondary' : 'ghost'}
                    size="icon"
                    aria-label="Diagnostics"
                    onClick={() => setShowRawEvents((current) => !current)}
                  >
                    <Braces className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Diagnostics</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
            {selectedSession ? (
              <>
                <span className="shrink-0 text-foreground/75">{sessionProviderLabel(selectedSession)}</span>
                <span className="shrink-0 text-term-faint">·</span>
                <span className="shrink-0 text-foreground/55">
                  {runtimeConfigSummary(selectedSession.providerKind, selectedSession.runtimeSettings, selectedSession.effectiveRuntimeConfig)}
                </span>
                <span className="shrink-0 text-term-faint">|</span>
                <span className="min-w-0 flex-1 truncate" title={selectedSession.cwd || undefined}>
                  {selectedSession.cwd.trim() ? compactPath(selectedSession.cwd) : 'no project'}
                </span>
                <span className="shrink-0 text-term-faint">|</span>
                <span className="shrink-0 text-foreground/70" title={sessionChatId(selectedSession)}>
                  {compactId(sessionChatId(selectedSession))}
                </span>
              </>
            ) : (
              <>
                <span className="shrink-0 text-foreground/75">{providerOption(newProviderKind).label}</span>
                <span className="shrink-0 text-term-faint">·</span>
                <span className="shrink-0 text-foreground/55">
                  {runtimeConfigSummary(newProviderKind, {
                    runtimeMode: newRuntimeMode,
                    model: newModel,
                    reasoningEffort: newReasoningEffort,
                  })}
                </span>
                <span className="shrink-0 text-term-faint">|</span>
                <span className="min-w-0 flex-1 truncate" title={newCwd}>
                  {newCwd.trim() ? compactPath(newCwd.trim()) : 'project required'}
                </span>
                {pendingLinkedSource ? (
                  <>
                    <span className="shrink-0 text-term-faint">|</span>
                    <span className="min-w-0 flex-1 truncate text-foreground/70" title={pendingLinkedSource.sessionId}>
                      from {pendingLinkedSource.label}
                    </span>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
        {selectedRecoveryState ? (
          <div className="mt-2">
            <RecoveryNotice state={selectedRecoveryState} compact />
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <RuntimeInteractionPanel
          requests={openRuntimeRequests}
          userInputRequests={openUserInputRequests}
          userInputDrafts={userInputDrafts}
          pendingInteractionIds={pendingInteractionIds}
          onRespond={respondToRuntimeRequest}
          onDraftChange={setUserInputDraft}
          onAnswer={answerRuntimeUserInput}
        />

        {showRawEvents ? (
          selectedSession ? (
            <ProviderEventDrawer session={selectedSession} />
          ) : (
            <ProviderSetupDiagnostics
              isRuntimeAvailable={isRuntimeAvailable}
              runtimeStatusText={runtimeStatusText}
              providerKind={newProviderKind}
              providerInstances={providerInstances}
              runtimeError={runtimeError}
              setupStatus={providerSetupStatus}
              isLoadingSetupStatus={isLoadingProviderSetupStatus}
              savingProviderInstanceId={savingProviderInstanceId}
              providerInstanceError={providerInstanceError}
              onSaveProviderInstance={saveProviderInstance}
            />
          )
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
          <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-ink-line-2 bg-ink px-4 py-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-term-dim2">Timeline</span>
            <span className="ml-auto font-mono text-[10.5px] tabular-nums text-term-faint">{selectedSessionProjection?.timeline.length ?? 0} entries</span>
          </div>
          {selectedSessionProjection?.timeline.length ? (
            <SessionTimeline
              entries={selectedSessionProjection.timeline}
              agent={selectedSession?.agent ?? 'claude-code'}
              canActOnPlan={canActOnPlan}
              onContinuePlan={continueRuntimePlan}
              onRevisePlan={reviseRuntimePlan}
              onOpenTurnDiff={openTurnDiff}
            />
          ) : (
            <div className="m-3.5 rounded-lg border border-dashed border-ink-line p-5 text-center font-mono text-sm text-term-dim2">
              {selectedSession ? 'No messages yet.' : 'New Chat'}
            </div>
          )}
        </div>

        {isTerminalPanelOpen && selectedTerminal ? (
          <SessionTerminalPanel
            terminal={selectedTerminal}
            isOpening={isOpeningTerminal}
            isSending={isSendingTerminalCommand}
            onSubmit={runSelectedTerminalCommand}
            onClear={clearSelectedTerminal}
            onClose={closeSelectedTerminal}
          />
        ) : null}

        <div className="shrink-0 border-t border-border bg-card p-2.5">
          {!selectedSession ? (
            <>
              {pendingLinkedSource ? (
                <div className="app-region-no-drag mb-2 rounded-lg border border-accent-ink/25 bg-accent-ink/[0.06] px-3 py-2 font-mono text-[10.5px] leading-4 text-muted-foreground">
                  <span className="font-medium text-foreground">Creating one Agent from {pendingLinkedSource.label}.</span> This records where it came from; it
                  does not add ongoing automation. Use New Workflow to keep Agents connected.
                </div>
              ) : null}
              {!isRuntimeAvailable ? (
                <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">{runtimeUnavailableText}</span>
                </div>
              ) : runtimeClient.kind === 'http' ? (
                <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">Folder picker is unavailable in web runtime. Enter a project path manually.</span>
                </div>
              ) : null}
              <NewChatSetupBar
                projects={newChatProjects}
                projectCwd={newCwd}
                validation={newCwdValidation}
                providerKind={newProviderKind}
                workMode={newWorkMode}
                branch={newBranch}
                runtimeMode={newRuntimeMode}
                model={newModel}
                reasoningEffort={newReasoningEffort}
                disabled={isCreating || !isRuntimeAvailable}
                canChooseProject={isElectron}
                onProjectChange={setNewCwd}
                onChooseProject={chooseNewChatProject}
                onProviderKindChange={changeNewProviderKind}
                onWorkModeChange={setNewWorkMode}
                onBranchChange={setNewBranch}
                onRuntimeModeChange={setNewRuntimeMode}
                onModelChange={setNewModel}
                onReasoningEffortChange={setNewReasoningEffort}
              />
            </>
          ) : null}
          <input
            ref={composerFileInputRef}
            className="hidden"
            type="file"
            multiple
            onChange={(event) => {
              if (event.currentTarget.files) {
                void addComposerFiles(event.currentTarget.files);
              }
              event.currentTarget.value = '';
            }}
          />
          <div
            className={cn(
              'app-region-no-drag @container mb-2 rounded-xl border border-ink-line bg-ink transition focus-within:border-lime-hi/55 focus-within:ring-1 focus-within:ring-lime-hi/25',
              isComposerDragActive && 'border-lime-hi/60 bg-lime/[0.05] ring-1 ring-lime-hi/25',
            )}
            onDragEnter={(event) => {
              if (event.dataTransfer.types.includes('Files')) {
                setIsComposerDragActive(true);
              }
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
              }
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                setIsComposerDragActive(false);
              }
            }}
            onDrop={handleComposerDrop}
          >
            {composerAttachments.length > 0 ? (
              <div className="grid gap-1.5 border-b border-ink-line-2 px-2.5 py-2">
                {composerAttachments.map((attachment) => (
                  <ComposerAttachmentPill key={attachment.id} attachment={attachment} disabled={composerDisabled} onRemove={removeComposerAttachment} />
                ))}
              </div>
            ) : null}
            <div className="flex cursor-text gap-2 px-3.5 pb-1 pt-3" onClick={() => composerEditorRef.current?.focus()}>
              <span
                className={cn('select-none font-mono text-[13px] leading-6 transition-colors', composerDisabled ? 'text-term-faint' : 'text-lime-hi')}
                aria-hidden="true"
              >
                ❯
              </span>
              <div
                ref={composerEditorRef}
                className="orrery-composer-editor max-h-40 min-h-6 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-mono text-[13px] leading-6 text-term-name outline-none"
                role="textbox"
                aria-multiline="true"
                aria-disabled={composerDisabled}
                contentEditable={!composerDisabled}
                data-placeholder={selectedSession ? 'Message this chat' : pendingLinkedSource ? 'Describe what this Agent should do' : 'Start a new chat'}
                suppressContentEditableWarning
                onInput={(event) => setMessage(event.currentTarget.innerText)}
                onPaste={handleComposerPaste}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void sendChatMessage();
                  }
                }}
              />
            </div>
            <div className="flex items-center gap-1 px-2 pb-2 pt-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="size-8 shrink-0 text-term-dim hover:text-term-name"
                    variant="ghost"
                    size="icon-sm"
                    disabled={composerDisabled}
                    aria-label="Attach files"
                    onClick={() => composerFileInputRef.current?.click()}
                  >
                    <Paperclip className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach files — or drag and drop, or paste</TooltipContent>
              </Tooltip>
              <div className="ml-auto flex items-center gap-2">
                {composerHasPayload && !canKill ? (
                  <span className="hidden font-mono text-[10px] text-term-faint @[26rem]:inline">{sendShortcutHint}</span>
                ) : null}
                {canKill ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        className="size-8 shrink-0 rounded-full"
                        variant="destructive"
                        size="icon-sm"
                        disabled={!isRuntimeAvailable || !selectedSession || !canKill}
                        aria-label="Stop"
                        onClick={killSelectedSession}
                      >
                        <Square className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Stop this run</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        className="size-8 shrink-0 rounded-full"
                        size="icon-sm"
                        disabled={
                          !isRuntimeAvailable || (selectedSession ? !canResume || isResuming : isCreating || !newCwdValidation.ok) || !composerHasPayload
                        }
                        aria-label={!selectedSession && pendingLinkedSource ? 'Create Agent' : 'Send'}
                        onClick={sendChatMessage}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {!selectedSession && pendingLinkedSource ? `Create Agent · ${sendShortcutHint}` : `Send · ${sendShortcutHint}`}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
