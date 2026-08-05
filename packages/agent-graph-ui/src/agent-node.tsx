import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { AgentNodeData } from './graph-model';

const ports = [
  ['left-in-upper', 'target', Position.Left, 'upper'],
  ['left-in-lower', 'target', Position.Left, 'lower'],
  ['left-out-upper', 'source', Position.Left, 'upper'],
  ['left-out-lower', 'source', Position.Left, 'lower'],
  ['right-in-upper', 'target', Position.Right, 'upper'],
  ['right-in-lower', 'target', Position.Right, 'lower'],
  ['right-out-upper', 'source', Position.Right, 'upper'],
  ['right-out-lower', 'source', Position.Right, 'lower'],
  ['top-in', 'target', Position.Top, 'center'],
  ['top-out', 'source', Position.Top, 'center'],
  ['bottom-in', 'target', Position.Bottom, 'center'],
  ['bottom-out', 'source', Position.Bottom, 'center'],
] as const;

function roleGlyph(role: AgentNodeData['node']['role']) {
  if (role === 'root') return '◆';
  if (role === 'implementer') return '⌘';
  return '✓';
}

function activityTime(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const AgentRoleNode = memo(function AgentRoleNode({
  data,
  selected,
}: NodeProps<Node<AgentNodeData>>) {
  const { node, latestReport, pending } = data;
  const runtimeLabel = node.runtimeLabel ?? (node.role === 'root' ? 'Governor' : 'Codex worker role');
  const stateLabel = pending ? 'pending' : node.role === 'root' ? 'master' : node.state;
  return (
    <article
      className="lag-node"
      data-role={node.role}
      data-state={node.state}
      data-selected={selected ? 'true' : 'false'}
      data-testid={`graph-node-${node.role}`}
      aria-label={`${node.label}, ${node.state}`}
    >
      {ports.map(([id, type, position, lane]) => (
        <Handle
          key={id}
          id={id}
          type={type}
          position={position}
          isConnectable={false}
          className={`lag-handle lag-handle-${lane} lag-handle-${type}`}
          aria-label={`${type} ${id} for ${node.label}`}
        />
      ))}
      <header className="lag-node-header">
        <span className="lag-node-glyph" aria-hidden="true">{roleGlyph(node.role)}</span>
        <span className="lag-node-heading">
          <strong title={node.label}>{node.label}</strong>
          <small title={node.model}>{node.model ?? runtimeLabel}</small>
        </span>
        <span className="lag-state-pill">{stateLabel}</span>
      </header>

      <div className="lag-node-body">
        {latestReport ? (
          <>
            <div className="lag-verdict" data-verdict={latestReport.verdict ?? latestReport.type}>
              <strong>
                {latestReport.verdict === 'clean'
                  ? '✓ clean'
                  : latestReport.verdict === 'issues'
                    ? `! ${latestReport.issueCount} issue${latestReport.issueCount === 1 ? '' : 's'}`
                    : 'done'}
              </strong>
              <span>{latestReport.type}</span>
            </div>
            {latestReport.summary ? <p className="lag-report-summary" title={latestReport.summary}>{latestReport.summary}</p> : null}
          </>
        ) : (
          <p className="lag-node-description">
            {node.description ??
              (node.role === 'root'
                ? 'Owns the cooperative transition decision.'
                : node.state === 'unbound'
                  ? 'Waiting for a role capability.'
                  : 'Participates through typed reports.')}
          </p>
        )}
      </div>

      <footer className="lag-node-footer">
        <span className="lag-node-activity"><b>{node.activityCount ?? 0}</b> events</span>
        <span title={node.lastActivityAt}>{activityTime(node.lastActivityAt) ?? node.id}</span>
      </footer>
    </article>
  );
});
