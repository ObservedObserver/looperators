import { Pause, Play, Target, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ThreadGoal } from '@shared/thread-goal';

const goalStatusLabels: Record<ThreadGoal['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limited',
  budgetLimited: 'Budget limited',
  complete: 'Complete',
};

const resumableGoalStatuses = new Set<ThreadGoal['status']>([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
]);

function compactDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function ThreadGoalProgressRow({
  goal,
  sessionRunning,
  busy,
  onPause,
  onResume,
  onClear,
}: {
  goal: ThreadGoal;
  sessionRunning: boolean;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const canPause = goal.status === 'active' && sessionRunning;
  const canResume = resumableGoalStatuses.has(goal.status) && !canPause;
  const usage = `${goal.tokensUsed.toLocaleString()} tokens · ${compactDuration(goal.timeUsedSeconds)}`;

  return (
    <div className="app-region-no-drag mb-2 flex items-center gap-2 rounded-lg border border-term-accent-hi/25 bg-term-accent/[0.055] px-2.5 py-2">
      <Target className="size-3.5 shrink-0 text-term-accent-hi" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.07em] text-term-accent-hi">
          <span>{goalStatusLabels[goal.status]}</span>
          <span className="normal-case tracking-normal text-term-faint">{usage}</span>
        </div>
        <div className="truncate font-mono text-[11px] text-term-name" title={goal.objective}>{goal.objective}</div>
      </div>
      {canPause ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-7" disabled={busy} aria-label="Pause goal" onClick={onPause}>
              <Pause className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Pause goal</TooltipContent>
        </Tooltip>
      ) : canResume ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-7" disabled={busy} aria-label="Resume goal" onClick={onResume}>
              <Play className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Resume goal</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="size-7 text-term-dim hover:text-term-rose" disabled={busy} aria-label="Clear goal" onClick={onClear}>
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Clear goal</TooltipContent>
      </Tooltip>
    </div>
  );
}
