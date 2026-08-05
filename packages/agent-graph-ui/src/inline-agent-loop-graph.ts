import type {
  AgentGraphFollowUpIntent,
  AgentGraphModel,
  AgentGraphSelection,
} from './graph-model';

export type InlineAgentLoopGraphOptions = {
  model: AgentGraphModel;
  mode?: 'snapshot' | 'live';
  liveState?: 'connecting' | 'live' | 'retrying';
  driftNote?: string;
  followUpAvailable?: boolean;
  onFollowUp?: (intent: AgentGraphFollowUpIntent) => void | Promise<void>;
};

export type InlineAgentLoopGraphController = {
  update: (
    model: AgentGraphModel,
    options?: Pick<InlineAgentLoopGraphOptions, 'liveState'>,
  ) => void;
  integrityError: (code: string) => void;
  destroy: () => void;
};

type Point = {
  x: number;
  y: number;
};

const nodePositions: Record<AgentGraphModel['nodes'][number]['role'], Point> = {
  root: { x: 55, y: 92 },
  implementer: { x: 375, y: 92 },
  reviewer: { x: 695, y: 92 },
};

const edgeGeometry: Record<
  AgentGraphModel['edges'][number]['kind'],
  { path: string; label: Point }
> = {
  governs: {
    path: 'M 325 158 C 342 158 358 158 375 158',
    label: { x: 350, y: 133 },
  },
  handoff: {
    path: 'M 645 158 C 662 158 678 158 695 158',
    label: { x: 670, y: 133 },
  },
  feedback: {
    path: 'M 695 213 C 670 292 665 292 645 213',
    label: { x: 670, y: 284 },
  },
  verdict: {
    path: 'M 695 226 C 645 342 375 342 325 226',
    label: { x: 510, y: 331 },
  },
};

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function compactId(value: string) {
  return value.length > 28
    ? `${value.slice(0, 12)}…${value.slice(-9)}`
    : value;
}

function statusTone(status: AgentGraphModel['status']) {
  if (status === 'running') return 'active';
  if (status === 'succeeded') return 'success';
  if (['paused', 'interrupted', 'capped'].includes(status)) return 'warning';
  if (['failed', 'cancelled'].includes(status)) return 'danger';
  return 'neutral';
}

function nodeDescription(
  node: AgentGraphModel['nodes'][number],
  model: AgentGraphModel,
) {
  if (model.latestReport?.fromRole === node.role) {
    if (model.latestReport.verdict === 'clean') return 'Clean verdict';
    if (model.latestReport.verdict === 'issues') {
      return `${model.latestReport.issueCount} issue${
        model.latestReport.issueCount === 1 ? '' : 's'
      }`;
    }
    return 'Worker report received';
  }
  if (node.role === 'root') return 'Owns bounded continuation decisions';
  if (node.state === 'unbound') return 'Waiting for native worker binding';
  return 'Bound to the task-scoped worker role';
}

