import { useEffect, useState } from 'react';
import { Bot, Braces, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TermLabel, termInputCls, termTextareaCls } from '@/components/terminal';
import { type ProviderSetupStatus } from '@/shared/graph-state';
import { type ProviderInstance, type ProviderKind } from '@/shared/provider-runtime';
import {
  providerOption,
  providerInstanceForKind,
  launchArgsText,
  providerEnvFromText,
  providerEnvText,
  providerInstanceFromDraft,
  providerSetupHints,
} from '@/lib/provider-catalog';
import { selectProviderSetupProfile } from '@shared/provider-setup';

export function providerSetupCheckClassName(status: ProviderSetupStatus['checks'][number]['status']) {
  switch (status) {
    case 'ok':
      return 'border-term-green/30 bg-term-green/10 text-term-green';
    case 'warning':
      return 'border-term-amber/30 bg-term-amber/10 text-term-amber';
    case 'error':
      return 'border-term-rose/35 bg-term-rose/10 text-term-rose';
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim2';
  }
}

export function ProviderInstanceSettingsPanel({
  providerKind,
  providerInstanceId,
  providerInstances,
  disabled,
  savingInstanceId,
  error,
  onSave,
}: {
  providerKind: ProviderKind;
  providerInstanceId?: string;
  providerInstances: ProviderInstance[];
  disabled?: boolean;
  savingInstanceId?: string;
  error?: string;
  onSave: (instance: ProviderInstance) => void;
}) {
  const exactInstance = selectProviderSetupProfile(providerInstances, providerKind, providerInstanceId);
  const instance =
    exactInstance ??
    (providerInstanceId
      ? {
          ...providerInstanceForKind([], providerKind),
          providerInstanceId,
          label: `${providerOption(providerKind).label} (${providerInstanceId})`,
        }
      : providerInstanceForKind(providerInstances, providerKind));
  const isReferencedInstanceMissing = Boolean(providerInstanceId && !exactInstance);
  const instanceId = instance.providerInstanceId;
  const instanceLabel = instance.label;
  const instanceBinaryPath = instance.binaryPath ?? '';
  const instanceHomePath = instance.homePath ?? '';
  const instanceShadowHomePath = instance.shadowHomePath ?? '';
  const instanceLaunchArgs = launchArgsText(instance);
  const instanceEnvText = providerEnvText(instance);
  const [label, setLabel] = useState(instanceLabel);
  const [binaryPath, setBinaryPath] = useState(instanceBinaryPath);
  const [homePath, setHomePath] = useState(instanceHomePath);
  const [shadowHomePath, setShadowHomePath] = useState(instanceShadowHomePath);
  const [launchArgs, setLaunchArgs] = useState(instanceLaunchArgs);
  const [envText, setEnvText] = useState(instanceEnvText);
  let envError: string | undefined;
  try {
    providerEnvFromText(envText);
  } catch (error) {
    envError = error instanceof Error ? error.message : String(error);
  }
  const isSaving = savingInstanceId === instance.providerInstanceId;

  useEffect(() => {
    setLabel(instanceLabel);
    setBinaryPath(instanceBinaryPath);
    setHomePath(instanceHomePath);
    setShadowHomePath(instanceShadowHomePath);
    setLaunchArgs(instanceLaunchArgs);
    setEnvText(instanceEnvText);
  }, [instanceBinaryPath, instanceEnvText, instanceHomePath, instanceId, instanceLabel, instanceLaunchArgs, instanceShadowHomePath]);

  return (
    <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <Bot className="size-3.5 shrink-0 text-lime-hi" />
        <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-[0.12em] text-term-dim2">Provider profile</span>
        <span className="truncate text-[10.5px] text-term-faint" title={instance.providerInstanceId}>
          {instance.providerInstanceId}
        </span>
      </div>

      <div className="grid gap-2">
        {isReferencedInstanceMissing ? (
          <div className="rounded-md border border-term-amber/35 bg-term-amber/10 px-2 py-1.5 text-[11px] leading-4 text-term-amber">
            Referenced profile <span className="font-semibold">{providerInstanceId}</span> is missing. Saving recreates that exact profile; no other profile
            will be changed.
          </div>
        ) : null}
        <label className="grid gap-1">
          <TermLabel>label</TermLabel>
          <input className={termInputCls} value={label} disabled={disabled || isSaving} onChange={(event) => setLabel(event.target.value)} />
        </label>

        <label className="grid gap-1">
          <TermLabel>binary path</TermLabel>
          <input
            className={termInputCls}
            value={binaryPath}
            disabled={disabled || isSaving}
            placeholder={providerKind === 'codex' ? 'codex' : providerKind === 'grok' ? 'grok' : 'claude'}
            onChange={(event) => setBinaryPath(event.target.value)}
          />
        </label>

        <div className={cn('grid grid-cols-1 gap-2', providerKind === 'codex' && 'min-[420px]:grid-cols-2')}>
          <label className="grid gap-1">
            <TermLabel>home path</TermLabel>
            <input
              className={termInputCls}
              value={homePath}
              disabled={disabled || isSaving}
              placeholder="provider default"
              onChange={(event) => setHomePath(event.target.value)}
            />
          </label>

          {providerKind === 'codex' ? (
            <label className="grid gap-1">
              <TermLabel>shadow home</TermLabel>
              <input
                className={termInputCls}
                value={shadowHomePath}
                disabled={disabled || isSaving}
                placeholder="optional"
                onChange={(event) => setShadowHomePath(event.target.value)}
              />
            </label>
          ) : null}
        </div>

        <label className="grid gap-1">
          <TermLabel>launch args</TermLabel>
          <textarea
            className={cn(termTextareaCls, 'min-h-16 resize-y text-[11.5px] leading-5')}
            value={launchArgs}
            disabled={disabled || isSaving}
            placeholder="one argument per line"
            onChange={(event) => setLaunchArgs(event.target.value)}
          />
        </label>

        <label className="grid gap-1">
          <TermLabel>environment (non-secret)</TermLabel>
          <textarea
            className={cn(termTextareaCls, 'min-h-16 resize-y text-[11.5px] leading-5')}
            value={envText}
            disabled={disabled || isSaving}
            placeholder={'NAME=value\none per line'}
            onChange={(event) => setEnvText(event.target.value)}
          />
          <span className="text-[10px] leading-4 text-term-faint">Credentials and token/key/secret/password variables must be set in the Orrery runtime environment.</span>
        </label>

        {envError || error ? (
          <div className="rounded-md border border-term-rose/35 bg-term-rose/10 px-2 py-1.5 text-[11px] leading-4 text-term-rose">{envError ?? error}</div>
        ) : null}

        <Button
          className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
          size="sm"
          disabled={disabled || isSaving || Boolean(envError)}
          onClick={() =>
            onSave(
              providerInstanceFromDraft({
                instance,
                label,
                binaryPath,
                homePath,
                shadowHomePath: providerKind === 'codex' ? shadowHomePath : '',
                launchArgs,
                envText,
              }),
            )
          }
        >
          <Check className="size-3.5" />
          <span>{isSaving ? 'Saving...' : 'Save profile'}</span>
        </Button>
      </div>
    </div>
  );
}

