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
