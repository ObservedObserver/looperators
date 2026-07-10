// L6 relation template library — the single compile face (proposal §L6).
//
// Templates are compilers, not entities: each one expands a few filled
// slots into ordinary runtime commands (author_subscription, the goal-loop
// preset, create_session). Nothing here touches the kernel — the plan a
// template compiles to is executed by the runtime through the same verbs a
// hand-authored subscription would use, so what lands on the canvas IS the
// teaching material.
//
// This module is pure: no IO, no clocks, no randomness. The runtime owns
// ids and timestamps (suffixes for paired edges, tpl-ids for saved
// templates); tests can assert compiled plans without a runtime.

import { normalizeDailyAt } from './graph-core/schedule.js';

export type TemplateSlotKind = 'session' | 'text' | 'longtext' | 'number' | 'schedule' | 'external-source';

export type TemplateSlot = {
  key: string;
  label: string;
  kind: TemplateSlotKind;
  required: boolean;
  placeholder?: string;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  help?: string;
};

export type TemplateDescriptor = {
  id: string;
  name: string;
  tagline: string;
  handsOff: string;
  builtin: boolean;
  slots: TemplateSlot[];
};

// Endpoints inside a compiled plan. `{ ref }` points at a create-session
// step in the same plan (resolved by the executor after the session
// exists); the other three are literal kernel endpoints.
export type PlanEndpoint = { session: string } | { ref: string } | { timer: true } | { external: string };

export type PlanSubscriptionInput = {
  // The runtime appends a shared `-<suffix>` so paired edges from one
  // apply stay visibly siblings (goal-check/goal-retry precedent).
  idPrefix?: string;
  label?: string;
  source: PlanEndpoint;
  on: Record<string, unknown>;
  target: PlanEndpoint;
  action: { kind: 'deliver' | 'deliver+activate'; topic?: string; note?: string };
  gate?: string;
  concurrency?: string;
  stop?: Record<string, unknown>;
  onStop?: string;
};

export type TemplatePlanStep =
  | {
      kind: 'create-session';
      ref: string;
      label: string;
      prompt: string;
      // Session id whose provider/cwd/runtimeSettings the new session
      // inherits (the goal judge precedent).
      inheritFromSessionId: string;
      linkLabel?: string;
    }
  | { kind: 'author-subscription'; input: PlanSubscriptionInput }
  // A one-shot deliver+activate command (kernel doc §8.1): a handoff is
  // NOT a standing relation, so it lands as an immediate delivery of the
  // source's artifact bundle plus one activation — no subscription exists
  // afterwards and an idle source hands off right now, not on its next
  // finished turn.
  | { kind: 'handoff'; source: PlanEndpoint; target: PlanEndpoint; topic: string; note: string }
  | {
      kind: 'goal-loop';
      input: { workerSessionId: string; goal: string; maxLaps?: number };
    };

export type TemplatePlan = { steps: TemplatePlanStep[] };

export type SavedTemplate = {
  id: string;
  name: string;
  tagline?: string;
  createdAt: string;
  slots: TemplateSlot[];
  subscriptions: PlanSubscriptionInput[];
};

export type ScheduleParam = { everySeconds?: number; dailyAt?: string };

// ---- prompt/note text ----
//
// The review vocabulary (verdict issues|clean) and the membrane-report
// discipline mirror the hero-loop prompts in the runtime: a template must
// land the same teaching-quality edges a hand-built loop would.

const reviewerBootstrapPrompt = [
  'You are the Reviewer in an Orrery review loop.',
  'Your job on each activation: read the work delivered in your context channel, then call mcp__orrery_membrane__report exactly once with type "verdict" — verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain.',
  'Do not edit files.',
  'For now, reply with exactly: ready. Then stop and wait for activations.',
].join('\n');

const reviewerActivationNote = [
  'Review the latest work delivered in your context channel (file paths listed below).',
  'Do not edit files.',
  'Call mcp__orrery_membrane__report exactly once with type "verdict": verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain. Then stop.',
].join('\n');

const coderFixNote = [
  'The reviewer reported issues; the review is delivered in your context channel (file paths listed below).',
  'Fix the listed issues, then finish your turn so the loop can run the reviewer again.',
].join('\n');

const handoffDefaultNote = [
  'Handoff: the previous agent finished its turn; its results are delivered in your context channel (file paths listed below).',
  'Continue the work from there.',
].join('\n');

// ---- built-in registry ----