export function ProviderSetupDiagnostics({
  isRuntimeAvailable,
  runtimeStatusText,
  providerKind,
  providerInstanceId,
  providerInstances,
  runtimeError,
  setupStatus,
  isLoadingSetupStatus,
  savingProviderInstanceId,
  providerInstanceError,
  onSaveProviderInstance,
}: {
  isRuntimeAvailable: boolean;
  runtimeStatusText: string;
  providerKind: ProviderKind;
  providerInstanceId?: string;
  providerInstances: ProviderInstance[];
  runtimeError?: string;
  setupStatus?: ProviderSetupStatus;
  isLoadingSetupStatus?: boolean;
  savingProviderInstanceId?: string;
  providerInstanceError?: string;
  onSaveProviderInstance: (instance: ProviderInstance) => void;
}) {
  const provider = providerOption(providerKind);
  const hints = providerSetupHints(providerKind);

  return (
    <div className="border-b border-ink-line bg-ink px-3.5 py-3 font-mono">
      <div className="mb-2 flex items-center gap-2">
        <Braces className="size-3.5 text-term-cyan" />
        <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">Provider setup</span>
        <span
          className={cn(
            'ml-auto rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em]',
            isRuntimeAvailable ? 'border-term-green/30 bg-term-green/10 text-term-green' : 'border-term-rose/30 bg-term-rose/10 text-term-rose',
          )}
        >
          {isRuntimeAvailable ? 'runtime ready' : 'runtime unavailable'}
        </span>
      </div>

      <div className="space-y-2">
        <ProviderInstanceSettingsPanel
          providerKind={providerKind}
          providerInstanceId={providerInstanceId}
          providerInstances={providerInstances}
          disabled={!isRuntimeAvailable}
          savingInstanceId={savingProviderInstanceId}
          error={providerInstanceError}
          onSave={onSaveProviderInstance}
        />

        <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
          <div className="grid gap-1.5 text-[11.5px] leading-5">
            <div className="flex min-w-0 gap-2">
              <span className="w-20 shrink-0 text-term-dim2">runtime</span>
              <span className="min-w-0 text-term-name">{isRuntimeAvailable ? runtimeStatusText : 'Start a runtime to create chats'}</span>
            </div>
            <div className="flex min-w-0 gap-2">
              <span className="w-20 shrink-0 text-term-dim2">provider</span>
              <span className="min-w-0 text-term-name">{provider.label}</span>
            </div>
          </div>
        </div>

        {setupStatus?.models ? (
          <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-term-dim2">Discovered models</div>
            <div className="space-y-1 text-[11.5px] leading-5">
              <div className="flex gap-2">
                <span className="w-20 shrink-0 text-term-dim2">source</span>
                <span className={setupStatus.models.stale ? 'text-term-amber' : 'text-term-name'}>
                  {setupStatus.models.source}{setupStatus.models.stale ? ' · stale' : ''}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="w-20 shrink-0 text-term-dim2">current</span>
                <span className="text-term-name">{setupStatus.models.currentModelId ?? 'provider default'}</span>
              </div>
              {setupStatus.models.availableModels.map((model) => (
                <div key={model.modelId} className="flex min-w-0 gap-2 rounded bg-ink px-2 py-1">
                  <span className="min-w-0 flex-1 truncate text-term-name">{model.name}</span>
                  <span className="shrink-0 text-term-faint">{model.modelId}</span>
                </div>
              ))}
              {setupStatus.models.setupCreatesSession ? (
                <p className="text-[10px] leading-4 text-term-faint">This readiness check creates an upstream provider session.</p>
              ) : null}
              {setupStatus.models.error ? (
                <p className="text-[10px] leading-4 text-term-amber">{setupStatus.models.error}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-term-dim2">Setup checks</div>
          {setupStatus?.checks.length ? (
            <div className="space-y-1.5">
              {setupStatus.checks.map((check) => (
                <div key={check.id} className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 rounded-md bg-ink px-2 py-1.5 text-[11.5px] leading-5">
                  <span
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-center text-[10px] uppercase tracking-[0.06em]',
                      providerSetupCheckClassName(check.status),
                    )}
                  >
                    {check.status}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-term-name">{check.label}</span>
                    <span className="block break-words text-term-dim">{check.message}</span>
                    {check.detail ? <span className="mt-0.5 block truncate text-[10.5px] text-term-faint">{check.detail}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : isLoadingSetupStatus ? (
            <div className="rounded-md border border-dashed border-ink-line p-3 text-[11.5px] text-term-dim2">Loading setup checks...</div>
          ) : (
            <div className="space-y-1">
              {hints.map((hint, index) => (
                <div key={hint} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-[11.5px] leading-5">
                  <span className="text-center text-term-faint">{index === hints.length - 1 ? '└' : '├'}</span>
                  <span className="min-w-0 text-term-dim">{hint}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {runtimeError ? (
          <div className="rounded-lg border border-term-rose/35 bg-term-rose/10 px-2.5 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-term-rose">Last error</div>
            <p className="whitespace-pre-wrap break-words text-[11.5px] leading-5 text-term-dim">{runtimeError}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
