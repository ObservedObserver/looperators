import { app, shell } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';

import {
  appUpdateDisabledReason,
  enableAppUpdates,
  initialAppUpdateState,
  markAppUpdateAvailable,
  markAppUpdateError,
  markAppUpToDate,
  startAppUpdateCheck,
  type AppUpdateState,
} from '../shared/app-update.js';

const { autoUpdater } = electronUpdater;

const STARTUP_CHECK_DELAY_MS = 15_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const RELEASES_URL = 'https://github.com/ObservedObserver/looperators/releases/latest';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class AppUpdateController {
  #state = initialAppUpdateState(app.getVersion());
  #checkInFlight?: Promise<AppUpdateState>;
  #startupTimer?: NodeJS.Timeout;
  #pollTimer?: NodeJS.Timeout;
  readonly #broadcast: (state: AppUpdateState) => void;

  constructor(options: { broadcast: (state: AppUpdateState) => void }) {
    this.#broadcast = options.broadcast;
  }

  getState() {
    return { ...this.#state };
  }

  #setState(state: AppUpdateState) {
    this.#state = state;
    this.#broadcast(this.getState());
  }

  configure() {
    const feedConfigPath = path.join(process.resourcesPath, 'app-update.yml');
    const disabledReason = appUpdateDisabledReason({
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      hasFeedConfig: fs.existsSync(feedConfigPath),
    });

    if (disabledReason) {
      this.#setState({
        ...this.#state,
        status: 'disabled',
        message: disabledReason,
      });
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = console;

    autoUpdater.on('checking-for-update', () => {
      console.info('[app-updater] checking for updates');
    });
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.#setState(markAppUpdateAvailable(this.#state, info.version, new Date().toISOString(), info.releaseDate));
      console.info(`[app-updater] update ${info.version} is available`);
    });
    autoUpdater.on('update-not-available', () => {
      this.#setState(markAppUpToDate(this.#state, new Date().toISOString()));
      console.info('[app-updater] app is up to date');
    });
    autoUpdater.on('error', (error: Error) => {
      this.#setState(markAppUpdateError(this.#state, errorMessage(error), new Date().toISOString()));
      console.error('[app-updater] update check failed', error);
    });

    this.#setState(enableAppUpdates(this.#state));
    this.#startupTimer = setTimeout(() => {
      void this.checkForUpdates('startup');
    }, STARTUP_CHECK_DELAY_MS);
    this.#startupTimer.unref();

    this.#pollTimer = setInterval(() => {
      void this.checkForUpdates('periodic');
    }, PERIODIC_CHECK_INTERVAL_MS);
    this.#pollTimer.unref();
  }

  checkForUpdates(reason = 'manual') {
    if (!this.#state.enabled || this.#state.status === 'available') {
      return Promise.resolve(this.getState());
    }
    if (this.#checkInFlight) {
      return this.#checkInFlight;
    }

    console.info(`[app-updater] starting ${reason} update check`);
    this.#setState(startAppUpdateCheck(this.#state, new Date().toISOString()));
    this.#checkInFlight = autoUpdater
      .checkForUpdates()
      .then(() => this.getState())
      .catch((error: unknown) => {
        if (this.#state.status !== 'error') {
          this.#setState(markAppUpdateError(this.#state, errorMessage(error), new Date().toISOString()));
        }
        return this.getState();
      })
      .finally(() => {
        this.#checkInFlight = undefined;
      });

    return this.#checkInFlight;
  }

  async openReleasePage() {
    await shell.openExternal(RELEASES_URL);
  }

  dispose() {
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
  }
}