export const defaultReviewMaxLaps = 6;
export const defaultReactiveFixerMaxFirings = 3;

const sessionSlot = (key: string, label: string, overrides: Partial<TemplateSlot> = {}): TemplateSlot => ({
  key,
  label,
  kind: 'session',
  required: true,
  ...overrides,
});

export const builtinTemplates: TemplateDescriptor[] = [
  {
    id: 'handoff',
    name: 'Handoff',
    tagline: '把工作交给下一个 agent',
    handsOff: '上下文搬运(一次性命令)',
    builtin: true,
    slots: [
      sessionSlot('source', 'From Agent'),
      sessionSlot('target', 'To Agent'),
      {
        key: 'note',
        label: 'Handoff note',
        kind: 'longtext',
        required: false,
        placeholder: 'What should the next agent do with the results?',
      },
    ],
  },
  {
    id: 'watch-and-summarize',
    name: 'Watch & summarize',
    tagline: '持续把进展喂给它,别打扰它',
    handsOff: '注意力(deliver-only,不激活)',
    builtin: true,
    slots: [
      sessionSlot('source', 'Watched Agent'),
      sessionSlot('watcher', 'Summary Agent'),
      {
        key: 'note',
        label: 'Delivery note',
        kind: 'longtext',
        required: false,
        placeholder: 'Optional note attached to each delivery',
      },
    ],
  },
  {
    id: 'review-until-clean',
    name: 'Review until clean',
    tagline: '改 → 审 → 再改,直到干净',
    handsOff: '循环的发动机(reviewer 报 clean 即停)',
    builtin: true,
    slots: [
      sessionSlot('coder', 'Coder Agent'),
      sessionSlot('reviewer', 'Reviewer Agent', {
        required: false,
        help: 'Leave empty to create a Reviewer Agent next to the Coder',
      }),
      {
        key: 'maxLaps',
        label: 'Max laps',
        kind: 'number',
        required: false,
        defaultValue: defaultReviewMaxLaps,
        min: 1,
        max: 999,
      },
    ],
  },
  {
    id: 'goal-loop',
    name: 'Goal loop',
    tagline: '转到达标为止(自然语言定义达标)',
    handsOff: '停止条件',
    builtin: true,
    slots: [
      sessionSlot('worker', 'Worker Agent'),
      {
        key: 'goal',
        label: 'The goal (one sentence defining done)',
        kind: 'longtext',
        required: true,
        placeholder: 'e.g. "Running `npm test` in this repository exits with code 0."',
      },
      {
        key: 'maxLaps',
        label: 'Max laps',
        kind: 'number',
        required: false,
        defaultValue: defaultReviewMaxLaps,
        min: 1,
        max: 99,
      },
    ],
  },
  {
    id: 'scheduled-routine',
    name: 'Scheduled routine',
    tagline: '按时醒来干活',
    handsOff: '触发时机',
    builtin: true,
    slots: [
      sessionSlot('target', 'Agent to wake'),
      { key: 'schedule', label: 'Schedule', kind: 'schedule', required: true },
      {
        key: 'instruction',
        label: 'What to do on each wake-up',
        kind: 'longtext',
        required: true,
        placeholder: 'e.g. "Summarize new issues since the last run."',
      },
    ],
  },
  {
    id: 'reactive-fixer',
    name: 'Reactive fixer',
    tagline: '外部世界出事就响应',
    handsOff: '全程(事件 → 响应,带护栏)',
    builtin: true,
    slots: [
      {
        key: 'source',
        label: 'External source',
        kind: 'external-source',
        required: true,
        help: 'Register sources in the Sources panel first',
      },
      sessionSlot('target', 'Responder Agent'),
      {
        key: 'instruction',
        label: 'What to do when the event fires',
        kind: 'longtext',
        required: true,
        placeholder: 'e.g. "CI failed — read the event payload and fix the failure."',
      },
      {
        key: 'maxFirings',
        label: 'Max firings',
        kind: 'number',
        required: false,
        defaultValue: defaultReactiveFixerMaxFirings,
        min: 1,
        max: 999,
      },
    ],
  },
];

export const builtinTemplateById = new Map(builtinTemplates.map((template) => [template.id, template]));

// ---- slot validation ----

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
};

