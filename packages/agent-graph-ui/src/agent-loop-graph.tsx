import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
  type OnSelectionChangeParams,
  type NodeChange,
} from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AgentRoleNode } from './agent-node';
import { AgentRelationshipEdge } from './relationship-edge';
import { LoopBadge } from './loop-badge';
import { LoopPanel } from './loop-panel';
import { RelationshipInspector } from './relationship-inspector';
import { LoopStatus } from './loop-status';
import {
  assertAgentGraphModel,
  createAgentLoopFlowElements,
  orientationForWidth,
  type AgentEdgeData,
  type AgentGraphFollowUpIntent,
  type AgentGraphModel,
  type AgentGraphSelection,
  type AgentNodeData,
} from './graph-model';

const nodeTypes = {
  'agent-role': AgentRoleNode,
};

const edgeTypes = {
  'agent-relationship': AgentRelationshipEdge,
};

export type AgentLoopGraphProps = {
  model: AgentGraphModel;
  mode?: 'snapshot' | 'live';
  liveState?: 'connecting' | 'live' | 'retrying';
  followUpAvailable?: boolean;
  explainAvailable?: boolean;
  controlAvailable?: boolean;
  onFollowUp?: (intent: AgentGraphFollowUpIntent) => void | Promise<void>;
  className?: string;
};

function joinClassNames(...values: Array<string | undefined | false>) {
  return values.filter(Boolean).join(' ');
}

function controlKind(model: AgentGraphModel) {
  if (model.status === 'paused' || model.status === 'interrupted') {
    return 'resume' as const;
  }
  return 'pause' as const;
}

