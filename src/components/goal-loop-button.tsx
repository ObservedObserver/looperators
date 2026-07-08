import { useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { RefreshCw, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { activeGoalCheckEdge } from '@/lib/graph-view';
import type { GraphState, SessionId, Subscription } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

// L3 goal loop entry: hand off the stop condition in one sentence. The
// runtime compiles it into a judge session plus two subscriptions; nothing
// here parses the goal — it goes verbatim into the judge's prompts.
export function GoalLoopButton({
  sessionId,
  subscriptions,
  runtimeApi,
  onStateChange,
  onError,
}: {
  sessionId: SessionId;
  subscriptions: Record<string, Subscription> | undefined;
  runtimeApi: RuntimeApi | undefined;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [maxLaps, setMaxLaps] = useState('6');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Same compiled fingerprint the runtime uses (see graph-view): an
  // id-prefix squatter is not a goal loop and must not block (or
  // advertise) one.
  const activeGoal = activeGoalCheckEdge(subscriptions, sessionId);

  const submit = async () => {
    const trimmed = goal.trim();
    if (!runtimeApi || trimmed.length === 0 || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      const laps = Math.floor(Number(maxLaps));
      const result = await runtimeApi.createGoalLoop({
        workerSessionId: sessionId,
        goal: trimmed,
        ...(Number.isFinite(laps) && laps >= 1 ? { maxLaps: laps } : {}),
      });
      onStateChange(result.state);
      setOpen(false);
      setGoal('');
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <Button
              className="app-region-no-drag h-7 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
              variant={activeGoal ? 'secondary' : 'outline'}
              size="sm"
              disabled={!runtimeApi}
              aria-label="Set a goal loop"
            >
              <Target className="size-3.5" />
              <span className="hidden @[34rem]:inline">Goal</span>
            </Button>
          </PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent>
          {activeGoal ? `Goal loop active: ${activeGoal.label ?? activeGoal.id}` : 'Define done in one sentence; a judge checks each turn'}
        </TooltipContent>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          side="bottom"
          sideOffset={8}
          className="z-50 w-80 rounded-xl border border-border bg-popover p-3 font-mono text-popover-foreground shadow-[0_18px_44px_-16px_rgba(0,0,0,0.55)]"
        >
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Goal loop</div>
          <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground">
            One sentence defining done. A judge session runs your check after each turn and reports done or fail; the loop stops itself at done or at the lap
            cap.
          </p>
          {activeGoal ? (
            <p className="mt-1.5 rounded-md border border-term-amber/40 bg-term-amber/10 px-2 py-1 text-[10.5px] leading-4 text-amber-700 dark:text-term-amber">
              A goal loop is already active on this chat: {activeGoal.label ?? activeGoal.id}
            </p>
          ) : null}
          <textarea
            className="mt-2 h-20 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[12px] leading-5 outline-none focus:border-lime-hi/60"
            placeholder='e.g. "until the test suite is green and lint has no warnings"'
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <label className="text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground" htmlFor="goal-max-laps">
              Max laps
            </label>
            <input
              id="goal-max-laps"
              type="number"
              min={1}
              max={99}
              className="h-7 w-16 rounded-lg border border-border bg-background px-2 text-[12px] tabular-nums outline-none focus:border-lime-hi/60"
              value={maxLaps}
              onChange={(event) => setMaxLaps(event.target.value)}
            />
            <Button
              className="ml-auto h-7 px-3 font-mono text-[10.5px] uppercase tracking-[0.06em]"
              size="sm"
              disabled={goal.trim().length === 0 || isSubmitting || Boolean(activeGoal)}
              onClick={() => void submit()}
            >
              {isSubmitting ? <RefreshCw className="size-3.5 animate-spin" /> : <Target className="size-3.5" />}
              Start
            </Button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
