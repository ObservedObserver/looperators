import { cn } from '@/lib/utils';

export function OrreryMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background text-primary',
        className,
      )}
    >
      <svg viewBox="0 0 32 32" className="size-6" fill="none" aria-hidden="true">
        <circle cx="16" cy="16" r="9" stroke="currentColor" strokeOpacity="0.22" />
        <circle cx="16" cy="16" r="5.3" stroke="currentColor" strokeOpacity="0.16" />
        <circle cx="16" cy="16" r="2.4" fill="currentColor" />
        <g className="orrery-orbit">
          <circle cx="25" cy="16" r="1.8" fill="currentColor" />
        </g>
        <g className="orrery-orbit-rev">
          <circle cx="10.7" cy="16" r="1.3" fill="currentColor" fillOpacity="0.75" />
        </g>
      </svg>
    </span>
  );
}