function renderNode(
  node: AgentGraphModel['nodes'][number],
  index: number,
  model: AgentGraphModel,
  selection?: AgentGraphSelection,
) {
  const { x, y } = nodePositions[node.role];
  const selected = selection?.kind === 'node' && selection.id === node.id;
  const pending = model.pending?.role === node.role;
  const glyph =
    node.role === 'root' ? 'G' : node.role === 'implementer' ? 'I' : 'R';
  const subtitle = node.role === 'root' ? 'Governor' : 'Native worker role';
  return `<g class="lag-inline-node" data-node-index="${index}" data-role="${escapeHtml(
    node.role,
  )}" data-state="${escapeHtml(node.state)}" data-selected="${
    selected ? 'true' : 'false'
  }" role="button" tabindex="0" aria-label="${escapeHtml(
    `${node.label}, ${node.state}`,
  )}" transform="translate(${x} ${y})">
    <rect class="lag-inline-node-card" width="270" height="146" rx="14"></rect>
    <rect class="lag-inline-glyph-box" x="14" y="14" width="34" height="34" rx="10"></rect>
    <text class="lag-inline-glyph" x="31" y="36" text-anchor="middle">${glyph}</text>
    <text class="lag-inline-node-title" x="60" y="27">${escapeHtml(node.label)}</text>
    <text class="lag-inline-node-subtitle" x="60" y="43">${subtitle}</text>
    <rect class="lag-inline-state-box" x="194" y="15" width="62" height="22" rx="11"></rect>
    <text class="lag-inline-state" x="225" y="30" text-anchor="middle">${escapeHtml(
      pending ? 'pending' : node.state,
    )}</text>
    <rect class="lag-inline-description-box" x="14" y="60" width="242" height="48" rx="9"></rect>
    <text class="lag-inline-description" x="26" y="82">${escapeHtml(
      nodeDescription(node, model),
    )}</text>
    <line class="lag-inline-node-separator" x1="0" y1="119" x2="270" y2="119"></line>
    <text class="lag-inline-node-id" x="14" y="136">${escapeHtml(
      compactId(node.id),
    )}</text>
    <text class="lag-inline-node-binding" x="256" y="136" text-anchor="end">${escapeHtml(
      node.nativeAgentId ? compactId(node.nativeAgentId) : 'not bound',
    )}</text>
  </g>`;
}

function renderEdge(
  edge: AgentGraphModel['edges'][number],
  index: number,
  selection?: AgentGraphSelection,
) {
  const geometry = edgeGeometry[edge.kind];
  const selected = selection?.kind === 'edge' && selection.id === edge.id;
  const label = `${edge.kind} · ${edge.reportCount}`;
  const labelWidth = Math.max(78, 21 + label.length * 6.2);
  const labelX = geometry.label.x - labelWidth / 2;
  return `<g class="lag-inline-edge" data-edge-index="${index}" data-kind="${escapeHtml(
    edge.kind,
  )}" data-active="${edge.active ? 'true' : 'false'}" data-selected="${
    selected ? 'true' : 'false'
  }" role="button" tabindex="0" aria-label="${escapeHtml(
    `${edge.source} to ${edge.target}, ${edge.kind}`,
  )}">
    <path class="lag-inline-edge-hit" d="${geometry.path}"></path>
    <path class="lag-inline-edge-path" d="${geometry.path}" marker-end="url(#lag-arrow)"></path>
    <rect class="lag-inline-edge-label-box" x="${labelX}" y="${
      geometry.label.y - 11
    }" width="${labelWidth}" height="22" rx="11"></rect>
    <text class="lag-inline-edge-label" x="${geometry.label.x}" y="${
      geometry.label.y + 3
    }" text-anchor="middle">${escapeHtml(label)}</text>
  </g>`;
}

function selectedCopy(model: AgentGraphModel, selection?: AgentGraphSelection) {
  const node =
    selection?.kind === 'node'
      ? model.nodes.find((candidate) => candidate.id === selection.id)
      : undefined;
  const edge =
    selection?.kind === 'edge'
      ? model.edges.find((candidate) => candidate.id === selection.id)
      : undefined;
  if (node) {
    return {
      eyebrow: 'Selected node',
      title: node.label,
      detail: `${node.role} · ${node.state}${
        node.nativeAgentId ? ' · native worker bound' : ''
      }`,
    };
  }
  if (edge) {
    return {
      eyebrow: 'Selected relationship',
      title: `${edge.source} → ${edge.target}`,
      detail: `${edge.kind} · ${edge.reportCount} reports${
        edge.active ? ' · active' : ''
      }`,
    };
  }
  return {
    eyebrow: 'Verified snapshot',
    title: 'Select a node or relationship',
    detail: `revision ${model.identity.revision} · digest ${model.identity.projectionDigest.slice(
      0,
      12,
    )}`,
  };
}

