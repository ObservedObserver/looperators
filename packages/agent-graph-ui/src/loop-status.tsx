import { statusTone, type AgentGraphModel } from './graph-model';

export function LoopStatus({
  model,
  mode,
  liveState,
}: {
  model: AgentGraphModel;
  mode: 'snapshot' | 'live';
  liveState?: 'connecting' | 'live' | 'retrying';
}) {
  return (
    <header className="lag-header">
      <div>
        <p className="lag-eyebrow">looperators</p>
        <h2>Agent Loop</h2>
      </div>
      <div className="lag-badges" aria-label="Loop status">
        <span className="lag-badge lag-verified">verified</span>
        <span className="lag-badge" data-tone={statusTone(model.status)}>
          {model.status}
        </span>
        <span className="lag-badge">
          lap {model.currentLap}/{model.lapCap}
        </span>
        <span className="lag-badge">
          lease {model.lease.consumed}/{model.lease.granted}
        </span>
        <span className="lag-badge">
          {mode === 'live' ? (liveState ?? 'connecting') : 'snapshot'}
        </span>
      </div>
    </header>
  );
}
