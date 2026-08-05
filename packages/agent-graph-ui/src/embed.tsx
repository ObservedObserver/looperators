/* oxlint-disable react/only-export-components -- self-mounting plugin entrypoint */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentLoopGraph } from './agent-loop-graph';
import {
  assertAgentGraphModel,
  type AgentGraphFollowUpIntent,
  type AgentGraphModel,
} from './graph-model';
import '@xyflow/react/dist/style.css';
import './styles.css';

type EmbedEnvelope = {
  model: AgentGraphModel;
  mode?: 'snapshot' | 'live';
  followUpAvailable?: boolean;
};

type OpenAIHost = {
  sendFollowUpMessage?: (input: {
    prompt: string;
    title?: string;
  }) => Promise<void>;
};

declare global {
  interface Window {
    openai?: OpenAIHost;
    looperatorsAgentGraphView?: {
      update: (nextModel: unknown) => void;
      integrityError: (code: string) => void;
    };
  }
}

const rootElement = document.getElementById('looperators-agent-graph-root');
const dataElement = document.getElementById('looperators-agent-graph-data');

function promptFor(intent: AgentGraphFollowUpIntent) {
  const selected = intent.selection?.id;
  if (intent.kind === 'explain') {
    return `Explain ${selected ? `the selected Agent Loop item ${selected}` : 'this Agent Loop'} for run ${intent.runId}. Separate authoritative projection facts from inference.`;
  }
  return `Please preview ${intent.kind} for looperators Agent Loop run ${intent.runId}. Do not mutate it until I confirm.`;
}

if (rootElement && dataElement) {
  const envelope = JSON.parse(dataElement.textContent ?? '{}') as EmbedEnvelope;
  const initialModel = assertAgentGraphModel(envelope.model);
  let setExternalModel: ((next: AgentGraphModel) => void) | undefined;
  let setIntegrityError: ((code: string | undefined) => void) | undefined;

  function EmbeddedGraph() {
    const [model, setModel] = useState(initialModel);
    const [error, setError] = useState<string>();
    setExternalModel = setModel;
    setIntegrityError = setError;
    const hostAvailable =
      envelope.followUpAvailable === true &&
      typeof window.openai?.sendFollowUpMessage === 'function';
    return (
      <>
        {error ? (
          <p className="lag-embed-error" role="status">
            Snapshot unavailable: {error}
          </p>
        ) : null}
        <AgentLoopGraph
          model={model}
          mode={envelope.mode ?? 'snapshot'}
          liveState={envelope.mode === 'live' ? 'live' : undefined}
          followUpAvailable={hostAvailable}
          onFollowUp={
            hostAvailable
              ? (intent) =>
                  window.openai?.sendFollowUpMessage?.({
                    prompt: promptFor(intent),
                    title: `looperators Agent Loop ${intent.kind}`,
                  })
              : undefined
          }
        />
      </>
    );
  }

  createRoot(rootElement).render(<EmbeddedGraph />);
  window.looperatorsAgentGraphView = Object.freeze({
    update(nextModel) {
      setIntegrityError?.(undefined);
      setExternalModel?.(assertAgentGraphModel(nextModel));
    },
    integrityError(code) {
      setIntegrityError?.(String(code).slice(0, 80));
    },
  });
}