function renderTimeline(model: AgentGraphModel) {
  const items =
    model.timeline.length > 0
      ? model.timeline
          .map(
            (item) =>
              `<li><time datetime="${escapeHtml(item.at)}">${escapeHtml(
                item.at,
              )}</time><span>${escapeHtml(item.label)}</span>${
                item.role ? `<small>${escapeHtml(item.role)}</small>` : ''
              }</li>`,
          )
          .join('')
      : '<li>No authoritative timeline entries.</li>';
  return `<details class="lag-inline-timeline">
    <summary>Bounded timeline <span>${model.timeline.length}</span></summary>
    <ol>${items}</ol>
  </details>`;
}

function renderAlert(
  model: AgentGraphModel,
  driftNote: string,
  integrityError: string,
) {
  if (integrityError) {
    return `<p class="lag-inline-alert lag-inline-error" role="status">Snapshot unavailable: ${escapeHtml(
      integrityError,
    )}</p>`;
  }
  if (driftNote) {
    return `<p class="lag-inline-alert" role="status">${escapeHtml(
      driftNote,
    )}</p>`;
  }
  if (model.recovery) {
    return `<p class="lag-inline-alert" role="status">Recovery: ${escapeHtml(
      model.recovery.reason,
    )}</p>`;
  }
  if (model.cancelRequested) {
    return '<p class="lag-inline-alert" role="status">Cancellation requested.</p>';
  }
  if (model.needsHuman) {
    return '<p class="lag-inline-alert" role="status">Human attention is required.</p>';
  }
  return '';
}

function renderGraph(
  model: AgentGraphModel,
  options: InlineAgentLoopGraphOptions,
  selection: AgentGraphSelection | undefined,
  integrityError: string,
  followUpStatus: string,
) {
  const selected = selectedCopy(model, selection);
  const terminal = ['succeeded', 'capped', 'cancelled', 'failed'].includes(
    model.status,
  );
  const control =
    model.status === 'paused' || model.status === 'interrupted'
      ? 'resume'
      : 'pause';
  const mode = options.mode ?? 'snapshot';
  const liveLabel =
    mode === 'live' ? (options.liveState ?? 'connecting') : 'snapshot';
  return `<section class="looperators-inline-agent-graph" data-status="${escapeHtml(
    model.status,
  )}" data-testid="inline-agent-loop-graph">
    <header class="lag-inline-header">
      <div><p class="lag-inline-eyebrow">looperators</p><h2>Agent Loop</h2></div>
      <div class="lag-inline-badges" aria-label="Loop status">
        <span class="lag-inline-badge lag-inline-verified">verified</span>
        <span class="lag-inline-badge" data-tone="${statusTone(
          model.status,
        )}">${escapeHtml(model.status)}</span>
        <span class="lag-inline-badge">lap ${model.currentLap}/${
          model.lapCap
        }</span>
        <span class="lag-inline-badge">lease ${model.lease.consumed}/${
          model.lease.granted
        }</span>
        <span class="lag-inline-badge">${escapeHtml(liveLabel)}</span>
      </div>
    </header>
    ${renderAlert(
      model,
      options.driftNote ?? '',
      integrityError,
    )}
    <div class="lag-inline-stage">
      <svg viewBox="0 0 1020 380" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Agent Loop relationship graph">
        <defs>
          <pattern id="lag-grid" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle class="lag-inline-grid-dot" cx="1.5" cy="1.5" r="1.1"></circle>
          </pattern>
          <marker id="lag-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
            <path class="lag-inline-arrow" d="M 0 0 L 9 4.5 L 0 9 z"></path>
          </marker>
        </defs>
        <rect class="lag-inline-grid" width="1020" height="380" rx="14"></rect>
        ${model.edges
          .map((edge, index) => renderEdge(edge, index, selection))
          .join('')}
        ${model.nodes
          .map((node, index) => renderNode(node, index, model, selection))
          .join('')}
      </svg>
    </div>
    <section class="lag-inline-inspector" aria-live="polite">
      <div>
        <p class="lag-inline-eyebrow">${escapeHtml(selected.eyebrow)}</p>
        <h3>${escapeHtml(selected.title)}</h3>
        <p class="lag-inline-detail">${escapeHtml(selected.detail)}</p>
      </div>
      <div class="lag-inline-actions">
        <button type="button" data-action="explain" ${
          selection ? '' : 'disabled'
        }>Explain selection</button>
        <button type="button" data-action="${control}" ${
          terminal ? 'disabled' : ''
        }>Request ${control}</button>
      </div>
      ${
        followUpStatus
          ? `<p class="lag-inline-follow-up" role="status">${escapeHtml(
              followUpStatus,
            )}</p>`
          : ''
      }
    </section>
    ${renderTimeline(model)}
    <footer class="lag-inline-footer">run ${escapeHtml(
      compactId(model.identity.runId),
    )} · revision ${model.identity.revision} · SVG runtime</footer>
  </section>`;
}

