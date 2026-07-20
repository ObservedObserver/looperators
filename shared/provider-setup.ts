export type ProviderSetupProfile = {
  providerInstanceId: string;
  kind: string;
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
  return JSON.stringify([
    profile.providerInstanceId,
    profile.kind,
    profile.binaryPath ?? '',
    profile.homePath ?? '',
    profile.shadowHomePath ?? '',
    profile.launchArgs ?? [],
    Object.entries(profile.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
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
