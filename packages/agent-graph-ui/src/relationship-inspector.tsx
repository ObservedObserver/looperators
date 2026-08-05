import type { AgentGraphEdge, AgentGraphNode } from './graph-model';

function nodeLabel(nodes: AgentGraphNode[], id: string) {
  return nodes.find((node) => node.id === id)?.label ?? id;
}

export function RelationshipInspector({
  edge,
  nodes,
  onClose,
  onRequestStop,
  stopAvailable = false,
}: {
  edge: AgentGraphEdge;
  nodes: AgentGraphNode[];
  onClose: () => void;
  onRequestStop?: () => void;
  stopAvailable?: boolean;
}) {
  return (
    <aside className="lag-relationship-inspector" aria-label="Relationship details">
      <header>
        <span className="lag-panel-icon" aria-hidden="true">↗</span>
        <div>
          <p className="lag-eyebrow">Relationship</p>
          <h3>{edge.label ?? edge.kind}</h3>
        </div>
        <button type="button" className="lag-icon-button" aria-label="Close Relationship inspector" onClick={onClose}>×</button>
      </header>
      <dl className="lag-relationship-grid">
        <dt>From</dt><dd>{nodeLabel(nodes, edge.source)}</dd>
        <dt>When</dt><dd>{edge.summary ?? edge.kind}</dd>
        <dt>Then</dt><dd>{nodeLabel(nodes, edge.target)}</dd>
        <dt>Gate</dt><dd>{edge.gate ?? 'Governor'}</dd>
        <dt>State</dt>
        <dd>
          {edge.active ? 'active' : 'waiting'} · {edge.firings ?? edge.reportCount}
          {edge.maxFirings !== undefined ? `/${edge.maxFirings}` : ''} firings
        </dd>
        <dt>Stop when</dt><dd>{edge.stopWhen ?? 'run reaches a terminal state'}</dd>
      </dl>
      {edge.summary ? <p className="lag-panel-note">{edge.summary}</p> : null}
      <button
        type="button"
        className="lag-danger-button"
        disabled={!stopAvailable || !onRequestStop}
        onClick={onRequestStop}
      >
        {stopAvailable ? 'Stop future handoffs' : 'Control unavailable'}
      </button>
    </aside>
  );
}
