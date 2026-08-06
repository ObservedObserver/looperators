import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, RefreshCw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { providerOptions, providerInstanceForKind } from '@/lib/provider-catalog';
import type { ProviderSetupStatus } from '@/shared/graph-state';
import type { ProviderInstance, ProviderKind } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { ProviderInstanceSettingsPanel, providerSetupCheckClassName } from '@/components/provider-settings';
import { createLatestRequestGate } from '@shared/latest-request-gate';

type StatusByKind = Partial<Record<ProviderKind, ProviderSetupStatus>>;
type LoadingByKind = Partial<Record<ProviderKind, boolean>>;
type ErrorByKind = Partial<Record<ProviderKind, string>>;

function readinessLabel(status?: ProviderSetupStatus) {
  switch (status?.readiness) {
    case 'ready':
      return 'Ready';
    case 'needs-attention':
      return 'Needs attention';
    case 'unavailable':
      return 'Unavailable';
    default:
      return status ? 'Not verified' : 'Not checked';
  }
}

function readinessDot(status?: ProviderSetupStatus) {
  switch (status?.readiness) {
    case 'ready':
      return 'bg-term-green';
    case 'needs-attention':
      return 'bg-term-amber';
    case 'unavailable':
      return 'bg-term-rose';
    default:
      return 'bg-term-dim2';
  }
}

function readinessTone(status?: ProviderSetupStatus) {
  switch (status?.readiness) {
    case 'ready':
      return 'text-term-green';
    case 'needs-attention':
      return 'text-term-amber';
    case 'unavailable':
      return 'text-term-rose';
    default:
      return 'text-term-dim2';
  }
}

function authSummary(status?: ProviderSetupStatus) {
  if (!status?.auth) return 'Authentication not checked';
  switch (status.auth.status) {
    case 'authenticated':
      return status.auth.accountLabel ? `Signed in as ${status.auth.accountLabel}` : 'Authenticated';
    case 'external':
      return `External authentication${status.auth.method ? ` · ${status.auth.method}` : ''}`;
    case 'not-required':
      return 'Authentication not required';
    case 'unauthenticated':
      return 'Sign-in required';
    default:
      return 'Authentication not confirmed';
  }
}

function compactVersion(value?: string) {
  if (!value) return 'Version unavailable';
  return value.length > 56 ? `${value.slice(0, 53)}…` : value;
}

