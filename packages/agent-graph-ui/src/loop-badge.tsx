import type { AgentGraphModel } from './graph-model';
import { statusTone } from './graph-model';

export function LoopBadge({
  model,
  onOpen,
}: {
  model: AgentGraphModel;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="lag-loop-badge"
      data-tone={statusTone(model.status)}
      aria-label={`Open Loop details, lap ${model.currentLap} of ${model.lapCap}`}
      onClick={onOpen}
    >
      <span className="lag-loop-badge-icon" aria-hidden="true">↻</span>
      <span className="lag-loop-badge-copy">
        <strong>{model.status === 'running' ? 'Review loop active' : `Review loop ${model.status}`}</strong>
        <small>{model.stopReason ?? `Lap ${model.currentLap}/${model.lapCap}`}</small>
      </span>
      <span className="lag-loop-badge-lap">{model.currentLap}/{model.lapCap}</span>
    </button>
  );
}
