import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, AtSign, X } from 'lucide-react';
import type { CollaborationMember } from '@shared/collaboration';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CollaborationMessageComposer({
  members,
  label,
  hint,
  busy,
  disabled,
  initialText,
  onInitialTextConsumed,
  onSend,
}: {
  members: CollaborationMember[];
  label: string;
  hint?: string;
  busy: boolean;
  disabled?: boolean;
  initialText?: string;
  onInitialTextConsumed?: () => void;
  onSend: (content: string, mentionedMemberIds: string[]) => Promise<boolean>;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [mentions, setMentions] = useState<string[]>([]);
  const [query, setQuery] = useState<string>();
  const [index, setIndex] = useState(0);
  const [showPeople, setShowPeople] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const optionsId = useId();
  useEffect(() => {
    if (!initialText) return;
    setText(initialText);
    onInitialTextConsumed?.();
  }, [initialText, onInitialTextConsumed]);
  const options = members.filter(
    (member) => !mentions.includes(member.memberId) && member.label.toLocaleLowerCase().includes((query ?? '').toLocaleLowerCase()),
  );
  const visibleMentions = mentions.filter((id) => members.some((member) => member.memberId === id));
  const choose = (id: string) => {
    setMentions((current) => (current.includes(id) ? current : [...current, id]));
    setText((current) => current.replace(/@[^@\s]*$/, ''));
    setQuery(undefined);
    setShowPeople(false);
    textareaRef.current?.focus();
  };
  const send = async () => {
    if (!text.trim() || busy || disabled) return;
    if (await onSend(text.trim(), visibleMentions)) {
      setText('');
      setMentions([]);
      setQuery(undefined);
      setShowPeople(false);
      textareaRef.current?.focus();
    }
  };
  return (
    <form
      className="shrink-0 bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="rounded-xl border border-border bg-background focus-within:border-accent-ink/50">
        {visibleMentions.length ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {visibleMentions.map((id) => (
              <button
                key={id}
                type="button"
                disabled={disabled}
                className="flex items-center gap-1 rounded-full bg-accent px-2 py-1 text-xs"
                aria-label={`Remove mention ${members.find((member) => member.memberId === id)?.label}`}
                onClick={() => setMentions((current) => current.filter((item) => item !== id))}
              >
                @{members.find((member) => member.memberId === id)?.label}
                <X className="size-3" />
              </button>
            ))}
          </div>
        ) : null}
        {(query !== undefined || showPeople) && options.length ? (
          <div id={optionsId} role="listbox" aria-label="Mention an Agent" className="m-2 rounded-lg border border-border bg-muted/30 p-1">
            {options.map((member, optionIndex) => (
              <button
                type="button"
                role="option"
                id={`${optionsId}-${optionIndex}`}
                aria-selected={optionIndex === index}
                key={member.memberId}
                className={cn('block w-full rounded-md px-3 py-2 text-left text-sm', optionIndex === index && 'bg-accent')}
                onClick={() => choose(member.memberId)}
              >
                {member.label}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={2}
          value={text}
          disabled={disabled}
          aria-label={label}
          aria-controls={query !== undefined || showPeople ? optionsId : undefined}
          aria-activedescendant={(query !== undefined || showPeople) && options.length ? `${optionsId}-${index % options.length}` : undefined}
          className="min-h-20 w-full resize-y bg-transparent px-3 py-3 text-[15px] leading-6 outline-none disabled:opacity-50"
          placeholder={disabled ? 'Restore this chat to send a message' : `${label}…`}
          onChange={(event) => {
            setText(event.target.value);
            setQuery(event.target.value.match(/@([^@\s]*)$/)?.[1]);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if ((query !== undefined || showPeople) && options.length) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                choose(options[index % options.length].memberId);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery(undefined);
                setShowPeople(false);
                return;
              }
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
            if (event.key === 'Backspace' && !text && mentions.length) setMentions((current) => current.slice(0, -1));
          }}
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Mention an Agent"
            disabled={disabled}
            aria-expanded={showPeople}
            onClick={() => {
              setQuery(undefined);
              setShowPeople((value) => !value);
              setIndex(0);
            }}
          >
            <AtSign className="size-4" />
          </Button>
          {!hint ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled || visibleMentions.length === members.length}
              onClick={() => {
                setMentions(members.map((member) => member.memberId));
                setQuery(undefined);
                setShowPeople(false);
                textareaRef.current?.focus();
              }}
            >
              Ask everyone
            </Button>
          ) : null}
          <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
            {hint ??
              (visibleMentions.length
                ? `Notify ${visibleMentions.map((id) => members.find((member) => member.memberId === id)?.label).join(', ')}`
                : 'Use @ to ask an Agent. Without @, this is a shared note.')}
          </span>
          <Button type="submit" size="icon" aria-label={`Send ${label.toLocaleLowerCase()}`} disabled={busy || disabled || !text.trim()}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
      <p className="mt-1.5 text-right text-[11px] text-muted-foreground">⌘ / Ctrl + Enter to send</p>
    </form>
  );
}
