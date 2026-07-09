import { useState } from 'react';
import { Activity, GitBranch, Plus, Send, SquareTerminal, Trash2, Webhook, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatClock } from '@/lib/format';
import type { ExternalSource, ExternalSourceKind, GraphState } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

const kindIcons: Record<string, typeof Activity> = {
  git: GitBranch,
  script: SquareTerminal,
  webhook: Webhook,
  manual: Zap,
};

const registrableKinds: ExternalSourceKind[] = ['manual', 'webhook', 'git', 'script'];

// The trigger-source directory (L2): the pickable catalog the proposal
// describes. Registration and removal go straight to the runtime's source
// registry; "emit test" fires one event through the same ingestion choke
// point every adapter uses.
export function SourceDirectoryPanel({
  runtimeApi,
  runtimeState,
  onClose,
  onStateChange,
  onError,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  onClose: () => void;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
}) {
  const [kind, setKind] = useState<ExternalSourceKind>('manual');
  const [topic, setTopic] = useState('');
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Shown exactly once after registering a tokened source; not recoverable
  // later (the token never enters the kernel log).
  const [issuedToken, setIssuedToken] = useState<string>();
  const [emitFeedback, setEmitFeedback] = useState<string>();

  const sources = Object.values(runtimeState.sources ?? {}).sort((left, right) => left.id.localeCompare(right.id));

  const refreshState = async () => {
    if (!runtimeApi) {
      return;
    }
    onStateChange(await runtimeApi.getState());
  };

  const register = async () => {
    if (!runtimeApi || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setIssuedToken(undefined);
    try {
      const config = kind === 'script' ? { command: command.trim() } : kind === 'git' ? { repoPath: repoPath.trim() } : {};
      const result = await runtimeApi.registerExternalSource({
        kind,
        ...(topic.trim() ? { topic: topic.trim() } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        config,
      });
      setIssuedToken(result.token);
      setTopic('');
      setLabel('');
      setCommand('');
      setRepoPath('');
      await refreshState();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const remove = async (sourceId: string) => {
    if (!runtimeApi) {
      return;
    }
    try {
      await runtimeApi.removeExternalSource({ sourceId });
      await refreshState();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const emitTest = async (source: ExternalSource) => {
    if (!runtimeApi) {
      return;
    }
    try {
      const result = await runtimeApi.emitExternalEvent({
        sourceId: source.id,
        payload: { test: 'true', note: 'manual test event from the source directory' },
      });
      setEmitFeedback(result.ok ? `${source.id}: event ${result.type} accepted` : `${source.id}: dropped — ${result.reason}`);
      await refreshState();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-background font-mono">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <Webhook className="size-4 text-accent-ink" />
        <h2 className="text-[12px] uppercase tracking-[0.14em] text-foreground">Trigger sources</h2>
        <Button className="ml-auto" variant="ghost" size="icon" aria-label="Close sources" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <p className="text-[10.5px] leading-4 text-muted-foreground">
          Explicitly registered event sources. Each accepted emit appends one <code>external.&lt;topic&gt;</code> fact; edges from a source fire through the
          ordinary gates and guardrails.
        </p>

        {sources.length === 0 ? <p className="text-[11px] text-muted-foreground">No sources registered yet.</p> : null}
        <ul className="space-y-2">
          {sources.map((source) => {
            const Icon = kindIcons[source.kind] ?? Activity;
            const removed = source.state === 'removed';
            return (
              <li key={source.id} className={cn('rounded-lg border border-border bg-card p-2.5', removed && 'opacity-60')}>
                <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
                  <Icon className="size-3.5 shrink-0 text-sky-600 dark:text-sky-300" />
                  <span className="truncate">{source.label ?? source.id}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{removed ? 'removed' : source.kind}</span>
                </div>
                <div className="mt-1 text-[10.5px] leading-4 text-muted-foreground">
                  <div>
                    external.{source.topic} · {source.id}
                  </div>
                  <div className="tabular-nums">{source.lastEventAt ? `last event ${formatClock(source.lastEventAt)}` : 'no events yet'}</div>
                  {source.lastError ? <div className="text-rose-600 dark:text-rose-400">error: {source.lastError}</div> : null}
                </div>
                {!removed ? (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    {source.kind === 'manual' || source.kind === 'webhook' ? (
                      <Button
                        className="h-6 px-2 font-mono text-[10px] uppercase tracking-[0.06em]"
                        variant="outline"
                        size="sm"
                        onClick={() => void emitTest(source)}
                      >
                        <Send className="size-3" />
                        Emit test
                      </Button>
                    ) : null}
                    <Button
                      className="ml-auto h-6 px-2 font-mono text-[10px] uppercase tracking-[0.06em]"
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(source.id)}
                    >
                      <Trash2 className="size-3" />
                      Remove
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {emitFeedback ? <p className="text-[10.5px] leading-4 text-muted-foreground">{emitFeedback}</p> : null}

        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            <Plus className="size-3.5" />
            Register source
          </div>
          <div className="mt-2 space-y-2 text-[11.5px]">
            <select
              className="h-7 w-full rounded-lg border border-border bg-background px-2 text-[11.5px] outline-none focus:border-lime-hi/60"
              value={kind}
              onChange={(event) => setKind(event.target.value as ExternalSourceKind)}
              aria-label="Source kind"
            >
              {registrableKinds.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
            <input
              className="h-7 w-full rounded-lg border border-border bg-background px-2 outline-none focus:border-lime-hi/60"
              placeholder={`topic (default: ${kind})`}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
            <input
              className="h-7 w-full rounded-lg border border-border bg-background px-2 outline-none focus:border-lime-hi/60"
              placeholder="label (optional)"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            {kind === 'script' ? (
              <input
                className="h-7 w-full rounded-lg border border-border bg-background px-2 outline-none focus:border-lime-hi/60"
                placeholder="command (absolute path)"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            ) : null}
            {kind === 'git' ? (
              <input
                className="h-7 w-full rounded-lg border border-border bg-background px-2 outline-none focus:border-lime-hi/60"
                placeholder="repository path"
                value={repoPath}
                onChange={(event) => setRepoPath(event.target.value)}
              />
            ) : null}
            <Button
              className="h-7 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]"
              size="sm"
              disabled={!runtimeApi || isSubmitting || (kind === 'script' && !command.trim()) || (kind === 'git' && !repoPath.trim())}
              onClick={() => void register()}
            >
              Register
            </Button>
            {issuedToken ? (
              <p className="rounded-md border border-term-amber/40 bg-term-amber/10 px-2 py-1 text-[10.5px] leading-4 text-amber-700 dark:text-term-amber">
                Emit token (shown once): <code className="break-all">{issuedToken}</code>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}
