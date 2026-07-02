import { type AgentSession, type RuntimeStateDiagnostic } from '@/shared/graph-state';
import { compactPath, compactId, parseTimestamp } from '@/lib/format';

export type RecoveryTone = 'amber' | 'rose' | 'cyan' | 'muted';

export type RecoveryState = {
  tone: RecoveryTone;
  title: string;
  detail: string;
};

export type RuntimeDiagnosticNotice = RecoveryState & {
  id: string;
  ts: string;
  titleText: string;
  count?: number;
};

export function diagnosticSessionId(diagnostic: RuntimeStateDiagnostic) {
  const sessionId = diagnostic.details?.sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

export function diagnosticsForSession(diagnostics: RuntimeStateDiagnostic[], sessionId: string) {
  return diagnostics.filter((diagnostic) => diagnosticSessionId(diagnostic) === sessionId);
}

export function diagnosticDisplay(diagnostic: RuntimeStateDiagnostic): RecoveryState {
  if (diagnostic.type === 'runtime.active_session_recovered') {
    return {
      tone: 'amber',
      title: 'Restored after restart',
      detail: 'The previous turn was interrupted. Review the last output and send a new message when ready.',
    };
  }

  if (diagnostic.type === 'storage.cwd_invalid') {
    const cwd = diagnostic.details?.cwd;
    return {
      tone: 'rose',
      title: 'Project folder unavailable',
      detail:
        typeof cwd === 'string'
          ? `Restore ${compactPath(cwd)} or start a linked chat with a valid cwd.`
          : 'Restore the project folder or start a linked chat with a valid cwd.',
    };
  }

  if (diagnostic.type.includes('parse_failed')) {
    return {
      tone: 'rose',
      title: 'Saved state needed repair',
      detail: 'Orrery recovered from persisted state diagnostics. Open diagnostics for details if anything looks missing.',
    };
  }

  if (diagnostic.type.includes('repaired') || diagnostic.type.includes('created')) {
    return {
      tone: 'cyan',
      title: 'Saved state repaired',
      detail: diagnostic.message,
    };
  }

  return {
    tone: 'muted',
    title: 'Recovery diagnostic',
    detail: diagnostic.message,
  };
}

export function messageLooksLikeCwdIssue(message: string) {
  return /Project (folder|cwd)|cwd|ENOTDIR|ENOENT/.test(message);
}

export function messageLooksLikeProviderIssue(message: string) {
  return /provider|claude|codex|auth|login|spawn|command not found|not found/i.test(message);
}

export function sessionRecoveryState({
  session,
  diagnostics,
  frozen,
}: {
  session: AgentSession;
  diagnostics: RuntimeStateDiagnostic[];
  frozen?: boolean;
}): RecoveryState | undefined {
  const sessionDiagnostics = diagnosticsForSession(diagnostics, session.sessionId);
  const cwdDiagnostic = sessionDiagnostics.find((diagnostic) => diagnostic.type === 'storage.cwd_invalid');
  if (cwdDiagnostic) {
    return diagnosticDisplay(cwdDiagnostic);
  }

  const recoveredDiagnostic = sessionDiagnostics.find((diagnostic) => diagnostic.type === 'runtime.active_session_recovered');
  if (recoveredDiagnostic) {
    return diagnosticDisplay(recoveredDiagnostic);
  }

  if (frozen) {
    return {
      tone: 'muted',
      title: 'Frozen by workflow',
      detail: 'This chat is paused by its graph scope. Unfreeze or start a linked chat to continue.',
    };
  }

  if (session.status === 'killed') {
    return {
      tone: 'amber',
      title: 'Stopped',
      detail: 'This turn was stopped and cannot be resumed directly. Start a linked chat to continue the thread.',
    };
  }

  if (session.status === 'failed') {
    const message = session.error ?? 'The provider run failed.';
    if (messageLooksLikeCwdIssue(message)) {
      return {
        tone: 'rose',
        title: 'Project folder unavailable',
        detail: message,
      };
    }

    if (messageLooksLikeProviderIssue(message)) {
      return {
        tone: 'rose',
        title: 'Provider unavailable',
        detail: message,
      };
    }

    return {
      tone: 'rose',
      title: 'Run failed',
      detail: message,
    };
  }

  return undefined;
}

export function recoveryToneClassName(tone: RecoveryTone) {
  switch (tone) {
    case 'rose':
      return 'border-term-rose/35 bg-term-rose/10 text-term-rose';
    case 'amber':
      return 'border-term-amber/35 bg-term-amber/10 text-term-amber';
    case 'cyan':
      return 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan';
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim';
  }
}

export function recoveryDetailClassName(tone: RecoveryTone) {
  return tone === 'rose' ? 'text-term-dim' : 'text-term-dim2';
}

export function diagnosticCwd(diagnostic: RuntimeStateDiagnostic) {
  if (diagnostic.type !== 'storage.cwd_invalid') {
    return undefined;
  }

  const cwd = diagnostic.details?.cwd;
  return typeof cwd === 'string' ? cwd : undefined;
}

export function invalidCwdsFromDiagnostics(diagnostics: RuntimeStateDiagnostic[]) {
  return new Set(diagnostics.flatMap((diagnostic) => diagnosticCwd(diagnostic) ?? []));
}

export function formatAffectedChats(labels: string[], fallbackCount: number) {
  const uniqueLabels = Array.from(new Set(labels)).filter(Boolean);
  const count = uniqueLabels.length || fallbackCount;
  if (uniqueLabels.length === 0) {
    return `${count} ${count === 1 ? 'chat' : 'chats'}`;
  }

  const visibleLabels = uniqueLabels.slice(0, 2);
  const remaining = uniqueLabels.length - visibleLabels.length;
  return `${visibleLabels.join(', ')}${remaining > 0 ? ` +${remaining} more` : ''}`;
}

export function affectedChatCount(labels: string[], fallbackCount: number) {
  return Array.from(new Set(labels)).filter(Boolean).length || fallbackCount;
}

export function latestDiagnosticTs(diagnostics: RuntimeStateDiagnostic[]) {
  return diagnostics.reduce((latest, diagnostic) => {
    const latestMs = parseTimestamp(latest)?.getTime() ?? 0;
    const diagnosticMs = parseTimestamp(diagnostic.ts)?.getTime() ?? 0;
    return diagnosticMs > latestMs ? diagnostic.ts : latest;
  }, diagnostics[0]?.ts ?? '');
}

export function runtimeDiagnosticNotices({
  diagnostics,
  sessions,
}: {
  diagnostics: RuntimeStateDiagnostic[];
  sessions: AgentSession[];
}): RuntimeDiagnosticNotice[] {
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const cwdGroups = new Map<string, RuntimeStateDiagnostic[]>();
  const repairGroups = new Map<string, RuntimeStateDiagnostic[]>();
  const notices: RuntimeDiagnosticNotice[] = [];

  diagnostics.forEach((diagnostic) => {
    const cwd = diagnosticCwd(diagnostic);
    if (!cwd) {
      if (diagnostic.type.includes('repaired') || diagnostic.type.includes('created')) {
        const key = `${diagnostic.type}:${diagnostic.message}`;
        const group = repairGroups.get(key) ?? [];
        group.push(diagnostic);
        repairGroups.set(key, group);
        return;
      }

      const state = diagnosticDisplay(diagnostic);
      notices.push({
        ...state,
        id: diagnostic.id,
        ts: diagnostic.ts,
        titleText: diagnostic.type,
      });
      return;
    }

    const group = cwdGroups.get(cwd) ?? [];
    group.push(diagnostic);
    cwdGroups.set(cwd, group);
  });

  repairGroups.forEach((group) => {
    const first = group[0];
    if (!first) {
      return;
    }

    const state = diagnosticDisplay(first);
    notices.push({
      ...state,
      id: `repair:${first.type}:${first.message}`,
      ts: latestDiagnosticTs(group),
      titleText: group.length > 1 ? `${first.type} (${group.length} events)` : first.type,
      detail: group.length > 1 ? `${group.length} saved-state repairs completed. ${state.detail}` : state.detail,
      count: group.length,
    });
  });

  cwdGroups.forEach((group, cwd) => {
    const labels = group.flatMap((diagnostic) => {
      const sessionId = diagnosticSessionId(diagnostic);
      if (!sessionId) {
        return [];
      }

      return [sessionById.get(sessionId)?.label ?? compactId(sessionId)];
    });
    const affected = formatAffectedChats(labels, group.length);
    const affectedCount = affectedChatCount(labels, group.length);
    const usesVerb = affectedCount === 1 ? 'uses' : 'use';
    notices.push({
      id: `storage.cwd_invalid:${cwd}`,
      ts: latestDiagnosticTs(group),
      titleText: `storage.cwd_invalid ${cwd}`,
      tone: 'rose',
      title: affectedCount === 1 ? 'Project folder unavailable' : `${affectedCount} chats need a valid cwd`,
      detail: `${affected} ${usesVerb} ${compactPath(cwd)}. Restore the folder or start linked chats with a valid cwd.`,
    });
  });

  return notices
    .sort((a, b) => {
      const aMs = parseTimestamp(a.ts)?.getTime() ?? 0;
      const bMs = parseTimestamp(b.ts)?.getTime() ?? 0;
      return bMs - aMs;
    })
    .slice(0, 3);
}
