import { type Dispatch, type SetStateAction, useCallback, useState } from 'react';

import type { AgentSession, RuntimeTerminal } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function useTerminalPanel({
  runtimeApi,
  runtimeUnavailableText,
  setRuntimeError,
  selectedSession,
  isRuntimeAvailable,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeUnavailableText: string;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  selectedSession: AgentSession | undefined;
  isRuntimeAvailable: boolean;
}) {
  const [terminalPanel, setTerminalPanel] = useState<RuntimeTerminal>();
  const [isTerminalPanelOpen, setIsTerminalPanelOpen] = useState(false);
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false);
  const [isSendingTerminalCommand, setIsSendingTerminalCommand] = useState(false);

  const selectedTerminal = terminalPanel?.sessionId === selectedSession?.sessionId ? terminalPanel : undefined;
  const canOpenSelectedTerminal = Boolean(isRuntimeAvailable && selectedSession?.sessionId && selectedSession?.cwd.trim());

  const syncTerminalFromEvent = useCallback((terminal: RuntimeTerminal) => {
    setTerminalPanel((current) => (current?.terminalId === terminal.terminalId ? terminal : current));
  }, []);

  const openSelectedTerminal = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText);
      return undefined;
    }
    if (!selectedSession) {
      return undefined;
    }

    setIsOpeningTerminal(true);
    setRuntimeError(undefined);

    try {
      const result = await runtimeApi.createTerminal({
        sessionId: selectedSession.sessionId,
        cwd: selectedSession.cwd,
      });
      setTerminalPanel(result.terminal);
      setIsTerminalPanelOpen(true);
      return result.terminal;
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setIsOpeningTerminal(false);
    }
  }, [runtimeApi, runtimeUnavailableText, selectedSession, setRuntimeError]);

  const runSelectedTerminalCommand = useCallback(
    async (command: string) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText);
        return;
      }

      const terminal = selectedTerminal?.status === 'running' ? selectedTerminal : await openSelectedTerminal();
      if (!terminal) {
        return;
      }

      setIsSendingTerminalCommand(true);
      setRuntimeError(undefined);

      try {
        const result = await runtimeApi.runTerminalCommand({
          terminalId: terminal.terminalId,
          command,
        });
        setTerminalPanel(result.terminal);
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const currentCommand = result.terminal.currentCommand;
          if (!currentCommand || currentCommand.commandId !== result.commandId) {
            break;
          }

          await wait(100);
          const refreshed = await runtimeApi.getTerminal({
            terminalId: terminal.terminalId,
          });
          setTerminalPanel(refreshed.terminal);
          const finished = refreshed.terminal.lastCommand;
          if (finished?.commandId === result.commandId || refreshed.terminal.currentCommand?.commandId !== result.commandId) {
            break;
          }
        }
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsSendingTerminalCommand(false);
      }
    },
    [openSelectedTerminal, runtimeApi, runtimeUnavailableText, selectedTerminal, setRuntimeError],
  );

  const clearSelectedTerminal = useCallback(async () => {
    if (!runtimeApi || !selectedTerminal) {
      return;
    }

    try {
      const result = await runtimeApi.clearTerminal({
        terminalId: selectedTerminal.terminalId,
      });
      setTerminalPanel(result.terminal);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }
  }, [runtimeApi, selectedTerminal, setRuntimeError]);

  const closeSelectedTerminal = useCallback(async () => {
    if (!runtimeApi || !selectedTerminal) {
      setIsTerminalPanelOpen(false);
      return;
    }

    try {
      const result = await runtimeApi.closeTerminal({
        terminalId: selectedTerminal.terminalId,
      });
      setTerminalPanel(result.terminal);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTerminalPanelOpen(false);
    }
  }, [runtimeApi, selectedTerminal, setRuntimeError]);

  return {
    terminalPanel,
    isTerminalPanelOpen,
    setIsTerminalPanelOpen,
    isOpeningTerminal,
    isSendingTerminalCommand,
    selectedTerminal,
    canOpenSelectedTerminal,
    syncTerminalFromEvent,
    openSelectedTerminal,
    runSelectedTerminalCommand,
    clearSelectedTerminal,
    closeSelectedTerminal,
  };
}

export type TerminalPanelState = ReturnType<typeof useTerminalPanel>;