// Coerce+validate raw params against a slot list. Returns a normalized map
// (strings trimmed, numbers coerced, defaults applied); throws the kind of
// error a user can act on — this is the template UI's validation layer too.
export function validateSlotParams(templateName: string, slots: TemplateSlot[], params: Record<string, unknown> = {}): Record<string, unknown> {
  const known = new Set(slots.map((slot) => slot.key));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) {
      throw new Error(`Template "${templateName}" has no slot "${key}"`);
    }
  }
  const normalized: Record<string, unknown> = {};
  for (const slot of slots) {
    const raw = params[slot.key];
    let value: unknown;
    switch (slot.kind) {
      case 'session':
      case 'external-source':
      case 'text':
      case 'longtext': {
        value = trimmed(raw);
        break;
      }
      case 'number': {
        if (raw === undefined || raw === null || raw === '') {
          value = undefined;
        } else {
          const num = Number(raw);
          // Safe integer + slot-specific product bounds. Goal loop delegates
          // to the L3 runtime verb whose public contract is 1-99; keeping the
          // bound on the descriptor makes the shared compiler and runtime
          // agree while allowing other firing-count slots to use 1-999.
          const min = slot.min ?? 1;
          const max = slot.max ?? 999;
          if (!Number.isSafeInteger(num) || num < min || num > max) {
            throw new Error(`Template "${templateName}" slot "${slot.label}" must be an integer (${min}-${max})`);
          }
          value = num;
        }
        break;
      }
      case 'schedule': {
        if (raw === undefined || raw === null) {
          value = undefined;
          break;
        }
        if (!isRecord(raw)) {
          throw new Error(`Template "${templateName}" slot "${slot.label}" must be { everySeconds } or { dailyAt }`);
        }
        const everySeconds = raw.everySeconds === undefined || raw.everySeconds === '' ? undefined : Number(raw.everySeconds);
        const dailyAt = trimmed(raw.dailyAt);
        if ((everySeconds === undefined) === (dailyAt === undefined)) {
          throw new Error(`Template "${templateName}" slot "${slot.label}" requires exactly one of everySeconds or dailyAt`);
        }
        // Value validation belongs to the compile face too: a malformed
        // schedule must not leak into a plan only to die in runtime
        // authoring. The runtime's minimum-interval floor stays a runtime
        // concern (it is environment-tunable); shape is checked here.
        if (everySeconds !== undefined) {
          if (!Number.isInteger(everySeconds) || everySeconds <= 0) {
            throw new Error(`Template "${templateName}" slot "${slot.label}" everySeconds must be a positive integer`);
          }
          value = { everySeconds };
        } else {
          const normalized = normalizeDailyAt(dailyAt);
          if (!normalized) {
            throw new Error(`Template "${templateName}" slot "${slot.label}" dailyAt must be HH:MM (24h)`);
          }
          value = { dailyAt: normalized };
        }
        break;
      }
    }
    if (value === undefined && slot.defaultValue !== undefined) {
      value = slot.defaultValue;
    }
    if (value === undefined) {
      if (slot.required) {
        throw new Error(`Template "${templateName}" is missing required slot "${slot.label}"`);
      }
      continue;
    }
    normalized[slot.key] = value;
  }
  return normalized;
}

// ---- built-in compilers ----

const session = (id: unknown): PlanEndpoint => ({ session: String(id) });