export function AgentLoopGraph({
  model: modelValue,
  mode = 'snapshot',
  liveState,
  followUpAvailable = false,
  explainAvailable = followUpAvailable,
  controlAvailable = followUpAvailable,
  onFollowUp,
  className,
}: AgentLoopGraphProps) {
  const model = assertAgentGraphModel(modelValue);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [selection, setSelection] = useState<AgentGraphSelection>();
  const [followUpStatus, setFollowUpStatus] = useState('');
  const [loopPanelOpen, setLoopPanelOpen] = useState(false);
  const [stopConfirming, setStopConfirming] = useState(false);
  const orientation = orientationForWidth(width);
  const flow = useMemo(
    () => createAgentLoopFlowElements(model, orientation),
    [model, orientation],
  );
  const [presentationNodes, setPresentationNodes] = useState(flow.nodes);
  const nodes = presentationNodes.map((node) => ({
    ...node,
    draggable: true,
    selected: selection?.kind === 'node' && selection.id === node.id,
  }));
  const edges: Edge<AgentEdgeData>[] = flow.edges.map((edge) => ({
    ...edge,
    selected: selection?.kind === 'edge' && selection.id === edge.id,
    data: {
      ...(edge.data as AgentEdgeData),
      onSelect: (edgeId: string) => setSelection({ kind: 'edge', id: edgeId }),
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = () => {
      const nextWidth = Math.round(container.getBoundingClientRect().width);
      setWidth((currentWidth) =>
        currentWidth === nextWidth ? currentWidth : nextWidth,
      );
    };
    updateWidth();
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  useEffect(() => {
    setPresentationNodes(flow.nodes);
  }, [flow.nodes]);

  useEffect(() => {
    if (
      selection?.kind === 'node' &&
      !model.nodes.some((node) => node.id === selection.id)
    ) {
      setSelection(undefined);
    }
    if (
      selection?.kind === 'edge' &&
      !model.edges.some((edge) => edge.id === selection.id)
    ) {
      setSelection(undefined);
    }
  }, [model.edges, model.nodes, selection]);

  const selectedNode =
    selection?.kind === 'node'
      ? model.nodes.find((node) => node.id === selection.id)
      : undefined;
  const selectedEdge =
    selection?.kind === 'edge'
      ? model.edges.find((edge) => edge.id === selection.id)
      : undefined;

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    setSelection({ kind: 'node', id: node.id });
  };
  const onEdgeClick: EdgeMouseHandler = (_event, edge) => {
    setSelection({ kind: 'edge', id: edge.id });
  };
  const onSelectionChange = useCallback(
    ({
      nodes: selectedNodes,
      edges: selectedEdges,
    }: OnSelectionChangeParams<Node<AgentNodeData>, Edge<AgentEdgeData>>) => {
      const selectedNodeValue = selectedNodes.at(-1);
      if (selectedNodeValue) {
        setSelection({ kind: 'node', id: selectedNodeValue.id });
        return;
      }
      const selectedEdgeValue = selectedEdges.at(-1);
      if (selectedEdgeValue) {
        setSelection({ kind: 'edge', id: selectedEdgeValue.id });
        return;
      }
      setSelection(undefined);
    },
    [],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<AgentNodeData>>[]) => {
      setPresentationNodes((currentNodes) => {
        const meaningfulChanges = changes.filter((change) => {
          if (change.type !== 'dimensions' || !change.dimensions) return true;
          const currentNode = currentNodes.find((node) => node.id === change.id);
          return (
            currentNode?.measured?.width !== change.dimensions.width ||
            currentNode?.measured?.height !== change.dimensions.height
          );
        });
        return meaningfulChanges.length === 0
          ? currentNodes
          : applyNodeChanges(meaningfulChanges, currentNodes);
      });
    },
    [],
  );
  const onGraphKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const edgeElement = target.closest<SVGElement>('.react-flow__edge');
    const nodeElement = target.closest<HTMLElement>('.react-flow__node');
    if (edgeElement?.dataset.id) {
      setSelection({ kind: 'edge', id: edgeElement.dataset.id });
    } else if (nodeElement?.dataset.id) {
      setSelection({ kind: 'node', id: nodeElement.dataset.id });
    }
  };

  const requestFollowUp = async (
    kind: AgentGraphFollowUpIntent['kind'],
  ) => {
    const available = kind === 'explain' ? explainAvailable : controlAvailable;
    if (!available || !onFollowUp) {
      setFollowUpStatus('Host follow-up is unavailable.');
      return;
    }
    try {
      setFollowUpStatus('Requesting follow-up…');
      await onFollowUp({
        kind,
        runId: model.identity.runId,
        ...(selection ? { selection } : {}),
      });
      setFollowUpStatus('Follow-up requested.');
    } catch {
      setFollowUpStatus('Follow-up cancelled or failed.');
    }
  };

  const terminal = ['succeeded', 'capped', 'cancelled', 'failed'].includes(
    model.status,
  );
  const control = controlKind(model);
  const requestStopConfirmation = () => {
    setStopConfirming(true);
    setLoopPanelOpen(true);
  };
  const closeLoopPanel = () => {
    setStopConfirming(false);
    setLoopPanelOpen(false);
  };
  return (
    <section
      ref={containerRef}
      className={joinClassNames('looperators-agent-graph', className)}
      data-orientation={orientation}
      data-status={model.status}
      data-testid="agent-loop-graph"
      onKeyDownCapture={onGraphKeyDownCapture}
    >
      <LoopStatus model={model} mode={mode} liveState={liveState} />
      {model.needsHuman || model.cancelRequested || model.recovery ? (
        <div className="lag-alert" role="status">
          {model.recovery
            ? `Recovery: ${model.recovery.reason}`
            : model.cancelRequested
              ? 'Cancellation requested.'
              : 'Human attention is required.'}
        </div>
      ) : null}
      <div
        className="lag-workspace"
        data-panel-open={loopPanelOpen || Boolean(selectedEdge)}
      >
        <div className="lag-canvas-stack">
          <LoopBadge model={model} onOpen={() => setLoopPanelOpen(true)} />
          <div
            className="lag-flow"
            data-testid="graph-viewport"
            data-orientation={orientation}
          >
            <ReactFlow<Node<AgentNodeData>, Edge<AgentEdgeData>>
              key={orientation}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
              elevateEdgesOnSelect
              minZoom={0.45}
              maxZoom={1.5}
              fitView
              fitViewOptions={{ padding: 0.24, maxZoom: 1.05 }}
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onSelectionChange={onSelectionChange}
              onPaneClick={() => setSelection(undefined)}
              aria-label="Agent Loop relationship graph"
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
              <Controls position="bottom-right" />
              <MiniMap
                pannable
                zoomable
                position="bottom-left"
                bgColor="var(--lag-card)"
                maskColor="color-mix(in srgb, var(--lag-background) 55%, transparent)"
                nodeColor="var(--lag-card-muted)"
                nodeStrokeColor="var(--lag-border)"
              />
            </ReactFlow>
          </div>
        </div>
        {selectedEdge && !loopPanelOpen ? (
          <RelationshipInspector
            edge={selectedEdge}
            nodes={model.nodes}
            onClose={() => setSelection(undefined)}
            stopAvailable={controlAvailable && !terminal}
            onRequestStop={requestStopConfirmation}
          />
        ) : null}
        {loopPanelOpen ? (
          <LoopPanel
            model={model}
            onClose={closeLoopPanel}
            controlAvailable={controlAvailable}
            onControl={onFollowUp}
            confirming={stopConfirming}
            onConfirmingChange={setStopConfirming}
          />
        ) : null}
      </div>
      <section className="lag-inspector" aria-live="polite">
        <div className="lag-inspector-copy">
          <p className="lag-eyebrow">
            {selectedNode
              ? 'Selected node'
              : selectedEdge
                ? 'Selected relationship'
                : 'Verified snapshot'}
          </p>
          <h3>
            {selectedNode?.label ??
              (selectedEdge
                ? `${selectedEdge.source} → ${selectedEdge.target}`
                : 'Select a node or relationship')}
          </h3>
          <p>
            {selectedNode
              ? `${selectedNode.role} · ${selectedNode.state}${selectedNode.nativeAgentId ? ' · native worker bound' : ''}`
              : selectedEdge
                ? `${selectedEdge.kind} · ${selectedEdge.reportCount} reports${selectedEdge.active ? ' · active' : ''}`
                : `revision ${model.identity.revision} · digest ${model.identity.projectionDigest.slice(0, 12)}`}
          </p>
        </div>
        <div className="lag-actions">
          <button
            type="button"
            disabled={!selection || !explainAvailable}
            onClick={() => void requestFollowUp('explain')}
          >
            Explain selection
          </button>
          <button
            type="button"
            disabled={terminal || !controlAvailable}
            onClick={() => void requestFollowUp(control)}
          >
            Request {control}
          </button>
          <button
            type="button"
            disabled={terminal || !controlAvailable}
            onClick={requestStopConfirmation}
          >
            Review stop…
          </button>
        </div>
        {followUpStatus ? (
          <p className="lag-follow-up-status" role="status">
            {followUpStatus}
          </p>
        ) : null}
      </section>
      <details className="lag-timeline">
        <summary>
          Bounded timeline <span>{model.timeline.length}</span>
        </summary>
        <ol>
          {model.timeline.length > 0 ? (
            model.timeline.map((item) => (
              <li key={item.id}>
                <time dateTime={item.at}>{item.at}</time>
                <span>{item.label}</span>
                {item.role ? <small>{item.role}</small> : null}
              </li>
            ))
          ) : (
            <li>No authoritative timeline entries.</li>
          )}
        </ol>
      </details>
    </section>
  );
}
