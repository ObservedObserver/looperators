import { Download, ExternalLink, X } from 'lucide-react';
import { useState } from 'react';

import { useAppUpdate } from '@/hooks/use-app-update';

export function AppUpdateNotice() {
  const { state, actionError, openReleasePage } = useAppUpdate();
  const [dismissedVersion, setDismissedVersion] = useState<string>();

  if (state?.status !== 'available' || !state.availableVersion || dismissedVersion === state.availableVersion) {
    return null;
  }

  return (
    <div className="app-region-no-drag shrink-0 px-3 pb-2">
      <div className="rounded-lg border border-term-cyan/35 bg-term-cyan/[0.07] px-3 py-2 font-mono">
        <div className="flex items-start gap-2">
          <Download className="mt-0.5 size-3.5 shrink-0 text-term-cyan" />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] font-medium text-term-name">looperators {state.availableVersion} is available</div>
            <div className="mt-0.5 text-[10.5px] leading-4 text-term-dim">Download the signed macOS update from GitHub.</div>
          </div>
          <button
            type="button"
            aria-label="Dismiss update until next launch"
            className="rounded p-0.5 text-term-dim2 transition hover:bg-foreground/[0.07] hover:text-term-name"
            onClick={() => setDismissedVersion(state.availableVersion)}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-term-cyan transition hover:underline"
          onClick={() => void openReleasePage()}
        >
          Open download page
          <ExternalLink className="size-3" />
        </button>
        {actionError ? <div className="mt-1.5 text-[10.5px] leading-4 text-destructive">{actionError}</div> : null}
      </div>
    </div>
  );
}
