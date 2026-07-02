import {
  FileText,
  Image as ImageIcon,
  X,
} from 'lucide-react'
import {
  type ChatAttachment,
} from '@/shared/provider-runtime'
import {
  formatFileSize,
} from '@/lib/format'

export function ComposerAttachmentPill({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: ChatAttachment
  disabled?: boolean
  onRemove: (id: string) => void
}) {
  return (
    <div className="group/attachment grid min-w-0 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-ink-line bg-foreground/[0.04] px-2 py-2 font-mono">
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink-line bg-ink-soft text-term-cyan">
        {attachment.kind === 'image' && attachment.dataUrl ? (
          <img
            className="size-full object-cover"
            src={attachment.dataUrl}
            alt=""
          />
        ) : attachment.kind === 'image' ? (
          <ImageIcon className="size-4" />
        ) : (
          <FileText className="size-4" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-term-name">
          {attachment.name}
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-term-dim2">
          {attachment.mediaType} · {formatFileSize(attachment.size)}
          {attachment.truncated ? ' · truncated' : ''}
        </span>
      </span>
      <button
        type="button"
        className="rounded-md p-1 text-term-dim2 transition hover:bg-foreground/[0.06] hover:text-term-name disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled}
        aria-label={`Remove ${attachment.name}`}
        onClick={() => onRemove(attachment.id)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
