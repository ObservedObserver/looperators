import { useCallback, useEffect, useRef, useState } from 'react'

import type { OpenWorkspaceTarget } from '@/shared/graph-state'
import {
  chatPanelWidthStorageKey,
  clampChatPanelWidth,
  expandedGraphLayoutMinWidth,
  graphCollapsedStorageKey,
  initialChatPanelWidth,
  initialGraphCollapsed,
  initialOpenWorkspaceTarget,
  initialViewportWidth,
  openWorkspaceTargetStorageKey,
  railSidebarWidth,
} from '@/lib/layout-prefs'

export type ColorScheme = 'dark' | 'light'

export function useLayoutPrefs() {
  const [chatPanelWidth, setChatPanelWidth] = useState(initialChatPanelWidth)
  const [isResizingChatPanel, setIsResizingChatPanel] = useState(false)
  const [graphCollapsed, setGraphCollapsed] = useState(initialGraphCollapsed)
  const [viewportWidth, setViewportWidth] = useState(initialViewportWidth)
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => {
    if (typeof window === 'undefined') {
      return 'dark'
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  })
  const [openWorkspaceTarget, setOpenWorkspaceTarget] =
    useState<OpenWorkspaceTarget>(initialOpenWorkspaceTarget)
  const splitContainerRef = useRef<HTMLElement | null>(null)

  const adjustChatPanelWidth = useCallback((delta: number) => {
    const totalWidth =
      splitContainerRef.current?.getBoundingClientRect().width ??
      (typeof window !== 'undefined' ? window.innerWidth : undefined)
    setChatPanelWidth((current) =>
      clampChatPanelWidth(current + delta, totalWidth)
    )
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', colorScheme === 'dark')
  }, [colorScheme])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(
        chatPanelWidthStorageKey,
        String(Math.round(chatPanelWidth))
      )
    } catch {
      // Width persistence is best-effort; resizing still works without storage.
    }
  }, [chatPanelWidth])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(
        graphCollapsedStorageKey,
        graphCollapsed ? '1' : '0'
      )
    } catch {
      // Collapse persistence is best-effort.
    }
  }, [graphCollapsed])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(
        openWorkspaceTargetStorageKey,
        openWorkspaceTarget
      )
    } catch {
      // Open-target persistence is best-effort.
    }
  }, [openWorkspaceTarget])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = () => {
      const totalWidth =
        splitContainerRef.current?.getBoundingClientRect().width ??
        window.innerWidth
      setViewportWidth(totalWidth)
      setChatPanelWidth((current) =>
        clampChatPanelWidth(current, totalWidth)
      )
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (!isResizingChatPanel) {
      return
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent) => {
      const rect = splitContainerRef.current?.getBoundingClientRect()
      if (!rect) {
        return
      }

      setChatPanelWidth(
        clampChatPanelWidth(
          event.clientX - rect.left - railSidebarWidth,
          rect.width
        )
      )
    }

    const stopResizing = () => setIsResizingChatPanel(false)

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing, { once: true })
    window.addEventListener('pointercancel', stopResizing, { once: true })

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }
  }, [isResizingChatPanel])

  const graphForcedCollapsed = viewportWidth < expandedGraphLayoutMinWidth
  const effectiveGraphCollapsed = graphCollapsed || graphForcedCollapsed

  return {
    splitContainerRef,
    chatPanelWidth,
    isResizingChatPanel,
    setIsResizingChatPanel,
    graphCollapsed,
    setGraphCollapsed,
    viewportWidth,
    colorScheme,
    setColorScheme,
    openWorkspaceTarget,
    setOpenWorkspaceTarget,
    adjustChatPanelWidth,
    graphForcedCollapsed,
    effectiveGraphCollapsed,
  }
}

export type LayoutPrefsState = ReturnType<typeof useLayoutPrefs>
