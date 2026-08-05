import { useState } from 'react';
import type { AgentGraphFollowUpIntent, AgentGraphIssue, AgentGraphModel } from './graph-model';
import { statusTone } from './graph-model';

function IssueList({ issues }: { issues: AgentGraphIssue[] }) {
  return (
    <ul className="lag-issue-list">
      {issues.map((issue, index) => (
        <li key={`${issue.file ?? ''}:${issue.line ?? ''}:${issue.message}:${index}`}>
          <strong>{issue.severity ?? 'issue'}</strong>
          <span>{issue.message}</span>
          {issue.file ? <small>{issue.file}{issue.line ? `:${issue.line}` : ''}</small> : null}
        </li>
      ))}
    </ul>
  );
}

export function LoopPanel({
  model,
  onClose,
  controlAvailable = false,
  onControl,
  confirming,
  onConfirmingChange,
}: {
  model: AgentGraphModel;
  onClose: () => void;
  controlAvailable?: boolean;
  onControl?: (intent: AgentGraphFollowUpIntent) => void | Promise<void>;
  confirming?: boolean;
  onConfirmingChange?: (confirming: boolean) => void;
}) {
  const [internalConfirming, setInternalConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const isConfirming = confirming ?? internalConfirming;
  const setConfirming = onConfirmingChange ?? setInternalConfirming;
  const terminal = ['succeeded', 'capped', 'cancelled', 'failed'].includes(model.status);
  const issues = model.latestReport?.issues ?? [];

  const cancel = async () => {
    if (!onControl || pending) return;
    setPending(true);
    try {
      await onControl({ kind: 'cancel', runId: model.identity.runId });
      setConfirming(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="lag-loop-panel" aria-label="Loop details">
      <header>
        <span className="lag-panel-icon" data-active={model.status === 'running'} aria-hidden="true">↻</span>
        <div>
          <h3>{model.status === 'running' ? 'Review loop active' : `Review loop ${model.status}`}</h3>
          <p>Lap {model.currentLap}/{model.lapCap}</p>
        </div>
        <button type="button" className="lag-icon-button" aria-label="Close loop details" onClick={onClose}>×</button>
      </header>

      <div className="lag-loop-panel-body">
        {isConfirming ? (
          <section className="lag-stop-confirm" aria-label="Confirm Stop loop">
            <strong>Stop future handoffs?</strong>
            <p>Work already running may finish, but it cannot activate another lap.</p>
            <div>
              <button type="button" disabled={pending} onClick={() => setConfirming(false)}>Keep running</button>
              <button type="button" disabled={pending} onClick={() => void cancel()}>{pending ? 'Stopping…' : 'Stop handoffs'}</button>
            </div>
          </section>
        ) : null}

        <section className="lag-loop-summary" data-tone={statusTone(model.status)}>
          <h4>{model.stopReason ?? (terminal ? `Run ${model.status}` : 'Review until clean')}</h4>
          <p>
            {model.recovery?.reason ??
              (model.responsibleRole ? `${model.responsibleRole} is responsible for the next action.` : 'The Governor owns the next transition.')}
          </p>
          <dl>
            <div><dt>Lap</dt><dd>{model.currentLap}/{model.lapCap}</dd></div>
            <div><dt>Now responsible</dt><dd>{model.responsibleRole ?? (terminal ? 'Complete' : 'Governor')}</dd></div>
            {model.latestReport?.verdict ? <div><dt>Last verdict</dt><dd>{model.latestReport.verdict}</dd></div> : null}
            {model.stopReason ? <div><dt>Why it stopped</dt><dd>{model.stopReason}</dd></div> : null}
          </dl>
          {!terminal ? (
            <button type="button" disabled={!controlAvailable || !onControl} onClick={() => setConfirming(true)}>
              {controlAvailable ? 'Stop loop' : 'Control unavailable'}
            </button>
          ) : null}
          {model.recovery?.guidance ? <small>{model.recovery.guidance}</small> : null}
        </section>

        {issues.length > 0 ? (
          <section className="lag-blocking-issues">
            <h4>Latest blocking issues</h4>
            <IssueList issues={issues} />
          </section>
        ) : null}

        <ol className="lag-lap-list">
          {[...(model.laps ?? [])].reverse().map((lap) => (
            <li key={lap.index} className="lag-lap-card" data-status={lap.status}>
              <header><strong>Lap {lap.index}</strong><span>{lap.verdict ?? lap.status}</span></header>
              {lap.implementerSummary ? <p><b>Implementer</b>{lap.implementerSummary}</p> : null}
              {lap.reviewerSummary ? <p><b>Reviewer</b>{lap.reviewerSummary}</p> : null}
              {lap.issues.length > 0 ? <IssueList issues={lap.issues} /> : null}
              {lap.at ? <time dateTime={lap.at}>{lap.at}</time> : null}
            </li>
          ))}
        </ol>

        <details className="lag-diagnostics">
          <summary>Diagnostics & advanced details</summary>
          <div>runId: {model.identity.runId}</div>
          <div>revision: {model.identity.revision}</div>
          <div>digest: {model.identity.projectionDigest}</div>
        </details>
      </div>
    </aside>
  );
}
