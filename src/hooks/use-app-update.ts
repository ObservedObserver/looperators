import { useCallback, useEffect, useState } from 'react';

import type { AppUpdateState } from '@shared/app-update';

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    const updates = window.orrery?.updates;
    if (!updates) return;

    let active = true;
    const unsubscribe = updates.onState((nextState) => {
      if (active) setState(nextState);
    });
    void updates
      .getState()
      .then((nextState) => {
        if (active) setState(nextState);
      })
      .catch((error: unknown) => {
        if (active) {
          setActionError(error instanceof Error ? error.message : 'Could not read update status.');
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const openReleasePage = useCallback(async () => {
    setActionError(undefined);
    try {
      await window.orrery?.updates.openReleasePage();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not open the download page.');
    }
  }, []);

  return { state, actionError, openReleasePage };
}
