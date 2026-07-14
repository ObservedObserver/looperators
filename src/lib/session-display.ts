import { type AgentSession, type GraphState, type Report, type SessionStatus } from '@/shared/graph-state';
import { providerOption } from '@/lib/provider-catalog';
import { firstContentLine } from '@/lib/format';
import { type RecoveryState } from '@/lib/diagnostics';
import { reportTitle, reportBody } from '@/lib/reports';

export const statusLabels: Record<SessionStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  idle: 'Idle',
  failed: 'Failed',
  killed: 'Killed',
};

export const statusDotClassNames: Record<SessionStatus, string> = {
  pending: 'bg-term-amber',
  running: 'bg-term-green',
  idle: 'bg-term-dim2',
  failed: 'bg-term-rose',
  killed: 'bg-term-amber',
};

export function sessionMarker(status: SessionStatus, isSelected: boolean, role: 'worker' | 'master'): { char: string; cls: string } {
  if (isSelected) return { char: '●', cls: 'text-term-accent-hi' };
  if (role === 'master') return { char: '◆', cls: 'text-term-amber' };
  switch (status) {
    case 'running':
      return { char: '◌', cls: 'text-term-amber animate-pulse' };
    case 'pending':
      return { char: '◌', cls: 'text-term-amber' };
    case 'failed':
      return { char: '✗', cls: 'text-term-rose' };
    case 'killed':
      return { char: '✗', cls: 'text-term-amber' };
    default:
      return { char: '○', cls: 'text-term-dim2' };
  }
}

export const statePillBase = 'shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]';

export function statePillCls(status: SessionStatus, role: 'worker' | 'master') {
  if (role === 'master') return 'border-term-amber/30 bg-term-amber/10 text-term-amber';
  switch (status) {
    case 'running':
    case 'pending':
    case 'killed':
      return 'border-term-amber/30 bg-term-amber/10 text-term-amber';
    case 'failed':
      return 'border-term-rose/30 bg-term-rose/10 text-term-rose';
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim';
  }
}

// Chrome-friendly state pill for graph nodes (flips correctly in light mode).

export function nodeStatePillCls(status: SessionStatus, role: 'worker' | 'master', frozen?: boolean) {
  if (frozen) return 'border-border bg-muted text-muted-foreground';
  if (role === 'master') return 'border-term-amber/40 bg-term-amber/10 text-term-amber';
  switch (status) {
    case 'running':
    case 'pending':
      return 'border-term-amber/40 bg-term-amber/10 text-term-amber';
    case 'failed':
    case 'killed':
      return 'border-term-rose/40 bg-term-rose/10 text-term-rose';
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

// Terminal action-button class presets (accent primary / chrome outline, mono).

export function sessionProviderLabel(session: AgentSession) {
  return providerOption(session.providerKind).label;
}

export function sessionChatId(session: AgentSession) {
  return session.backendSessionId ?? session.providerSessionId ?? session.sessionId;
}

export const defaultSessionLabelPattern = /^(?:new chat|chat|claude|codex)\s*\d*$/i;

export function sessionDisplayLabel(session: AgentSession) {
  const label = session.label.trim();
  if (!defaultSessionLabelPattern.test(label)) {
    return label;
  }
  const firstUserMessage = session.messages.find((message) => message.role === 'user' && message.content.trim().length > 0);
  return firstContentLine(firstUserMessage?.content) ?? label;
}

export function shortAgentName(value: string) {
  const compact = value
    .replace(/\(.*?\)/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return compact.length > 0 ? compact : value;
}

// The kernel keeps these arrays' statuses current as request.opened/resolved
// events land, so the sidebar can group sessions without a full projection.
export function firstOpenRequests(session: AgentSession) {
  return {
    openRequests: (session.runtimeRequests ?? []).filter((request) => request.status === 'open'),
    openInputs: (session.runtimeUserInputRequests ?? []).filter((request) => request.status === 'open'),
  };
}

export function lastMessagePreview(session: AgentSession | undefined) {
  const message = session?.messages.at(-1);
  if (message?.content) {
    return message.content;
  }

  return session?.prompt ?? 'Runtime session';
}

export function latestUserMessagePreview(session: AgentSession) {
  return [...session.messages].reverse().find((message) => message.role === 'user' && message.content.trim())?.content ?? session.prompt;
}

export function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function sessionSearchHaystack({ session, latestReport, recovery }: { session: AgentSession; latestReport?: Report; recovery?: RecoveryState }) {
  return normalizeSearchText(
    [
      session.label,
      session.sessionId,
      session.backendSessionId,
      session.providerSessionId,
      session.providerKind,
      sessionProviderLabel(session),
      session.agent,
      session.cwd,
      statusLabels[session.status],
      session.status,
      session.role,
      session.error,
      latestUserMessagePreview(session),
      lastMessagePreview(session),
      latestReport ? reportTitle(latestReport) : undefined,
      latestReport ? reportBody(latestReport) : undefined,
      recovery?.title,
      recovery?.detail,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function sessionMatchesSearch({
  session,
  latestReport,
  recovery,
  query,
}: {
  session: AgentSession;
  latestReport?: Report;
  recovery?: RecoveryState;
  query: string;
}) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  return normalizedQuery.split(' ').every((token) => sessionSearchHaystack({ session, latestReport, recovery }).includes(token));
}

export function sessionLabel(state: GraphState, sessionId: string) {
  return state.sessions[sessionId]?.label ?? sessionId.slice(0, 8);
}

export function sessionSort(left: AgentSession, right: AgentSession) {
  return right.updatedAt.localeCompare(left.updatedAt);
}