export function mountInlineAgentLoopGraph(
  root: HTMLElement,
  initialOptions: InlineAgentLoopGraphOptions,
): InlineAgentLoopGraphController {
  let model = initialOptions.model;
  let options = { ...initialOptions };
  let selection: AgentGraphSelection | undefined;
  let integrityError = '';
  let followUpStatus = '';

  const render = () => {
    root.innerHTML = renderGraph(
      model,
      options,
      selection,
      integrityError,
      followUpStatus,
    );
  };

  const activateSelection = (element: Element) => {
    const nodeElement = element.closest<SVGGElement>('[data-node-index]');
    const edgeElement = element.closest<SVGGElement>('[data-edge-index]');
    if (nodeElement) {
      const node = model.nodes[Number(nodeElement.dataset.nodeIndex)];
      if (node) selection = { kind: 'node', id: node.id };
    } else if (edgeElement) {
      const edge = model.edges[Number(edgeElement.dataset.edgeIndex)];
      if (edge) selection = { kind: 'edge', id: edge.id };
    } else {
      selection = undefined;
    }
    render();
  };

  const requestFollowUp = async (
    kind: AgentGraphFollowUpIntent['kind'],
  ) => {
    if (!options.followUpAvailable || !options.onFollowUp) {
      followUpStatus = 'Host follow-up is unavailable.';
      render();
      return;
    }
    followUpStatus = 'Requesting follow-up…';
    render();
    try {
      await options.onFollowUp({
        kind,
        runId: model.identity.runId,
        ...(selection ? { selection } : {}),
      });
      followUpStatus = 'Follow-up requested.';
    } catch {
      followUpStatus = 'Follow-up cancelled or failed.';
    }
    render();
  };

  const clickHandler = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLButtonElement>('button[data-action]');
    if (action?.dataset.action) {
      void requestFollowUp(
        action.dataset.action as AgentGraphFollowUpIntent['kind'],
      );
      return;
    }
    if (target.closest('[data-node-index], [data-edge-index]')) {
      activateSelection(target);
    }
  };

  const keyHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('[data-node-index], [data-edge-index]')
    ) {
      event.preventDefault();
      activateSelection(target);
    }
  };

  root.addEventListener('click', clickHandler);
  root.addEventListener('keydown', keyHandler);
  render();

  return Object.freeze({
    update(
      nextModel: AgentGraphModel,
      nextOptions: Pick<InlineAgentLoopGraphOptions, 'liveState'> = {},
    ) {
      model = nextModel;
      options = { ...options, ...nextOptions };
      integrityError = '';
      if (
        selection?.kind === 'node' &&
        !model.nodes.some((node) => node.id === selection?.id)
      ) {
        selection = undefined;
      }
      if (
        selection?.kind === 'edge' &&
        !model.edges.some((edge) => edge.id === selection?.id)
      ) {
        selection = undefined;
      }
      render();
    },
    integrityError(code: string) {
      integrityError = String(code).slice(0, 80);
      render();
    },
    destroy() {
      root.removeEventListener('click', clickHandler);
      root.removeEventListener('keydown', keyHandler);
      root.replaceChildren();
    },
  });
}
