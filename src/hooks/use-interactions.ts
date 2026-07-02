import { type Dispatch, type SetStateAction, useCallback, useState } from 'react';

import type { GraphState } from '@/shared/graph-state';
import type { RuntimeRequest, RuntimeRequestDecision, UserInputAnswerMap, UserInputAnswerValue, UserInputRequest } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { answerValueAsString, userInputDraftKey } from '@/components/runtime-interaction-panel';

export function useInteractions({
  runtimeApi,
  runtimeUnavailableText,
  setRuntimeState,
  setRuntimeError,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeUnavailableText: string;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
}) {
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, UserInputAnswerValue>>({});
  const [pendingInteractionIds, setPendingInteractionIds] = useState<Record<string, boolean>>({});

  const respondToRuntimeRequest = useCallback(
    async (request: RuntimeRequest, decision: RuntimeRequestDecision) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText);
        return;
      }

      setPendingInteractionIds((current) => ({
        ...current,
        [request.id]: true,
      }));
      setRuntimeError(undefined);

      try {
        const result = await runtimeApi.respondRuntimeRequest({
          sessionId: request.sessionId,
          requestId: request.id,
          decision,
        });
        setRuntimeState(result.state);
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingInteractionIds((current) => {
          const next = { ...current };
          delete next[request.id];
          return next;
        });
      }
    },
    [runtimeApi, runtimeUnavailableText, setRuntimeError, setRuntimeState],
  );

  const setUserInputDraft = useCallback((requestId: string, value: UserInputAnswerValue) => {
    setUserInputDrafts((current) => ({
      ...current,
      [requestId]: value,
    }));
  }, []);

  const answerRuntimeUserInput = useCallback(
    async (request: UserInputRequest) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText);
        return;
      }

      const questions = request.questions ?? [];
      const answers: UserInputAnswerMap | undefined = questions.length
        ? Object.fromEntries(
            questions.map((question) => {
              const value = userInputDrafts[userInputDraftKey(request, question.id)];
              if (Array.isArray(value)) {
                return [question.id, value];
              }
              return [question.id, typeof value === 'string' ? value : ''];
            }),
          )
        : undefined;
      const answer = questions.length > 0 ? undefined : answerValueAsString(userInputDrafts[userInputDraftKey(request)]);

      setPendingInteractionIds((current) => ({
        ...current,
        [request.id]: true,
      }));
      setRuntimeError(undefined);

      try {
        const result = await runtimeApi.answerUserInput({
          sessionId: request.sessionId,
          requestId: request.id,
          ...(answer !== undefined ? { answer } : {}),
          ...(answers ? { answers } : {}),
        });
        setRuntimeState(result.state);
        setUserInputDrafts((current) => {
          const next = { ...current };
          delete next[userInputDraftKey(request)];
          for (const question of questions) {
            delete next[userInputDraftKey(request, question.id)];
          }
          return next;
        });
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingInteractionIds((current) => {
          const next = { ...current };
          delete next[request.id];
          return next;
        });
      }
    },
    [runtimeApi, runtimeUnavailableText, setRuntimeError, setRuntimeState, userInputDrafts],
  );

  return {
    userInputDrafts,
    setUserInputDraft,
    pendingInteractionIds,
    respondToRuntimeRequest,
    answerRuntimeUserInput,
  };
}

export type InteractionsState = ReturnType<typeof useInteractions>;