export function compileBuiltinTemplate(templateId: string, params: Record<string, unknown> = {}): TemplatePlan {
  const template = builtinTemplateById.get(templateId);
  if (!template) {
    throw new Error(`Unknown template: ${templateId}`);
  }
  const filled = validateSlotParams(template.name, template.slots, params);

  switch (templateId) {
    case 'handoff': {
      return {
        steps: [
          {
            kind: 'handoff',
            source: session(filled.source),
            target: session(filled.target),
            topic: 'handoff',
            note: (filled.note as string | undefined) ?? handoffDefaultNote,
          },
        ],
      };
    }
    case 'watch-and-summarize': {
      return {
        steps: [
          {
            kind: 'author-subscription',
            input: {
              idPrefix: 'watch',
              label: 'watch',
              source: session(filled.source),
              on: { on: 'finished' },
              target: session(filled.watcher),
              // Pure attention: deliveries pile up in the watcher's channel
              // and never activate it, so there is no cycle to guard.
              action: {
                kind: 'deliver',
                topic: 'progress',
                ...(filled.note ? { note: filled.note as string } : {}),
              },
            },
          },
        ],
      };
    }
    case 'review-until-clean': {
      const coder = String(filled.coder);
      const reviewer = filled.reviewer as string | undefined;
      const maxLaps = (filled.maxLaps as number | undefined) ?? defaultReviewMaxLaps;
      const reviewerEndpoint: PlanEndpoint = reviewer ? { session: reviewer } : { ref: 'reviewer' };
      // Both edges carry the same stop, the goal-ring precedent: whenReport
      // observes the edge's participants, so the reviewer's `clean` stops
      // the pair together. The gate is explicitly auto — deterministic
      // reviewing needs no master, and the maxFirings guardrail is what
      // keeps the cycle safe (also the goal-ring precedent; an unset gate
      // would default to master on a cycle).
      const stop = { whenReport: { verdict: 'clean' }, maxFirings: maxLaps };
      const steps: TemplatePlanStep[] = [];
      if (!reviewer) {
        steps.push({
          kind: 'create-session',
          ref: 'reviewer',
          label: 'Reviewer',
          prompt: reviewerBootstrapPrompt,
          inheritFromSessionId: coder,
          linkLabel: 'review pair',
        });
      }
      steps.push(
        {
          kind: 'author-subscription',
          input: {
            idPrefix: 'review-pass',
            label: 'review pass',
            source: session(coder),
            on: { on: 'finished' },
            target: reviewerEndpoint,
            action: { kind: 'deliver+activate', topic: 'diff', note: reviewerActivationNote },
            gate: 'auto',
            stop,
          },
        },
        {
          kind: 'author-subscription',
          input: {
            idPrefix: 'review-fix',
            label: 'review fix',
            source: reviewerEndpoint,
            on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
            target: session(coder),
            action: { kind: 'deliver+activate', topic: 'review', note: coderFixNote },
            gate: 'auto',
            stop,
          },
        },
      );
      return { steps };
    }
    case 'goal-loop': {
      return {
        steps: [
          {
            kind: 'goal-loop',
            input: {
              workerSessionId: String(filled.worker),
              goal: String(filled.goal),
              ...(filled.maxLaps !== undefined ? { maxLaps: filled.maxLaps as number } : {}),
            },
          },
        ],
      };
    }
    case 'scheduled-routine': {
      const schedule = filled.schedule as ScheduleParam;
      return {
        steps: [
          {
            kind: 'author-subscription',
            input: {
              idPrefix: 'routine',
              label: 'scheduled routine',
              source: { timer: true },
              on: { on: 'schedule', ...schedule },
              target: session(filled.target),
              action: { kind: 'deliver+activate', note: String(filled.instruction) },
            },
          },
        ],
      };
    }
    case 'reactive-fixer': {
      return {
        steps: [
          {
            kind: 'author-subscription',
            input: {
              idPrefix: 'fixer',
              label: 'reactive fixer',
              source: { external: String(filled.source) },
              on: { on: 'external' },
              target: session(filled.target),
              action: { kind: 'deliver+activate', note: String(filled.instruction) },
              // The proposal's guardrail: an external world gone haywire
              // must not spin the responder forever.
              stop: { maxFirings: (filled.maxFirings as number | undefined) ?? defaultReactiveFixerMaxFirings },
            },
          },
        ],
      };
    }
    default: {
      // Registry and compiler must move in lockstep; a descriptor without
      // a compiler is a programming error, not a user error.
      throw new Error(`Template "${templateId}" has no compiler`);
    }
  }
}

// ---- custom templates: save (parameterize) and apply (rebind) ----

type SubscriptionLike = {
  id: string;
  label?: string;
  source: { kind: string; sessionId?: string; sourceId?: string; clusterId?: string };
  on: Record<string, unknown>;
  target: { kind: string; sessionId?: string };
  action: { kind: string; topic?: string; note?: string };
  gate?: string;
  concurrency?: string;
  stop?: Record<string, unknown>;
  onStop?: string;
};

