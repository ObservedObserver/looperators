import {
  type ReactNode,
} from 'react'
import {
  Check,
} from 'lucide-react'
import {
  cn,
} from '@/lib/utils'

export type WorkflowStepStatus = 'done' | 'active' | 'blocked'

export function workflowStepClassName(status: WorkflowStepStatus) {
  switch (status) {
    case 'done':
      return 'border-term-green/35 bg-term-green/10 text-term-green'
    case 'active':
      return 'border-lime-hi/35 bg-lime/[0.08] text-lime-hi'
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim2'
  }
}

export function workflowStatusPillClassName(status: WorkflowStepStatus) {
  switch (status) {
    case 'done':
      return 'border-term-green/30 bg-term-green/10 text-term-green'
    case 'active':
      return 'border-term-amber/30 bg-term-amber/10 text-term-amber'
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim2'
  }
}

export function WorkflowStep({
  index,
  title,
  detail,
  status,
}: {
  index: number
  title: string
  detail: string
  status: WorkflowStepStatus
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[28px_minmax(0,1fr)] gap-2 rounded-lg border px-2.5 py-2 font-mono',
        workflowStepClassName(status)
      )}
    >
      <span className="flex size-5 items-center justify-center rounded-md border border-current/25 text-[10px] tabular-nums">
        {status === 'done' ? <Check className="size-3" /> : index}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium">{title}</span>
        <span className="mt-0.5 block line-clamp-2 text-[10.5px] leading-4 opacity-75">
          {detail}
        </span>
      </span>
    </div>
  )
}

export function WorkflowSummaryRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 text-[11.5px] leading-5">
      <span className="text-term-dim2">{label}</span>
      <span className="min-w-0 text-term-dim">{children}</span>
    </div>
  )
}
