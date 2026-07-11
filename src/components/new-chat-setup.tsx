import { useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ClipboardCheck,
  FolderOpen,
  GitBranch,
  RefreshCw,
  Sparkles,
  Terminal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive, Select as SelectPrimitive } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type OpenWorkspaceTarget, type ProviderSetupModel, type WorkMode } from '@/shared/graph-state';
import {
  type ProviderKind,
  type ProviderReasoningEffort,
  type ProviderRuntimeMode,
  providerCapability,
  providerRuntimeModeCapability,
  providerSupportsReasoningEffort,
} from '@/shared/provider-runtime';
import { workspaceOpenTargetOptions, workspaceOpenTargetOption, workspaceOpenTargetAvailable } from '@/lib/layout-prefs';
import { providerOptions, modelOptionsForKind, workModeOptions, reasoningEffortOptionsForKind } from '@/lib/provider-catalog';
import { type ProjectCwdValidation, type NewChatProjectOption, chooseProjectOptionValue, uniqueStrings } from '@/lib/workspace';

export function ProviderSegmentedControl({
  value,
  disabled,
  className,
  onChange,
}: {
  value: ProviderKind;
  disabled?: boolean;
  className?: string;
  onChange: (value: ProviderKind) => void;
}) {
  return (
    <div className={cn('grid grid-cols-3 gap-1 rounded-lg border border-ink-line bg-ink p-1 font-mono', disabled && 'opacity-60', className)}>
      {providerOptions.map((option) => {
        const isSelected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            className={cn(
              'truncate rounded-md px-2 py-1.5 text-[10.5px] uppercase tracking-[0.06em] transition disabled:cursor-not-allowed',
              isSelected ? 'bg-lime/[0.12] text-lime ring-1 ring-lime/30' : 'text-term-dim hover:bg-foreground/[0.06] hover:text-term-name',
            )}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function ProjectCwdField({
  value,
  validation,
  disabled,
  onChange,
}: {
  value: string;
  validation: ProjectCwdValidation;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={cn(
        'flex h-8 min-w-0 items-center gap-2 rounded-md border border-ink-line bg-ink px-2.5 font-mono transition focus-within:border-lime-hi/55 focus-within:ring-1 focus-within:ring-lime-hi/25',
        !validation.ok && 'border-term-rose/45 focus-within:border-term-rose/70',
        disabled && 'opacity-55',
      )}
      title="Project folder"
    >
      <FolderOpen className="size-3.5 shrink-0 text-lime-hi" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[12px] text-term-name outline-none placeholder:text-term-faint disabled:cursor-not-allowed"
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder="/path/to/project"
        aria-label="Project folder path"
        aria-invalid={!validation.ok}
        onChange={(event) => onChange(event.target.value)}
      />
      {!validation.ok ? <TriangleAlert className="size-3.5 shrink-0 text-term-rose" /> : null}
    </label>
  );
}

export function ProjectCwdChip({
  value,
  validation,
  projects,
  disabled,
  onChange,
}: {
  value: string;
  validation: ProjectCwdValidation;
  projects: NewChatProjectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={cn(
        'relative flex h-7 w-56 min-w-0 shrink-0 items-center gap-1.5 rounded-md border bg-ink px-2 font-mono transition focus-within:ring-1',
        validation.ok
          ? 'border-ink-line focus-within:border-lime-hi/60 focus-within:ring-lime-hi/25'
          : 'border-term-rose/55 focus-within:border-term-rose/70 focus-within:ring-term-rose/25',
        disabled && 'opacity-55',
      )}
      title={validation.ok ? 'Project folder' : validation.message}
    >
      <FolderOpen className={cn('size-3.5 shrink-0', validation.ok ? 'text-lime-hi' : 'text-term-rose')} />
      <input
        list="orrery-project-suggestions"
        className="min-w-0 flex-1 bg-transparent text-[11.5px] text-term-name outline-none placeholder:text-term-faint disabled:cursor-not-allowed"
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder="/path/to/project"
        aria-label="Project folder path"
        aria-invalid={!validation.ok}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id="orrery-project-suggestions">
        {projects.map((project) => (
          <option key={project.id} value={project.cwd}>
            {project.name}
          </option>
        ))}
      </datalist>
    </label>
  );
}

export type SetupOption = { value: string; label: string; disabled?: boolean };

export function NewChatSetupPill({
  icon: Icon,
  label,
  value,
  options,
  placeholder,
  tone = 'primary',
  disabled,
  invalid,
  hint,
  className,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  options: SetupOption[];
  placeholder?: string;
  tone?: 'primary' | 'secondary';
  disabled?: boolean;
  invalid?: boolean;
  hint?: string;
  className?: string;
  onChange: (value: string) => void;
}) {
  const primary = tone === 'primary';
  const display = options.find((option) => option.value === value)?.label ?? placeholder ?? label;
  return (
    <SelectPrimitive.Root value={value} disabled={disabled} onValueChange={onChange}>
      <SelectPrimitive.Trigger
        aria-label={label}
        title={hint ?? label}
        className={cn(
          'group relative flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md font-mono outline-none transition disabled:cursor-not-allowed disabled:opacity-55',
          primary
            ? 'border border-ink-line bg-ink pl-2 pr-1.5 hover:border-ink-line-2 data-[state=open]:border-lime-hi/60 focus-visible:border-lime-hi/60 focus-visible:ring-1 focus-visible:ring-lime-hi/25'
            : 'border border-transparent px-1.5 hover:bg-white/[0.05] data-[state=open]:bg-white/[0.05] focus-visible:bg-white/[0.05]',
          invalid && 'border-term-rose/55 data-[state=open]:border-term-rose/70 focus-visible:border-term-rose/70 focus-visible:ring-term-rose/25',
          className,
        )}
      >
        <Icon className={cn('size-3.5 shrink-0', invalid ? 'text-term-rose' : primary ? 'text-lime-hi' : 'text-term-dim2')} />
        <span className={cn('min-w-0 flex-1 truncate text-left text-[11.5px]', primary ? 'font-medium text-term-name' : 'text-term-dim')}>{display}</span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180', primary ? 'text-term-dim2' : 'text-term-faint')}
          />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-ink-line bg-ink-soft p-1 font-mono shadow-[0_12px_32px_-8px_rgba(0,0,0,0.75)]"
        >
          <SelectPrimitive.Viewport className="flex flex-col gap-0.5">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex h-7 cursor-pointer select-none items-center gap-2 rounded-md pl-2.5 pr-7 text-[11.5px] text-term-dim outline-none data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-term-name data-[state=checked]:bg-lime-hi/10 data-[state=checked]:font-medium data-[state=checked]:text-term-name data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
                  <Check className="size-3.5 text-lime-hi" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function OpenWorkspaceSplitButton({
  target,
  platform,
  disabled,
  pendingTarget,
  onOpen,
  onTargetChange,
}: {
  target: OpenWorkspaceTarget;
  platform?: string;
  disabled?: boolean;
  pendingTarget?: OpenWorkspaceTarget;
  onOpen: (target: OpenWorkspaceTarget) => void;
  onTargetChange: (target: OpenWorkspaceTarget) => void;
}) {
  const activeOption = workspaceOpenTargetOption(target);
  const ActiveIcon = activeOption.icon;
  const isOpening = Boolean(pendingTarget);
  const activeUnavailable = !workspaceOpenTargetAvailable(activeOption, platform);
  const mainDisabled = disabled || isOpening || activeUnavailable;

  return (
    <DropdownMenuPrimitive.Root>
      <div className="app-region-no-drag inline-flex h-7 shrink-0 overflow-hidden rounded-lg border border-border bg-background shadow-sm">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="h-7 rounded-none border-0 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
              variant="ghost"
              size="sm"
              disabled={mainDisabled}
              aria-label={`Open in ${activeOption.label}`}
              onClick={() => onOpen(target)}
            >
              {isOpening && pendingTarget === target ? <RefreshCw className="size-3.5 animate-spin" /> : <ActiveIcon className="size-3.5" />}
              <span className="hidden max-w-16 truncate @[34rem]:inline">{activeOption.label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{activeUnavailable ? `${activeOption.label} is unavailable on this platform` : `Open in ${activeOption.label}`}</TooltipContent>
        </Tooltip>
        <DropdownMenuPrimitive.Trigger asChild>
          <Button
            className="h-7 w-7 rounded-none border-0 border-l border-border bg-muted/70 px-0"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || isOpening}
            aria-label="Choose open target"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuPrimitive.Trigger>
      </div>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          side="bottom"
          sideOffset={8}
          className="z-50 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_18px_44px_-16px_rgba(0,0,0,0.55)] data-[side=bottom]:animate-in data-[side=bottom]:slide-in-from-top-1"
        >
          {workspaceOpenTargetOptions.map((option) => {
            const Icon = option.icon;
            const unavailable = !workspaceOpenTargetAvailable(option, platform);
            const selected = option.id === target;
            const pending = pendingTarget === option.id;

            return (
              <DropdownMenuPrimitive.Item
                key={option.id}
                disabled={disabled || isOpening || unavailable}
                className="relative flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 pr-8 text-[13px] outline-none transition data-[disabled]:pointer-events-none data-[disabled]:opacity-35 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                onSelect={() => {
                  onTargetChange(option.id);
                  onOpen(option.id);
                }}
              >
                {pending ? (
                  <RefreshCw className="size-4 shrink-0 animate-spin text-lime-hi" />
                ) : (
                  <Icon className={cn('size-4 shrink-0', selected ? 'text-lime-hi' : 'text-muted-foreground')} />
                )}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected ? <Check className="absolute right-2.5 size-3.5 text-lime-hi" /> : null}
              </DropdownMenuPrimitive.Item>
            );
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export const modelDefaultOptionValue = '__orrery_model_default__';

export const modelCustomOptionValue = '__orrery_model_custom__';

// Per-agent model picker: a curated dropdown (Default + presets) plus a
// "Custom…" option that reveals a free-text field for arbitrary model ids.

export function ModelPickerPill({
  providerKind,
  model,
  discoveredOptions,
  disabled,
  onChange,
}: {
  providerKind: ProviderKind;
  model: string;
  discoveredOptions?: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const options = discoveredOptions ?? modelOptionsForKind(providerKind);
  const trimmed = model.trim();
  const isCustomValue = trimmed !== '' && !options.some((option) => option.value === trimmed);
  const [forceCustom, setForceCustom] = useState(false);

  // Switching agent resets to the curated list (the parent also clears the
  // model so a Codex id can't leak into a Claude session).
  useEffect(() => {
    setForceCustom(false);
  }, [providerKind]);

  const showCustom = forceCustom || isCustomValue;
  const selectValue = showCustom ? modelCustomOptionValue : trimmed === '' ? modelDefaultOptionValue : trimmed;
  const selectOptions: SetupOption[] = [{ value: modelDefaultOptionValue, label: 'Default' }, ...options, { value: modelCustomOptionValue, label: 'Custom…' }];

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <NewChatSetupPill
        icon={Bot}
        label="Model"
        hint="Model (provider default if unset)"
        value={selectValue}
        options={selectOptions}
        disabled={disabled}
        className="w-32"
        onChange={(next) => {
          if (next === modelCustomOptionValue) {
            setForceCustom(true);
            return;
          }
          setForceCustom(false);
          onChange(next === modelDefaultOptionValue ? '' : next);
        }}
      />
      {showCustom ? (
        <input
          className="h-7 w-28 shrink-0 rounded-md border border-ink-line bg-ink px-2 text-[11.5px] font-medium text-term-name outline-none transition placeholder:text-term-faint focus-visible:border-lime-hi/60 focus-visible:ring-1 focus-visible:ring-lime-hi/25 disabled:cursor-not-allowed disabled:opacity-55"
          value={model}
          disabled={disabled}
          placeholder="model id"
          aria-label="Custom model id"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}

export function NewChatSetupBar({
  projects,
  projectCwd,
  validation,
  providerKind,
  workMode,
  branch,
  runtimeMode,
  model,
  reasoningEffort,
  discoveredModels,
  currentModelId,
  disabled,
  canChooseProject,
  onProjectChange,
  onChooseProject,
  onProviderKindChange,
  onWorkModeChange,
  onBranchChange,
  onRuntimeModeChange,
  onModelChange,
  onReasoningEffortChange,
}: {
  projects: NewChatProjectOption[];
  projectCwd: string;
  validation: ProjectCwdValidation;
  providerKind: ProviderKind;
  workMode: WorkMode;
  branch: string;
  runtimeMode: ProviderRuntimeMode;
  model: string;
  reasoningEffort: ProviderReasoningEffort;
  discoveredModels?: ProviderSetupModel[];
  currentModelId?: string;
  disabled?: boolean;
  canChooseProject?: boolean;
  onProjectChange: (cwd: string) => void;
  onChooseProject: () => void;
  onProviderKindChange: (providerKind: ProviderKind) => void;
  onWorkModeChange: (workMode: WorkMode) => void;
  onBranchChange: (branch: string) => void;
  onRuntimeModeChange: (runtimeMode: ProviderRuntimeMode) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (reasoningEffort: ProviderReasoningEffort) => void;
}) {
  const selectedProject = projects.find((project) => project.cwd === projectCwd.trim()) ?? projects[0];
  const branchOptions = uniqueStrings([selectedProject?.currentBranch, ...(selectedProject?.branches ?? [])]);
  const currentBranch = selectedProject?.currentBranch ?? branchOptions[0];
  const localBranchValue = currentBranch ?? '';
  const worktreeBranchValue = branch && branchOptions.includes(branch) ? branch : localBranchValue;
  const branchValue = workMode === 'worktree' ? worktreeBranchValue : localBranchValue;
  const isKnownNonGitProject = selectedProject?.isGitRepo === false;
  const canPickBranch = workMode === 'worktree' && branchOptions.length > 0;
  const providerRuntimeModes = providerCapability(providerKind).runtimeModes;
  const selectedCatalogModel = discoveredModels?.find(
    (entry) => entry.modelId === (model.trim() || currentModelId),
  );
  const baseEffortOptions = reasoningEffortOptionsForKind(providerKind);
  const effortOptions =
    selectedCatalogModel?.supportsReasoningEffort === false
      ? []
      : selectedCatalogModel?.reasoningEfforts
        ? baseEffortOptions.filter((option) => selectedCatalogModel.reasoningEfforts?.includes(option.id))
        : baseEffortOptions;

  return (
    <div className="app-region-no-drag mb-2">
      <div className="orrery-chip-row flex flex-nowrap items-center gap-1.5 overflow-x-auto py-1">
        {canChooseProject ? (
          <NewChatSetupPill
            icon={FolderOpen}
            label="Project"
            value={selectedProject?.cwd ?? ''}
            placeholder="Choose project"
            options={[
              ...projects.map((project) => ({
                value: project.cwd,
                label: project.name,
              })),
              { value: chooseProjectOptionValue, label: 'Choose project…' },
            ]}
            disabled={disabled}
            invalid={!validation.ok}
            hint={validation.ok ? 'Project' : validation.message}
            className="max-w-[12rem] shrink-0"
            onChange={(nextCwd) => {
              if (nextCwd === chooseProjectOptionValue) {
                onChooseProject();
                return;
              }
              onProjectChange(nextCwd);
              onBranchChange('');
            }}
          />
        ) : (
          <ProjectCwdChip
            value={projectCwd}
            validation={validation}
            projects={projects}
            disabled={disabled}
            onChange={(nextCwd) => {
              onProjectChange(nextCwd);
              onBranchChange('');
            }}
          />
        )}

        <NewChatSetupPill
          icon={Sparkles}
          label="Agent"
          hint="Agent runtime"
          value={providerKind}
          options={providerOptions.map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          disabled={disabled}
          className="w-36"
          onChange={(next) => {
            onProviderKindChange(next as ProviderKind);
          }}
        />

        <ModelPickerPill
          providerKind={providerKind}
          model={model}
          discoveredOptions={discoveredModels?.map((entry) => ({ value: entry.modelId, label: entry.name }))}
          disabled={disabled}
          onChange={onModelChange}
        />

        <NewChatSetupPill
          icon={Terminal}
          label="Work"
          value={workMode}
          tone="secondary"
          options={workModeOptions.map((option) => ({
            value: option.id,
            label: option.label,
            disabled: option.id === 'worktree' && isKnownNonGitProject,
          }))}
          disabled={disabled}
          className="shrink-0"
          onChange={(nextWorkMode) => {
            const normalized = nextWorkMode === 'worktree' ? 'worktree' : 'local';
            onWorkModeChange(normalized);
            if (normalized === 'local') {
              onBranchChange('');
            }
          }}
        />

        <NewChatSetupPill
          icon={GitBranch}
          label="Branch"
          value={branchValue}
          placeholder="Branch"
          tone="secondary"
          options={branchOptions.map((option) => ({
            value: option,
            label: option,
          }))}
          disabled={disabled || !canPickBranch}
          className="max-w-[10rem] shrink-0"
          onChange={onBranchChange}
        />

        {providerRuntimeModes.length > 0 ? (
          <NewChatSetupPill
            icon={ClipboardCheck}
            label="Mode"
            value={providerRuntimeModeCapability(providerKind, runtimeMode) ? runtimeMode : providerRuntimeModes[0]?.id}
            tone="secondary"
            options={providerRuntimeModes.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
            disabled={disabled}
            className="shrink-0"
            onChange={(nextRuntimeMode) => onRuntimeModeChange(nextRuntimeMode as ProviderRuntimeMode)}
          />
        ) : null}

        {providerSupportsReasoningEffort(providerKind) && effortOptions.length > 0 ? (
          <NewChatSetupPill
            icon={Activity}
            label="Think"
            value={reasoningEffort}
            tone="secondary"
            options={effortOptions.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
            disabled={disabled}
            className="shrink-0"
            onChange={(nextReasoningEffort) => onReasoningEffortChange(nextReasoningEffort as ProviderReasoningEffort)}
          />
        ) : null}
      </div>
    </div>
  );
}
