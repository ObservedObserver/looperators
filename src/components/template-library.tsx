import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import { BookMarked, ChevronRight, Play, Save, Trash2, Workflow, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GraphState, TemplateDescriptor, TemplateSlot } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import { partitionWorkflowIds, primaryWorkflowCatalog, type WorkflowEntry } from '@shared/workflow-catalog';
import { ReviewWorkflowComposer } from '@/components/review-workflow-composer';

// Product-facing New Workflow entry. Templates remain the compile mechanism,
// but the first-run UI is organized around outcomes rather than operators.
export function TemplateLibraryPanel({
  runtimeApi,
  runtimeState,
  onClose,
  onStateChange,
  onError,
  autoFocusClose = false,
  defaultCwd,
  onWorkflowStarted,
  requestCloseRef,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  onClose: () => void;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  autoFocusClose?: boolean;
  defaultCwd: string;
  onWorkflowStarted: (result: { coderSessionId: string; loopId?: string }) => void;
  requestCloseRef?: MutableRefObject<(() => void) | undefined>;
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
  const [reviewDraftDirty, setReviewDraftDirty] = useState(false);
  const [discardAction, setDiscardAction] = useState<{ type: 'close' } | { type: 'select'; nextId?: string }>();

  const sessions = Object.values(runtimeState.sessions).filter((session) => session.status !== 'killed');
  const sources = Object.values(runtimeState.sources ?? {}).filter((source) => source.state === 'active');
  const subscriptions = Object.values(runtimeState.subscriptions ?? {});
  const selected = templates.find((template) => template.id === selectedId);
  const catalogById = new Map<string, WorkflowEntry>(primaryWorkflowCatalog.map((entry) => [entry.id, entry]));
  const partitioned = partitionWorkflowIds(templates.map((template) => template.id));
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const primaryTemplates = partitioned.primary.map((id) => templateById.get(id)).filter((template): template is TemplateDescriptor => Boolean(template));
  const moreTemplates = partitioned.more.map((id) => templateById.get(id)).filter((template): template is TemplateDescriptor => Boolean(template));

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

  const commitPick = (nextId?: string) => {
    setSelectedId(nextId);
    setSlotValues({});
    setScheduleModes({});
    setFeedback(undefined);
  };

  const pick = (templateId: string) => {
    const nextId = selectedId === templateId ? undefined : templateId;
    if (selectedId === 'review-until-clean' && reviewDraftDirty) {
      setDiscardAction({ type: 'select', nextId });
      return;
    }
    commitPick(nextId);
  };

  const requestClose = useCallback(() => {
    if (selectedId === 'review-until-clean' && reviewDraftDirty) {
      setDiscardAction({ type: 'close' });
      return;
    }
    onClose();
  }, [onClose, reviewDraftDirty, selectedId]);

  useEffect(() => {
    if (!requestCloseRef) return;
    requestCloseRef.current = requestClose;
    return () => {
      if (requestCloseRef.current === requestClose) {
        requestCloseRef.current = undefined;
      }
    };
  }, [requestClose, requestCloseRef]);

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
      const parts = [
        ...(result.subscriptionIds.length ? [`${result.subscriptionIds.length} relationship(s) created`] : []),
        ...(result.createdSessionIds.length ? [`${result.createdSessionIds.length} Agent(s) created`] : []),
        // One-shot templates (handoff) leave nothing standing — say what
        // actually happened instead of reporting zero subscriptions.
        ...(result.deliveredTo?.length ? [`handed off to ${result.deliveredTo.length} Agent(s)`] : []),
      ];
      setFeedback(`${selected.name}: ${parts.join(', ') || 'ready'}`);
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
          <option value="">
            {slot.required ? (sessions.length ? 'pick an Agent…' : 'no Agents yet — start a Chat first') : (slot.help ?? 'none (optional)')}
          </option>
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
        min={slot.kind === 'number' ? slot.min : undefined}
        max={slot.kind === 'number' ? slot.max : undefined}
        placeholder={slot.placeholder ?? (slot.defaultValue !== undefined ? `default: ${slot.defaultValue}` : undefined)}
        value={slotValues[slot.key] ?? ''}
        onChange={(event) => setSlotValues((values) => ({ ...values, [slot.key]: event.target.value }))}
      />
    );
  };

  const templateCard = (template: TemplateDescriptor, entry?: WorkflowEntry) => {
    const isSelected = template.id === selectedId;
    return (
      <li key={template.id} className={cn('rounded-xl border bg-card p-3', isSelected ? 'border-lime-hi/50 ring-1 ring-lime-hi/25' : 'border-border')}>
        <button type="button" className="block w-full text-left" onClick={() => pick(template.id)}>
          <div className="flex items-center gap-2 text-[12px] font-medium">
            <BookMarked className={cn('size-3.5 shrink-0', entry ? 'text-sky-600 dark:text-sky-300' : 'text-term-amber')} />
            <span className="min-w-0 flex-1 truncate">{entry?.name ?? template.name}</span>
            <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isSelected && 'rotate-90')} />
          </div>
          {entry ? (
            <div className="mt-1.5 space-y-1 text-[10.5px] leading-4 text-muted-foreground">
              <p>{entry.summary}</p>
              <p className="text-term-faint">Needs: {entry.needs}</p>
              <p className="text-term-faint">Result: {entry.result}</p>
            </div>
          ) : (
            <div className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground">
              <p>{template.tagline}</p>
              <p className="text-term-faint">Result: {template.handsOff}</p>
            </div>
          )}
        </button>

        {isSelected && template.id === 'review-until-clean' ? (
          <ReviewWorkflowComposer
            runtimeApi={runtimeApi}
            runtimeState={runtimeState}
            defaultCwd={defaultCwd}
            onStateChange={onStateChange}
            onError={onError}
            onDirtyChange={setReviewDraftDirty}
            onStarted={(result) => {
              setReviewDraftDirty(false);
              onWorkflowStarted(result);
              onClose();
            }}
          />
        ) : isSelected ? (
          <div className="mt-2.5 space-y-2 border-t border-border/70 pt-2.5">
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
              className="h-8 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]"
              size="sm"
              disabled={!runtimeApi || isSubmitting || missingRequired}
              onClick={() => void apply()}
            >
              <Play className="size-3" />
              Create workflow
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
  };

  return (
    <aside
      className={cn(
        'flex max-w-full shrink-0 flex-col border-l border-border bg-background font-mono',
        selectedId === 'review-until-clean' ? 'w-[440px]' : 'w-[360px]',
      )}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <Workflow className="size-4 text-accent-ink" />
        <h2 className="text-[12px] uppercase tracking-[0.14em] text-foreground">New Workflow</h2>
        <Button className="ml-auto" variant="ghost" size="icon" aria-label="Close New Workflow" autoFocus={autoFocusClose} onClick={requestClose}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {discardAction ? (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-[10.5px] leading-4">
            <p className="font-medium text-foreground">Discard this Review workflow draft?</p>
            <p className="mt-1 text-muted-foreground">Nothing has run or been added to the graph yet.</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" className="h-7 flex-1 text-[10px]" onClick={() => setDiscardAction(undefined)}>
                Keep editing
              </Button>
              <Button
                size="sm"
                className="h-7 flex-1 text-[10px]"
                onClick={() => {
                  setReviewDraftDirty(false);
                  const action = discardAction;
                  setDiscardAction(undefined);
                  if (action.type === 'close') {
                    onClose();
                  } else {
                    commitPick(action.nextId);
                  }
                }}
              >
                Discard draft
              </Button>
            </div>
          </div>
        ) : null}
        <div className="rounded-xl border border-accent-ink/20 bg-accent-ink/[0.05] p-3 text-[10.5px] leading-4 text-muted-foreground">
          <p className="font-medium text-foreground">Chats start one Agent. Workflows connect Agents.</p>
          <p className="mt-1">Choose the result you want. Orrery will place the relationship on the graph.</p>
        </div>

        <div>
          <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Start with a common workflow</p>
          <ul className="space-y-2">{primaryTemplates.map((template) => templateCard(template, catalogById.get(template.id)))}</ul>
        </div>
        {feedback ? <p className="text-[10.5px] leading-4 text-lime-700 dark:text-lime-300">{feedback}</p> : null}

        <details className="rounded-xl border border-border bg-card p-3">
          <summary className="cursor-pointer text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">More workflows · Advanced</summary>
          <ul className="mt-2 space-y-2">{moreTemplates.map((template) => templateCard(template))}</ul>

          {subscriptions.length > 0 ? (
            <div className="mt-3 border-t border-border pt-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                <Save className="size-3.5" />
                Save relationships as template
              </div>
              <p className="mt-1 text-[10px] leading-3.5 text-term-faint">
                Advanced: select existing automated relationships and turn their Agent endpoints into reusable blanks.
              </p>
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
        </details>
      </div>
    </aside>
  );
}
