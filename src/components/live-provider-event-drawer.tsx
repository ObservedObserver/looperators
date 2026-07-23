import { ProviderEventDrawer } from '@/components/provider-event-drawer';
import { useRuntimeSessionView } from '@/hooks/use-runtime-session-view';
import type { RuntimeStateStore } from '@shared/runtime-state-store';

type LiveProviderEventDrawerProps = {
  runtimeStateStore: RuntimeStateStore;
  sessionId: string;
};

export function LiveProviderEventDrawer({
  runtimeStateStore,
  sessionId,
}: LiveProviderEventDrawerProps) {
  const view = useRuntimeSessionView(runtimeStateStore, sessionId);
  return view ? <ProviderEventDrawer session={view.session} /> : null;
}
