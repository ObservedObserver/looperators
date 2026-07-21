export type AppUpdateStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';

export type AppUpdateState = {
  enabled: boolean;
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseDate?: string;
  checkedAt?: string;
  message?: string;
};

export type AppUpdateSupportInput = {
  isPackaged: boolean;
  platform: string;
  arch: string;
  hasFeedConfig: boolean;
};

export function appUpdateDisabledReason(input: AppUpdateSupportInput) {
  if (!input.isPackaged) {
    return 'Update checks are only available in packaged builds.';
  }
  if (input.platform !== 'darwin') {
    return 'This release currently supports update checks on macOS only.';
  }
  if (input.arch !== 'arm64') {
    return 'This release currently supports update checks on Apple Silicon only.';
  }
  if (!input.hasFeedConfig) {
    return 'No update feed is configured for this build.';
  }
  return undefined;
}

export function initialAppUpdateState(currentVersion: string): AppUpdateState {
  return {
    enabled: false,
    status: 'disabled',
    currentVersion,
  };
}

export function enableAppUpdates(state: AppUpdateState): AppUpdateState {
  return {
    ...state,
    enabled: true,
    status: 'idle',
    message: undefined,
  };
}

export function startAppUpdateCheck(state: AppUpdateState, checkedAt: string): AppUpdateState {
  return {
    ...state,
    status: 'checking',
    checkedAt,
    message: undefined,
  };
}

export function markAppUpdateAvailable(state: AppUpdateState, version: string, checkedAt: string, releaseDate?: string): AppUpdateState {
  return {
    ...state,
    status: 'available',
    availableVersion: version,
    releaseDate,
    checkedAt,
    message: undefined,
  };
}

export function markAppUpToDate(state: AppUpdateState, checkedAt: string): AppUpdateState {
  return {
    ...state,
    status: 'up-to-date',
    availableVersion: undefined,
    releaseDate: undefined,
    checkedAt,
    message: undefined,
  };
}

export function markAppUpdateError(state: AppUpdateState, message: string, checkedAt: string): AppUpdateState {
  return {
    ...state,
    status: 'error',
    checkedAt,
    message,
  };
}
