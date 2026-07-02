/// <reference types="vite/client" />

import type { ElectronOrreryApi } from './runtime-client';

interface ImportMetaEnv {
  readonly VITE_ORRERY_RUNTIME_URL?: string;
  readonly VITE_ORRERY_RUNTIME_HTTP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    orrery?: ElectronOrreryApi;
  }
}