// Turn a set of live subscriptions into a reusable, parameterized template
// body: every distinct session endpoint becomes a session slot (labeled
// with the live session's label as a hint), every external source becomes
// an external-source slot; timers pass through. Ids, firings, and runtime
// state are deliberately dropped — a template captures the relation, not
// the history.
export function parameterizeSubscriptions(
  subscriptions: SubscriptionLike[],
  labelFor: { session: (id: string) => string | undefined; source: (id: string) => string | undefined },
): { slots: TemplateSlot[]; subscriptions: PlanSubscriptionInput[] } {
  if (subscriptions.length === 0) {
    throw new Error('Saving a template requires at least one subscription');
  }
  const slots: TemplateSlot[] = [];
  const sessionSlots = new Map<string, string>();
  const sourceSlots = new Map<string, string>();

  const sessionEndpoint = (sessionId: string): PlanEndpoint => {
    let key = sessionSlots.get(sessionId);
    if (!key) {
      key = `session-${sessionSlots.size + 1}`;
      sessionSlots.set(sessionId, key);
      slots.push({
        key,
        label: labelFor.session(sessionId) ?? key,
        kind: 'session',
        required: true,
      });
    }
    return { session: `$${key}` };
  };
  const externalEndpoint = (sourceId: string): PlanEndpoint => {
    let key = sourceSlots.get(sourceId);
    if (!key) {
      key = `source-${sourceSlots.size + 1}`;
      sourceSlots.set(sourceId, key);
      slots.push({
        key,
        label: labelFor.source(sourceId) ?? key,
        kind: 'external-source',
        required: true,
      });
    }
    return { external: `$${key}` };
  };

  const endpoint = (ref: SubscriptionLike['source']): PlanEndpoint => {
    if (ref.kind === 'session' && ref.sessionId) return sessionEndpoint(ref.sessionId);
    if (ref.kind === 'timer') return { timer: true };
    if (ref.kind === 'external' && ref.sourceId) return externalEndpoint(ref.sourceId);
    throw new Error(`Cannot template a subscription with a ${ref.kind} endpoint (only session, timer, and external endpoints are parameterizable)`);
  };

  // Keep the semantic id prefix (review-pass, goal-check, …): the apply
  // executor appends one shared suffix per apply, so a saved ring comes
  // back as visibly paired siblings, not unrelated sub-* edges. Ids that
  // do not follow the `<prefix>-<8hex>` scheme stay runtime-generated.
  const idPrefixOf = (id: string): string | undefined => /^(.+)-[0-9a-f]{8}$/.exec(id)?.[1];

  const bodies = subscriptions.map((subscription): PlanSubscriptionInput => ({
    ...(idPrefixOf(subscription.id) ? { idPrefix: idPrefixOf(subscription.id) } : {}),
    ...(subscription.label ? { label: subscription.label } : {}),
    source: endpoint(subscription.source),
    on: { ...subscription.on },
    target: endpoint(subscription.target),
    action: {
      kind: subscription.action.kind === 'deliver' ? 'deliver' : 'deliver+activate',
      ...(subscription.action.topic ? { topic: subscription.action.topic } : {}),
      ...(subscription.action.note ? { note: subscription.action.note } : {}),
    },
    ...(subscription.gate ? { gate: subscription.gate } : {}),
    ...(subscription.concurrency ? { concurrency: subscription.concurrency } : {}),
    ...(subscription.stop ? { stop: { ...subscription.stop } } : {}),
    ...(subscription.onStop ? { onStop: subscription.onStop } : {}),
  }));

  return { slots, subscriptions: bodies };
}

// Rebind a saved template's `$slot` endpoints to the given params and
// return an executable plan. Symmetric with parameterizeSubscriptions.
export function compileSavedTemplate(template: Pick<SavedTemplate, 'name' | 'slots' | 'subscriptions'>, params: Record<string, unknown> = {}): TemplatePlan {
  const filled = validateSlotParams(template.name, template.slots, params);

  const materialize = (endpoint: PlanEndpoint): PlanEndpoint => {
    if ('session' in endpoint && endpoint.session.startsWith('$')) {
      const key = endpoint.session.slice(1);
      return { session: String(filled[key]) };
    }
    if ('external' in endpoint && endpoint.external.startsWith('$')) {
      const key = endpoint.external.slice(1);
      return { external: String(filled[key]) };
    }
    return endpoint;
  };

  return {
    steps: template.subscriptions.map((input) => ({
      kind: 'author-subscription',
      input: {
        ...input,
        source: materialize(input.source),
        target: materialize(input.target),
      },
    })),
  };
}

// One list for the UI: built-ins first, then saved templates as
// descriptors (builtin:false). The renderer never sees compile logic —
// only this data.
export function templateDescriptors(saved: Record<string, SavedTemplate> | undefined): TemplateDescriptor[] {
  const custom = Object.values(saved ?? {})
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((template) => ({
      id: template.id,
      name: template.name,
      tagline: template.tagline ?? 'Saved from the canvas',
      handsOff: `${template.subscriptions.length} subscription(s)`,
      builtin: false,
      slots: template.slots,
    }));
  return [...builtinTemplates, ...custom];
}
