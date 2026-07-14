import { Popover as PopoverPrimitive } from 'radix-ui';
import { Check, Palette } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { themes, type ThemeId } from '@/lib/themes';
import type { ColorScheme } from '@/hooks/use-layout-prefs';

export function ThemePicker({ theme, setTheme, colorScheme }: { theme: ThemeId; setTheme: (theme: ThemeId) => void; colorScheme: ColorScheme }) {
  return (
    <PopoverPrimitive.Root>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <Button variant="ghost" size="icon" aria-label="Choose theme">
              <Palette className="size-4" />
            </Button>
          </PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content align="end" sideOffset={6} className="z-50 w-56 rounded-lg border border-border bg-popover p-1.5 shadow-md outline-none">
          {themes.map((option) => {
            const [surface, accent] = option.preview[colorScheme];
            const active = option.id === theme;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setTheme(option.id)}
                title={option.description}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground transition-colors hover:bg-accent',
                  active && 'bg-accent',
                )}
              >
                <span className="flex shrink-0 -space-x-1">
                  <span className="size-4 rounded-full border border-border" style={{ background: surface }} />
                  <span className="size-4 rounded-full border border-border" style={{ background: accent }} />
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {active ? <Check className="size-3.5 shrink-0 text-accent-ink" /> : null}
              </button>
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
