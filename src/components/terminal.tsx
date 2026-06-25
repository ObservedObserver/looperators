import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Shared terminal / lime-ink primitives.
 *
 * Design rule (see design-docs/terminal-redesign/HANDOFF.md): the chrome flips
 * light/dark, but ink "stages" (input fields, console surfaces) stay dark in
 * BOTH themes. Field surfaces below use the constant `ink` palette; labels and
 * command-line chrome use the flipping tokens so they read on warm paper too.
 */

/** A command-line section header, e.g. `❯ orrery session new --prompt`. */
export function CmdLine({
  command,
  flag,
  trailing,
  className,
}: {
  command: string
  flag?: string
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 font-mono text-[12px] leading-none',
        className
      )}
    >
      <span className="text-lime-hi">❯</span>
      <span className="truncate text-foreground">{command}</span>
      {flag ? <span className="shrink-0 text-accent-ink">{flag}</span> : null}
      {trailing ? (
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {trailing}
        </span>
      ) : null}
    </div>
  )
}

/** Mono uppercase field label. */
export function TermLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground',
        className
      )}
    >
      {children}
    </span>
  )
}

/** Small mono chip on the chrome (policy flags, counts). */
export function TermChip({
  children,
  tone = 'default',
  className,
}: {
  children: ReactNode
  tone?: 'default' | 'lime' | 'amber'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10.5px] leading-none',
        tone === 'lime'
          ? 'border-accent-ink/30 bg-accent-ink/10 text-accent-ink'
          : tone === 'amber'
            ? 'border-term-amber/30 bg-term-amber/10 text-term-amber'
            : 'border-border bg-muted/50 text-muted-foreground',
        className
      )}
    >
      {children}
    </span>
  )
}

/** Ink input field (single line). Dark in both themes. */
export const termInputCls =
  'h-9 w-full rounded-md border border-ink-line bg-ink px-3 font-mono text-[13px] text-term-name outline-none transition placeholder:text-term-faint focus:border-lime-hi/55 focus:ring-1 focus:ring-lime-hi/25 disabled:opacity-50'

/** Ink textarea. Dark in both themes. */
export const termTextareaCls =
  'w-full resize-y rounded-md border border-ink-line bg-ink px-3 py-2.5 font-mono text-[13px] leading-6 text-term-name outline-none transition placeholder:text-term-faint focus:border-lime-hi/55 focus:ring-1 focus:ring-lime-hi/25 disabled:opacity-50'
