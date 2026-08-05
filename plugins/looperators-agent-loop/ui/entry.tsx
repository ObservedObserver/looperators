/* oxlint-disable react/only-export-components -- self-mounting plugin entrypoint */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AgentLoopGraph,
  type AgentGraphFollowUpIntent,
  type AgentGraphModel,
} from '@looperators/agent-graph-ui';
import { projectionToAgentGraphModel } from '../lib/projection-to-graph-model.mjs';
import '@xyflow/react/dist/style.css';
import '@looperators/agent-graph-ui/styles.css';

type PluginEnvelope = {
  projection: unknown;
  expectedProjectionDigest: string;
  runId: string;
  mode: 'inline' | 'sidecar';
  driftNote?: string;
  eventsUrl?: string;
  controlUrl?: string;
  csrfToken?: string;
};

declare global {
  interface Window {
    looperatorsAgentLoopView?: {
      update: (nextVerifiedProjection: unknown) => void;
      integrityError: (code: string) => void;
    };
  }
}

const rootElement = document.getElementById('looperators-agent-loop-root');
const fallbackElement = document.getElementById(
  'looperators-agent-loop-fallback',
);
const dataElement = document.getElementById('looperators-agent-loop-data');

function boundedCode(value: unknown) {
  return String(value ?? 'SURFACE_REQUEST_FAILED').slice(0, 80);
}

if (rootElement && dataElement) {
  const envelope = JSON.parse(
    dataElement.textContent ?? '{}',
  ) as PluginEnvelope;
  const initialModel = projectionToAgentGraphModel(envelope.projection, {
    expectedProjectionDigest: envelope.expectedProjectionDigest,
    expectedRunId: envelope.runId,
  });

  function PluginAgentLoopGraph() {
    const [model, setModel] = useState<AgentGraphModel>(initialModel);
    const [liveState, setLiveState] = useState<
      'connecting' | 'live' | 'retrying' | undefined
    >(envelope.mode === 'sidecar' ? 'connecting' : undefined);
    const [integrityError, setIntegrityError] = useState<string>();

    useEffect(() => {
      fallbackElement?.setAttribute('hidden', '');
      window.looperatorsAgentLoopView = Object.freeze({
        update(nextVerifiedProjection) {
          setModel(
            projectionToAgentGraphModel(nextVerifiedProjection, {
              expectedRunId: initialModel.identity.runId,
            }),
          );
          setIntegrityError(undefined);
          setLiveState(envelope.mode === 'sidecar' ? 'live' : undefined);
        },
        integrityError(code) {
          setIntegrityError(boundedCode(code));
        },
      });
      return () => {
        delete window.looperatorsAgentLoopView;
      };
    }, []);

    useEffect(() => {
      if (envelope.mode !== 'sidecar' || !envelope.eventsUrl) return;
      const stream = new EventSource(envelope.eventsUrl);
      stream.addEventListener('open', () => setLiveState('live'));
      stream.addEventListener('snapshot', (event) => {
        try {
          window.looperatorsAgentLoopView?.update(
            JSON.parse((event as MessageEvent<string>).data),
          );
        } catch {
          setIntegrityError('GRAPH_VIEW_PROJECTION_INVALID');
        }
      });
      stream.addEventListener('integrity-error', (event) => {
        try {
          const value = JSON.parse((event as MessageEvent<string>).data);
          setIntegrityError(boundedCode(value.code));
        } catch {
          setIntegrityError('HISTORY_CORRUPT');
        }
      });
      stream.onerror = () => setLiveState('retrying');
      return () => stream.close();
    }, []);

    const requestControl = async (intent: AgentGraphFollowUpIntent) => {
      if (
        intent.kind === 'explain' ||
        !envelope.controlUrl ||
        !envelope.csrfToken
      ) {
        throw new Error('CONTROL_UNAVAILABLE');
      }
      const response = await fetch(envelope.controlUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Looperators-CSRF': envelope.csrfToken,
        },
        body: JSON.stringify({
          action: intent.kind,
          requestId: `surface-${crypto.randomUUID()}`,
        }),
      });
      if (!response.ok) {
        throw new Error(boundedCode((await response.json()).code));
      }
    };

    return (
      <>
        {integrityError ? (
          <p className="lag-embed-error" role="status">
            Snapshot unavailable: {integrityError}
          </p>
        ) : null}
        <AgentLoopGraph
          model={model}
          mode={envelope.mode === 'sidecar' ? 'live' : 'snapshot'}
          liveState={liveState}
          explainAvailable={false}
          controlAvailable={
            envelope.mode === 'sidecar' &&
            Boolean(envelope.controlUrl && envelope.csrfToken)
          }
          onFollowUp={requestControl}
        />
      </>
    );
  }

  createRoot(rootElement).render(<PluginAgentLoopGraph />);
}
