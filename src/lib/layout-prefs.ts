import { Box, CodeXml, FolderOpen, Hammer, Rocket, Terminal, Waves, type LucideIcon } from 'lucide-react';
import { type OpenWorkspaceTarget, openWorkspaceTargetIds } from '@/shared/graph-state';

export const chatPanelWidthStorageKey = 'orrery.chatPanelWidth.v1';

export const defaultChatPanelWidth = 440;

export const chatPanelMinWidth = 360;

export const canvasPanelMinWidth = 520;

export const chatCanvasSeparatorWidth = 8;

export const railSidebarWidth = 264;

export const expandedGraphLayoutMinWidth = railSidebarWidth + chatPanelMinWidth + chatCanvasSeparatorWidth + canvasPanelMinWidth;

export const graphCollapsedStorageKey = 'orrery.graphCollapsed.v1';

export const openWorkspaceTargetStorageKey = 'orrery.openWorkspaceTarget.v1';

export const workspaceOpenTargetOptions: {
  id: OpenWorkspaceTarget;
  label: string;
  icon: LucideIcon;
  darwinOnly?: boolean;
}[] = [
  { id: 'vscode', label: 'VS Code', icon: CodeXml },
  { id: 'cursor', label: 'Cursor', icon: Box },
  { id: 'windsurf', label: 'Windsurf', icon: Waves },
  { id: 'antigravity', label: 'Antigravity', icon: Rocket },
  { id: 'finder', label: 'Finder', icon: FolderOpen },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'ghostty', label: 'Ghostty', icon: Terminal },
  { id: 'xcode', label: 'Xcode', icon: Hammer, darwinOnly: true },
];

export function initialChatPanelWidth() {
  if (typeof window === 'undefined') {
    return defaultChatPanelWidth;
  }

  try {
    const stored = Number(window.localStorage.getItem(chatPanelWidthStorageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : defaultChatPanelWidth;
  } catch {
    return defaultChatPanelWidth;
  }
}

export function isOpenWorkspaceTarget(value: string): value is OpenWorkspaceTarget {
  return openWorkspaceTargetIds.includes(value as OpenWorkspaceTarget);
}

export function initialOpenWorkspaceTarget(): OpenWorkspaceTarget {
  if (typeof window === 'undefined') {
    return 'vscode';
  }

  try {
    const stored = window.localStorage.getItem(openWorkspaceTargetStorageKey);
    return stored && isOpenWorkspaceTarget(stored) ? stored : 'vscode';
  } catch {
    return 'vscode';
  }
}

export function workspaceOpenTargetOption(target: OpenWorkspaceTarget) {
  return workspaceOpenTargetOptions.find((option) => option.id === target) ?? workspaceOpenTargetOptions[0];
}

export function workspaceOpenTargetAvailable(option: (typeof workspaceOpenTargetOptions)[number], platform?: string) {
  return !option.darwinOnly || platform === 'darwin';
}

export function initialGraphCollapsed() {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(graphCollapsedStorageKey) === '1';
  } catch {
    return false;
  }
}

export function initialViewportWidth() {
  if (typeof window === 'undefined') {
    return expandedGraphLayoutMinWidth;
  }

  return window.innerWidth;
}

export function clampChatPanelWidth(width: number, totalWidth?: number) {
  const maxWidth =
    totalWidth && totalWidth > 0
      ? Math.max(chatPanelMinWidth, totalWidth - railSidebarWidth - canvasPanelMinWidth - chatCanvasSeparatorWidth)
      : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(width, chatPanelMinWidth), maxWidth);
}

export type RailTab = 'orchestrate' | 'sessions' | 'chat';
