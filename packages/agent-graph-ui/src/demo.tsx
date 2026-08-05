/* oxlint-disable react/only-export-components -- standalone Vite entrypoint */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentLoopGraph } from './agent-loop-graph';
import { agentGraphScenarios, desktopParityModel } from './fixtures';
import type { AgentGraphFollowUpIntent } from './graph-model';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './demo.css';

function Demo() {
  const [scenarioName, setScenarioName] = useState('desktop-parity');
  const [dark, setDark] = useState(true);
  const [followUpAvailable, setFollowUpAvailable] = useState(true);
  const [lastIntent, setLastIntent] = useState<AgentGraphFollowUpIntent>();
  const model =
    scenarioName === 'desktop-parity'
      ? desktopParityModel
      : (agentGraphScenarios.find(
          (candidate) => candidate.name === scenarioName,
        )?.expectedModel ?? agentGraphScenarios[0].expectedModel);
  return (
    <main className="lag-demo" data-mode={dark ? 'dark' : 'light'}>
      <div className="lag-demo-toolbar">
        <label>
          Scenario
          <select
            value={scenarioName}
            onChange={(event) => setScenarioName(event.target.value)}
          >
            <option value="desktop-parity">desktop-parity</option>
            {agentGraphScenarios.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={dark}
            onChange={(event) => setDark(event.target.checked)}
          />
          Dark
        </label>
        <label>
          <input
            type="checkbox"
            checked={followUpAvailable}
            onChange={(event) => setFollowUpAvailable(event.target.checked)}
          />
          Follow-up host
        </label>
        <output data-testid="follow-up-output">
          {lastIntent
            ? `${lastIntent.kind}:${lastIntent.selection?.id ?? 'run'}`
            : 'No follow-up'}
        </output>
      </div>
      <AgentLoopGraph
        model={model}
        followUpAvailable={followUpAvailable}
        onFollowUp={(intent) => setLastIntent(intent)}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
