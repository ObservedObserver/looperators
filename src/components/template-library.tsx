import { useEffect, useState } from 'react';
import { BookMarked, LibraryBig, Play, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GraphState, TemplateDescriptor, TemplateSlot } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

// The relation template library (L6): pick a template, fill two or three
// slots, and the runtime compiles it into ordinary subscriptions that land
// on the canvas. The renderer is compile-free on purpose — descriptors
// (names, taglines, slot definitions) arrive as data from listTemplates,
// so the single compile face stays in shared/templates.ts.
export function TemplateLibraryPanel({
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
  const [templates, setTemplates] = useState<TemplateDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [slotValues, setSlotValues] = useState<Record<string, string>>({});
  const [scheduleModes, setScheduleModes] = useState<Record<string, 'everySeconds' | 'dailyAt'>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  // Save-as-template: a subscription multi-select plus a name.
  const [saveName, setSaveName] = useState('');
  const [saveSelection, setSaveSelection] = useState<Record<string, boolean>>({});

  const sessions = Object.values(runtimeState.sessions).filter((session) => session.status !== 'killed');
  const sources = Object.values(runtimeState.sources ?? {}).filter((source) => source.state === 'active');
  const subscriptions = Object.values(runtimeState.subscriptions ?? {});
  const selected = templates.find((template) => template.id === selectedId);

  const loadTemplates = async () => {
    if (!runtimeApi) {
      return;
    }
    try {
      const result = await runtimeApi.listTemplates();
      setTemplates(result.templates);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open; saves/removes refresh explicitly
  }, [runtimeApi]);

  const pick = (templateId: string) => {
    setSelectedId((current) => (current === templateId ? undefined : templateId));
    setSlotValues({});
    setScheduleModes({});
    setFeedback(undefined);
  };

  const slotParam = (slot: TemplateSlot): unknown => {
    const raw = (slotValues[slot.key] ?? '').trim();
    if (slot.kind === 'schedule') {
      if (!raw) {
        return undefined;
      }
      const mode = scheduleModes[slot.key] ?? 'everySeconds';
      return mode === 'everySeconds' ? { everySeconds: Number(raw) } : { dailyAt: raw };
    }
    return raw.length > 0 ? raw : undefined;
  };

  const missingRequired = (selected?.slots ?? []).some((slot) => slot.required && slotParam(slot) === undefined && slot.defaultValue === undefined);

  const apply = async () => {
    if (!runtimeApi || !selected || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setFeedback(undefined);
    try {
      const params: Record<string, unknown> = {};
      for (const slot of selected.slots) {
        const value = slotParam(slot);
        if (value !== undefined) {
          params[slot.key] = value;
        }
      }
      const result = await runtimeApi.applyTemplate({ templateId: selected.id, params });
      onStateChange(result.state);
      const created = result.createdSessionIds.length;
      setFeedback(`${selected.name}: ${result.subscriptionIds.length} subscription(s) landed${created ? `, ${created} session(s) created` : ''}`);
      setSlotValues({});
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const removeTemplate = async (templateId: string) => {
    if (!runtimeApi) {
      return;
    }
    try {
      const result = await runtimeApi.removeTemplate({ templateId });
      onStateChange(result.state);
      if (selectedId === templateId) {
        setSelectedId(undefined);
      }
      await loadTemplates();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveTemplate = async () => {
    if (!runtimeApi || isSubmitting) {
      return;
    }
    const subscriptionIds = Object.keys(saveSelection).filter((id) => saveSelection[id]);
    setIsSubmitting(true);
    try {
      const result = await runtimeApi.saveTemplate({ name: saveName.trim(), subscriptionIds });
      onStateChange(result.state);
      setSaveName('');
      setSaveSelection({});
      setFeedback(`saved as template: ${result.template.name}`);
      await loadTemplates();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const slotInputCls = 'h-7 w-full rounded-lg border border-border bg-background px-2 text-[11.5px] outline-none focus:border-lime-hi/60';

  const slotField = (slot: TemplateSlot) => {
    if (slot.kind === 'session') {
      return (
        <select
          className={slotInputCls}
          value={slotValues[slot.key] ?? ''}
          onChange={(event) => setSlotValues((values) => ({ ...values, [slot.key]: event.target.value }))}
        >
          <option value="">{slot.required ? 'pick a session…' : (slot.help ?? 'none (optional)')}</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.label ?? session.sessionId}
            </option>
          ))}
        </select>
      );
    }
    if (slot.kind === 'external-source') {
      return (
        <select
          className={slotInputCls}
          value={slotValues[slot.key] ?? ''}
          onChange={(event) => setSlotValues((values) => ({ ...values, [slot.key]: event.target.value }))}
        >
          <option value="">{sources.length ? 'pick a source…' : 'no active sources — register one first'}</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label ?? `${source.kind} · external.${source.topic}`}
            </option>
          ))}
        </select>
      );
    }
    if (slot.kind === 'schedule') {
      const mode = scheduleModes[slot.key] ?? 'everySeconds';
      return (
        <div className="flex gap-1.5">
          <select
            className={cn(slotInputCls, 'w-32 shrink-0')}
            value={mode}
            onChange={(event) => setScheduleModes((modes) => ({ ...modes, [slot.key]: event.target.value as 'everySeconds' | 'dailyAt' }))}
          >
            <option value="everySeconds">every (s)</option>
            <option value="dailyAt">daily at</option>
          </select>
          <input
            className={slotInputCls}
            placeholder={mode === 'everySeconds' ? 'e.g. 900' : 'HH:MM'}
            value={slotValues[slot.key] ?? ''}
            onChange={(event) => setSlotValues((values) => ({ ...values, [slot.key]: event.target.value }))}
          />
        </div>
      );
    }
    if (slot.kind === 'longtext') {
      return (
        <textarea
          className="min-h-14 w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-[11.5px] leading-4 outline-none focus:border-lime-hi/60"
          placeholder={slot.placeholder}
          value={slotValues[slot.key] ?? ''}
          onChange={(event) => setSlotValues((values) => ({ ...values, [slot.key]: event.target.value }))}
        />
      );
    }
    return (
      <input
        className={cn(slotInputCls, slot.kind === 'number' && 'tabular-nums')}
        type={slot.kind === 'number' ? 'number' : 'text'}
        placeholder={slot.placeholder ?? (slot.defaultValue !== undefined ? `default: ${slot.defaultValue}` : undefined)}
        value={slotValues[slot.key] ?? ''}
        onChange={(event) => setSlotValues((values) => ({ ...values, [slot.key]: event.target.value }))}
      />
    );
  };

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-background font-mono">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <LibraryBig className="size-4 text-accent-ink" />
        <h2 className="text-[12px] uppercase tracking-[0.14em] text-foreground">Templates</h2>
        <Button className="ml-auto" variant="ghost" size="icon" aria-label="Close templates" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <p className="text-[10.5px] leading-4 text-muted-foreground">
          Pick a template, fill the blanks, and ready-made subscriptions land on the canvas — gates, stops, and guardrails included. What lands is the real
          compiled relation; open any edge to learn the parameters.
        </p>

        <ul className="space-y-2">
          {templates.map((template) => {
            const isSelected = template.id === selectedId;
            return (
              <li
                key={template.id}
                className={cn('rounded-lg border bg-card p-2.5', isSelected ? 'border-lime-hi/50 ring-1 ring-lime-hi/25' : 'border-border')}
              >
                <button type="button" className="block w-full text-left" onClick={() => pick(template.id)}>
                  <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
                    <BookMarked className={cn('size-3.5 shrink-0', template.builtin ? 'text-sky-600 dark:text-sky-300' : 'text-term-amber')} />
                    <span className="truncate">{template.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                      {template.builtin ? 'built-in' : 'saved'}
                    </span>
                  </div>
                  <div className="mt-1 text-[10.5px] leading-4 text-muted-foreground">
                    <div>{template.tagline}</div>
                    <div className="text-term-faint">交出去的:{template.handsOff}</div>
                  </div>
                </button>

                {isSelected ? (
                  <div className="mt-2 space-y-2 border-t border-border/70 pt-2">
                    {template.slots.map((slot) => (
                      <label key={slot.key} className="block space-y-1">
                        <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                          {slot.label}
                          {slot.required ? '' : ' (optional)'}
                        </span>
                        {slotField(slot)}
                        {slot.help ? <span className="block text-[10px] leading-3.5 text-term-faint">{slot.help}</span> : null}
                      </label>
                    ))}
                    <Button
                      className="h-7 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]"
                      size="sm"
                      disabled={!runtimeApi || isSubmitting || missingRequired}
                      onClick={() => void apply()}
                    >
                      <Play className="size-3" />
                      Apply template
                    </Button>
                  </div>
                ) : null}

                {!template.builtin && !isSelected ? (
                  <div className="mt-1.5 flex justify-end">
                    <Button
                      className="h-6 px-2 font-mono text-[10px] uppercase tracking-[0.06em]"
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeTemplate(template.id)}
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
        {feedback ? <p className="text-[10.5px] leading-4 text-lime-700 dark:text-lime-300">{feedback}</p> : null}

        {subscriptions.length > 0 ? (
          <div className="rounded-lg border border-border bg-card p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <Save className="size-3.5" />
              Save as template
            </div>
            <p className="mt-1 text-[10px] leading-3.5 text-term-faint">Pick edges from the canvas; their session endpoints become fill-in slots.</p>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {subscriptions.map((subscription) => (
                <li key={subscription.id}>
                  <label className="flex items-center gap-2 text-[10.5px]">
                    <input
                      type="checkbox"
                      className="accent-lime-600"
                      checked={saveSelection[subscription.id] ?? false}
                      onChange={(event) => setSaveSelection((selection) => ({ ...selection, [subscription.id]: event.target.checked }))}
                    />
                    <span className="truncate">
                      {subscription.label ?? subscription.id}
                      {subscription.state === 'stopped' ? ' · stopped' : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <input className={cn(slotInputCls, 'mt-2')} placeholder="template name" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
            <Button
              className="mt-2 h-7 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]"
              size="sm"
              variant="outline"
              disabled={!runtimeApi || isSubmitting || saveName.trim().length === 0 || !Object.values(saveSelection).some(Boolean)}
              onClick={() => void saveTemplate()}
            >
              Save template
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
