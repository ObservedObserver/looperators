export type ProviderSetupProfile = {
  providerInstanceId: string;
  kind: string;
  label?: string;
  binaryPath?: string;
  homePath?: string;
  shadowHomePath?: string;
  launchArgs?: string[];
  env?: Record<string, string>;
};

export function selectProviderSetupProfile<T extends ProviderSetupProfile>(providerInstances: T[], providerKind: string, providerInstanceId?: string) {
  if (providerInstanceId) {
    return providerInstances.find((instance) => instance.providerInstanceId === providerInstanceId && instance.kind === providerKind);
  }
  return providerInstances.find((instance) => instance.kind === providerKind);
}

export function providerSetupProfileFingerprint(profile: ProviderSetupProfile | undefined) {
  if (!profile) return 'missing';
  const serialized = JSON.stringify([
    profile.providerInstanceId,
    profile.kind,
    profile.label ?? '',
    profile.binaryPath ?? '',
    profile.homePath ?? '',
    profile.shadowHomePath ?? '',
    profile.launchArgs ?? [],
    Object.entries(profile.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `profile-v1-${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

export type ProviderSetupSnapshotLike<Status> = {
  profileFingerprint: string;
  cwd: string;
  checkedAt: string;
  expiresAt: string;
  status: Status;
};

export function providerSetupSnapshotMatchesProfile(
  snapshot: ProviderSetupSnapshotLike<unknown> | undefined,
  profile: ProviderSetupProfile | undefined,
  cwd: string,
) {
  return Boolean(
    snapshot &&
      snapshot.profileFingerprint === providerSetupProfileFingerprint(profile) &&
      snapshot.cwd === cwd.trim(),
  );
}

export function providerSetupStatusFromSnapshot<Status extends object>(
  snapshot: ProviderSetupSnapshotLike<Status>,
  timestampMs = Date.now(),
) {
  const expiresAtMs = Date.parse(snapshot.expiresAt);
  return {
    ...snapshot.status,
    source: 'snapshot' as const,
    stale: !Number.isFinite(expiresAtMs) || expiresAtMs <= timestampMs,
    expiresAt: snapshot.expiresAt,
  };
}

export function providerSetupStatusForSnapshot(status: any) {
  return {
    ...status,
    auth: status?.auth
      ? { status: status.auth.status, method: status.auth.method }
      : undefined,
    models: status?.models
      ? { ...status.models, error: undefined }
      : undefined,
    checks: Array.isArray(status?.checks)
      ? status.checks.map((check: any) => ({
          id: check?.id,
          label: check?.label,
          status: check?.status,
          message: `${check?.label ?? 'Check'} ${check?.status === 'ok' ? 'passed' : check?.status === 'error' ? 'failed' : 'needs review'} during the cached readiness check. Run Test for current details.`,
        }))
      : [],
  };
}

export function providerSetupSafeDiagnostics(status: any) {
  const hostEnvironment = status?.diagnostics?.hostEnvironment;
  const profile = status?.diagnostics?.profile;
  return {
    providerKind: status?.providerKind,
    providerInstanceId: status?.providerInstanceId,
    generatedAt: status?.generatedAt,
    expiresAt: status?.expiresAt,
    source: status?.source,
    stale: status?.stale,
    durationMs: status?.durationMs,
    readiness: status?.readiness,
    installed: status?.installed,
    version: status?.version,
    command: status?.command
      ? {
          requested: status.command.requested,
          resolved: status.command.resolved,
          source: status.command.source,
        }
      : undefined,
    auth: status?.auth
      ? { status: status.auth.status, method: status.auth.method }
      : undefined,
    models: status?.models
      ? {
          source: status.models.source,
          stale: status.models.stale,
          count: Array.isArray(status.models.availableModels)
            ? status.models.availableModels.length
            : 0,
        }
      : undefined,
    diagnostics: status?.diagnostics
      ? {
          hostEnvironment: hostEnvironment
            ? {
                source: hostEnvironment.source,
                shell: hostEnvironment.shell,
                pathEntryCount: hostEnvironment.pathEntryCount,
              }
            : undefined,
          profile: profile
            ? {
                label: profile.label,
                commandSource: profile.commandSource,
                binaryOverride: profile.binaryOverride,
                homeOverride: profile.homeOverride,
                shadowHomeOverride: profile.shadowHomeOverride,
                launchArgumentCount: profile.launchArgumentCount,
                environmentKeys: Array.isArray(profile.environmentKeys)
                  ? profile.environmentKeys.filter(
                      (key: unknown): key is string => typeof key === 'string',
                    )
                  : [],
              }
            : undefined,
        }
      : undefined,
    checks: Array.isArray(status?.checks)
      ? status.checks.map((check: any) => ({
          id: check?.id,
          status: check?.status,
        }))
      : [],
  };
}

export function providerEnvKeyIsSensitive(key: string) {
  return /(?:token|key|secret|password|credential)/i.test(key);
}

export function parseProviderEnvText(value: string) {
  const entries = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator <= 0) throw new Error(`Environment entry must be KEY=value: ${line}`);
      const key = line.slice(0, separator).trim();
      const entryValue = line.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      if (providerEnvKeyIsSensitive(key)) {
        throw new Error(`${key} looks sensitive. Set it in the looperators runtime environment instead.`);
      }
      return [key, entryValue] as const;
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
