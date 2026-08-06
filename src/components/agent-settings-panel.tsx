import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Copy, Plus, RefreshCw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { providerOption, providerOptions } from '@/lib/provider-catalog';
import type { ProviderSetupSnapshot, ProviderSetupStatus } from '@/shared/graph-state';
import type { ProviderInstance, ProviderKind } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { ProviderInstanceSettingsPanel, providerSetupCheckClassName } from '@/components/provider-settings';
import { createLatestRequestGate } from '@shared/latest-request-gate';
import { providerSetupProfileFingerprint, providerSetupSafeDiagnostics, providerSetupSnapshotMatchesProfile, providerSetupStatusFromSnapshot } from '@shared/provider-setup';

type StatusByInstance = Record<string, ProviderSetupStatus | undefined>;
type LoadingByInstance = Record<string, boolean | undefined>;
type ErrorByInstance = Record<string, string | undefined>;

function readinessLabel(status?: ProviderSetupStatus) {
  const label = (() => {
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
  })();
  if (status?.stale) return `Stale · ${label}`;
  if (status?.source === 'snapshot') return `Cached · ${label}`;
  return label;
}

function readinessDot(status?: ProviderSetupStatus) {
  if (status?.stale) return 'bg-term-amber';
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
  if (status?.stale) return 'text-term-amber';
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

function snapshotStatuses(
  snapshots: Record<string, ProviderSetupSnapshot> | undefined,
  providerInstances: ProviderInstance[],
  cwd: string,
  timestampMs = Date.now(),
) {
  return Object.fromEntries(
    providerInstances.flatMap((instance) => {
      const snapshot = snapshots?.[instance.providerInstanceId];
      return snapshot && providerSetupSnapshotMatchesProfile(snapshot, instance, cwd)
        ? [[instance.providerInstanceId, providerSetupStatusFromSnapshot(snapshot, timestampMs)] as const]
        : [];
    }),
  ) as StatusByInstance;
}

function newProfileId(providerKind: ProviderKind) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${providerKind.replace(/[^a-z0-9]+/g, '-')}-${suffix}`;
}

export function AgentSettingsPanel({
  runtimeApi,
  isRuntimeAvailable,
  runtimeStatusText,
  providerInstances,
  providerSetupSnapshots,
  cwd,
  savingProviderInstanceId,
  providerInstanceError,
  onSaveProviderInstance,
}: {
  runtimeApi: RuntimeApi | undefined;
  isRuntimeAvailable: boolean;
  runtimeStatusText: string;
  providerInstances: ProviderInstance[];
  providerSetupSnapshots?: Record<string, ProviderSetupSnapshot>;
  cwd: string;
  savingProviderInstanceId?: string;
  providerInstanceError?: string;
  onSaveProviderInstance: (instance: ProviderInstance) => Promise<boolean | void> | boolean | void;
}) {
  const [statuses, setStatuses] = useState<StatusByInstance>(() => snapshotStatuses(providerSetupSnapshots, providerInstances, cwd));
  const [loading, setLoading] = useState<LoadingByInstance>({});
  const [errors, setErrors] = useState<ErrorByInstance>({});
  const [expandedInstanceId, setExpandedInstanceId] = useState<string>();
  const [creatingKind, setCreatingKind] = useState<ProviderKind>();
  const [copiedInstanceId, setCopiedInstanceId] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const [snapshotTimestampMs, setSnapshotTimestampMs] = useState(() => Date.now());
  const requestGateRef = useRef(createLatestRequestGate<string>());
  const instancesRef = useRef(providerInstances);
  instancesRef.current = providerInstances;
  const profileKey = useMemo(
    () => JSON.stringify(providerInstances.map((instance) => providerSetupProfileFingerprint(instance))),
    [providerInstances],
  );

  useEffect(() => {
    setSnapshotTimestampMs(Date.now());
    setLoading({});
    setErrors({});
  }, [cwd, profileKey]);

  useEffect(() => {
    const snapshots = snapshotStatuses(providerSetupSnapshots, instancesRef.current, cwd, snapshotTimestampMs);
    setStatuses((current) => Object.fromEntries(
      instancesRef.current.flatMap((instance) => {
        const snapshot = snapshots[instance.providerInstanceId];
        if (!snapshot) return [];
        const live = current[instance.providerInstanceId];
        const status =
          live?.source === 'live' &&
          live.generatedAt === snapshot.generatedAt &&
          snapshot.stale !== true
            ? live
            : snapshot;
        return [[instance.providerInstanceId, status]];
      }),
    ));
  }, [cwd, profileKey, providerSetupSnapshots, snapshotTimestampMs]);

  useEffect(() => {
    const nextExpiryMs = instancesRef.current.reduce((next, instance) => {
      const snapshot = providerSetupSnapshots?.[instance.providerInstanceId];
      if (!snapshot || !providerSetupSnapshotMatchesProfile(snapshot, instance, cwd)) return next;
      const expiresAtMs = Date.parse(snapshot.expiresAt);
      return Number.isFinite(expiresAtMs) && expiresAtMs > snapshotTimestampMs
        ? Math.min(next, expiresAtMs)
        : next;
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextExpiryMs)) return;
    const timer = window.setTimeout(
      () => setSnapshotTimestampMs(Date.now()),
      Math.max(0, nextExpiryMs - Date.now() + 25),
    );
    return () => window.clearTimeout(timer);
  }, [cwd, profileKey, providerSetupSnapshots, snapshotTimestampMs]);

  const refresh = useCallback(
    async (instance: ProviderInstance, forceRefresh = false) => {
      if (!runtimeApi) return;
      const requestKey = instance.providerInstanceId;
      const requestToken = requestGateRef.current.begin(requestKey);
      const requestScope = `${providerSetupProfileFingerprint(instance)}\0${cwd}`;
      const isCurrentRequest = () => {
        const currentInstance = instancesRef.current.find((candidate) => candidate.providerInstanceId === requestKey);
        return (
          requestGateRef.current.isCurrent(requestToken) &&
          currentInstance !== undefined &&
          `${providerSetupProfileFingerprint(currentInstance)}\0${cwd}` === requestScope
        );
      };
      setLoading((current) => ({ ...current, [requestKey]: true }));
      setErrors((current) => ({ ...current, [requestKey]: undefined }));
      try {
        const status = await runtimeApi.getProviderSetupStatus({
          providerKind: instance.kind,
          providerInstanceId: instance.providerInstanceId,
          cwd: cwd.trim() || undefined,
          forceRefresh,
        });
        if (isCurrentRequest()) setStatuses((current) => ({ ...current, [requestKey]: status }));
      } catch (error) {
        if (isCurrentRequest()) {
          setErrors((current) => ({
            ...current,
            [requestKey]: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        if (isCurrentRequest()) setLoading((current) => ({ ...current, [requestKey]: false }));
      }
    },
    [cwd, runtimeApi],
  );

  useEffect(() => {
    if (!runtimeApi) return;
    // Claude and Codex checks are non-session probes. Grok remains explicit
    // because its current ACP readiness contract creates an upstream session.
    void Promise.all(instancesRef.current.filter((instance) => instance.kind !== 'grok').map((instance) => refresh(instance)));
  }, [profileKey, refresh, runtimeApi]);

  const refreshSafeProviders = () => {
    void Promise.all(providerInstances.filter((instance) => instance.kind !== 'grok').map((instance) => refresh(instance, true)));
  };

  const addProfile = async (providerKind: ProviderKind) => {
    const peers = providerInstances.filter((instance) => instance.kind === providerKind);
    const instance: ProviderInstance = {
      providerInstanceId: newProfileId(providerKind),
      kind: providerKind,
      label: `${providerOption(providerKind).label} ${peers.length + 1}`,
    };
    setCreatingKind(providerKind);
    try {
      const saved = await onSaveProviderInstance(instance);
      if (saved === false) return;
      setExpandedInstanceId(instance.providerInstanceId);
    } finally {
      setCreatingKind(undefined);
    }
  };

  const copyDiagnostics = async (status: ProviderSetupStatus) => {
    setCopyError(undefined);
    try {
      await navigator.clipboard.writeText(JSON.stringify(providerSetupSafeDiagnostics(status), null, 2));
      setCopiedInstanceId(status.providerInstanceId);
      window.setTimeout(() => setCopiedInstanceId((current) => (current === status.providerInstanceId ? undefined : current)), 1_500);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  };

  const anySafeLoading = providerInstances.some((instance) => instance.kind !== 'grok' && loading[instance.providerInstanceId]);

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
              looperators reuses coding agents installed and authenticated on this computer. Profiles, readiness snapshots, and real chats share one resolved launch configuration.
            </p>
          </div>
          <Button
            className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em]"
            variant="outline"
            size="sm"
            disabled={!runtimeApi || anySafeLoading}
            title="Refresh Claude Code and Codex. Grok stays explicit because its readiness check creates a session."
            onClick={refreshSafeProviders}
          >
            <RefreshCw className={cn('size-3.5', anySafeLoading && 'animate-spin')} />
            Refresh safe checks
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-ink-line bg-background/35 px-3 py-2 font-mono text-[11px] text-term-dim">
            <span className={cn('size-1.5 rounded-full', isRuntimeAvailable ? 'bg-term-green' : 'bg-term-rose')} />
            <span>{runtimeStatusText}</span>
          </div>
          {copyError ? <div className="rounded-lg border border-term-rose/35 bg-term-rose/10 px-3 py-2 text-[11px] text-term-rose">Could not copy diagnostics: {copyError}</div> : null}

          {providerOptions.map((provider) => {
            const instances = providerInstances.filter((instance) => instance.kind === provider.id);
            return (
              <section key={provider.id} className="space-y-2">
                <div className="flex items-center justify-between gap-3 px-1">
                  <div>
                    <h3 className="text-sm font-semibold text-term-name">{provider.label}</h3>
                    <p className="font-mono text-[10px] text-term-faint">{instances.length} profile{instances.length === 1 ? '' : 's'}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 font-mono text-[10.5px] uppercase tracking-[0.07em]"
                    disabled={!runtimeApi || creatingKind === provider.id}
                    onClick={() => void addProfile(provider.id)}
                  >
                    <Plus className="size-3.5" />
                    {creatingKind === provider.id ? 'Adding…' : 'Add profile'}
                  </Button>
                </div>

                {instances.map((instance) => {
                  const status = statuses[instance.providerInstanceId];
                  const isExpanded = expandedInstanceId === instance.providerInstanceId;
                  const isLoading = loading[instance.providerInstanceId] === true;
                  const error = errors[instance.providerInstanceId];
                  const modelCount = status?.models?.availableModels.length ?? 0;
                  return (
                    <article key={instance.providerInstanceId} className="overflow-hidden rounded-xl border border-ink-line bg-background/45 shadow-sm">
                      <div className="flex items-start gap-3 px-4 py-3.5">
                        <span className={cn('mt-2 size-2 shrink-0 rounded-full shadow-[0_0_10px_currentColor]', readinessDot(status))} />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h4 className="truncate text-sm font-semibold text-term-name">{instance.label}</h4>
                            <span className={cn('shrink-0 font-mono text-[10px] uppercase tracking-[0.09em]', readinessTone(status))}>
                              {isLoading ? 'Checking…' : readinessLabel(status)}
                            </span>
                          </div>
                          <div className="mt-1 grid gap-0.5 font-mono text-[11px] leading-4 text-term-dim">
                            <span className="truncate" title={status?.command?.resolved ?? status?.command?.requested}>
                              {status?.command?.resolved ?? status?.command?.requested ?? instance.binaryPath ?? 'Auto-detect'}
                            </span>
                            <span>{compactVersion(status?.version)} · {authSummary(status)}</span>
                            {status?.models ? <span>{modelCount} model{modelCount === 1 ? '' : 's'} · {status.models.source}{status.models.stale ? ' · stale' : ''}{status.durationMs !== undefined ? ` · ${status.durationMs} ms` : ''}</span> : null}
                          </div>
                          {provider.id === 'grok' && !status ? <p className="mt-1.5 text-[10.5px] leading-4 text-term-faint">Testing Grok creates an upstream ACP session because the provider has no non-session readiness endpoint.</p> : null}
                          {error ? <p className="mt-1.5 text-[11px] leading-4 text-term-rose">{error}</p> : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button variant="outline" size="sm" className="h-8 font-mono text-[10.5px] uppercase tracking-[0.07em]" disabled={!runtimeApi || isLoading} onClick={() => void refresh(instance, true)}>
                            <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
                            Test
                          </Button>
                          <Button variant={isExpanded ? 'secondary' : 'ghost'} size="sm" className="h-8 font-mono text-[10.5px] uppercase tracking-[0.07em]" aria-expanded={isExpanded} onClick={() => setExpandedInstanceId(isExpanded ? undefined : instance.providerInstanceId)}>
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
                              const saved = await onSaveProviderInstance(nextInstance);
                              if (saved === false) return;
                            }}
                          />

                          <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
                            <div className="mb-2 flex items-center gap-2">
                              <ShieldCheck className="size-3.5 text-term-cyan" />
                              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-term-dim2">Detection details</span>
                              {status ? (
                                <Button variant="ghost" size="sm" className="ml-auto h-7 font-mono text-[9.5px] uppercase tracking-[0.06em]" onClick={() => void copyDiagnostics(status)}>
                                  {copiedInstanceId === instance.providerInstanceId ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                                  {copiedInstanceId === instance.providerInstanceId ? 'Copied' : 'Copy safe diagnostics'}
                                </Button>
                              ) : null}
                            </div>
                            {status?.diagnostics ? (
                              <div className="mb-2 rounded-md border border-ink-line bg-ink px-2 py-1.5 font-mono text-[10px] leading-4 text-term-dim">
                                host env: {status.diagnostics.hostEnvironment.source} · {status.diagnostics.hostEnvironment.pathEntryCount} PATH entries<br />
                                profile: {status.diagnostics.profile.commandSource} · {status.diagnostics.profile.launchArgumentCount} args · {status.diagnostics.profile.environmentKeys.length} non-secret env keys
                              </div>
                            ) : null}
                            {status?.checks.length ? (
                              <div className="space-y-1.5">
                                {status.checks.map((check) => (
                                  <div key={check.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-md bg-ink px-2 py-1.5 font-mono text-[11px] leading-4">
                                    <span className={cn('self-start rounded border px-1 py-0.5 text-center text-[9.5px] uppercase tracking-[0.06em]', providerSetupCheckClassName(check.status))}>{check.status}</span>
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
                                Run Test to inspect this provider profile.
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
