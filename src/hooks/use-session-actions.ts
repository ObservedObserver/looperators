import { type Dispatch, type RefObject, type SetStateAction, useCallback, useState } from 'react';

import type { AgentMessage, AgentSession, GraphState, OpenWorkspaceTarget, WorkMode } from '@/shared/graph-state';
import type { ChatAttachment, ProviderInstance, ProviderKind, ProviderReasoningEffort, ProviderRuntimeMode, RuntimePlan } from '@/shared/provider-runtime';
import { providerSupportsThreadGoals } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { parseGoalComposerCommand, type GoalComposerCommand } from '@shared/thread-goal';
import { defaultWorkspaceCwd, latestSessionCwd, validateProjectCwd } from '@/lib/workspace';
import { providerOption, providerRuntimeSettingsDraft } from '@/lib/provider-catalog';
import type { RailTab } from '@/lib/layout-prefs';

export function useSessionActions({
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
  composer,
  newChat,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeUnavailableText: string;
  runtimeState: GraphState;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  sessions: AgentSession[];
  selectedSession: AgentSession | undefined;
  selectedSessionId: string | null | undefined;
  setSelectedSessionId: Dispatch<SetStateAction<string | null | undefined>>;
  isRuntimeAvailable: boolean;
  canResume: boolean;
  invalidProjectCwds: Set<string>;
  setActiveTab: Dispatch<SetStateAction<RailTab>>;
  setShowRawEvents: Dispatch<SetStateAction<boolean>>;
  composer: {
    message: string;
    composerAttachments: ChatAttachment[];
    clearComposer: () => void;
    setComposerText: (text: string) => void;
    composerEditorRef: RefObject<HTMLDivElement | null>;
  };
  newChat: {
    newCwd: string;
    setNewCwd: Dispatch<SetStateAction<string>>;
    newWorkMode: WorkMode;
    setNewWorkMode: Dispatch<SetStateAction<WorkMode>>;
    newBranch: string;
    setNewBranch: Dispatch<SetStateAction<string>>;
    newProviderKind: ProviderKind;
    newRuntimeMode: ProviderRuntimeMode;
    newModel: string;
    newReasoningEffort: ProviderReasoningEffort;
    newProviderInstance: ProviderInstance;
    changeNewProviderKind: (providerKind: ProviderKind) => void;
  };
}) {
  const { message, composerAttachments, clearComposer, setComposerText, composerEditorRef } = composer;
  const {
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
  } = newChat;

  const [isCreating, setIsCreating] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string>();
  const [pendingLinkedSourceId, setPendingLinkedSourceId] = useState<string | null>(null);
  const [openingWorkspaceTarget, setOpeningWorkspaceTarget] = useState<OpenWorkspaceTarget>();

  const pendingLinkedSource = pendingLinkedSourceId ? runtimeState.sessions[pendingLinkedSourceId] : undefined;
  const composerDisabled = !isRuntimeAvailable || (selectedSession ? !canResume || isResuming : isCreating);
  const canOpenSelectedWorkspace = Boolean(isRuntimeAvailable && selectedSession?.cwd.trim());

  const startNewChat = useCallback(() => {
    setPendingLinkedSourceId(null);
    setSelectedSessionId(null);
    setNewCwd(latestSessionCwd(sessions, invalidProjectCwds) ?? defaultWorkspaceCwd());
    setNewWorkMode('local');
    setNewBranch('');
    setActiveTab('chat');
    setShowRawEvents(false);
    clearComposer();
  }, [clearComposer, invalidProjectCwds, sessions, setActiveTab, setNewBranch, setNewCwd, setNewWorkMode, setSelectedSessionId, setShowRawEvents]);

  const startLinkedChat = useCallback(() => {
    if (!selectedSession) {
      return;
    }

    const sourceCwd = invalidProjectCwds.has(selectedSession.cwd)
      ? (latestSessionCwd(sessions, invalidProjectCwds) ?? defaultWorkspaceCwd())
      : selectedSession.cwd;

    setPendingLinkedSourceId(selectedSession.sessionId);
    setSelectedSessionId(null);
    changeNewProviderKind(selectedSession.providerKind);
    setNewCwd(sourceCwd);
    setNewWorkMode('local');
    setNewBranch('');
    setActiveTab('chat');
    setShowRawEvents(false);
    clearComposer();
  }, [
    changeNewProviderKind,
    clearComposer,
    invalidProjectCwds,
    selectedSession,
    sessions,
    setActiveTab,
    setNewBranch,
    setNewCwd,
    setNewWorkMode,
    setSelectedSessionId,
    setShowRawEvents,
  ]);

  const createSessionFromPrompt = useCallback(
    async (
      prompt: string,
      options: {
        sourceSessionId?: string | null;
        context?: string;
        attachments?: ChatAttachment[];
      } = {},
    ) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText);
        return false;
      }

      const trimmedPrompt = prompt.trim();
      if (trimmedPrompt.length === 0) {
        return false;
      }

      const cwd = newCwd.trim();
      const cwdValidation = validateProjectCwd(cwd);
      if (!cwdValidation.ok) {
        setRuntimeError(cwdValidation.message);
        return false;
      }

      const sourceSessionId =
        typeof options.sourceSessionId === 'string' && options.sourceSessionId.trim().length > 0 ? options.sourceSessionId.trim() : undefined;
      if (sourceSessionId && !runtimeState.sessions[sourceSessionId]) {
        setRuntimeError('Linked chat source is no longer available.');
        return false;
      }

      setIsCreating(true);
      setRuntimeError(undefined);

      try {
        const selectedProvider = providerOption(newProviderKind);
        const result = await runtimeApi.createSession({
          prompt: trimmedPrompt,
          context: options.context,
          attachments: options.attachments,
          cwd,
          workMode: newWorkMode,
          ...(newWorkMode === 'worktree' && newBranch.trim().length > 0 ? { branch: newBranch.trim() } : {}),
          agent: selectedProvider.agent,
          providerKind: selectedProvider.id,
          providerInstanceId: newProviderInstance.providerInstanceId,
          runtimeSettings: providerRuntimeSettingsDraft({
            runtimeMode: newRuntimeMode,
            model: newModel,
            reasoningEffort: newReasoningEffort,
          }),
          label: `${sourceSessionId ? 'Agent' : 'New Chat'} ${sessions.length + 1}`,
          ...(sourceSessionId
            ? {
                sourceSessionId,
                linkLabel: 'created from chat',
              }
            : {}),
        });
        setRuntimeState(result.state);
        setSelectedSessionId(result.sessionId);
        setPendingLinkedSourceId(null);
        setActiveTab('chat');
        return true;
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setIsCreating(false);
      }
    },
    [
      newBranch,
      newCwd,
      newModel,
      newProviderInstance.providerInstanceId,
      newProviderKind,
      newReasoningEffort,
      newRuntimeMode,
      newWorkMode,
      runtimeApi,
      runtimeState.sessions,
      runtimeUnavailableText,
      sessions.length,
      setActiveTab,
      setRuntimeError,
      setRuntimeState,
      setSelectedSessionId,
    ],
  );

  const sendChatMessage = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText);
      return;
    }

    const trimmed = message.trim();
    if (trimmed.length === 0 && composerAttachments.length === 0) {
      return;
    }
    const goalCommand = parseGoalComposerCommand(trimmed);
    if (goalCommand) {
      if (composerAttachments.length > 0) {
        setRuntimeError('Remove attachments before using /goal.');
        return;
      }
      if (goalCommand.kind === 'invalid') {
        setRuntimeError(goalCommand.message);
        return;
      }
      if (goalCommand.kind === 'view') {
        if (!selectedSession?.threadGoal) {
          setRuntimeError('This chat does not have a goal.');
        } else {
          setRuntimeError(undefined);
          clearComposer();
        }
        return;
      }

      const providerKind = selectedSession?.providerKind ?? newProviderKind;
      if (!providerSupportsThreadGoals(providerKind)) {
        setRuntimeError('Thread goals are supported by Codex chats only.');
        return;
      }

      if (!selectedSession || !selectedSessionId) {
        if (goalCommand.kind !== 'set') {
          setRuntimeError('Set a goal objective before using goal controls.');
          return;
        }
        const cwd = newCwd.trim();
        const cwdValidation = validateProjectCwd(cwd);
        if (!cwdValidation.ok) {
          setRuntimeError(cwdValidation.message);
          return;
        }
        setIsCreating(true);
        setRuntimeError(undefined);
        try {
          const selectedProvider = providerOption(newProviderKind);
          const result = await runtimeApi.setThreadGoal({
            objective: goalCommand.objective,
            status: 'active',
            cwd,
            workMode: newWorkMode,
            ...(newWorkMode === 'worktree' && newBranch.trim().length > 0 ? { branch: newBranch.trim() } : {}),
            agent: selectedProvider.agent,
            providerKind: selectedProvider.id,
            providerInstanceId: newProviderInstance.providerInstanceId,
            runtimeSettings: providerRuntimeSettingsDraft({
              runtimeMode: newRuntimeMode,
              model: newModel,
              reasoningEffort: newReasoningEffort,
            }),
            label: `New Chat ${sessions.length + 1}`,
            ...(pendingLinkedSourceId
              ? { sourceSessionId: pendingLinkedSourceId, linkLabel: 'created from chat' }
              : {}),
          });
          setRuntimeState(result.state);
          if (result.sessionId) setSelectedSessionId(result.sessionId);
          setPendingLinkedSourceId(null);
          setActiveTab('chat');
          clearComposer();
        } catch (error) {
          setRuntimeError(error instanceof Error ? error.message : String(error));
        } finally {
          setIsCreating(false);
        }
        return;
      }

      setIsResuming(true);
      setRuntimeError(undefined);
      try {
        const result = goalCommand.kind === 'clear'
          ? await runtimeApi.clearThreadGoal({ sessionId: selectedSessionId })
          : await runtimeApi.setThreadGoal({
              sessionId: selectedSessionId,
              ...(goalCommand.kind === 'set'
                ? { objective: goalCommand.objective, status: 'active' as const }
                : { status: goalCommand.kind === 'pause' ? 'paused' as const : 'active' as const }),
            });
        setRuntimeState(result.state);
        clearComposer();
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsResuming(false);
      }
      return;
    }
    const prompt = trimmed.length > 0 ? trimmed : 'Please review the attached files.';

    if (!selectedSession || !selectedSessionId) {
      const created = await createSessionFromPrompt(prompt, {
        sourceSessionId: pendingLinkedSourceId,
        attachments: composerAttachments,
      });
      if (created) {
        clearComposer();
      }
      return;
    }

    setIsResuming(true);
    setRuntimeError(undefined);

    try {
      const result = await runtimeApi.resumeSession({
        sessionId: selectedSessionId,
        message: prompt,
        attachments: composerAttachments,
      });
      setRuntimeState(result.state);
      clearComposer();
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsResuming(false);
    }
  }, [
    clearComposer,
    composerAttachments,
    createSessionFromPrompt,
    message,
    newBranch,
    newCwd,
    newModel,
    newProviderInstance.providerInstanceId,
    newProviderKind,
    newReasoningEffort,
    newRuntimeMode,
    newWorkMode,
    pendingLinkedSourceId,
    runtimeApi,
    runtimeUnavailableText,
    selectedSession,
    selectedSessionId,
    setRuntimeError,
    setRuntimeState,
    setSelectedSessionId,
    setActiveTab,
    sessions.length,
  ]);

  const controlSelectedThreadGoal = useCallback(async (command: Extract<GoalComposerCommand, { kind: 'pause' | 'resume' | 'clear' }>) => {
    if (!runtimeApi || !selectedSessionId) return;
    setIsResuming(true);
    setRuntimeError(undefined);
    try {
      const result = command.kind === 'clear'
        ? await runtimeApi.clearThreadGoal({ sessionId: selectedSessionId })
        : await runtimeApi.setThreadGoal({
            sessionId: selectedSessionId,
            status: command.kind === 'pause' ? 'paused' : 'active',
          });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsResuming(false);
    }
  }, [runtimeApi, selectedSessionId, setRuntimeError, setRuntimeState]);

  const killSelectedSession = useCallback(async () => {
    if (!runtimeApi || !selectedSessionId) {
      return;
    }

    try {
      const result = await runtimeApi.killSession(selectedSessionId);
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }
  }, [runtimeApi, selectedSessionId, setRuntimeError, setRuntimeState]);

  const forkSessionFromMessage = useCallback(
    async (assistantMessage: AgentMessage) => {
      if (!runtimeApi || !selectedSessionId || !selectedSession) {
        setRuntimeError(runtimeUnavailableText);
        return;
      }

      setForkingMessageId(assistantMessage.id);
      setRuntimeError(undefined);
      try {
        const result = await runtimeApi.forkSession({
          sessionId: selectedSessionId,
          messageId: assistantMessage.id,
        });
        setRuntimeState(result.state);
        setSelectedSessionId(result.sessionId);
        setPendingLinkedSourceId(null);
        setActiveTab('chat');
        setShowRawEvents(false);
        clearComposer();
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setForkingMessageId(undefined);
      }
    },
    [
      clearComposer,
      runtimeApi,
      runtimeUnavailableText,
      selectedSession,
      selectedSessionId,
      setActiveTab,
      setRuntimeError,
      setRuntimeState,
      setSelectedSessionId,
      setShowRawEvents,
    ],
  );

  const openSelectedWorkspace = useCallback(
    async (target: OpenWorkspaceTarget) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText);
        return;
      }
      if (!selectedSession) {
        return;
      }

      setOpeningWorkspaceTarget(target);
      setRuntimeError(undefined);

      try {
        await runtimeApi.openWorkspace({
          cwd: selectedSession.cwd,
          target,
        });
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setOpeningWorkspaceTarget(undefined);
      }
    },
    [runtimeApi, runtimeUnavailableText, selectedSession, setRuntimeError],
  );

  const continueRuntimePlan = useCallback(
    async (plan: RuntimePlan) => {
      if (!runtimeApi || !selectedSessionId) {
        setRuntimeError(runtimeUnavailableText);
        return;
      }

      const planText = plan.items.map((item, index) => `${index + 1}. ${item.title}`).join('\n');
      const messageText = ['Proceed with this proposed plan.', planText ? `\nPlan:\n${planText}` : undefined].filter(Boolean).join('\n');

      setIsResuming(true);
      setRuntimeError(undefined);

      try {
        const result = await runtimeApi.resumeSession({
          sessionId: selectedSessionId,
          message: messageText,
        });
        setRuntimeState(result.state);
        clearComposer();
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsResuming(false);
      }
    },
    [clearComposer, runtimeApi, runtimeUnavailableText, selectedSessionId, setRuntimeError, setRuntimeState],
  );

  const reviseRuntimePlan = useCallback(
    (plan: RuntimePlan) => {
      const title = plan.title ?? 'this plan';
      setComposerText(`Revise ${title}: `);
      composerEditorRef.current?.focus();
    },
    [composerEditorRef, setComposerText],
  );

  return {
    isCreating,
    isResuming,
    forkingMessageId,
    pendingLinkedSourceId,
    setPendingLinkedSourceId,
    pendingLinkedSource,
    openingWorkspaceTarget,
    composerDisabled,
    canOpenSelectedWorkspace,
    startNewChat,
    startLinkedChat,
    createSessionFromPrompt,
    sendChatMessage,
    controlSelectedThreadGoal,
    killSelectedSession,
    forkSessionFromMessage,
    openSelectedWorkspace,
    continueRuntimePlan,
    reviseRuntimePlan,
  };
}

export type SessionActionsState = ReturnType<typeof useSessionActions>;