export function AgentSettingsPanel({
  runtimeApi,
  isRuntimeAvailable,
  runtimeStatusText,
  providerInstances,
  cwd,
  savingProviderInstanceId,
  providerInstanceError,
  onSaveProviderInstance,
}: {
  runtimeApi: RuntimeApi | undefined;
  isRuntimeAvailable: boolean;
  runtimeStatusText: string;
  providerInstances: ProviderInstance[];
  cwd: string;
  savingProviderInstanceId?: string;
  providerInstanceError?: string;
  onSaveProviderInstance: (instance: ProviderInstance) => Promise<void> | void;
}) {
  const [statuses, setStatuses] = useState<StatusByKind>({});
  const [loading, setLoading] = useState<LoadingByKind>({});
  const [errors, setErrors] = useState<ErrorByKind>({});
  const [expandedKind, setExpandedKind] = useState<ProviderKind>();
  const providerInstancesRef = useRef(providerInstances);
  const requestGateRef = useRef(createLatestRequestGate<ProviderKind>());
  const requestScopeRef = useRef('');
  providerInstancesRef.current = providerInstances;
  const profileKey = useMemo(
    () => JSON.stringify(providerInstances.map((instance) => [instance.providerInstanceId, instance.binaryPath, instance.homePath, instance.shadowHomePath, instance.launchArgs, instance.env])),
    [providerInstances],
  );
  requestScopeRef.current = `${profileKey}\0${cwd}`;

  const refresh = useCallback(
    async (providerKind: ProviderKind, forceRefresh = false) => {
      if (!runtimeApi) return;
      const instance = providerInstanceForKind(providerInstancesRef.current, providerKind);
      const requestToken = requestGateRef.current.begin(providerKind);
      const requestScope = requestScopeRef.current;
      const isCurrentRequest = () =>
        requestGateRef.current.isCurrent(requestToken) &&
        requestScopeRef.current === requestScope;
      setLoading((current) => ({ ...current, [providerKind]: true }));
      setErrors((current) => ({ ...current, [providerKind]: undefined }));
      try {
        const status = await runtimeApi.getProviderSetupStatus({
          providerKind,
          providerInstanceId: instance.providerInstanceId,
          cwd: cwd.trim() || undefined,
          forceRefresh,
        });
        if (isCurrentRequest()) {
          setStatuses((current) => ({ ...current, [providerKind]: status }));
        }
      } catch (error) {
        if (isCurrentRequest()) {
          setErrors((current) => ({
            ...current,
            [providerKind]: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        if (isCurrentRequest()) {
          setLoading((current) => ({ ...current, [providerKind]: false }));
        }
      }
    },
    [cwd, runtimeApi],
  );

  useEffect(() => {
    if (!runtimeApi) return;
    // Codex and Claude probes do not create provider turns. Grok's current ACP
    // readiness contract creates an upstream session, so it remains explicit.
    void Promise.all([
      refresh('claude-code'),
      refresh('codex'),
    ]);
  }, [profileKey, refresh, runtimeApi]);

  const refreshAll = () => {
    void Promise.all(providerOptions.map((provider) => refresh(provider.id, true)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="app-region-drag shrink-0 border-b border-ink-line bg-background/85 px-6 pb-4 pt-6 backdrop-blur">
        <div className="app-region-no-drag mx-auto flex w-full max-w-4xl items-start justify-between gap-5">
          <div>
            <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-term-cyan">
              <Bot className="size-3.5" />
              Settings
            </div>
            <h2 className="text-xl font-semibold text-term-name">Agent providers</h2>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-term-dim">
              looperators reuses the coding agents installed and authenticated on this computer. Detection and real chats use the same resolved executable.
            </p>
          </div>
          <Button
            className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em]"
            variant="outline"
            size="sm"
            disabled={!runtimeApi || Object.values(loading).some(Boolean)}
            onClick={refreshAll}
          >
            <RefreshCw className={cn('size-3.5', Object.values(loading).some(Boolean) && 'animate-spin')} />
            Refresh all
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-4xl space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-ink-line bg-background/35 px-3 py-2 font-mono text-[11px] text-term-dim">
            <span className={cn('size-1.5 rounded-full', isRuntimeAvailable ? 'bg-term-green' : 'bg-term-rose')} />
            <span>{runtimeStatusText}</span>
          </div>

          {providerOptions.map((provider) => {
            const status = statuses[provider.id];
            const instance = providerInstanceForKind(providerInstances, provider.id);
            const isExpanded = expandedKind === provider.id;
            const isLoading = loading[provider.id] === true;
            const error = errors[provider.id];
            const modelCount = status?.models?.availableModels.length ?? 0;
            return (
              <section key={provider.id} className="overflow-hidden rounded-xl border border-ink-line bg-background/45 shadow-sm">
                <div className="flex items-start gap-3 px-4 py-3.5">
                  <span className={cn('mt-2 size-2 shrink-0 rounded-full shadow-[0_0_10px_currentColor]', readinessDot(status))} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <h3 className="truncate text-sm font-semibold text-term-name">{provider.label}</h3>
                      <span className={cn('shrink-0 font-mono text-[10px] uppercase tracking-[0.09em]', readinessTone(status))}>
                        {isLoading ? 'Checking…' : readinessLabel(status)}
                      </span>
                    </div>
                    <div className="mt-1 grid gap-0.5 font-mono text-[11px] leading-4 text-term-dim">
                      <span className="truncate" title={status?.command?.resolved ?? status?.command?.requested}>
                        {status?.command?.resolved ?? status?.command?.requested ?? instance.binaryPath ?? 'Auto-detect'}
                      </span>
                      <span>{compactVersion(status?.version)} · {authSummary(status)}</span>
                      {status?.models ? <span>{modelCount} model{modelCount === 1 ? '' : 's'} · {status.models.source}{status.models.stale ? ' · stale' : ''}</span> : null}
                    </div>
                    {provider.id === 'grok' && !status ? (
                      <p className="mt-1.5 text-[10.5px] leading-4 text-term-faint">Testing Grok creates an upstream ACP session because the provider has no non-session readiness endpoint.</p>
                    ) : null}
                    {error ? <p className="mt-1.5 text-[11px] leading-4 text-term-rose">{error}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 font-mono text-[10.5px] uppercase tracking-[0.07em]"
                      disabled={!runtimeApi || isLoading}
                      onClick={() => void refresh(provider.id, true)}
                    >
                      <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
                      Test
                    </Button>
                    <Button
                      variant={isExpanded ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-8 font-mono text-[10.5px] uppercase tracking-[0.07em]"
                      onClick={() => setExpandedKind(isExpanded ? undefined : provider.id)}
                    >
                      {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      Configure
                    </Button>
                  </div>
                </div>

                {isExpanded ? (
                  <div className="grid gap-3 border-t border-ink-line bg-ink/55 px-4 py-4 min-[860px]:grid-cols-[minmax(300px,0.9fr)_minmax(340px,1.1fr)]">
                    <ProviderInstanceSettingsPanel
                      providerKind={provider.id}
                      providerInstanceId={instance.providerInstanceId}
                      providerInstances={providerInstances}
                      disabled={!isRuntimeAvailable}
                      savingInstanceId={savingProviderInstanceId}
                      error={providerInstanceError}
                      onSave={async (nextInstance) => {
                        await onSaveProviderInstance(nextInstance);
                        await refresh(provider.id, true);
                      }}
                    />

                    <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
                      <div className="mb-2 flex items-center gap-2">
                        <ShieldCheck className="size-3.5 text-term-cyan" />
                        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-term-dim2">Detection details</span>
                      </div>
                      {status?.checks.length ? (
                        <div className="space-y-1.5">
                          {status.checks.map((check) => (
                            <div key={check.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-md bg-ink px-2 py-1.5 font-mono text-[11px] leading-4">
                              <span className={cn('self-start rounded border px-1 py-0.5 text-center text-[9.5px] uppercase tracking-[0.06em]', providerSetupCheckClassName(check.status))}>
                                {check.status}
                              </span>
                              <span className="min-w-0">
                                <span className="block text-term-name">{check.label}</span>
                                <span className="block break-words text-term-dim">{check.message}</span>
                                {check.detail ? <span className="mt-0.5 block break-all text-[10px] text-term-faint">{check.detail}</span> : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 rounded-md border border-dashed border-ink-line px-3 py-4 font-mono text-[11px] text-term-dim2">
                          <TerminalSquare className="size-3.5" />
                          Run Test to inspect this provider.
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
