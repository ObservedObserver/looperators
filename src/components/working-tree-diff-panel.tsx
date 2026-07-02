import { FileText, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type AgentSession, type WorkingTreeDiffResult } from '@/shared/graph-state';
import { compactPath, formatTimestamp } from '@/lib/format';
import { diffPatchLineClassName, diffRangeLabel } from '@/lib/diff';

export function WorkingTreeDiffPanel({
  session,
  diff,
  isLoading,
  error,
  onRefresh,
  onClose,
}: {
  session?: AgentSession;
  diff?: WorkingTreeDiffResult;
  isLoading: boolean;
  error?: string;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const hasChanges = Boolean(diff && diff.files.length > 0);
  const patchLines = diff?.patch ? diff.patch.split('\n') : [];
  const title = diff?.range.kind === 'checkpoint' ? 'Turn changes' : 'Uncommitted changes';

  return (
    <aside className="flex h-full w-[min(460px,38vw)] min-w-[360px] shrink-0 flex-col border-l border-border bg-sidebar font-mono">
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="size-3.5 shrink-0 text-accent-ink" />
            <h2 className="truncate text-[12px] font-semibold text-foreground">{title}</h2>
          </div>
          <p className="mt-1 truncate text-[10.5px] text-muted-foreground" title={session?.cwd}>
            {session ? compactPath(session.cwd) : 'No chat selected'}
          </p>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="size-7 shrink-0" variant="ghost" size="icon" disabled={!session || isLoading} aria-label="Refresh diff" onClick={onRefresh}>
              <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh diff</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="size-7 shrink-0" variant="ghost" size="icon" aria-label="Close diff panel" onClick={onClose}>
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close diff panel</TooltipContent>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!session ? (
          <div className="m-3 rounded-lg border border-dashed border-ink-line bg-ink p-4 text-[12px] leading-5 text-term-dim2">
            Select a chat node to inspect its project folder.
          </div>
        ) : null}

        {error ? <div className="m-3 rounded-lg border border-term-rose/35 bg-term-rose/10 p-3 text-[11.5px] leading-5 text-term-rose">{error}</div> : null}

        {isLoading && !diff ? <div className="m-3 rounded-lg border border-ink-line bg-ink p-4 text-[12px] text-term-dim2">Loading diff...</div> : null}

        {diff ? (
          <>
            <section className="border-b border-border px-3 py-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border border-ink-line bg-ink px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-term-faint">files</div>
                  <div className="mt-1 text-[18px] leading-none text-term-name">{diff.totals.files}</div>
                </div>
                <div className="rounded-lg border border-term-green/25 bg-term-green/10 px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-term-green">added</div>
                  <div className="mt-1 text-[18px] leading-none text-term-green">+{diff.totals.additions}</div>
                </div>
                <div className="rounded-lg border border-term-rose/25 bg-term-rose/10 px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-term-rose">removed</div>
                  <div className="mt-1 text-[18px] leading-none text-term-rose">-{diff.totals.deletions}</div>
                </div>
              </div>

              <div className="mt-2 grid gap-1.5 text-[11px] leading-5">
                <div className="flex min-w-0 gap-2">
                  <span className="w-14 shrink-0 text-term-dim2">range</span>
                  <span className="truncate text-term-cyan">{diffRangeLabel(diff)}</span>
                </div>
                <div className="flex min-w-0 gap-2">
                  <span className="w-14 shrink-0 text-term-dim2">updated</span>
                  <span className="truncate text-term-dim">{formatTimestamp(diff.generatedAt)}</span>
                </div>
              </div>
            </section>

            {diff.statusEntries.length ? (
              <section className="border-b border-border px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-term-dim2">Git status</div>
                <pre className="max-h-28 overflow-auto rounded-lg border border-ink-line bg-ink px-2.5 py-2 text-[11px] leading-5 text-term-dim">
                  {diff.statusEntries.join('\n')}
                </pre>
              </section>
            ) : null}

            <section className="border-b border-border px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">Files</span>
                <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">{diff.files.length}</span>
              </div>

              {hasChanges ? (
                <div className="space-y-1.5">
                  {diff.files.map((file) => (
                    <div
                      key={`${file.changeType}:${file.path}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-ink-line bg-ink px-2.5 py-2 text-[11.5px]"
                    >
                      <span className="min-w-0 truncate text-term-name">{file.path}</span>
                      <span className="tabular-nums text-term-green">+{file.additions}</span>
                      <span className="tabular-nums text-term-rose">-{file.deletions}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-ink-line bg-ink p-4 text-center text-[12px] text-term-dim2">
                  No uncommitted changes in this project folder.
                </div>
              )}
            </section>

            <section className="px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">Patch</span>
                {diff.truncated ? (
                  <span className="ml-auto rounded border border-term-amber/30 bg-term-amber/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-term-amber">
                    truncated
                  </span>
                ) : null}
              </div>

              {patchLines.length ? (
                <pre className="max-h-[52vh] overflow-auto rounded-lg border border-ink-line bg-ink py-2 text-[11px] leading-5">
                  {patchLines.map((line, index) => (
                    <span key={`${index}:${line.slice(0, 16)}`} className={cn('block min-w-max px-3', diffPatchLineClassName(line))}>
                      {line.length ? line : ' '}
                    </span>
                  ))}
                </pre>
              ) : (
                <div className="rounded-lg border border-dashed border-ink-line bg-ink p-4 text-center text-[12px] text-term-dim2">No patch to show.</div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </aside>
  );
}
