import { Braces } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type AgentSession } from '@/shared/graph-state';
import { type NativeProviderEvent, type ProviderRuntimeEvent } from '@/shared/provider-runtime';
import { formatClockSeconds } from '@/lib/format';

export type ProviderEventEntry = {
  id: string;
  ts: string;
  channel: 'runtime' | 'native';
  title: string;
  payload: unknown;
};

export function providerEventTitle(event: ProviderRuntimeEvent) {
  if (event.type === 'content.delta') {
    return `${event.type}:${event.streamKind}`;
  }
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    return `${event.type}:${event.item.kind}`;
  }
  return event.type;
}

export function nativeEventTitle(event: NativeProviderEvent) {
  return event.raw.method ?? event.raw.messageType ?? event.raw.source;
}

export function providerEventEntries(session: AgentSession): ProviderEventEntry[] {
  const runtime = (session.runtimeEvents ?? []).map((event) => ({
    id: event.id,
    ts: event.ts,
    channel: 'runtime' as const,
    title: providerEventTitle(event),
    payload: event.raw?.payload ?? event,
  }));
  const native = (session.nativeEvents ?? []).map((event) => ({
    id: event.id,
    ts: event.ts,
    channel: 'native' as const,
    title: nativeEventTitle(event),
    payload: event.raw.payload,
  }));

  return [...runtime, ...native].sort((left, right) => right.ts.localeCompare(left.ts)).slice(0, 40);
}

export function stringifyEventPayload(payload: unknown) {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    text = String(payload);
  }

  return text.length > 6000 ? `${text.slice(0, 6000)}\n... truncated` : text;
}

export function ProviderEventDrawer({ session }: { session: AgentSession }) {
  const entries = providerEventEntries(session);

  return (
    <div className="border-b border-ink-line bg-ink px-3.5 py-3 font-mono">
      <div className="mb-2 flex items-center gap-2">
        <Braces className="size-3.5 text-term-cyan" />
        <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">diagnostics</span>
        <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">last {entries.length}</span>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-ink-line p-3 text-[11.5px] text-term-dim2">No diagnostics captured yet.</p>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {entries.map((entry) => (
            <details key={`${entry.channel}:${entry.id}`} className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
              <summary className="cursor-pointer list-none">
                <span className="inline-flex min-w-0 items-center gap-2 text-[11px]">
                  <span
                    className={cn(
                      'rounded border px-1.5 py-0.5 uppercase tracking-[0.08em]',
                      entry.channel === 'native'
                        ? 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan'
                        : 'border-term-accent/30 bg-term-accent/[0.08] text-term-accent',
                    )}
                  >
                    {entry.channel}
                  </span>
                  <span className="truncate text-term-name">{entry.title}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-term-faint">{formatClockSeconds(entry.ts)}</span>
                </span>
              </summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink px-2.5 py-2 text-[10.5px] leading-4 text-term-dim">
                {stringifyEventPayload(entry.payload)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
